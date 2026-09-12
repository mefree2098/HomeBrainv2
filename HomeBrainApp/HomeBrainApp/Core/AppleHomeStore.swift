import Combine
import Foundation
import HomeKit
import UIKit

/// HomeKit is used only on iOS for pairing and home metadata. Watch Siri uses the paired Apple Home.
/// Never writes an accessory characteristic or executes a scene during synchronization.
@MainActor
final class AppleHomeStore: NSObject, ObservableObject, HMHomeManagerDelegate {
    static let shared = AppleHomeStore()
    @Published private(set) var status: HBAppleHomeStatus?
    @Published private(set) var homes: [HMHome] = []
    @Published private(set) var message = "Connect once to use device, room, and workflow names directly with Siri."
    @Published private(set) var issues: [String] = []
    @Published private(set) var busy = false
    @Published private(set) var homeAccessGranted = false
    @Published private(set) var selectedHomeID: UUID?
    @Published private(set) var pairing: HBAppleHomePairing?
    @Published private(set) var matchedAccessoryCount: Int?
    private var manager: HMHomeManager?
    private var homeDataReady = false
    private var currentBinding: String?
    private var state = HBAppleHomeSyncState()

    private var consentKey: String? {
        guard let url = SessionStore.shared.normalizedServerURL,
              let account = SessionStore.shared.currentUser?.id, SessionStore.shared.isAuthenticated else { return nil }
        return HBAppleHomeSyncPolicy.binding(server: url, account: account, namespace: "consent")
    }
    var hasConnected: Bool { consentKey.map { UserDefaults.standard.bool(forKey: $0) } ?? false }
    struct RestoreRequest {
        fileprivate let binding: String
        fileprivate let sessionContext: UUID
        fileprivate let homeID: UUID
        let homeName: String
    }
    var restoreRequest: RestoreRequest? {
        guard hasConnected, status?.running == true, let currentBinding, let selectedHomeID,
              let home = homes.first(where: { $0.uniqueIdentifier == selectedHomeID }) else { return nil }
        return .init(binding: currentBinding, sessionContext: SessionStore.shared.sessionContextID,
                     homeID: selectedHomeID, homeName: home.name)
    }

    nonisolated func homeManagerDidUpdateHomes(_ manager: HMHomeManager) {
        Task { @MainActor [weak self] in self?.updateHomeData() }
    }
    nonisolated func homeManager(_ manager: HMHomeManager, didUpdate status: HMHomeManagerAuthorizationStatus) {
        Task { @MainActor [weak self] in self?.updateHomeData() }
    }
    private func updateHomeData() {
        guard let manager else { return }
        homeDataReady = true
        homeAccessGranted = manager.authorizationStatus.contains(.authorized)
        homes = manager.homes
        if !homeAccessGranted { message = "Allow Home access for HomeBrain in iPhone Settings → Privacy & Security → HomeKit." }
    }
    private func homeManagerReady() async throws {
        if manager == nil {
            homeDataReady = false
            manager = HMHomeManager()
            manager?.delegate = self
        }
        for _ in 0..<100 {
            try Task.checkCancellation()
            if homeDataReady { break }
            try await Task.sleep(for: .milliseconds(150))
        }
        guard homeDataReady else { throw HBSiriError.message("Apple Home is still loading. Check Home permission and retry.") }
        updateHomeData()
        guard homeAccessGranted else { throw HBSiriError.message("HomeBrain needs Home permission to create rooms and workflow scenes automatically.") }
    }
    private func requireCurrent(_ snapshot: HBSiriSession, binding: String, homeID: UUID? = nil) throws {
        try Task.checkCancellation()
        let session = SessionStore.shared
        guard session.isAuthenticated, session.sessionContextID == snapshot.context,
              let url = session.normalizedServerURL, let account = session.currentUser?.id,
              let status, status.running,
              HBAppleHomeSyncPolicy.binding(server: url, account: account, namespace: status.namespace) == binding,
              currentBinding == binding else { throw HBSiriError.changedHome }
        if let homeID, selectedHomeID != homeID { throw HBSiriError.changedHome }
    }
    private func persist() {
        guard let currentBinding, let data = try? JSONEncoder().encode(state) else { return }
        UserDefaults.standard.set(data, forKey: currentBinding)
        if let homeID = state.homeID {
            UserDefaults.standard.set(data, forKey: currentBinding + ".home." + homeID.uuidString)
        }
    }
    private func bind(_ status: HBAppleHomeStatus, snapshot: HBSiriSession) throws {
        guard let account = SessionStore.shared.currentUser?.id,
              SessionStore.shared.sessionContextID == snapshot.context else { throw HBSiriError.changedHome }
        let key = HBAppleHomeSyncPolicy.binding(server: snapshot.baseURL, account: account, namespace: status.namespace)
        if currentBinding != key {
            pairing = nil; issues = []; matchedAccessoryCount = nil; currentBinding = key
            state = UserDefaults.standard.data(forKey: key).flatMap { try? JSONDecoder().decode(HBAppleHomeSyncState.self, from: $0) } ?? HBAppleHomeSyncState()
            selectedHomeID = state.homeID
        }
        self.status = status
    }
    func refresh() async { await refresh(restoring: nil) }
    private func refresh(restoring request: RestoreRequest?) async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        do {
            let (status, snapshot) = try await HomeBrainSiriRuntime.client.appleHomeStatus()
            try bind(status, snapshot: snapshot)
            if let request {
                guard currentBinding == request.binding, snapshot.context == request.sessionContext,
                      selectedHomeID == request.homeID else { throw HBSiriError.changedHome }
            }
            issues = []; matchedAccessoryCount = nil
            message = !status.error.isEmpty ? status.error : status.running
                ? "\(status.targets.count) accessories and workflow triggers are published by the hub. Pair the bridge with Apple Home to add them to your home."
                : "The Apple Home bridge is not enabled. Connect below to begin."
            if hasConnected, status.running {
                try await sync(status: status, snapshot: snapshot, restoringNamesAndRooms: request != nil)
            }
        } catch { message = error.localizedDescription }
    }
    func restoreNamesAndRooms(_ request: RestoreRequest?) async {
        guard let request, currentBinding == request.binding, selectedHomeID == request.homeID,
              SessionStore.shared.sessionContextID == request.sessionContext else {
            message = "The selected Apple Home changed. Review the selected home before restoring names and rooms."
            return
        }
        await refresh(restoring: request)
    }
    func connect() async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        do {
            _ = try await HomeBrainSiriRuntime.client.configureAppleHome(enabled: true)
            let (status, snapshot) = try await HomeBrainSiriRuntime.client.appleHomeStatus()
            try bind(status, snapshot: snapshot)
            guard let key = consentKey else { throw HBSiriError.signIn }
            UserDefaults.standard.set(true, forKey: key)
            try await homeManagerReady()
            guard let binding = currentBinding else { throw HBSiriError.changedHome }
            try requireCurrent(snapshot, binding: binding)
            pairing = try await HomeBrainSiriRuntime.client.appleHomePairing()
            try requireCurrent(snapshot, binding: binding)
            message = "Choose your Apple Home, then pair the HomeBrain bridge below. Rooms and workflow scenes synchronize automatically."
        } catch { message = error.localizedDescription }
    }
    func loadPairing() async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        do {
            let (status, snapshot) = try await HomeBrainSiriRuntime.client.appleHomeStatus()
            try bind(status, snapshot: snapshot)
            guard let binding = currentBinding else { throw HBSiriError.changedHome }
            try requireCurrent(snapshot, binding: binding)
            let value = try await HomeBrainSiriRuntime.client.appleHomePairing()
            try requireCurrent(snapshot, binding: binding)
            pairing = value
        } catch { message = error.localizedDescription }
    }
    func hidePairing() { pairing = nil }
    func selectHome(_ id: UUID?) {
        guard !busy else { return }
        if id != selectedHomeID {
            // Do not delete resources in the previous home or reuse ownership records in the next one.
            if let id, let binding = currentBinding,
               let data = UserDefaults.standard.data(forKey: binding + ".home." + id.uuidString),
               let saved = try? JSONDecoder().decode(HBAppleHomeSyncState.self, from: data), saved.homeID == id {
                state = saved
            } else { state = HBAppleHomeSyncState(homeID: id) }
            selectedHomeID = id; matchedAccessoryCount = nil; issues = []; persist()
            message = "Home selected. Use Set Up Bridge Pairing to add HomeBrain to this home, then refresh to synchronize rooms and workflow scenes."
        }
    }
    func pairBridge(_ bridge: HBAppleHomePairing.Bridge) async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        do {
            try await homeManagerReady()
            guard let homeID = selectedHomeID, let home = homes.first(where: { $0.uniqueIdentifier == homeID }) else {
                throw HBSiriError.message("Choose the Apple Home to connect first. Create a home in Apple's Home app if none is listed.")
            }
            let (status, snapshot) = try await HomeBrainSiriRuntime.client.appleHomeStatus()
            try bind(status, snapshot: snapshot)
            guard let binding = currentBinding else { throw HBSiriError.changedHome }
            try requireCurrent(snapshot, binding: binding, homeID: homeID)
            guard let currentBridge = status.bridges.first(where: { $0.index == bridge.index && $0.name == bridge.name }) else {
                throw HBSiriError.message("The bridge changed. Refresh its pairing information before retrying.")
            }
            if !currentBridge.paired {
                message = "Finding \(currentBridge.name) on your local network…"
                let accessory = try await discoverBridge(named: currentBridge.name) {
                    try self.requireCurrent(snapshot, binding: binding, homeID: homeID)
                }
                // addAccessory performs Apple's pairing/code authentication and leaves organization
                // to this app. performAccessorySetup also launches room/name setup for EVERY
                // bridged device, blocking our bulk synchronization until that wizard completes.
                message = "Enter the bridge pairing code when Apple asks. HomeBrain will organize its devices after pairing."
                try await home.addAccessory(accessory)
                try requireCurrent(snapshot, binding: binding, homeID: homeID)
            }
            // The status captured before pairing may still say unpaired.
            let (updatedStatus, updatedSession) = try await HomeBrainSiriRuntime.client.appleHomeStatus()
            try requireCurrent(snapshot, binding: binding, homeID: homeID)
            try bind(updatedStatus, snapshot: updatedSession)
            pairing = nil
            updateHomeData()
            try await sync(status: updatedStatus, snapshot: updatedSession)
        } catch { message = error.localizedDescription }
    }
    private func discoverBridge(named name: String, check: () throws -> Void) async throws -> HMAccessory {
        let browser = HMAccessoryBrowser()
        browser.startSearchingForNewAccessories()
        defer { browser.stopSearchingForNewAccessories() }
        for _ in 0..<100 {
            try check()
            let accessories = browser.discoveredAccessories
            let id = try HBAppleHomeSyncPolicy.pairingCandidate(named: name, candidates: accessories.map {
                .init(id: $0.uniqueIdentifier, name: $0.name, isBridge: $0.category.categoryType == HMAccessoryCategoryTypeBridge,
                      manufacturer: $0.manufacturer)
            })
            if let id, let accessory = accessories.first(where: { $0.uniqueIdentifier == id }) { return accessory }
            try await Task.sleep(for: .milliseconds(200))
        }
        throw HBSiriError.message("\(name) was not found nearby. Connect your iPhone to the hub's LAN, allow Home and Local Network access, then retry. If you already paired it in Apple's Home app, refresh the connection instead.")
    }
    func disable() async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        do {
            status = try await HomeBrainSiriRuntime.client.configureAppleHome(enabled: false)
            pairing = nil; matchedAccessoryCount = nil; issues = []
            if let key = consentKey { UserDefaults.standard.set(false, forKey: key) }
            message = "Bridge disabled. Apple Home cannot send commands through it. Pairings are retained for reconnection."
        } catch { message = error.localizedDescription }
    }
    func foregroundLoop() async {
        while !Task.isCancelled {
            if hasConnected { await refresh() }
            do { try await Task.sleep(for: .seconds(30)) } catch { return }
        }
    }
    func resetVisibleContext() {
        // Retain per-account connection preferences, never a previous account's visible pairing PIN.
        pairing = nil; status = nil; currentBinding = nil; selectedHomeID = nil; issues = []
        matchedAccessoryCount = nil
        state = HBAppleHomeSyncState()
    }
    private func snapshot(_ scene: HMActionSet) -> HBAppleHomeSyncPolicy.SceneSnapshot {
        let action = scene.actions.first as? HMCharacteristicWriteAction<NSNumber>
        return .init(uuid: scene.uniqueIdentifier, name: scene.name, characteristic: action?.characteristic.uniqueIdentifier,
                     writesOn: action?.targetValue.boolValue == true, actionCount: scene.actions.count)
    }
    private func sync(status: HBAppleHomeStatus, snapshot session: HBSiriSession, restoringNamesAndRooms: Bool = false) async throws {
        try await homeManagerReady()
        guard let binding = currentBinding else { throw HBSiriError.changedHome }
        try requireCurrent(session, binding: binding)
        guard let homeID = selectedHomeID, let home = homes.first(where: { $0.uniqueIdentifier == homeID }) else {
            message = "Choose your Apple Home below, then pair the bridge. No individual Shortcuts are needed."
            return
        }
        let check = { try self.requireCurrent(session, binding: binding, homeID: homeID) }
        var warnings: [String] = []
        let unassigned = status.targets.filter { !$0.hasAssignedRoom }.count
        if unassigned > 0 {
            warnings.append("\(unassigned) accessories have no room assigned in HomeBrain. Their existing Apple Home rooms are preserved. Set their rooms in HomeBrain to include them in automatic room synchronization.")
        }
        var matched = 0
        var desiredKeys = Set<String>()
        var characteristicBySerial: [String: HMCharacteristic] = [:]
        var accessoryBySerial: [String: HMAccessory] = [:]
        var duplicateSerials = Set<String>()
        // Read identity only for this manufacturer's accessories. Never adopt by display name alone.
        for accessory in home.accessories where accessory.manufacturer == "HomeBrain" {
            try check()
            // HomeKit deprecated/removed app access to its SerialNumber characteristic in iOS 11.
            // Our publisher also exposes the opaque hub-scoped identity as the public accessory model.
            guard let serial = accessory.model, status.targets.contains(where: { $0.serial == serial }) else { continue }
            if accessoryBySerial[serial] != nil || duplicateSerials.contains(serial) {
                accessoryBySerial.removeValue(forKey: serial); duplicateSerials.insert(serial)
                warnings.append("Duplicate accessory identity in Apple Home. Remove the duplicate before synchronizing.")
                continue
            }
            accessoryBySerial[serial] = accessory
        }
        for target in status.targets {
            for name in target.sceneNames { desiredKeys.insert(HBAppleHomeSyncPolicy.sceneKey(serial: target.serial, name: name)) }
            guard let accessory = accessoryBySerial[target.serial] else { continue }
            matched += 1
            do {
                try check()
                let previous = state.accessories[target.serial]
                var record = previous ?? .init(lastName: accessory.name, lastRoom: accessory.room?.name ?? "")
                do {
                    if HBAppleHomeSyncPolicy.shouldUpdate(current: accessory.name, previous: previous?.lastName, desired: target.name, restore: restoringNamesAndRooms) {
                        try await accessory.updateName(target.name); try check()
                        record.lastName = target.name
                    } else if accessory.name == target.name { record.lastName = target.name }
                } catch { try check(); warnings.append("\(target.name) accessory name: \(error.localizedDescription)") }
                state.accessories[target.serial] = record; persist()
                // HomeKit keeps service names separately from the accessory name. Home tiles and
                // Siri can retain the wizard's generic name if only the accessory is renamed.
                for service in accessory.services where [HMServiceTypeLightbulb, HMServiceTypeSwitch].contains(service.serviceType) {
                    let serviceID = service.uniqueIdentifier.uuidString
                    let lastName = previous?.serviceNames?[serviceID] ?? previous?.lastName
                    do {
                        if HBAppleHomeSyncPolicy.shouldUpdate(current: service.name, previous: lastName, desired: target.name, restore: restoringNamesAndRooms) {
                            try await service.updateName(target.name); try check()
                            record.serviceNames = (record.serviceNames ?? [:]).merging([serviceID: target.name]) { _, new in new }
                        } else if service.name == target.name {
                            record.serviceNames = (record.serviceNames ?? [:]).merging([serviceID: target.name]) { _, new in new }
                        }
                    } catch { try check(); warnings.append("\(target.name) service name: \(error.localizedDescription)") }
                    state.accessories[target.serial] = record; persist()
                }
                do {
                    if HBAppleHomeSyncPolicy.shouldUpdateRoom(current: accessory.room?.name ?? "", previous: previous?.lastRoom,
                        desired: target.room, assigned: target.hasAssignedRoom, restore: restoringNamesAndRooms) {
                        let matching = home.rooms.filter { HBAppleHomeSyncPolicy.normalize($0.name) == HBAppleHomeSyncPolicy.normalize(target.room) }
                        guard matching.count <= 1 else { throw HBSiriError.message("Ambiguous room name ‘\(target.room)’ in Apple Home.") }
                        let room: HMRoom
                        if let existing = matching.first { room = existing }
                        else { room = try await home.addRoom(named: target.room); try check() }
                        try await home.assignAccessory(accessory, to: room); try check()
                        record.lastRoom = room.name
                    } else if target.hasAssignedRoom, accessory.room?.name == target.room { record.lastRoom = target.room }
                } catch { try check(); warnings.append("\(target.name) room: \(error.localizedDescription)") }
                state.accessories[target.serial] = record; persist()
                if let on = accessory.services.flatMap(\.characteristics).first(where: { $0.characteristicType == HMCharacteristicTypePowerState }) {
                    characteristicBySerial[target.serial] = on
                }
            } catch {
                try check()
                warnings.append("\(target.name): \(error.localizedDescription)")
            }
        }
        // Prune only our own, unmodified scenes whose underlying workflow/alias was removed.
        // Pairing not yet visible is not proof the target was removed: desiredKeys comes from the backend manifest.
        for (key, owned) in Array(state.scenes) where !desiredKeys.contains(key) {
            try check()
            guard let scene = home.actionSets.first(where: { $0.uniqueIdentifier == owned.uuid }) else {
                state.scenes.removeValue(forKey: key); persist(); continue
            }
            if HBAppleHomeSyncPolicy.isUnmodified(snapshot(scene), owned: owned)
                || (owned.pending && scene.name == owned.name && scene.actions.isEmpty) {
                do { try await home.removeActionSet(scene); try check(); state.scenes.removeValue(forKey: key); persist() }
                catch { try check(); warnings.append("Could not remove obsolete scene ‘\(owned.name)’: \(error.localizedDescription)") }
            } else { warnings.append("Preserved customized scene ‘\(scene.name)’; it is no longer managed by HomeBrain.") }
        }
        for target in status.targets where !target.sceneNames.isEmpty {
            guard let characteristic = characteristicBySerial[target.serial] else { continue }
            for name in target.sceneNames {
                try check()
                let key = HBAppleHomeSyncPolicy.sceneKey(serial: target.serial, name: name)
                if let owned = state.scenes[key], owned.pending,
                   let scene = home.actionSets.first(where: { $0.uniqueIdentifier == owned.uuid }), scene.name == owned.name {
                    do {
                        if scene.actions.isEmpty {
                            try await scene.addAction(HMCharacteristicWriteAction(characteristic: characteristic, targetValue: NSNumber(value: true)))
                            try check()
                        }
                        if HBAppleHomeSyncPolicy.isUnmodified(snapshot(scene), owned: owned) {
                            state.scenes[key]?.pending = false; persist()
                        }
                    } catch { try check(); warnings.append("Scene ‘\(name)’ needs retry: \(error.localizedDescription)"); continue }
                }
                if let owned = state.scenes[key], let scene = home.actionSets.first(where: { $0.uniqueIdentifier == owned.uuid }),
                   !HBAppleHomeSyncPolicy.isUnmodified(snapshot(scene), owned: owned) {
                    warnings.append("Preserved customized scene ‘\(scene.name)’ instead of overwriting it.")
                    continue
                }
                switch HBAppleHomeSyncPolicy.decision(name: name, characteristic: characteristic.uniqueIdentifier, existing: home.actionSets.map(snapshot)) {
                case .reuse:
                    // An exact pre-existing scene works already. Do not claim ownership of somebody else's scene.
                    break
                case .conflict:
                    warnings.append("Scene ‘\(name)’ already exists for another action. It was not overwritten.")
                case .create:
                    do {
                        let scene = try await home.addActionSet(named: name); try check()
                        // Persist ownership before adding the action, so a later failure can safely be repaired.
                        let owned = HBAppleHomeSyncState.Scene(uuid: scene.uniqueIdentifier, name: name, serial: target.serial, characteristic: characteristic.uniqueIdentifier, pending: true)
                        state.scenes[key] = owned; persist()
                        do {
                            try await scene.addAction(HMCharacteristicWriteAction(characteristic: characteristic, targetValue: NSNumber(value: true)))
                            try check()
                            state.scenes[key]?.pending = false; persist()
                        } catch {
                            try check()
                            if scene.actions.isEmpty, scene.name == name {
                                try? await home.removeActionSet(scene); try check()
                                if !home.actionSets.contains(where: { $0.uniqueIdentifier == scene.uniqueIdentifier }) { state.scenes.removeValue(forKey: key); persist() }
                            }
                            throw error
                        }
                    } catch { try check(); warnings.append("Scene ‘\(name)’: \(error.localizedDescription)") }
                }
            }
        }
        try check()
        issues = warnings
        matchedAccessoryCount = matched
        message = HBAppleHomeSyncPolicy.syncMessage(home: home.name, matched: matched, total: status.targets.count,
            unpairedBridges: status.unpairedBridges.map(\.name), issueCount: warnings.count)
    }
}
