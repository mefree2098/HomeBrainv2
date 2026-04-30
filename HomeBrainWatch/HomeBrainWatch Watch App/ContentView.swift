//
//  ContentView.swift
//  HomeBrainWatch Watch App
//
//  Created by Matt Freestone on 4/30/26.
//

import SwiftUI

struct ContentView: View {
    @StateObject private var store = HomeBrainWatchStore()

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
    }
}

#Preview {
    ContentView()
}
