import SwiftUI

struct RootView: View {
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var uiPreview: UIPreviewStore
    @AppStorage("homebrain.ios.theme-mode") private var themeModeRaw = HBThemeMode.system.rawValue

    var body: some View {
        Group {
            if session.isAuthenticated && !uiPreview.isForcedByLaunch {
                AppShellView(previewMode: false)
            } else if uiPreview.isEnabled {
                AppShellView(previewMode: true)
            } else {
                AuthView()
            }
        }
        .preferredColorScheme((HBThemeMode(rawValue: themeModeRaw) ?? .system).colorScheme)
        .tint(HBPalette.accentBlue)
        .task {
            await session.bootstrap()
        }
        .onChange(of: session.isAuthenticated) { _, isAuthenticated in
            if isAuthenticated && uiPreview.isEnabled && !uiPreview.isForcedByLaunch {
                uiPreview.exit()
            }
        }
    }
}
