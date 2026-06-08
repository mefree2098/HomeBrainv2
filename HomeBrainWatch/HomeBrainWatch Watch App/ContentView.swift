//
//  ContentView.swift
//  HomeBrainWatch Watch App
//
//  Created by Matt Freestone on 4/30/26.
//

import SwiftUI

struct ContentView: View {
    @StateObject private var store = HomeBrainWatchStore()
    @EnvironmentObject private var pushNotificationManager: WatchPushNotificationManager

    var body: some View {
        NavigationStack {
            ZStack {
                LinearGradient(
                    colors: [
                        Color.black,
                        Color(red: 0.03, green: 0.08, blue: 0.12),
                        Color(red: 0.05, green: 0.04, blue: 0.09)
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
                .ignoresSafeArea()

                if store.isAuthenticated {
                    WatchDashboardRootView(store: store)
                } else {
                    SignInView(store: store)
                }
            }
        }
        .tint(.cyan)
        .task {
            pushNotificationManager.bind(store: store)
            await pushNotificationManager.configureForAuthenticationState()
        }
        .onChange(of: store.isAuthenticated) { _, isAuthenticated in
            Task {
                if isAuthenticated {
                    await pushNotificationManager.configureForAuthenticationState()
                } else {
                    pushNotificationManager.handleSignOut()
                }
            }
        }
    }
}

#Preview {
    ContentView()
}
