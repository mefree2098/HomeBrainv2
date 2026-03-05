import SwiftUI

struct RootView: View {
    @EnvironmentObject private var session: SessionStore
    @AppStorage("homebrain.ios.theme-mode") private var themeModeRaw = HBThemeMode.system.rawValue

    var body: some View {
        Group {
            if session.isAuthenticated {
                AppShellView()
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
