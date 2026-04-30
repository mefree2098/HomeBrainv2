import Foundation
import WatchConnectivity

final class WatchCompanionSync: NSObject, WCSessionDelegate {
    private weak var store: HomeBrainWatchStore?
    private var pendingSessionRequest = false

    init(store: HomeBrainWatchStore) {
        self.store = store
        super.init()
    }

    func activate() {
        guard WCSession.isSupported() else {
            return
        }

        let session = WCSession.default
        session.delegate = self
        session.activate()

        if !session.receivedApplicationContext.isEmpty {
            handle(session.receivedApplicationContext)
        }
    }

    func requestSessionSync() {
        guard WCSession.isSupported() else {
            Task { @MainActor in
                store?.companionStatusMessage = "Apple Watch pairing is unavailable."
            }
            return
        }

        let session = WCSession.default
        guard session.activationState == .activated else {
            pendingSessionRequest = true
            Task { @MainActor in
                store?.companionStatusMessage = "Waiting for iPhone connection..."
            }
            return
        }

        let request: [String: Any] = [
            "type": "homebrain.watch.requestSession",
            "watchDeviceId": store?.deviceID ?? ""
        ]

        guard session.isReachable else {
            if !session.receivedApplicationContext.isEmpty {
                handle(session.receivedApplicationContext)
            } else {
                session.transferUserInfo(request)
                Task { @MainActor in
                    store?.companionStatusMessage = "Sync requested. Open HomeBrain on iPhone if it does not finish."
                }
            }
            return
        }

        session.sendMessage(request, replyHandler: { [weak self] reply in
            guard let message = reply["message"] as? String else { return }
            Task { @MainActor in
                self?.store?.companionStatusMessage = message
            }
        }, errorHandler: { [weak self] error in
            session.transferUserInfo(request)
            Task { @MainActor in
                print("Watch session request immediate delivery failed: \(error.localizedDescription)")
                self?.store?.companionStatusMessage = "Sync requested. Open HomeBrain on iPhone if it does not finish."
            }
        })
    }

    private func handle(_ payload: [String: Any]) {
        Task { @MainActor in
            store?.applyCompanionPayload(payload)
        }
    }

    func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        Task { @MainActor in
            if let error {
                store?.companionStatusMessage = error.localizedDescription
            } else if !session.receivedApplicationContext.isEmpty {
                store?.applyCompanionPayload(session.receivedApplicationContext)
            } else if pendingSessionRequest {
                pendingSessionRequest = false
                requestSessionSync()
            }
        }
    }

    func sessionReachabilityDidChange(_ session: WCSession) {
        guard session.isReachable else { return }
        requestSessionSync()
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        handle(applicationContext)
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        handle(message)
    }

    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        handle(userInfo)
    }
}
