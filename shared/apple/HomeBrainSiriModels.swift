import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

nonisolated enum HBSiriError: LocalizedError {
    case signIn, changedHome, missingTarget, readOnly, invalidResponse
    case message(String)
    var errorDescription: String? {
        switch self {
        case .signIn: return "Open HomeBrain and sign in first. On Apple Watch, sync your session from iPhone."
        case .changedHome: return "This shortcut belongs to a different HomeBrain or account. Switch back, or select the action again in Shortcuts."
        case .missingTarget: return "The selected light, room, workflow, or scene is no longer available. Update the shortcut in Shortcuts."
        case .readOnly: return "This HomeBrain account is read-only and cannot run commands."
        case .invalidResponse: return "HomeBrain returned an unreadable Siri response. Update the backend and try again."
        case .message(let message): return message
        }
    }
}

nonisolated struct HBSiriTarget: Codable, Sendable, Equatable {
    let kind: String
    let id: String
    let name: String
    let room: String
    let aliases: [String]
}
nonisolated struct HBSiriCatalog: Codable, Sendable {
    let success: Bool
    let accountId: String
    let canExecute: Bool
    let targets: [HBSiriTarget]
}
nonisolated struct HBSiriCommandResult: Codable, Sendable {
    let success: Bool
    let requestId: String
    let state: String
    let message: String
}

/// Persist only the target's identity, never tokens. The same ID is valid on iPhone and Watch,
/// but cannot silently be redirected to another server/account after a home switch.
nonisolated struct HBSiriIdentity: Codable, Sendable, Equatable {
    let version: Int
    let server: String
    let account: String
    let kind: String
    let target: String

    init(server: String, account: String, kind: String, target: String) {
        self.version = 1
        self.server = server
        self.account = account
        self.kind = kind
        self.target = target
    }
    func encoded() throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(self).base64EncodedString()
    }
    static func decode(_ value: String) throws -> Self {
        guard value.count <= 8_192, let data = Data(base64Encoded: value),
              let identity = try? JSONDecoder().decode(Self.self, from: data),
              identity.version == 1, !identity.server.isEmpty, !identity.account.isEmpty,
              ["room", "light", "workflow", "scene"].contains(identity.kind), !identity.target.isEmpty else {
            throw HBSiriError.missingTarget
        }
        return identity
    }
    func resolve(server: String, catalog: HBSiriCatalog) throws -> HBSiriTarget {
        guard self.server == server, account == catalog.accountId else { throw HBSiriError.changedHome }
        guard let target = catalog.targets.first(where: { $0.kind == kind && $0.id == self.target }) else {
            throw HBSiriError.missingTarget
        }
        return target
    }
}
nonisolated enum HBSiriPolicy {
    static func normalized(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_US_POSIX"))
            .split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }
    static func matching(_ query: String, in targets: [HBSiriTarget]) -> [HBSiriTarget] {
        let query = normalized(query)
        guard !query.isEmpty else { return targets }
        let exact = targets.filter { ([ $0.name ] + $0.aliases).contains { normalized($0) == query } }
        // Keep all matches for Siri disambiguation. Never pick an arbitrary first match.
        if !exact.isEmpty { return exact }
        return targets.filter { ([ $0.name ] + $0.aliases).contains { normalized($0).contains(query) } }
    }
    static func endpoint(baseURL: URL, path: String) throws -> URL {
        let appleHomeEndpoints: Set<String> = ["/api/apple-home/status", "/api/apple-home/configuration", "/api/apple-home/pairing", "/api/apple-home/sync"]
        guard (path.hasPrefix("/api/siri/") || appleHomeEndpoints.contains(path)),
              !path.contains(".."), !path.contains("?"), !path.contains("#"), !path.contains("%"), !path.contains("\\"),
              var parts = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
              ["http", "https"].contains(parts.scheme?.lowercased() ?? ""), parts.host != nil,
              parts.user == nil, parts.password == nil else { throw HBSiriError.signIn }
        parts.query = nil
        parts.fragment = nil
        parts.percentEncodedPath = parts.percentEncodedPath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        parts.percentEncodedPath = (parts.percentEncodedPath.isEmpty ? "" : "/" + parts.percentEncodedPath) + path
        guard let url = parts.url else { throw HBSiriError.signIn }
        return url
    }
    static func serverIdentity(_ baseURL: URL) -> String {
        guard var parts = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else { return baseURL.absoluteString }
        parts.scheme = parts.scheme?.lowercased()
        parts.host = parts.host?.lowercased()
        if (parts.scheme == "https" && parts.port == 443) || (parts.scheme == "http" && parts.port == 80) { parts.port = nil }
        parts.query = nil
        parts.fragment = nil
        parts.percentEncodedPath = parts.percentEncodedPath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if !parts.percentEncodedPath.isEmpty { parts.percentEncodedPath = "/" + parts.percentEncodedPath }
        return parts.string ?? baseURL.absoluteString
    }
    static func dialog(_ result: HBSiriCommandResult) throws -> String {
        guard result.success, ["running", "completed"].contains(result.state) else {
            throw HBSiriError.message(result.message)
        }
        return result.message
    }
}
