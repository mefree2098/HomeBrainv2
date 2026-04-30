import SwiftUI
import AppIntents

@main
struct HomeBrainAppApp: App {
    @StateObject private var sessionStore = SessionStore()
    @StateObject private var uiPreviewStore = UIPreviewStore()
    @StateObject private var watchSyncManager = WatchSyncManager()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(sessionStore)
                .environmentObject(uiPreviewStore)
                .environmentObject(watchSyncManager)
                .task {
                    watchSyncManager.bind(sessionStore: sessionStore)
                    if sessionStore.isAuthenticated {
                        _ = await watchSyncManager.syncNow()
                    }
                }
                .onChange(of: sessionStore.isAuthenticated) { _, isAuthenticated in
                    Task {
                        if isAuthenticated {
                            _ = await watchSyncManager.syncNow()
                        } else {
                            watchSyncManager.clearWatchSession()
                        }
                    }
                }
                .onChange(of: sessionStore.serverURLString) { _, _ in
                    guard sessionStore.isAuthenticated else { return }
                    Task {
                        _ = await watchSyncManager.syncNow()
                    }
                }
        }
    }
}
