import Foundation
import Combine

@MainActor
final class SessionStore: ObservableObject {
    @Published var serverURLString: String
    @Published var currentUser: AppUser?
    @Published var authError: String?
    @Published var isProcessingAuth = false

    @Published private(set) var accessToken: String?
    @Published private(set) var refreshToken: String?

    lazy var apiClient = APIClient(sessionStore: self)

    var isAuthenticated: Bool {
        accessToken != nil && currentUser != nil
    }

    private let defaults = UserDefaults.standard
    private let serverURLKey = "homebrain.serverURL"
    private let accessTokenKey = "homebrain.accessToken"
    private let refreshTokenKey = "homebrain.refreshToken"
    private let currentUserKey = "homebrain.currentUser"
    private static let defaultServerURL = "https://freestonefamily.com"

    init() {
        let storedServerURL = defaults.string(forKey: serverURLKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
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
        guard accessToken != nil else {
            return
        }

        if currentUser != nil {
            return
        }

        do {
            let response = try await apiClient.get("/api/auth/me")
            let object = JSON.object(response)
            if let user = AppUser.from(object) {
                currentUser = user
                persistCurrentUser(user)
            } else {
                clearAuthData()
            }
        } catch {
            clearAuthData()
        }
    }

    func updateServerURL(_ value: String) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        serverURLString = trimmed
        defaults.set(trimmed, forKey: serverURLKey)
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
            _ = try? await apiClient.post("/api/auth/logout", body: ["email": currentUser?.email ?? ""])
            await MainActor.run {
                clearAuthData()
            }
        }
    }

    func refreshTokens() async throws {
        guard let refreshToken else {
            expireAuthentication()
            throw APIError.unauthorized
        }

        let payload: [String: Any] = ["refreshToken": refreshToken]
        do {
            let response = try await apiClient.post("/api/auth/refresh", body: payload, authorized: false)
            try applyAuthPayload(JSON.object(response))
        } catch let apiError as APIError {
            if case .unauthorized = apiError {
                expireAuthentication()
                throw APIError.unauthorized
            }
            throw apiError
        }
    }

    func expireAuthentication(message: String = APIError.unauthorized.localizedDescription) {
        authError = message
        isProcessingAuth = false
        clearAuthData()
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
        accessToken = nil
        refreshToken = nil
        currentUser = nil
        defaults.removeObject(forKey: accessTokenKey)
        defaults.removeObject(forKey: refreshTokenKey)
        defaults.removeObject(forKey: currentUserKey)
    }
}
