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
    static func shouldUpdate(current: String, previous: String?, desired: String) -> Bool {
        current != desired && (previous == nil || current == previous)
    }
}
