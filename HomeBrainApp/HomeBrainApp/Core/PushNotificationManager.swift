import Foundation
import Combine
import UIKit
import UserNotifications

@MainActor
final class PushNotificationManager: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = PushNotificationManager()

    @Published private(set) var authorizationStatus: UNAuthorizationStatus = .notDetermined
    @Published private(set) var lastRegistrationError: String?
    @Published private(set) var lastRegisteredAt: Date?
    @Published private(set) var securityCriticalPushEnabled: Bool

    private weak var sessionStore: SessionStore?
    private var pendingDeviceToken: Data?
    private let notificationCenter = UNUserNotificationCenter.current()
    private let criticalPushPreferenceKey = "homebrain.securityCriticalPushEnabled"

    private override init() {
        let storedPreference = UserDefaults.standard.object(forKey: "homebrain.securityCriticalPushEnabled") as? Bool
        securityCriticalPushEnabled = storedPreference ?? (UIDevice.current.userInterfaceIdiom == .phone)
        super.init()
        notificationCenter.delegate = self
    }

    func bind(sessionStore: SessionStore) {
        self.sessionStore = sessionStore
    }

    func configureForAuthenticationState() async {
        await refreshAuthorizationStatus()

        guard sessionStore?.isAuthenticated == true else {
            return
        }

        guard securityCriticalPushEnabled else {
            return
        }

        await requestAuthorizationAndRegister()
    }

    func handleLogout() {
        pendingDeviceToken = nil
        lastRegistrationError = nil
    }

    func setSecurityCriticalPushEnabled(_ enabled: Bool) async {
        securityCriticalPushEnabled = enabled
        UserDefaults.standard.set(enabled, forKey: criticalPushPreferenceKey)

        guard sessionStore?.isAuthenticated == true else {
            return
        }

        if enabled {
            await requestAuthorizationAndRegister()
        } else {
            await unregisterCurrentDevice()
        }
    }

    func registerDeviceToken(_ deviceToken: Data) async {
        pendingDeviceToken = deviceToken
        await sendDeviceTokenIfReady()
    }

    func recordRegistrationFailure(_ error: Error) {
        lastRegistrationError = error.localizedDescription
    }

    private func requestAuthorizationAndRegister() async {
        do {
            let granted = try await notificationCenter.requestAuthorization(options: [.alert, .sound, .badge])
            await refreshAuthorizationStatus()

            guard granted else {
                lastRegistrationError = "Notification permission was not granted."
                return
            }

            lastRegistrationError = nil
            UIApplication.shared.registerForRemoteNotifications()

            if pendingDeviceToken != nil {
                await sendDeviceTokenIfReady()
            }
        } catch {
            lastRegistrationError = error.localizedDescription
        }
    }

    private func refreshAuthorizationStatus() async {
        let settings = await notificationCenter.notificationSettings()
        authorizationStatus = settings.authorizationStatus
    }

    private func sendDeviceTokenIfReady() async {
        guard let sessionStore, sessionStore.isAuthenticated, let pendingDeviceToken else {
            return
        }

        let payload: [String: Any] = [
            "installationId": sessionStore.clientInstallationId,
            "deviceToken": Self.hexString(for: pendingDeviceToken),
            "deviceFamily": Self.deviceFamilyName(),
            "deviceName": UIDevice.current.model,
            "systemVersion": UIDevice.current.systemVersion,
            "appVersion": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
            "buildNumber": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "",
            "bundleId": Bundle.main.bundleIdentifier ?? "NTechR.HomeBrainApp",
            "environment": Self.apnsEnvironmentName(),
            "pushEnabled": true,
            "securityCriticalPushEnabled": securityCriticalPushEnabled,
            "authorizationStatus": Self.authorizationStatusName(authorizationStatus)
        ]

        do {
            _ = try await sessionStore.apiClient.post("/api/notifications/push/devices", body: payload)
            lastRegisteredAt = Date()
            lastRegistrationError = nil
        } catch {
            lastRegistrationError = error.localizedDescription
        }
    }

    private func unregisterCurrentDevice() async {
        guard let sessionStore else {
            return
        }

        let encodedInstallationId = sessionStore.clientInstallationId
            .addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionStore.clientInstallationId

        do {
            _ = try await sessionStore.apiClient.delete("/api/notifications/push/devices/\(encodedInstallationId)")
            lastRegistrationError = nil
        } catch {
            lastRegistrationError = error.localizedDescription
        }
    }

    private static func hexString(for data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    private static func deviceFamilyName() -> String {
        switch UIDevice.current.userInterfaceIdiom {
        case .phone:
            return "iPhone"
        case .pad:
            return "iPad"
        case .mac:
            return "mac"
        default:
            return "unknown"
        }
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

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound, .badge]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
    }
}

final class HomeBrainAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Task { @MainActor in
            await PushNotificationManager.shared.registerDeviceToken(deviceToken)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        Task { @MainActor in
            PushNotificationManager.shared.recordRegistrationFailure(error)
        }
    }
}
