import AppIntents
import Foundation

nonisolated struct HomeBrainLightsEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Lights"
    static let defaultQuery = HomeBrainLightsQuery()
    let id: String
    let name: String
    let room: String
    let aliases: [String]
    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)", subtitle: "\(room)", image: .init(systemName: "lightbulb.fill"),
                              synonyms: aliases.map { "\($0)" })
    }
}
nonisolated struct HomeBrainWorkflowEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Workflow"
    static let defaultQuery = HomeBrainWorkflowQuery()
    let id: String
    let name: String
    let aliases: [String]
    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)", image: .init(systemName: "arrow.triangle.branch"),
                              synonyms: aliases.map { "\($0)" })
    }
}
nonisolated struct HomeBrainSceneEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Scene"
    static let defaultQuery = HomeBrainSceneQuery()
    let id: String
    let name: String
    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)", image: .init(systemName: "sparkles"))
    }
}

nonisolated enum HBSiriEntityQuery {
    static func targets(kinds: Set<String>, matching: String? = nil, identifiers: [String]? = nil) async throws -> [(String, HBSiriTarget)] {
        let available = try await HomeBrainSiriRuntime.client.targets(kinds: kinds)
        let selected: [HBSiriTarget]
        if let matching {
            selected = HBSiriPolicy.matching(matching, in: available.map { $0.1 })
        } else {
            selected = available.map { $0.1 }
        }
        var result: [(String, HBSiriTarget)] = []
        for (identity, target) in available where selected.contains(target) {
            let encoded = try identity.encoded()
            if let identifiers, !identifiers.contains(encoded) { continue }
            result.append((encoded, target))
        }
        if let identifiers {
            // Preserve requested order, rather than substituting any unavailable/deleted entity.
            return identifiers.compactMap { identifier in result.first { $0.0 == identifier } }
        }
        return result
    }
}
nonisolated struct HomeBrainLightsQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [HomeBrainLightsEntity] {
        try await values(identifiers: identifiers)
    }
    func entities(matching string: String) async throws -> [HomeBrainLightsEntity] { try await values(matching: string) }
    func suggestedEntities() async throws -> [HomeBrainLightsEntity] { try await values() }
    private func values(matching: String? = nil, identifiers: [String]? = nil) async throws -> [HomeBrainLightsEntity] {
        try await HBSiriEntityQuery.targets(kinds: ["room", "light"], matching: matching, identifiers: identifiers).map {
            HomeBrainLightsEntity(id: $0.0, name: $0.1.name, room: $0.1.room, aliases: $0.1.aliases)
        }
    }
}
nonisolated struct HomeBrainWorkflowQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [HomeBrainWorkflowEntity] { try await values(identifiers: identifiers) }
    func entities(matching string: String) async throws -> [HomeBrainWorkflowEntity] { try await values(matching: string) }
    func suggestedEntities() async throws -> [HomeBrainWorkflowEntity] { try await values() }
    private func values(matching: String? = nil, identifiers: [String]? = nil) async throws -> [HomeBrainWorkflowEntity] {
        try await HBSiriEntityQuery.targets(kinds: ["workflow"], matching: matching, identifiers: identifiers).map {
            HomeBrainWorkflowEntity(id: $0.0, name: $0.1.name, aliases: $0.1.aliases)
        }
    }
}
nonisolated struct HomeBrainSceneQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [HomeBrainSceneEntity] { try await values(identifiers: identifiers) }
    func entities(matching string: String) async throws -> [HomeBrainSceneEntity] { try await values(matching: string) }
    func suggestedEntities() async throws -> [HomeBrainSceneEntity] { try await values() }
    private func values(matching: String? = nil, identifiers: [String]? = nil) async throws -> [HomeBrainSceneEntity] {
        try await HBSiriEntityQuery.targets(kinds: ["scene"], matching: matching, identifiers: identifiers).map {
            HomeBrainSceneEntity(id: $0.0, name: $0.1.name)
        }
    }
}

struct TurnOnHomeBrainLightsIntent: AppIntent {
    static let title: LocalizedStringResource = "Turn On Lights"
    static let description = IntentDescription("Turn on a light or all lights in a HomeBrain room.")
    static let openAppWhenRun = false
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    @Parameter(title: "Lights", requestValueDialog: "Which lights?") var lights: HomeBrainLightsEntity
    static var parameterSummary: some ParameterSummary { Summary("Turn on \(\.$lights)") }
    @MainActor func perform() async throws -> some IntentResult & ProvidesDialog {
        let message = try await HomeBrainSiriRuntime.client.execute(identity: lights.id, action: "turn_on")
        return .result(dialog: "\(message)")
    }
}
struct TurnOffHomeBrainLightsIntent: AppIntent {
    static let title: LocalizedStringResource = "Turn Off Lights"
    static let description = IntentDescription("Turn off a light or all lights in a HomeBrain room.")
    static let openAppWhenRun = false
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    @Parameter(title: "Lights", requestValueDialog: "Which lights?") var lights: HomeBrainLightsEntity
    static var parameterSummary: some ParameterSummary { Summary("Turn off \(\.$lights)") }
    @MainActor func perform() async throws -> some IntentResult & ProvidesDialog {
        let message = try await HomeBrainSiriRuntime.client.execute(identity: lights.id, action: "turn_off")
        return .result(dialog: "\(message)")
    }
}
struct SetHomeBrainBrightnessIntent: AppIntent {
    static let title: LocalizedStringResource = "Set Light Brightness"
    static let description = IntentDescription("Set a light or room brightness from 0 to 100 percent.")
    static let openAppWhenRun = false
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    @Parameter(title: "Lights", requestValueDialog: "Which lights?") var lights: HomeBrainLightsEntity
    @Parameter(title: "Brightness", inclusiveRange: (0, 100), requestValueDialog: "What brightness percentage?") var brightness: Int
    static var parameterSummary: some ParameterSummary { Summary("Set \(\.$lights) brightness to \(\.$brightness) percent") }
    @MainActor func perform() async throws -> some IntentResult & ProvidesDialog {
        let message = try await HomeBrainSiriRuntime.client.execute(identity: lights.id, action: "set_brightness", brightness: brightness)
        return .result(dialog: "\(message)")
    }
}
struct RunHomeBrainWorkflowIntent: AppIntent {
    static let title: LocalizedStringResource = "Run Workflow"
    static let description = IntentDescription("Run an enabled HomeBrain workflow, including its configured device and automation actions.")
    static let openAppWhenRun = false
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    @Parameter(title: "Workflow", requestValueDialog: "Which workflow?") var workflow: HomeBrainWorkflowEntity
    static var parameterSummary: some ParameterSummary { Summary("Run \(\.$workflow)") }
    @MainActor func perform() async throws -> some IntentResult & ProvidesDialog {
        let message = try await HomeBrainSiriRuntime.client.execute(identity: workflow.id, action: "run")
        return .result(dialog: "\(message)")
    }
}
struct ActivateHomeBrainSceneIntent: AppIntent {
    static let title: LocalizedStringResource = "Activate Scene"
    static let description = IntentDescription("Activate a configured HomeBrain scene.")
    static let openAppWhenRun = false
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    @Parameter(title: "Scene", requestValueDialog: "Which scene?") var scene: HomeBrainSceneEntity
    static var parameterSummary: some ParameterSummary { Summary("Activate \(\.$scene)") }
    @MainActor func perform() async throws -> some IntentResult & ProvidesDialog {
        let message = try await HomeBrainSiriRuntime.client.execute(identity: scene.id, action: "activate")
        return .result(dialog: "\(message)")
    }
}

struct HomeBrainShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: TurnOnHomeBrainLightsIntent(), phrases: [
            "Turn on \(\.$lights) in \(.applicationName)", "Turn on lights in \(.applicationName)"
        ], shortTitle: "Turn On Lights", systemImageName: "lightbulb.fill")
        AppShortcut(intent: TurnOffHomeBrainLightsIntent(), phrases: [
            "Turn off \(\.$lights) in \(.applicationName)", "Turn off lights in \(.applicationName)"
        ], shortTitle: "Turn Off Lights", systemImageName: "lightbulb.slash")
        AppShortcut(intent: SetHomeBrainBrightnessIntent(), phrases: [
            "Set \(\.$lights) brightness in \(.applicationName)", "Set light brightness in \(.applicationName)"
        ], shortTitle: "Set Brightness", systemImageName: "sun.max.fill")
        AppShortcut(intent: RunHomeBrainWorkflowIntent(), phrases: [
            "Run \(\.$workflow) in \(.applicationName)", "Turn on \(\.$workflow) in \(.applicationName)",
            "Run a workflow in \(.applicationName)"
        ], shortTitle: "Run Workflow", systemImageName: "arrow.triangle.branch")
        AppShortcut(intent: ActivateHomeBrainSceneIntent(), phrases: [
            "Activate \(\.$scene) in \(.applicationName)", "Activate a scene in \(.applicationName)"
        ], shortTitle: "Activate Scene", systemImageName: "sparkles")
    }
}
