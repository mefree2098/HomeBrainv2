import Foundation
import Combine
import WatchConnectivity

@MainActor
final class WatchSyncManager: NSObject, ObservableObject {
    @Published private(set) var isSupported = WCSession.isSupported()
    @Published private(set) var activationState: WCSessionActivationState = .notActivated
    @Published private(set) var isPaired = false
    @Published private(set) var isWatchAppInstalled = false
    @Published private(set) var isReachable = false
    @Published private(set) var lastSyncDate: Date?
    @Published private(set) var lastErrorMessage: String?

    private weak var sessionStore: SessionStore?
    private var didActivate = false
    private var activationWaiters: [CheckedContinuation<Bool, Never>] = []

    func bind(sessionStore: SessionStore) {
        self.sessionStore = sessionStore
        activate()
    }

    func handleInstanceChange() {
        lastSyncDate = nil
        lastErrorMessage = nil
    }

    func activate() {
        guard WCSession.isSupported() else {
            isSupported = false
            finishActivationWaiters(false)
            return
        }

        let session = WCSession.default
        session.delegate = self
        activationState = session.activationState

        if session.activationState == .activated {
            updateState(from: session)
            finishActivationWaiters(true)
            return
        }

        resetWatchState()

        if !didActivate || session.activationState == .inactive {
            didActivate = true
            session.activate()
        }
    }

    @discardableResult
    func syncNow(watchDeviceId: String? = nil) async -> Bool {
        guard await ensureActivated() else {
            lastErrorMessage = "This iPhone does not support Apple Watch sync."
            return false
        }

        guard let sessionStore else {
            lastErrorMessage = "HomeBrain session is not ready yet."
            return false
        }

        do {
            let watchDeviceId = normalized(watchDeviceId) ?? "watch-\(sessionStore.clientInstallationId)"
            let response = try await sessionStore.apiClient.post(
                "/api/watch/session",
                body: [
                    "watchDeviceId": watchDeviceId,
                    "watchName": "Apple Watch"
                ]
            )
            let root = JSON.object(response)
            let tokens = JSON.object(root["tokens"])

            guard let accessToken = normalized(JSON.optionalString(tokens, "accessToken")),
                  let refreshToken = normalized(JSON.optionalString(tokens, "refreshToken")) else {
                lastErrorMessage = "HomeBrain did not return Apple Watch session tokens."
                return false
            }

            let payload: [String: Any] = [
                "type": "homebrain.session",
                "instanceID": sessionStore.activeInstanceID ?? "",
                "instanceName": sessionStore.activeInstance?.displayName ?? "HomeBrain",
                "serverURL": sessionStore.serverURLString,
                "accessToken": accessToken,
                "refreshToken": refreshToken,
                "watchDeviceId": watchDeviceId,
                "email": sessionStore.currentUser?.email ?? "",
                "name": sessionStore.currentUser?.name ?? "",
                "sentAt": Date()
            ]

            let session = WCSession.default
            try session.updateApplicationContext(payload)
            session.transferUserInfo(payload)
            if session.isReachable {
                session.sendMessage(payload, replyHandler: nil) { error in
                    Task { @MainActor in
                        print("Watch session immediate delivery failed: \(error.localizedDescription)")
                    }
                }
            }

            updateState(from: session)
            lastSyncDate = Date()
            lastErrorMessage = nil
            return true
        } catch {
            lastErrorMessage = error.localizedDescription
            return false
        }
    }

    func clearWatchSession() {
        guard WCSession.isSupported() else {
            return
        }

        Task { @MainActor in
            guard await ensureActivated() else {
                return
            }

            sendClearWatchSessionPayload()
        }
    }

    private func sendClearWatchSessionPayload() {
        let payload: [String: Any] = [
            "type": "homebrain.session.clear",
            "sentAt": Date()
        ]

        let session = WCSession.default
        try? session.updateApplicationContext(payload)
        session.transferUserInfo(payload)
        if session.isReachable {
            session.sendMessage(payload, replyHandler: nil) { error in
                Task { @MainActor in
                    print("Watch session clear immediate delivery failed: \(error.localizedDescription)")
                }
            }
        }
        lastSyncDate = Date()
    }

    private func handleWatchMessage(_ message: [String: Any], replyHandler: (([String: Any]) -> Void)? = nil) {
        guard (message["type"] as? String) == "homebrain.watch.requestSession" else {
            replyHandler?(["ok": false, "message": "Unknown watch message"])
            return
        }

        Task { @MainActor in
            let ok = await syncNow(watchDeviceId: message["watchDeviceId"] as? String)
            replyHandler?([
                "ok": ok,
                "message": lastErrorMessage ?? (ok ? "HomeBrain session sent." : "Unable to send HomeBrain session.")
            ])
        }
    }

    private func updateState(from session: WCSession) {
        activationState = session.activationState
        guard session.activationState == .activated else {
            resetWatchState()
            return
        }

        isPaired = session.isPaired
        isWatchAppInstalled = session.isWatchAppInstalled
        isReachable = session.isReachable
    }

    private func resetWatchState() {
        isPaired = false
        isWatchAppInstalled = false
        isReachable = false
    }

    private func ensureActivated() async -> Bool {
        guard WCSession.isSupported() else {
            isSupported = false
            return false
        }

        let session = WCSession.default
        session.delegate = self

        if session.activationState == .activated {
            updateState(from: session)
            return true
        }

        return await withCheckedContinuation { continuation in
            activationWaiters.append(continuation)
            activate()
        }
    }

    private func finishActivationWaiters(_ success: Bool) {
        guard !activationWaiters.isEmpty else {
            return
        }

        let waiters = activationWaiters
        activationWaiters.removeAll()
        waiters.forEach { $0.resume(returning: success) }
    }

    private func normalized(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}

extension WatchSyncManager: WCSessionDelegate {
    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        Task { @MainActor in
            if error != nil {
                didActivate = false
            }
            updateState(from: session)
            lastErrorMessage = error?.localizedDescription
            finishActivationWaiters(activationState == .activated && error == nil)
        }
    }

    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {
        Task { @MainActor in
            updateState(from: session)
        }
    }

    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        Task { @MainActor in
            didActivate = false
            session.activate()
            didActivate = true
            updateState(from: session)
        }
    }

    nonisolated func sessionWatchStateDidChange(_ session: WCSession) {
        Task { @MainActor in
            updateState(from: session)
        }
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        Task { @MainActor in
            updateState(from: session)
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        Task { @MainActor in
            handleWatchMessage(message)
            updateState(from: session)
        }
    }

    nonisolated func session(
        _ session: WCSession,
        didReceiveMessage message: [String: Any],
        replyHandler: @escaping ([String: Any]) -> Void
    ) {
        Task { @MainActor in
            handleWatchMessage(message, replyHandler: replyHandler)
            updateState(from: session)
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        Task { @MainActor in
            handleWatchMessage(userInfo)
            updateState(from: session)
        }
    }
}
