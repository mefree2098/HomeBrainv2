import SwiftUI
import AppIntents
import UIKit

@main
struct HomeBrainAppApp: App {
    @UIApplicationDelegateAdaptor(HomeBrainAppDelegate.self) private var appDelegate
    @StateObject private var sessionStore = SessionStore()
    @StateObject private var uiPreviewStore = UIPreviewStore()
    @StateObject private var watchSyncManager = WatchSyncManager()
    @StateObject private var pushNotificationManager = PushNotificationManager.shared

    init() {
        HBTypography.registerFonts()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(sessionStore)
                .environmentObject(uiPreviewStore)
                .environmentObject(watchSyncManager)
                .environmentObject(pushNotificationManager)
                .task {
                    watchSyncManager.bind(sessionStore: sessionStore)
                    pushNotificationManager.bind(sessionStore: sessionStore)
                    if sessionStore.isAuthenticated {
                        _ = await watchSyncManager.syncNow()
                        await pushNotificationManager.configureForAuthenticationState()
                    }
                }
                .onChange(of: sessionStore.isAuthenticated) { _, isAuthenticated in
                    Task {
                        if isAuthenticated {
                            _ = await watchSyncManager.syncNow()
                            await pushNotificationManager.configureForAuthenticationState()
                        } else {
                            watchSyncManager.clearWatchSession()
                            pushNotificationManager.handleLogout()
                        }
                    }
                }
                .onChange(of: sessionStore.sessionContextID) { _, _ in
                    watchSyncManager.handleInstanceChange()
                    pushNotificationManager.handleInstanceChange()
                    guard sessionStore.isAuthenticated else { return }
                    Task {
                        _ = await watchSyncManager.syncNow()
                        await pushNotificationManager.configureForAuthenticationState()
                    }
                }
        }
    }
}
