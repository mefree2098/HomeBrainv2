import Foundation
import Combine
import WatchKit
import UserNotifications

@MainActor
final class WatchPushNotificationManager: NSObject, ObservableObject, WKApplicationDelegate {
    @Published private(set) var authorizationStatus: UNAuthorizationStatus = .notDetermined
    @Published private(set) var lastRegistrationError: String?
    @Published private(set) var lastRegisteredAt: Date?

    private weak var store: HomeBrainWatchStore?
    private var pendingDeviceToken: Data?

    func bind(store: HomeBrainWatchStore) {
        self.store = store
    }

    func configureForAuthenticationState() async {
        await refreshAuthorizationStatus()

        guard store?.isAuthenticated == true else {
            return
        }

        await requestAuthorizationAndRegister()
    }

    func handleSignOut() {
        pendingDeviceToken = nil
        lastRegistrationError = nil
        WKApplication.shared().unregisterForRemoteNotifications()

        guard let store else {
            return
        }

        Task {
            try? await store.unregisterPushDevice(installationId: store.deviceID)
        }
    }

    func didRegisterForRemoteNotifications(withDeviceToken deviceToken: Data) {
        Task { @MainActor in
            pendingDeviceToken = deviceToken
            await sendDeviceTokenIfReady()
        }
    }

    func didFailToRegisterForRemoteNotificationsWithError(_ error: Error) {
        lastRegistrationError = error.localizedDescription
    }

    private func requestAuthorizationAndRegister() async {
        do {
            let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
            await refreshAuthorizationStatus()

            guard granted else {
                lastRegistrationError = "Notification permission was not granted."
                return
            }

            lastRegistrationError = nil
            WKApplication.shared().registerForRemoteNotifications()

            if pendingDeviceToken != nil {
                await sendDeviceTokenIfReady()
            }
        } catch {
            lastRegistrationError = error.localizedDescription
        }
    }

    private func refreshAuthorizationStatus() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        authorizationStatus = settings.authorizationStatus
    }

    private func sendDeviceTokenIfReady() async {
        guard let store, store.isAuthenticated, let pendingDeviceToken else {
            return
        }

        let registration = PushDeviceRegistrationRequest(
            installationId: store.deviceID,
            deviceToken: Self.hexString(for: pendingDeviceToken),
            deviceFamily: "Watch",
            deviceName: WKInterfaceDevice.current().name,
            systemVersion: WKInterfaceDevice.current().systemVersion,
            appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
            buildNumber: Bundle.main.infoDictionary?["CFBundleVersion"] as? String,
            bundleId: Bundle.main.bundleIdentifier ?? "NTechR.HomeBrainApp.watchkitapp",
            environment: Self.apnsEnvironmentName(),
            pushEnabled: true,
            securityCriticalPushEnabled: true,
            authorizationStatus: Self.authorizationStatusName(authorizationStatus)
        )

        do {
            try await store.registerPushDevice(registration)
            lastRegisteredAt = Date()
            lastRegistrationError = nil
        } catch {
            lastRegistrationError = error.localizedDescription
        }
    }

    private static func hexString(for data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    private static func authorizationStatusName(_ status: UNAuthorizationStatus) -> String {
        switch status {
        case .notDetermined:
            return "notDetermined"
        case .denied:
            return "denied"
        case .authorized:
            return "authorized"
        case .provisional:
            return "provisional"
        case .ephemeral:
            return "ephemeral"
        @unknown default:
            return "unknown"
        }
    }

    private static func apnsEnvironmentName() -> String {
        #if DEBUG
        return "development"
        #else
        return "production"
        #endif
    }
}
