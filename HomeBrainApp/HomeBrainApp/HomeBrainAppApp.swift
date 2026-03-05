import SwiftUI

@main
struct HomeBrainAppApp: App {
    @StateObject private var sessionStore = SessionStore()
    @StateObject private var uiPreviewStore = UIPreviewStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(sessionStore)
                .environmentObject(uiPreviewStore)
        }
    }
}
