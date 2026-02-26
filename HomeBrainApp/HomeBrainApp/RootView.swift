import SwiftUI

struct RootView: View {
    @EnvironmentObject private var session: SessionStore

    var body: some View {
        Group {
            if session.isAuthenticated {
                AppShellView()
            } else {
                AuthView()
            }
        }
        .task {
            await session.bootstrap()
        }
    }
}
