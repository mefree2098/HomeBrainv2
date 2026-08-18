import Foundation
import Combine
import UIKit

enum BackendConnectionState: Equatable {
    case online
    case reconnecting
    case offline
}

@MainActor
final class SessionStore: ObservableObject {
    @Published private(set) var serverURLString = ""
    @Published var currentUser: AppUser?
    @Published var authError: String?
    @Published var isProcessingAuth = false

    @Published private(set) var accessToken: String?
    @Published private(set) var refreshToken: String?
    @Published private(set) var savedInstances: [HomeBrainInstance] = []
    @Published private(set) var activeInstanceID: String?
    @Published private(set) var sessionContextID = UUID()
    @Published private(set) var isAddingInstance = false
    @Published private(set) var backendConnectionState: BackendConnectionState = .online
    @Published private(set) var backendRecoveryGeneration = 0
    @Published private(set) var backendLastRecoveredAt: Date?

    lazy var apiClient = APIClient(sessionStore: self)

    private var refreshTask: Task<Void, Error>?
    private var refreshTaskID: UUID?
    private var backendRecoveryTask: Task<Void, Never>?
    private var backendRecoveryTaskID: UUID?
    private var instanceToRestoreAfterAdding: String?

    var isAuthenticated: Bool {
        accessToken != nil && currentUser?.hasHomeBrainAccess == true
    }

    /// Opaque, process-local identity for restarting credential-bound tasks
    /// without embedding the bearer token in SwiftUI task identifiers.
    var credentialTaskIdentity: Int {
        accessToken?.hashValue ?? 0
    }

    var activeInstance: HomeBrainInstance? {
        guard let activeInstanceID else { return nil }
        return savedInstances.first { $0.id == activeInstanceID }
    }

    private let defaults = UserDefaults.standard
    private let serverURLKey = "homebrain.serverURL"
    private static let legacyAccessTokenKey = "homebrain.accessToken"
    private static let legacyRefreshTokenKey = "homebrain.refreshToken"
    private static let accessTokenAccount = "accessToken"
    private static let refreshTokenAccount = "refreshToken"
    private let currentUserKey = "homebrain.currentUser"
    private let instancesKey = "homebrain.instances.v1"
    private let activeInstanceIDKey = "homebrain.activeInstanceID"
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

        var legacyKeychainAccessToken = KeychainStore.read(account: Self.accessTokenAccount)
        var legacyKeychainRefreshToken = KeychainStore.read(account: Self.refreshTokenAccount)
        let legacyAccessToken = defaults.string(forKey: Self.legacyAccessTokenKey)
        let legacyRefreshToken = defaults.string(forKey: Self.legacyRefreshTokenKey)

        do {
            if legacyKeychainAccessToken == nil, let legacyAccessToken, !legacyAccessToken.isEmpty {
                try KeychainStore.save(legacyAccessToken, account: Self.accessTokenAccount)
                legacyKeychainAccessToken = legacyAccessToken
            }
            if legacyKeychainRefreshToken == nil, let legacyRefreshToken, !legacyRefreshToken.isEmpty {
                try KeychainStore.save(legacyRefreshToken, account: Self.refreshTokenAccount)
                legacyKeychainRefreshToken = legacyRefreshToken
            }
        } catch {
            KeychainStore.delete(account: Self.accessTokenAccount)
            KeychainStore.delete(account: Self.refreshTokenAccount)
            legacyKeychainAccessToken = nil
            legacyKeychainRefreshToken = nil
        }
        defaults.removeObject(forKey: Self.legacyAccessTokenKey)
        defaults.removeObject(forKey: Self.legacyRefreshTokenKey)

        if let data = defaults.data(forKey: instancesKey),
           let decoded = try? JSONDecoder().decode([HomeBrainInstance].self, from: data) {
            savedInstances = decoded.sorted { $0.lastUsedAt > $1.lastUsedAt }
        }

        if savedInstances.isEmpty,
           let userData = defaults.data(forKey: currentUserKey),
           let legacyUser = try? JSONDecoder().decode(AppUser.self, from: userData),
           legacyKeychainAccessToken != nil || legacyKeychainRefreshToken != nil {
            let migratedID = UUID().uuidString
            let migratedInstance = HomeBrainInstance(
                id: migratedID,
                serverURL: resolvedServerURL,
                user: legacyUser,
                addedAt: Date(),
                lastUsedAt: Date()
            )

            do {
                if let legacyKeychainAccessToken {
                    try KeychainStore.save(legacyKeychainAccessToken, account: Self.accessTokenAccount(for: migratedID))
                }
                if let legacyKeychainRefreshToken {
                    try KeychainStore.save(legacyKeychainRefreshToken, account: Self.refreshTokenAccount(for: migratedID))
                }
                savedInstances = [migratedInstance]
                persistInstances()
                defaults.set(migratedID, forKey: activeInstanceIDKey)
            } catch {
                KeychainStore.delete(account: Self.accessTokenAccount(for: migratedID))
                KeychainStore.delete(account: Self.refreshTokenAccount(for: migratedID))
                savedInstances = []
            }
        }

        KeychainStore.delete(account: Self.accessTokenAccount)
        KeychainStore.delete(account: Self.refreshTokenAccount)
        defaults.removeObject(forKey: currentUserKey)

        let preferredInstanceID = defaults.string(forKey: activeInstanceIDKey)
        let resolvedInstanceID = savedInstances.contains(where: { $0.id == preferredInstanceID })
            ? preferredInstanceID
            : savedInstances.first?.id

        if let resolvedInstanceID {
            activateInstance(resolvedInstanceID, updateLastUsedAt: false)
        } else {
            serverURLString = resolvedServerURL
            defaults.set(resolvedServerURL, forKey: serverURLKey)
        }
    }

    func bootstrap() async {
        let contextID = sessionContextID
        guard hasStoredSession else {
            return
        }

        if currentUser != nil && !accessTokenRequiresRefresh(accessToken) {
            authError = nil
            return
        }

        do {
            try await ensureValidAccessToken(contextID: contextID)
            try assertActiveContext(contextID)

            if currentUser != nil {
                authError = nil
                return
            }

            let response = try await apiClient.get("/api/auth/me")
            try assertActiveContext(contextID)
            let object = JSON.object(response)
            if let user = AppUser.from(object) {
                if user.hasHomeBrainAccess {
                    authError = nil
                    currentUser = user
                    persistCurrentUser(user)
                } else {
                    authError = Self.homeBrainAccessDeniedMessage
                    clearAuthData()
                }
            } else {
                clearAuthData()
            }
        } catch is CancellationError {
            return
        } catch let apiError as APIError {
            guard contextID == sessionContextID else { return }
            if case .unauthorized = apiError {
                clearAuthData()
            } else {
                authError = apiError.localizedDescription
            }
        } catch {
            guard contextID == sessionContextID else { return }
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

        if let activeInstance, currentUser != nil, normalized != activeInstance.serverURL {
            authError = "To connect to a different platform, add it as another HomeBrain."
            return false
        }

        let endpointChanged = serverURLString != normalized
        serverURLString = normalized
        defaults.set(normalized, forKey: serverURLKey)
        if endpointChanged {
            refreshTask?.cancel()
            refreshTask = nil
            refreshTaskID = nil
            sessionContextID = UUID()
        }
        resetBackendConnectionState()
        return true
    }

    func beginAddingInstance() {
        guard !isAddingInstance else { return }
        unregisterPushForActiveInstanceBestEffort()
        instanceToRestoreAfterAdding = activeInstanceID
        isAddingInstance = true
        deactivateRuntimeSession(serverURL: "")
    }

    func cancelAddingInstance() {
        guard isAddingInstance else { return }
        let restoreID = instanceToRestoreAfterAdding
        isAddingInstance = false
        instanceToRestoreAfterAdding = nil

        if let restoreID, savedInstances.contains(where: { $0.id == restoreID }) {
            activateInstance(restoreID)
        } else if let fallbackID = savedInstances.first?.id {
            activateInstance(fallbackID)
        } else {
            deactivateRuntimeSession(serverURL: Self.defaultServerURL)
        }
    }

    func switchInstance(to instanceID: String) {
        guard instanceID != activeInstanceID || !isAuthenticated,
              savedInstances.contains(where: { $0.id == instanceID }) else {
            return
        }

        unregisterPushForActiveInstanceBestEffort()
        isAddingInstance = false
        instanceToRestoreAfterAdding = nil
        activateInstance(instanceID)
        Task { await bootstrap() }
    }

    func removeInstance(_ instanceID: String) {
        guard let instance = savedInstances.first(where: { $0.id == instanceID }) else {
            return
        }

        let storedRefreshToken = KeychainStore.read(account: Self.refreshTokenAccount(for: instanceID))
        let storedAccessToken = KeychainStore.read(account: Self.accessTokenAccount(for: instanceID))
        revokeSessionBestEffort(instance: instance, refreshToken: storedRefreshToken)
        unregisterPushBestEffort(instance: instance, accessToken: storedAccessToken)

        KeychainStore.delete(account: Self.accessTokenAccount(for: instanceID))
        KeychainStore.delete(account: Self.refreshTokenAccount(for: instanceID))
        savedInstances.removeAll { $0.id == instanceID }
        persistInstances()

        guard activeInstanceID == instanceID else { return }

        if let fallbackID = savedInstances.first?.id {
            activateInstance(fallbackID)
            Task { await bootstrap() }
        } else {
            defaults.removeObject(forKey: activeInstanceIDKey)
            deactivateRuntimeSession(serverURL: Self.defaultServerURL)
        }
    }

    func login(email: String, password: String) async {
        let contextID = sessionContextID
        isProcessingAuth = true
        authError = nil
        defer { isProcessingAuth = false }

        do {
            let payload: [String: Any] = ["email": email, "password": password]
            let response = try await apiClient.post("/api/auth/login", body: payload, authorized: false)
            try assertActiveContext(contextID)
            try applyAuthPayload(JSON.object(response))
        } catch is CancellationError {
            return
        } catch {
            guard contextID == sessionContextID else { return }
            authError = error.localizedDescription
        }
    }

    func registerFirstOwner(email: String, password: String) async {
        let contextID = sessionContextID
        isProcessingAuth = true
        authError = nil
        defer { isProcessingAuth = false }

        do {
            let payload: [String: Any] = ["email": email, "password": password]
            let response = try await apiClient.post("/api/auth/register", body: payload, authorized: false)
            try assertActiveContext(contextID)
            try applyAuthPayload(JSON.object(response))
        } catch is CancellationError {
            return
        } catch {
            guard contextID == sessionContextID else { return }
            authError = error.localizedDescription
        }
    }

    func logout() {
        guard let activeInstanceID else {
            clearAuthData()
            return
        }
        removeInstance(activeInstanceID)
    }

    @discardableResult
    func deleteAccount(password: String) async -> Bool {
        isProcessingAuth = true
        authError = nil
        defer { isProcessingAuth = false }

        do {
            _ = try await apiClient.delete(
                "/api/auth/account",
                body: ["password": password]
            )
            authError = nil
            if let activeInstanceID {
                removeInstanceLocally(activeInstanceID)
            } else {
                clearAuthData()
            }
            return true
        } catch {
            authError = error.localizedDescription
            return false
        }
    }

    func refreshTokens(for contextID: UUID? = nil) async throws {
        if let contextID {
            try assertActiveContext(contextID)
        }

        if let refreshTask {
            try await refreshTask.value
            if let contextID {
                try assertActiveContext(contextID)
            }
            return
        }

        let refreshContextID = sessionContextID
        let task = Task { @MainActor in
            try await self.performTokenRefresh(contextID: refreshContextID)
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
        if let contextID {
            try assertActiveContext(contextID)
        }
    }

    func expireAuthentication(message: String = APIError.unauthorized.localizedDescription) {
        authError = message
        isProcessingAuth = false
        clearAuthData()
    }

    func ensureValidAccessToken(forceRefresh: Bool = false, contextID: UUID? = nil) async throws {
        if let contextID {
            try assertActiveContext(contextID)
        }
        guard forceRefresh || accessTokenRequiresRefresh(accessToken) else {
            return
        }

        try await refreshTokens(for: contextID)
    }

    func validAccessToken(contextID: UUID? = nil) async throws -> String {
        try await ensureValidAccessToken(contextID: contextID)

        if let contextID {
            try assertActiveContext(contextID)
        }

        guard let accessToken = normalizedToken(accessToken) else {
            expireAuthentication()
            throw APIError.unauthorized
        }

        return accessToken
    }

    func assertActiveContext(_ contextID: UUID) throws {
        guard contextID == sessionContextID else {
            throw CancellationError()
        }
    }

    func reportBackendRequestSucceeded() {
        markBackendOnline()
    }

    func reportTransientBackendFailure(_ error: Error, path: String? = nil) {
        if backendConnectionState == .online {
            backendConnectionState = .reconnecting
        }

        startBackendRecoveryMonitor()
    }

    func resumeBackendRecoveryIfNeeded() async {
        guard backendConnectionState != .online else {
            return
        }

        let contextID = sessionContextID

        do {
            try await pingBackend()
            guard contextID == sessionContextID else { return }
            markBackendOnline()
        } catch {
            guard contextID == sessionContextID else { return }
            reportTransientBackendFailure(error)
        }
    }

    private func applyAuthPayload(_ rootObject: [String: Any], establishesInstance: Bool = true) throws {
        let dataObject = JSON.object(rootObject["data"])

        let resolvedAccessToken = JSON.optionalString(rootObject, "accessToken")
            ?? JSON.optionalString(dataObject, "accessToken")
        let resolvedRefreshToken = JSON.optionalString(rootObject, "refreshToken")
            ?? JSON.optionalString(dataObject, "refreshToken")

        guard let access = resolvedAccessToken, let refresh = resolvedRefreshToken else {
            throw APIError.server(statusCode: 400, message: "Authentication tokens are missing from server response.")
        }

        guard let user = AppUser.from(rootObject) ?? AppUser.from(dataObject) ?? currentUser else {
            throw APIError.server(statusCode: 400, message: "Account details are missing from the server response.")
        }

        if !user.hasHomeBrainAccess {
            clearAuthData()
            throw APIError.server(statusCode: 403, message: Self.homeBrainAccessDeniedMessage)
        }

        guard let normalizedServerURL = Self.normalizedServerURLString(from: serverURLString) else {
            throw APIError.invalidURL
        }

        let instanceID: String
        if !establishesInstance, let activeInstanceID {
            instanceID = activeInstanceID
        } else {
            let existingInstance = savedInstances.first {
                $0.serverURL == normalizedServerURL
                    && $0.user.email.caseInsensitiveCompare(user.email) == .orderedSame
            }
            instanceID = existingInstance?.id ?? UUID().uuidString
        }

        do {
            try KeychainStore.save(refresh, account: Self.refreshTokenAccount(for: instanceID))
            try KeychainStore.save(access, account: Self.accessTokenAccount(for: instanceID))
        } catch {
            KeychainStore.delete(account: Self.accessTokenAccount(for: instanceID))
            KeychainStore.delete(account: Self.refreshTokenAccount(for: instanceID))
            throw error
        }

        authError = nil
        accessToken = access
        self.refreshToken = refresh
        currentUser = user
        activeInstanceID = instanceID
        if establishesInstance {
            isAddingInstance = false
            instanceToRestoreAfterAdding = nil
        }

        let now = Date()
        if let index = savedInstances.firstIndex(where: { $0.id == instanceID }) {
            savedInstances[index].user = user
            if establishesInstance {
                savedInstances[index].lastUsedAt = now
            }
        } else {
            savedInstances.append(
                HomeBrainInstance(
                    id: instanceID,
                    serverURL: normalizedServerURL,
                    user: user,
                    addedAt: now,
                    lastUsedAt: now
                )
            )
        }
        savedInstances.sort { $0.lastUsedAt > $1.lastUsedAt }
        persistInstances()
        defaults.set(instanceID, forKey: activeInstanceIDKey)
        defaults.set(normalizedServerURL, forKey: serverURLKey)
        if establishesInstance {
            sessionContextID = UUID()
        }
        resetBackendConnectionState()
    }

    private func persistCurrentUser(_ user: AppUser) {
        guard let activeInstanceID,
              let index = savedInstances.firstIndex(where: { $0.id == activeInstanceID }) else {
            return
        }

        savedInstances[index].user = user
        persistInstances()
    }

    private func clearAuthData() {
        refreshTask?.cancel()
        refreshTask = nil
        refreshTaskID = nil
        if let activeInstanceID {
            KeychainStore.delete(account: Self.accessTokenAccount(for: activeInstanceID))
            KeychainStore.delete(account: Self.refreshTokenAccount(for: activeInstanceID))
        }
        accessToken = nil
        refreshToken = nil
        currentUser = nil
        defaults.removeObject(forKey: Self.legacyAccessTokenKey)
        defaults.removeObject(forKey: Self.legacyRefreshTokenKey)
        defaults.removeObject(forKey: currentUserKey)
        sessionContextID = UUID()
        resetBackendConnectionState()
    }

    private func activateInstance(_ instanceID: String, updateLastUsedAt: Bool = true) {
        guard let index = savedInstances.firstIndex(where: { $0.id == instanceID }) else {
            return
        }

        refreshTask?.cancel()
        refreshTask = nil
        refreshTaskID = nil
        let instance = savedInstances[index]
        activeInstanceID = instanceID
        serverURLString = instance.serverURL
        currentUser = instance.user
        accessToken = KeychainStore.read(account: Self.accessTokenAccount(for: instanceID))
        refreshToken = KeychainStore.read(account: Self.refreshTokenAccount(for: instanceID))
        authError = nil

        if updateLastUsedAt {
            savedInstances[index].lastUsedAt = Date()
            savedInstances.sort { $0.lastUsedAt > $1.lastUsedAt }
            persistInstances()
        }

        defaults.set(instanceID, forKey: activeInstanceIDKey)
        defaults.set(instance.serverURL, forKey: serverURLKey)
        sessionContextID = UUID()
        resetBackendConnectionState()
    }

    private func deactivateRuntimeSession(serverURL: String) {
        refreshTask?.cancel()
        refreshTask = nil
        refreshTaskID = nil
        activeInstanceID = nil
        serverURLString = serverURL
        accessToken = nil
        refreshToken = nil
        currentUser = nil
        authError = nil
        isProcessingAuth = false
        sessionContextID = UUID()
        resetBackendConnectionState()
    }

    private func removeInstanceLocally(_ instanceID: String) {
        KeychainStore.delete(account: Self.accessTokenAccount(for: instanceID))
        KeychainStore.delete(account: Self.refreshTokenAccount(for: instanceID))
        savedInstances.removeAll { $0.id == instanceID }
        persistInstances()

        if let fallbackID = savedInstances.first?.id {
            activateInstance(fallbackID)
            Task { await bootstrap() }
        } else {
            defaults.removeObject(forKey: activeInstanceIDKey)
            deactivateRuntimeSession(serverURL: Self.defaultServerURL)
        }
    }

    private func persistInstances() {
        guard let encoded = try? JSONEncoder().encode(savedInstances) else { return }
        defaults.set(encoded, forKey: instancesKey)
    }

    private static func accessTokenAccount(for instanceID: String) -> String {
        "instance.\(instanceID).accessToken"
    }

    private static func refreshTokenAccount(for instanceID: String) -> String {
        "instance.\(instanceID).refreshToken"
    }

    private func revokeSessionBestEffort(instance: HomeBrainInstance, refreshToken: String?) {
        guard let refreshToken = normalizedToken(refreshToken),
              let url = instanceURL(instance, path: "/api/auth/logout") else {
            return
        }

        let payload: [String: Any] = [
            "email": instance.user.email,
            "refreshToken": refreshToken
        ]
        guard let body = try? JSONSerialization.data(withJSONObject: payload) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 5
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        for (header, value) in clientHeaders {
            request.setValue(value, forHTTPHeaderField: header)
        }

        Task {
            _ = try? await URLSession.shared.data(for: request)
        }
    }

    private func unregisterPushForActiveInstanceBestEffort() {
        guard let activeInstance, let activeInstanceID else { return }
        let storedAccessToken = KeychainStore.read(account: Self.accessTokenAccount(for: activeInstanceID))
        unregisterPushBestEffort(instance: activeInstance, accessToken: storedAccessToken)
    }

    private func unregisterPushBestEffort(instance: HomeBrainInstance, accessToken: String?) {
        guard let accessToken = normalizedToken(accessToken) else { return }
        let encodedInstallationID = clientInstallationId
            .addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? clientInstallationId
        guard let url = instanceURL(
            instance,
            path: "/api/notifications/push/devices/\(encodedInstallationID)"
        ) else {
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        request.timeoutInterval = 5
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        for (header, value) in clientHeaders {
            request.setValue(value, forHTTPHeaderField: header)
        }

        Task {
            _ = try? await URLSession.shared.data(for: request)
        }
    }

    private func instanceURL(_ instance: HomeBrainInstance, path: String) -> URL? {
        guard let baseURL = URL(string: instance.serverURL),
              var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            return nil
        }

        let basePath = components.percentEncodedPath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let requestPath = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let joinedPath = [basePath, requestPath].filter { !$0.isEmpty }.joined(separator: "/")
        components.percentEncodedPath = joinedPath.isEmpty ? "" : "/\(joinedPath)"
        components.queryItems = nil
        return components.url
    }

    private func resetBackendConnectionState() {
        backendRecoveryTask?.cancel()
        backendRecoveryTask = nil
        backendRecoveryTaskID = nil
        backendConnectionState = .online
    }

    private func startBackendRecoveryMonitor() {
        guard backendRecoveryTask == nil else {
            return
        }

        let taskID = UUID()
        let contextID = sessionContextID
        backendRecoveryTaskID = taskID
        backendRecoveryTask = Task { [weak self] in
            await self?.runBackendRecoveryMonitor(contextID: contextID, taskID: taskID)
        }
    }

    private func runBackendRecoveryMonitor(contextID: UUID, taskID: UUID) async {
        var attempt = 0
        defer {
            finishBackendRecoveryTask(taskID)
        }

        while !Task.isCancelled {
            guard contextID == sessionContextID else { return }
            if backendConnectionState == .online {
                finishBackendRecoveryTask(taskID)
                return
            }

            do {
                try await pingBackend()
                guard contextID == sessionContextID else { return }
                // Recovery observers retry immediately. Release this slot first so a
                // still-warming API can register a fresh monitor without getting stuck.
                finishBackendRecoveryTask(taskID)
                markBackendOnline()
                return
            } catch {
                guard contextID == sessionContextID else { return }
                guard backendConnectionState != .online else {
                    finishBackendRecoveryTask(taskID)
                    return
                }

                attempt += 1
                backendConnectionState = attempt >= 3 ? .offline : .reconnecting

                let delay = min(15.0, Double(attempt) * 2.0)
                try? await Task.sleep(for: .seconds(delay))
            }
        }
    }

    private func finishBackendRecoveryTask(_ taskID: UUID) {
        guard backendRecoveryTaskID == taskID else {
            return
        }

        backendRecoveryTask = nil
        backendRecoveryTaskID = nil
    }

    private func markBackendOnline() {
        let wasUnavailable = backendConnectionState != .online
        backendConnectionState = .online

        if wasUnavailable {
            backendLastRecoveredAt = Date()
            backendRecoveryGeneration += 1
        }
    }

    private func pingBackend() async throws {
        guard let url = buildBackendURL(path: "/ping") else {
            throw APIError.invalidURL
        }

        var request = URLRequest(url: url)
        request.timeoutInterval = 4
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        request.setValue("no-cache", forHTTPHeaderField: "Pragma")

        let (_, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              (200..<300).contains(httpResponse.statusCode) else {
            throw APIError.invalidResponse
        }
    }

    private func buildBackendURL(path: String) -> URL? {
        guard var components = normalizedServerURL.flatMap({
            URLComponents(url: $0, resolvingAgainstBaseURL: false)
        }) else {
            return nil
        }

        let basePath = components.percentEncodedPath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let normalizedPath = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let pathComponents = [basePath, normalizedPath].filter { !$0.isEmpty }
        components.percentEncodedPath = pathComponents.isEmpty ? "" : "/\(pathComponents.joined(separator: "/"))"
        components.queryItems = nil

        return components.url
    }

    private var hasStoredSession: Bool {
        normalizedToken(accessToken) != nil || normalizedToken(refreshToken) != nil
    }

    private func performTokenRefresh(contextID: UUID) async throws {
        try assertActiveContext(contextID)
        guard let refreshToken = normalizedToken(refreshToken) else {
            expireAuthentication()
            throw APIError.unauthorized
        }

        let payload: [String: Any] = ["refreshToken": refreshToken]
        do {
            let response = try await apiClient.post("/api/auth/refresh", body: payload, authorized: false)
            try Task.checkCancellation()
            try assertActiveContext(contextID)

            guard normalizedToken(self.refreshToken) == refreshToken else {
                throw CancellationError()
            }

            try applyAuthPayload(JSON.object(response), establishesInstance: false)
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
        guard !trimmed.isEmpty, trimmed.count <= 2_048 else {
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
              !host.isEmpty,
              ["http", "https"].contains(scheme),
              components.user == nil,
              components.password == nil,
              components.port.map({ (1...65_535).contains($0) }) ?? true,
              scheme != "http" || isLocalNetworkHost(host) else {
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

        return isLocalNetworkHost(host)
    }

    private static func isLocalNetworkHost(_ rawHost: String) -> Bool {
        let host = rawHost.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

        if host == "localhost" || host == "::1" || host.hasSuffix(".local") || !host.contains(".") {
            return true
        }

        if host.hasPrefix("fc") || host.hasPrefix("fd") || host.hasPrefix("fe80:") {
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
