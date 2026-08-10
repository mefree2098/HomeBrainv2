import SwiftUI
import UIKit

struct RootView: View {
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var uiPreview: UIPreviewStore
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("homebrain.ios.theme-mode") private var themeModeRaw = HBThemeMode.system.rawValue

    var body: some View {
        Group {
            if session.isAuthenticated && !uiPreview.isForcedByLaunch {
                AppShellView(previewMode: false)
                    .id(session.sessionContextID)
            } else if uiPreview.isEnabled {
                AppShellView(previewMode: true)
            } else {
                AuthView()
                    .id(session.sessionContextID)
            }
        }
        .font(HBTypography.body())
        .preferredColorScheme((HBThemeMode(rawValue: themeModeRaw) ?? .system).colorScheme)
        .tint(HBPalette.accentBlue)
        .task {
            await restoreSessionAndRecovery()
            applyPreviewOrientationIfNeeded()
        }
        .onAppear {
            applyPreviewOrientationIfNeeded()
        }
        .onChange(of: session.backendRecoveryGeneration) { _, generation in
            guard generation > 0 else {
                return
            }

            Task {
                await session.bootstrap()
            }
        }
        .onChange(of: session.isAuthenticated) { _, isAuthenticated in
            if isAuthenticated && uiPreview.isEnabled && !uiPreview.isForcedByLaunch {
                uiPreview.exit()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }

            Task {
                await restoreSessionAndRecovery()
            }
        }
    }

    private func restoreSessionAndRecovery() async {
        await session.bootstrap()
        await session.resumeBackendRecoveryIfNeeded()
    }

    private func applyPreviewOrientationIfNeeded() {
        guard uiPreview.isForcedByLaunch,
              let orientationMask = uiPreview.requestedInterfaceOrientationMask,
              let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else {
            return
        }

        scene.requestGeometryUpdate(.iOS(interfaceOrientations: orientationMask))
    }
}
