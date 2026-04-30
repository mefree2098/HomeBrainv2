import Foundation
import WatchConnectivity

final class WatchCompanionSync: NSObject, WCSessionDelegate {
    private weak var store: HomeBrainWatchStore?

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
            Task { @MainActor in
                store?.companionStatusMessage = "Waiting for iPhone connection..."
            }
            return
        }

        guard session.isReachable else {
            if !session.receivedApplicationContext.isEmpty {
                handle(session.receivedApplicationContext)
            } else {
                Task { @MainActor in
                    store?.companionStatusMessage = "Open HomeBrain on iPhone, then try again."
                }
            }
            return
        }

        session.sendMessage([
            "type": "homebrain.watch.requestSession",
            "watchDeviceId": store?.deviceID ?? ""
        ], replyHandler: { [weak self] reply in
            guard let message = reply["message"] as? String else { return }
            Task { @MainActor in
                self?.store?.companionStatusMessage = message
            }
        }, errorHandler: { [weak self] error in
            Task { @MainActor in
                self?.store?.companionStatusMessage = error.localizedDescription
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
}
