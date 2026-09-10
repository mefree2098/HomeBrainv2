import AppIntents
import Foundation

@MainActor
enum HomeBrainSiriRuntime {
    static let client = HBSiriClient(credentials: HomeBrainSiriCredentials(), clientType: clientType)
    private static var clientType: String {
        #if os(watchOS)
        return "watchos"
        #else
        return "ios"
        #endif
    }
    static func refreshSuggestions() {
        HomeBrainShortcuts.updateAppShortcutParameters()
    }
}

@MainActor
private struct HomeBrainSiriCredentials: HBSiriSessionProviding {
    func snapshot() async throws -> HBSiriSession {
        #if os(watchOS)
        return try HomeBrainWatchStore.shared.siriSession()
        #else
        let store = SessionStore.shared
        guard store.isAuthenticated, let url = store.normalizedServerURL else { throw HBSiriError.signIn }
        let context = store.sessionContextID
        let token = try await store.validAccessToken(contextID: context)
        return HBSiriSession(baseURL: url, accessToken: token, context: context)
        #endif
    }
    func refresh(_ previous: HBSiriSession) async throws -> HBSiriSession {
        try validate(previous)
        #if os(watchOS)
        try await HomeBrainWatchStore.shared.refreshSiriSession(previous.context)
        #else
        try await SessionStore.shared.refreshTokens(for: previous.context)
        #endif
        try validate(previous)
        return try await snapshot()
    }
    func validate(_ previous: HBSiriSession) throws {
        #if os(watchOS)
        let current = try HomeBrainWatchStore.shared.siriSession()
        guard previous.context == current.context,
              HBSiriPolicy.serverIdentity(previous.baseURL) == HBSiriPolicy.serverIdentity(current.baseURL) else {
            throw HBSiriError.changedHome
        }
        #else
        let store = SessionStore.shared
        guard store.isAuthenticated else { throw HBSiriError.signIn }
        guard previous.context == store.sessionContextID,
              store.normalizedServerURL.map(HBSiriPolicy.serverIdentity) == HBSiriPolicy.serverIdentity(previous.baseURL) else {
            throw HBSiriError.changedHome
        }
        #endif
    }
}
