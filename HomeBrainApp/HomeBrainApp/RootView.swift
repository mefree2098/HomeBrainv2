import SwiftUI

struct RootView: View {
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var uiPreview: UIPreviewStore
    @AppStorage("homebrain.ios.theme-mode") private var themeModeRaw = HBThemeMode.system.rawValue

    var body: some View {
        Group {
            if uiPreview.isEnabled {
                AppShellView(previewMode: true)
            } else if session.isAuthenticated {
                AppShellView(previewMode: false)
            } else {
                AuthView()
            }
        }
        .preferredColorScheme((HBThemeMode(rawValue: themeModeRaw) ?? .system).colorScheme)
        .tint(HBPalette.accentBlue)
        .task {
            await session.bootstrap()
        }
    }
}
