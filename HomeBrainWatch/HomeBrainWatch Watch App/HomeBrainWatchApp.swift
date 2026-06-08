//
//  HomeBrainWatchApp.swift
//  HomeBrainWatch Watch App
//
//  Created by Matt Freestone on 4/30/26.
//

import SwiftUI
import AppIntents
import WatchKit

@main
struct HomeBrainWatch_Watch_AppApp: App {
    @WKApplicationDelegateAdaptor(WatchPushNotificationManager.self) private var pushNotificationManager

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(pushNotificationManager)
        }
    }
}
