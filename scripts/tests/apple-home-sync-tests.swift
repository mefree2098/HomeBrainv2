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
