import Foundation

@main
struct AppleHomeSyncTests {
    static func main() throws {
        let id = UUID(), other = UUID(), sceneID = UUID()
        let existing = HBAppleHomeSyncPolicy.SceneSnapshot(uuid: sceneID, name: "Stars Only", characteristic: id, writesOn: true, actionCount: 1)
        var count = 0
        func check(_ name: String, _ condition: Bool) {
            precondition(condition, name); count += 1; print("PASS \(name)")
        }
        let nearby = HBAppleHomeSyncPolicy.PairingCandidate(id: id, name: "HomeBrain Test", isBridge: true, manufacturer: nil)
        check("direct pairing selects the advertised bridge before metadata is available",
            try HBAppleHomeSyncPolicy.pairingCandidate(named: "HomeBrain Test", candidates: [nearby]) == id)
        check("discovery never chooses a different nearby bridge",
            try HBAppleHomeSyncPolicy.pairingCandidate(named: "Other Bridge", candidates: [nearby]) == nil)
        check("a same-named light is not a pairing candidate",
            try HBAppleHomeSyncPolicy.pairingCandidate(named: "HomeBrain Test", candidates: [
                .init(id: other, name: "HomeBrain Test", isBridge: false, manufacturer: "HomeBrain")]) == nil)
        check("a different manufacturer's bridge cannot be selected by name",
            try HBAppleHomeSyncPolicy.pairingCandidate(named: "HomeBrain Test", candidates: [
                .init(id: other, name: "HomeBrain Test", isBridge: true, manufacturer: "Other Vendor")]) == nil)
        do {
            _ = try HBAppleHomeSyncPolicy.pairingCandidate(named: "HomeBrain Test", candidates: [nearby,
                .init(id: other, name: "HomeBrain Test", isBridge: true, manufacturer: "HomeBrain")])
            preconditionFailure("duplicate bridge names must not pick an arbitrary accessory")
        } catch { check("ambiguous bridge discovery stops before pairing", true) }
        check("explicit repair restores a generic name even after prior synchronization",
            HBAppleHomeSyncPolicy.shouldUpdate(current: "HomeBrain 701", previous: "Theater Cans", desired: "Theater Cans", restore: true))
        check("routine sync preserves a customized service name",
            !HBAppleHomeSyncPolicy.shouldUpdate(current: "My Movie Lights", previous: "Theater Cans", desired: "Theater Lights"))
        check("repair restores known source rooms in bulk", HBAppleHomeSyncPolicy.shouldUpdateRoom(current: "Default Room",
            previous: "Theater", desired: "Theater", assigned: true, restore: true))
        check("repair cannot overwrite a real room with Unassigned", !HBAppleHomeSyncPolicy.shouldUpdateRoom(current: "Office",
            previous: "Unassigned", desired: "Unassigned", assigned: false, restore: true))
        check("older hubs' Unassigned placeholder is also protected", !HBAppleHomeSyncPolicy.shouldUpdateRoom(current: "Office",
            previous: nil, desired: " unassigned ", assigned: true))
        check("fallback room is never treated as a source assignment", !HBAppleHomeSyncPolicy.shouldUpdateRoom(current: "Office",
            previous: nil, desired: "HomeBrain", assigned: false, restore: true))
        func roomTarget(_ room: String, assigned: Bool? = nil) throws -> HBAppleHomeTarget {
            var value: [String: Any] = ["key": "light:one", "kind": "light", "id": "one", "name": "Office Lamp",
                "room": room, "serial": "fixture", "aliases": [], "sceneNames": [], "bridgeIndex": 0]
            if let assigned { value["roomAssigned"] = assigned }
            return try JSONDecoder().decode(HBAppleHomeTarget.self, from: JSONSerialization.data(withJSONObject: value))
        }
        check("old backend responses retain real source rooms", try roomTarget("Office").hasAssignedRoom)
        check("old backend Unassigned rooms stay unmapped", try !roomTarget("Unassigned").hasAssignedRoom)
        check("old backend fallback rooms stay unmapped", try !roomTarget("HomeBrain").hasAssignedRoom)
        check("explicit room assignment distinguishes a real HomeBrain room", try roomTarget("HomeBrain", assigned: true).hasAssignedRoom)
        check("missing source assignment is preserved by decoding", try !roomTarget("HomeBrain", assigned: false).hasAssignedRoom)
        let oldAccessory = try JSONDecoder().decode(HBAppleHomeSyncState.Accessory.self, from: Data(#"{"lastName":"Theater Cans","lastRoom":"Theater"}"#.utf8))
        check("existing synchronization records survive the service-name upgrade", oldAccessory.lastName == "Theater Cans" && oldAccessory.serviceNames == nil)
        let serviceState = HBAppleHomeSyncState.Accessory(lastName: "Theater Cans", lastRoom: "Theater", serviceNames: [id.uuidString: "Theater Cans"])
        let savedService = try JSONDecoder().decode(HBAppleHomeSyncState.Accessory.self, from: JSONEncoder().encode(serviceState))
        check("service names are tracked separately for later user-override protection", savedService.serviceNames?[id.uuidString] == "Theater Cans")
        let unpaired = HBAppleHomeSyncPolicy.syncMessage(home: "My Home", matched: 0, total: 139,
            unpairedBridges: ["HomeBrain Test"], issueCount: 0)
        check("published but unpaired bridge requires pairing, not a successful zero-accessory sync",
            unpaired.contains("Setup incomplete") && unpaired.contains("0 of 139")
                && unpaired.contains("Pair HomeBrain Test") && !unpaired.contains("available to Apple Home and Siri"))
        let extraBridge = HBAppleHomeSyncPolicy.syncMessage(home: "My Home", matched: 149, total: 160,
            unpairedBridges: ["HomeBrain Test 2"], issueCount: 0)
        check("partially paired homes identify the remaining bridge", extraBridge.contains("Pair HomeBrain Test 2") && extraBridge.contains("Setup incomplete"))
        let undiscovered = HBAppleHomeSyncPolicy.syncMessage(home: "Other Home", matched: 0, total: 139,
            unpairedBridges: [], issueCount: 0)
        check("a backend pairing does not prove accessories exist in the selected home",
            undiscovered.contains("No HomeBrain accessories found in Other Home") && undiscovered.contains("Select the Apple Home used during pairing")
                && !undiscovered.contains("available to Apple Home and Siri"))
        let partial = HBAppleHomeSyncPolicy.syncMessage(home: "My Home", matched: 80, total: 139,
            unpairedBridges: [], issueCount: 0)
        check("incomplete discovery does not claim successful synchronization", partial.contains("Synchronization incomplete: 80 of 139"))
        let empty = HBAppleHomeSyncPolicy.syncMessage(home: "My Home", matched: 0, total: 0,
            unpairedBridges: [], issueCount: 0)
        check("empty catalogs cannot claim Siri is ready", empty.contains("No supported") && !empty.contains("available to Apple Home and Siri"))
        let issues = HBAppleHomeSyncPolicy.syncMessage(home: "My Home", matched: 139, total: 139,
            unpairedBridges: [], issueCount: 2)
        check("room or scene failures prevent a successful sync report", issues.contains("needs attention") && issues.contains("Review 2")
            && !issues.contains("available to Apple Home and Siri"))
        let complete = HBAppleHomeSyncPolicy.syncMessage(home: "My Home", matched: 139, total: 139,
            unpairedBridges: [], issueCount: 0)
        check("fully discovered accessories with no sync issues can report success", complete.contains("Synchronized 139") && complete.contains("available to Apple Home and Siri"))
        check("new Stars Only workflow becomes an Apple Home scene without a Shortcut", HBAppleHomeSyncPolicy.decision(name: "Stars Only", characteristic: id, existing: []) == .create)
        check("idempotent exact scene reuses the same object", HBAppleHomeSyncPolicy.decision(name: "Stars Only", characteristic: id, existing: [existing]) == .reuse(sceneID))
        check("normalized names match", HBAppleHomeSyncPolicy.decision(name: "  stars   ONLY ", characteristic: id, existing: [existing]) == .reuse(sceneID))
        check("unrelated user scene is never overwritten", HBAppleHomeSyncPolicy.decision(name: "Stars Only", characteristic: other, existing: [existing]) == .conflict)
        let custom = HBAppleHomeSyncPolicy.SceneSnapshot(uuid: sceneID, name: "Stars Only", characteristic: id, writesOn: true, actionCount: 2)
        check("multi-action user scenes are not adopted", HBAppleHomeSyncPolicy.decision(name: "Stars Only", characteristic: id, existing: [custom]) == .conflict)
        check("duplicate scene names fail closed", HBAppleHomeSyncPolicy.decision(name: "Stars Only", characteristic: id, existing: [existing, existing]) == .conflict)
        let off = HBAppleHomeSyncPolicy.SceneSnapshot(uuid: sceneID, name: "Stars Only", characteristic: id, writesOn: false, actionCount: 1)
        check("off is not a workflow execution scene", HBAppleHomeSyncPolicy.decision(name: "Stars Only", characteristic: id, existing: [off]) == .conflict)
        let owned = HBAppleHomeSyncState.Scene(uuid: sceneID, name: "Stars Only", serial: "fixture", characteristic: id)
        check("only unmodified owned scenes can be pruned", HBAppleHomeSyncPolicy.isUnmodified(existing, owned: owned))
        check("customized owned scene cannot be pruned", !HBAppleHomeSyncPolicy.isUnmodified(custom, owned: owned))
        let renamed = HBAppleHomeSyncPolicy.SceneSnapshot(uuid: sceneID, name: "User renamed", characteristic: id, writesOn: true, actionCount: 1)
        check("manual rename is preserved", !HBAppleHomeSyncPolicy.isUnmodified(renamed, owned: owned))
        check("new accessories receive source room assignment", HBAppleHomeSyncPolicy.shouldUpdate(current: "Default", previous: nil, desired: "Master Bedroom"))
        check("source room updates propagate", HBAppleHomeSyncPolicy.shouldUpdate(current: "Theater", previous: "Theater", desired: "Cinema"))
        check("manual Apple Home room change is preserved", !HBAppleHomeSyncPolicy.shouldUpdate(current: "Custom", previous: "Theater", desired: "Cinema"))
        check("no repeated writes when room already correct", !HBAppleHomeSyncPolicy.shouldUpdate(current: "Theater", previous: nil, desired: "Theater"))
        let url = URL(string: "https://example.test/homebrain")!
        let bind = HBAppleHomeSyncPolicy.binding(server: url, account: "one", namespace: "bridge")
        check("mapping isolated per account", bind != HBAppleHomeSyncPolicy.binding(server: url, account: "two", namespace: "bridge"))
        check("mapping isolated per backend bridge", bind != HBAppleHomeSyncPolicy.binding(server: url, account: "one", namespace: "other"))
        check("mapping isolated per home server", bind != HBAppleHomeSyncPolicy.binding(server: URL(string: "https://other.test")!, account: "one", namespace: "bridge"))
        check("workflow aliases have distinct stable scene keys", HBAppleHomeSyncPolicy.sceneKey(serial: "one", name: "Night TV") != HBAppleHomeSyncPolicy.sceneKey(serial: "one", name: "Stars Only"))
        let state = HBAppleHomeSyncState(homeID: UUID(), scenes: ["test": owned])
        let roundtrip = try JSONDecoder().decode(HBAppleHomeSyncState.self, from: JSONEncoder().encode(state))
        check("ownership and selected home persist", roundtrip.homeID == state.homeID && roundtrip.scenes == state.scenes)
        print("Apple Home sync: \(count) tests passed")
    }
}
