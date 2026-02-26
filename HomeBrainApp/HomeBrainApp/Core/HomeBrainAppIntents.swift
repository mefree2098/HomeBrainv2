import AppIntents

struct HomeBrainOpenAppIntent: AppIntent {
    static let title: LocalizedStringResource = "Open HomeBrain"
    static let description = IntentDescription("Opens the HomeBrain app.")
    static let openAppWhenRun = true

    func perform() async throws -> some IntentResult {
        .result()
    }
}

struct HomeBrainShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: HomeBrainOpenAppIntent(),
            phrases: ["Open HomeBrain in \(.applicationName)"],
            shortTitle: "Open HomeBrain",
            systemImageName: "house"
        )
    }
}
