import Foundation
import Combine
import UIKit

@MainActor
final class SessionStore: ObservableObject {
    @Published var serverURLString: String
    @Published var currentUser: AppUser?
    @Published var authError: String?
    @Published var isProcessingAuth = false

    @Published private(set) var accessToken: String?
    @Published private(set) var refreshToken: String?

    lazy var apiClient = APIClient(sessionStore: self)

    private var refreshTask: Task<Void, Error>?
    private var refreshTaskID: UUID?

    var isAuthenticated: Bool {
        accessToken != nil && currentUser?.hasHomeBrainAccess == true
    }

    private let defaults = UserDefaults.standard
    private let serverURLKey = "homebrain.serverURL"
    private let accessTokenKey = "homebrain.accessToken"
    private let refreshTokenKey = "homebrain.refreshToken"
    private let currentUserKey = "homebrain.currentUser"
    private let clientInstallationIdKey = "homebrain.clientInstallationId"
    private static let defaultServerURL = "http://homebrain.local:3000"
    private static let homeBrainAccessDeniedMessage = "This account does not have HomeBrain access."
    private static let accessTokenRefreshLeadTime: TimeInterval = 5 * 60

    private(set) lazy var clientInstallationId: String = {
        if let existing = defaults.string(forKey: clientInstallationIdKey),
           !existing.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return existing
        }

        let created = UUID().uuidString
        defaults.set(created, forKey: clientInstallationIdKey)
        return created
    }()

    init() {
        let storedServerURL = Self.normalizedServerURLString(from: defaults.string(forKey: serverURLKey))
        let legacyLocalURLs: Set<String> = [
            "http://127.0.0.1:3000",
            "http://localhost:3000",
            "https://127.0.0.1:3000",
            "https://localhost:3000"
        ]
        let resolvedServerURL: String
        if let storedServerURL, !storedServerURL.isEmpty, !legacyLocalURLs.contains(storedServerURL) {
            resolvedServerURL = storedServerURL
        } else {
            resolvedServerURL = Self.defaultServerURL
            defaults.set(resolvedServerURL, forKey: serverURLKey)
        }

        self.serverURLString = resolvedServerURL
        self.accessToken = defaults.string(forKey: accessTokenKey)
        self.refreshToken = defaults.string(forKey: refreshTokenKey)

        if let userData = defaults.data(forKey: currentUserKey),
           let decoded = try? JSONDecoder().decode(AppUser.self, from: userData) {
            self.currentUser = decoded
        } else {
            self.currentUser = nil
        }
    }

    func bootstrap() async {
        guard hasStoredSession else {
            return
        }

        if currentUser != nil && !accessTokenRequiresRefresh(accessToken) {
            return
        }

        do {
            try await ensureValidAccessToken()

            if currentUser != nil {
                return
            }

            let response = try await apiClient.get("/api/auth/me")
            let object = JSON.object(response)
            if let user = AppUser.from(object) {
                if user.hasHomeBrainAccess {
                    currentUser = user
                    persistCurrentUser(user)
                } else {
                    authError = Self.homeBrainAccessDeniedMessage
                    clearAuthData()
                }
            } else {
                clearAuthData()
            }
        } catch let apiError as APIError {
            if case .unauthorized = apiError {
                clearAuthData()
            } else {
                authError = apiError.localizedDescription
            }
        } catch {
            authError = error.localizedDescription
        }
    }

    var normalizedServerURL: URL? {
        Self.normalizedServerURL(from: serverURLString)
    }

    @discardableResult
    func updateServerURL(_ value: String) -> Bool {
        guard let normalized = Self.normalizedServerURLString(from: value) else {
            return false
        }

        serverURLString = normalized
        defaults.set(normalized, forKey: serverURLKey)
        return true
    }

    func login(email: String, password: String) async {
        isProcessingAuth = true
        authError = nil
        defer { isProcessingAuth = false }

        do {
            let payload: [String: Any] = ["email": email, "password": password]
            let response = try await apiClient.post("/api/auth/login", body: payload, authorized: false)
            try applyAuthPayload(JSON.object(response))
        } catch {
            authError = error.localizedDescription
        }
    }

    func register(email: String, password: String) async {
        isProcessingAuth = true
        authError = nil
        defer { isProcessingAuth = false }

        do {
            let payload: [String: Any] = ["email": email, "password": password]
            let response = try await apiClient.post("/api/auth/register", body: payload, authorized: false)
            let responseObject = JSON.object(response)

            if responseObject["accessToken"] != nil || JSON.object(responseObject["data"])["accessToken"] != nil {
                try applyAuthPayload(responseObject)
            } else {
                await login(email: email, password: password)
            }
        } catch {
            authError = error.localizedDescription
        }
    }

    func logout() {
        Task {
            let payload: [String: Any] = [
                "email": currentUser?.email ?? "",
                "refreshToken": refreshToken ?? ""
            ]
            _ = try? await apiClient.post("/api/auth/logout", body: payload, authorized: false)
            await MainActor.run {
                clearAuthData()
            }
        }
    }

    func refreshTokens() async throws {
        if let refreshTask {
            try await refreshTask.value
            return
        }

        let task = Task { @MainActor in
            try await self.performTokenRefresh()
        }
        let taskID = UUID()
        refreshTask = task
        refreshTaskID = taskID
        defer {
            if refreshTaskID == taskID {
                refreshTask = nil
                refreshTaskID = nil
            }
        }

        try await task.value
    }

    func expireAuthentication(message: String = APIError.unauthorized.localizedDescription) {
        authError = message
        isProcessingAuth = false
        clearAuthData()
    }

    func ensureValidAccessToken(forceRefresh: Bool = false) async throws {
        guard forceRefresh || accessTokenRequiresRefresh(accessToken) else {
            return
        }

        try await refreshTokens()
    }

    func validAccessToken() async throws -> String {
        try await ensureValidAccessToken()

        guard let accessToken = normalizedToken(accessToken) else {
            expireAuthentication()
            throw APIError.unauthorized
        }

        return accessToken
    }

    private func applyAuthPayload(_ rootObject: [String: Any]) throws {
        let dataObject = JSON.object(rootObject["data"])

        let resolvedAccessToken = JSON.optionalString(rootObject, "accessToken")
            ?? JSON.optionalString(dataObject, "accessToken")
        let resolvedRefreshToken = JSON.optionalString(rootObject, "refreshToken")
            ?? JSON.optionalString(dataObject, "refreshToken")

        guard let access = resolvedAccessToken, let refresh = resolvedRefreshToken else {
            throw APIError.server(statusCode: 400, message: "Authentication tokens are missing from server response.")
        }

        let user = AppUser.from(rootObject) ?? AppUser.from(dataObject)

        if let user, !user.hasHomeBrainAccess {
            clearAuthData()
            throw APIError.server(statusCode: 403, message: Self.homeBrainAccessDeniedMessage)
        }

        authError = nil
        accessToken = access
        self.refreshToken = refresh
        defaults.set(access, forKey: accessTokenKey)
        defaults.set(refresh, forKey: refreshTokenKey)

        if let user {
            currentUser = user
            persistCurrentUser(user)
        }
    }

    private func persistCurrentUser(_ user: AppUser) {
        if let encoded = try? JSONEncoder().encode(user) {
            defaults.set(encoded, forKey: currentUserKey)
        }
    }

    private func clearAuthData() {
        refreshTask?.cancel()
        refreshTask = nil
        refreshTaskID = nil
        accessToken = nil
        refreshToken = nil
        currentUser = nil
        defaults.removeObject(forKey: accessTokenKey)
        defaults.removeObject(forKey: refreshTokenKey)
        defaults.removeObject(forKey: currentUserKey)
    }

    private var hasStoredSession: Bool {
        normalizedToken(accessToken) != nil || normalizedToken(refreshToken) != nil
    }

    private func performTokenRefresh() async throws {
        guard let refreshToken = normalizedToken(refreshToken) else {
            expireAuthentication()
            throw APIError.unauthorized
        }

        let payload: [String: Any] = ["refreshToken": refreshToken]
        do {
            let response = try await apiClient.post("/api/auth/refresh", body: payload, authorized: false)
            try Task.checkCancellation()

            guard normalizedToken(self.refreshToken) == refreshToken else {
                throw CancellationError()
            }

            try applyAuthPayload(JSON.object(response))
        } catch let apiError as APIError {
            if case .unauthorized = apiError {
                expireAuthentication()
                throw APIError.unauthorized
            }
            if case .server(let statusCode, let message) = apiError,
               statusCode == 401 || statusCode == 403 {
                expireAuthentication(message: message)
                throw APIError.unauthorized
            }
            throw apiError
        }
    }

    private func accessTokenRequiresRefresh(_ token: String?) -> Bool {
        guard let normalizedToken = normalizedToken(token) else {
            return true
        }

        guard let expirationDate = tokenExpirationDate(from: normalizedToken) else {
            return false
        }

        return expirationDate.timeIntervalSinceNow <= Self.accessTokenRefreshLeadTime
    }

    private func normalizedToken(_ token: String?) -> String? {
        guard let trimmed = token?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else {
            return nil
        }

        return trimmed
    }

    private func tokenExpirationDate(from token: String) -> Date? {
        let segments = token.split(separator: ".")
        guard segments.count >= 2 else {
            return nil
        }

        var payload = String(segments[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = payload.count % 4
        if remainder != 0 {
            payload += String(repeating: "=", count: 4 - remainder)
        }

        guard let payloadData = Data(base64Encoded: payload),
              let payloadObject = try? JSONSerialization.jsonObject(with: payloadData, options: []) as? [String: Any],
              let expValue = payloadObject["exp"] as? NSNumber else {
            return nil
        }

        return Date(timeIntervalSince1970: expValue.doubleValue)
    }

    private static func normalizedServerURL(from rawValue: String?) -> URL? {
        guard let normalized = normalizedServerURLString(from: rawValue) else {
            return nil
        }

        return URL(string: normalized)
    }

    private static func normalizedServerURLString(from rawValue: String?) -> String? {
        guard let rawValue else {
            return nil
        }

        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return nil
        }

        let candidate: String
        if trimmed.contains("://") {
            candidate = trimmed
        } else {
            candidate = "\(defaultScheme(for: trimmed))://\(trimmed)"
        }

        guard var components = URLComponents(string: candidate),
              let scheme = components.scheme?.lowercased(),
              let host = components.host?.trimmingCharacters(in: .whitespacesAndNewlines),
              !host.isEmpty else {
            return nil
        }

        components.scheme = scheme
        components.host = host.lowercased()
        components.query = nil
        components.fragment = nil

        let trimmedPath = components.percentEncodedPath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components.percentEncodedPath = trimmedPath.isEmpty ? "" : "/\(trimmedPath)"

        return components.url?.absoluteString
    }

    private static func defaultScheme(for rawValue: String) -> String {
        prefersHTTP(for: rawValue) ? "http" : "https"
    }

    private static func prefersHTTP(for rawValue: String) -> Bool {
        guard let host = URLComponents(string: "http://\(rawValue)")?.host?.lowercased(),
              !host.isEmpty else {
            return false
        }

        if host == "localhost" || host == "::1" || host.hasSuffix(".local") || !host.contains(".") {
            return true
        }

        if host.hasPrefix("127.") || host.hasPrefix("10.") || host.hasPrefix("192.168.") {
            return true
        }

        let octets = host.split(separator: ".")
        if octets.count >= 2,
           octets[0] == "172",
           let second = Int(octets[1]),
           (16...31).contains(second) {
            return true
        }

        return false
    }

    var clientHeaders: [String: String] {
        var headers: [String: String] = [
            "X-HomeBrain-Client-Type": "ios",
            "X-HomeBrain-Client-Name": Self.deviceDisplayName(),
            "X-HomeBrain-Device-Id": clientInstallationId
        ]

        if let version = Self.appVersionString() {
            headers["X-HomeBrain-App-Version"] = version
        }

        return headers
    }

    private static func deviceDisplayName() -> String {
        let device = UIDevice.current
        let pieces = [
            device.name.trimmingCharacters(in: .whitespacesAndNewlines),
            device.model.trimmingCharacters(in: .whitespacesAndNewlines)
        ].filter { !$0.isEmpty }

        return pieces.isEmpty ? "iOS Device" : pieces.joined(separator: " • ")
    }

    private static func appVersionString() -> String? {
        let info = Bundle.main.infoDictionary
        let shortVersion = info?["CFBundleShortVersionString"] as? String
        let build = info?["CFBundleVersion"] as? String

        switch (shortVersion?.trimmingCharacters(in: .whitespacesAndNewlines), build?.trimmingCharacters(in: .whitespacesAndNewlines)) {
        case let (version?, build?) where !version.isEmpty && !build.isEmpty:
            return "\(version) (\(build))"
        case let (version?, _) where !version.isEmpty:
            return version
        case let (_, build?) where !build.isEmpty:
            return build
        default:
            return nil
        }
    }
}
