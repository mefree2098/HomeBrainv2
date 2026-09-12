import Foundation

nonisolated struct HBAppleHomeTarget: Codable, Identifiable, Equatable, Sendable {
    let key: String
    let kind: String
    let id: String
    let name: String
    let room: String
    let serial: String
    let aliases: [String]
    let sceneNames: [String]
    let bridgeIndex: Int
    let roomAssigned: Bool?
    var hasAssignedRoom: Bool {
        // Older hubs use HomeBrain as a fallback without identifying whether it was assigned.
        roomAssigned ?? (HBAppleHomeSyncPolicy.hasRoom(room) && HBAppleHomeSyncPolicy.normalize(room) != "homebrain")
    }
}
nonisolated struct HBAppleHomeBridgeInfo: Decodable, Identifiable, Sendable {
    let index: Int
    let name: String
    let paired: Bool
    let port: Int
    var id: Int { index }
}
nonisolated struct HBAppleHomeSkipped: Decodable, Identifiable, Sendable {
    let id: String
    let name: String
    let reason: String
}
nonisolated struct HBAppleHomeStatus: Decodable, Sendable {
    let success: Bool
    let enabled: Bool
    let running: Bool
    let namespace: String
    let canManage: Bool
    let error: String
    let bridges: [HBAppleHomeBridgeInfo]
    let targets: [HBAppleHomeTarget]
    let skipped: [HBAppleHomeSkipped]
    var unpairedBridges: [HBAppleHomeBridgeInfo] { bridges.filter { !$0.paired } }
}
nonisolated struct HBAppleHomePairing: Decodable, Sendable {
    struct Bridge: Decodable, Identifiable, Sendable {
        let index: Int
        let name: String
        let paired: Bool
        let setupURI: String
        var id: Int { index }
    }
    let success: Bool
    let pin: String
    let bridges: [Bridge]
}

/// Records only resources created/last managed by this app. No Home credentials are stored here.
nonisolated struct HBAppleHomeSyncState: Codable, Sendable {
    struct Accessory: Codable, Sendable {
        var lastName: String
        var lastRoom: String
        // Optional so records saved by earlier app builds still decode.
        var serviceNames: [String: String]?
    }
    struct Scene: Codable, Equatable, Sendable {
        var uuid: UUID
        var name: String
        var serial: String
        var characteristic: UUID
        var pending = false
    }
    var homeID: UUID?
    var accessories: [String: Accessory] = [:]
    var scenes: [String: Scene] = [:]
}

/// Small, testable policy shared by real HomeKit reconciliation and unit tests.
nonisolated enum HBAppleHomeSyncPolicy {
    struct PairingCandidate: Sendable {
        let id: UUID
        let name: String
        let isBridge: Bool
        let manufacturer: String?
    }
    static func pairingCandidate(named expected: String, candidates: [PairingCandidate]) throws -> UUID? {
        let matches = candidates.filter {
            $0.isBridge && normalize($0.name) == normalize(expected)
                && ($0.manufacturer?.isEmpty != false || $0.manufacturer == "HomeBrain")
        }
        guard matches.count <= 1 else {
            throw HBSiriError.message("More than one nearby bridge is named \(expected). Resolve the duplicate bridge names before pairing.")
        }
        return matches.first?.id
    }
    static func hasRoom(_ room: String) -> Bool {
        !["", "unassigned"].contains(normalize(room))
    }
    struct SceneSnapshot: Equatable, Sendable {
        let uuid: UUID
        let name: String
        let characteristic: UUID?
        let writesOn: Bool
        let actionCount: Int
    }
    enum SceneDecision: Equatable {
        case create, reuse(UUID), conflict
    }
    static func syncMessage(home: String, matched: Int, total: Int, unpairedBridges: [String], issueCount: Int) -> String {
        // Publication and permission to synchronize are not evidence of HomeKit pairing.
        // An empty or partially discovered home must never be presented as a successful sync.
        let message: String
        if !unpairedBridges.isEmpty {
            message = "Setup incomplete: \(matched) of \(total) HomeBrain accessories found in \(home). Pair \(unpairedBridges.joined(separator: ", ")) using Set Up Bridge Pairing below. Selecting a home and synchronizing do not add the bridge to Apple Home."
        } else if total == 0 {
            message = "No supported HomeBrain accessories are currently published. Review the entries not exported to Apple Home below."
        } else if matched == 0 {
            message = "No HomeBrain accessories found in \(home). The bridge has a pairing, but its accessories are not visible in this home. Select the Apple Home used during pairing, check that your iPhone and hub are on the same LAN, then refresh."
        } else if matched < total {
            message = "Synchronization incomplete: \(matched) of \(total) HomeBrain accessories found in \(home). Wait for Apple Home to discover the remaining accessories, then refresh."
        } else if issueCount > 0 {
            message = "Found \(matched) HomeBrain accessories in \(home), but room or workflow scene synchronization needs attention."
        } else {
            message = "Synchronized \(matched) HomeBrain accessories in \(home). Devices, rooms, and workflow scenes are available to Apple Home and Siri."
        }
        return message + (issueCount > 0 ? " Review \(issueCount) synchronization issue(s) below." : "")
    }
    static func normalize(_ value: String) -> String {
        value.precomposedStringWithCompatibilityMapping
            .split(whereSeparator: \.isWhitespace).joined(separator: " ").lowercased()
    }
    static func binding(server: URL, account: String, namespace: String) -> String {
        // JSON prevents delimiter collisions; identity does not include bearer tokens or pairing PINs.
        let fields = [HBSiriPolicy.serverIdentity(server), account, namespace]
        let data = (try? JSONEncoder().encode(fields)) ?? Data()
        return "homebrain.apple-home.v1." + data.base64EncodedString()
    }
    static func sceneKey(serial: String, name: String) -> String {
        serial + ":" + normalize(name)
    }
    static func decision(name: String, characteristic: UUID, existing: [SceneSnapshot]) -> SceneDecision {
        let matches = existing.filter { normalize($0.name) == normalize(name) }
        guard !matches.isEmpty else { return .create }
        guard matches.count == 1, let match = matches.first, match.actionCount == 1,
              match.characteristic == characteristic, match.writesOn else { return .conflict }
        return .reuse(match.uuid)
    }
    static func isUnmodified(_ scene: SceneSnapshot, owned: HBAppleHomeSyncState.Scene) -> Bool {
        scene.uuid == owned.uuid && scene.name == owned.name && scene.actionCount == 1
            && scene.characteristic == owned.characteristic && scene.writesOn
    }
    static func shouldUpdate(current: String, previous: String?, desired: String, restore: Bool = false) -> Bool {
        current != desired && (restore || previous == nil || current == previous)
    }
    static func shouldUpdateRoom(current: String, previous: String?, desired: String, assigned: Bool, restore: Bool = false) -> Bool {
        // A missing source room must not erase a useful Apple Home room, even during repair.
        assigned && hasRoom(desired) && shouldUpdate(current: current, previous: previous, desired: desired, restore: restore)
    }
}
