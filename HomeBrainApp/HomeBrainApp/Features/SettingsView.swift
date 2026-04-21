import SwiftUI

private enum SettingsParitySurface: String, CaseIterable, Identifiable {
    case senseEnergy
    case rainMachine
    case ollama
    case whisper
    case platformDeploy
    case operations
    case ssl

    var id: String { rawValue }

    var title: String {
        switch self {
        case .senseEnergy: return "Sense Energy"
        case .rainMachine: return "RainMachine"
        case .ollama: return "Ollama / LLM"
        case .whisper: return "Whisper STT"
        case .platformDeploy: return "Platform Deploy"
        case .operations: return "Operations"
        case .ssl: return "SSL Certificates"
        }
    }

    var icon: String {
        switch self {
        case .senseEnergy: return "bolt.fill"
        case .rainMachine: return "cloud.rain"
        case .ollama: return "brain"
        case .whisper: return "cpu"
        case .platformDeploy: return "arrow.up.forward.app"
        case .operations: return "waveform.path.ecg"
        case .ssl: return "lock.shield"
        }
    }
}

private enum SettingsWebArea: String, CaseIterable, Identifiable {
    case general
    case voice
    case integrations
    case alexa
    case codexSkill
    case openClaw
    case sense
    case tempest
    case rainMachine
    case deviceIntegrations
    case ecobee
    case apiKeys
    case aiProviders
    case llmPriority
    case hardwareOrbs
    case security
    case resources
    case maintenance
    case platformAdmin

    var id: String { rawValue }

    var title: String {
        switch self {
        case .general: return "General"
        case .voice: return "Voice"
        case .integrations: return "Integrations"
        case .alexa: return "Alexa"
        case .codexSkill: return "Codex Skill"
        case .openClaw: return "OpenClaw"
        case .sense: return "Sense"
        case .tempest: return "Tempest"
        case .rainMachine: return "RainMachine"
        case .deviceIntegrations: return "Device Integrations"
        case .ecobee: return "Ecobee"
        case .apiKeys: return "API Keys"
        case .aiProviders: return "AI / LLM"
        case .llmPriority: return "LLM Priority"
        case .hardwareOrbs: return "Hardware Orbs"
        case .security: return "Security"
        case .resources: return "Resources"
        case .maintenance: return "Maintenance"
        case .platformAdmin: return "Platform Admin"
        }
    }

    var subtitle: String {
        switch self {
        case .general: return "Location, timezone, notifications, discovery"
        case .voice: return "Wake word, mic, volume, STT settings"
        case .integrations: return "Web Settings integration index"
        case .alexa: return "Broker, link codes, discovery, voice users"
        case .codexSkill: return "Codex live skill token and bundle status"
        case .openClaw: return "OpenClaw MCP, token, Jetson bundle"
        case .sense: return "Sense Energy monitor setup and sync"
        case .tempest: return "Tempest station setup and weather fusion"
        case .rainMachine: return "RainMachine controller setup and sync"
        case .deviceIntegrations: return "INSTEON, SmartThings, Harmony"
        case .ecobee: return "Ecobee OAuth and thermostat sync"
        case .apiKeys: return "OpenAI, Anthropic, ElevenLabs, SmartThings"
        case .aiProviders: return "OpenAI, Codex, Anthropic, local LLM"
        case .llmPriority: return "Provider fallback order"
        case .hardwareOrbs: return "Orb provisioning and mount alignment"
        case .security: return "Security mode and refresh-session lifetime"
        case .resources: return "CPU, memory, disk, GPU, deploy health"
        case .maintenance: return "Sync, reset, backup, diagnostics"
        case .platformAdmin: return "Deploy, SSL, operations, model services"
        }
    }

    var icon: String {
        switch self {
        case .general: return "gearshape"
        case .voice: return "mic"
        case .integrations: return "puzzlepiece.extension"
        case .alexa: return "waveform"
        case .codexSkill: return "terminal"
        case .openClaw: return "point.3.connected.trianglepath.dotted"
        case .sense: return "bolt.fill"
        case .tempest: return "cloud.sun"
        case .rainMachine: return "cloud.rain"
        case .deviceIntegrations: return "switch.2"
        case .ecobee: return "thermometer.medium"
        case .apiKeys: return "key"
        case .aiProviders: return "brain"
        case .llmPriority: return "arrow.up.arrow.down"
        case .hardwareOrbs: return "circle.hexagongrid"
        case .security: return "lock.shield"
        case .resources: return "gauge.with.dots.needle.50percent"
        case .maintenance: return "wrench.adjustable"
        case .platformAdmin: return "server.rack"
        }
    }

    var isAdminOnly: Bool {
        switch self {
        case .alexa, .codexSkill, .openClaw, .sense, .tempest, .rainMachine, .deviceIntegrations,
             .ecobee, .apiKeys, .aiProviders, .llmPriority, .hardwareOrbs, .resources, .maintenance,
             .platformAdmin:
            return true
        default:
            return false
        }
    }
}

struct SettingsView: View {
    @EnvironmentObject private var session: SessionStore

    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var infoMessage = ""
    @State private var presentedSettingsSurface: SettingsParitySurface?
    @State private var presentedWebSettingsArea: SettingsWebArea?
    @State private var selectedSettingsArea: SettingsWebArea = .general

    @State private var serverURL = ""
    @State private var authSessionMaxAgeDays = 365
    @State private var authSessions: [AuthSessionRecord] = []
    @State private var revokingSessionIDs: Set<String> = []
    @State private var hardwareOrbs: [HardwareOrbRecord] = []
    @State private var hardwareOrbLoadError: String?
    @State private var savingHardwareOrbIDs: Set<String> = []

    @State private var location = ""
    @State private var timezone = ""
    @State private var wakeWordSensitivity = 0.7
    @State private var voiceVolume = 0.8
    @State private var microphoneSensitivity = 0.6
    @State private var enableVoiceConfirmation = true
    @State private var enableNotifications = true
    @State private var enableSecurityMode = false
    @State private var autoDiscoveryEnabled = false

    @State private var llmProvider = "openai"
    @State private var openaiModel = "gpt-5.2-codex"
    @State private var codexModel = "gpt-5.4"
    @State private var anthropicModel = "claude-3-sonnet-20240229"
    @State private var localLlmEndpoint = "http://localhost:11434"
    @State private var localLlmModel = "llama2-7b"

    @State private var sttProvider = "openai"
    @State private var sttModel = "gpt-4o-mini-transcribe"
    @State private var sttLanguage = "en"

    @State private var smartthingsUseOAuth = true
    @State private var harmonyHubAddresses = ""

    @State private var openaiApiKey = ""
    @State private var anthropicApiKey = ""
    @State private var elevenLabsApiKey = ""
    @State private var smartThingsToken = ""

    @State private var llmPriority = "local,codex,openai,anthropic"

    private let llmProviders = ["openai", "codex", "anthropic", "local"]
    private let sttProviders = ["openai", "local"]

    private var isAdmin: Bool {
        session.currentUser?.role == "admin"
    }

    var body: some View {
        VStack(spacing: 12) {
            if isLoading {
                LoadingView(title: "Loading settings...")
            } else {
                HBSectionHeader(
                    title: "Settings",
                    subtitle: "Platform configuration and integration keys"
                )

                Form {
                    if let errorMessage {
                        Section {
                            InlineErrorView(message: errorMessage) {
                                Task { await loadSettings() }
                            }
                        }
                    }

                    if !infoMessage.isEmpty {
                        Section {
                            Text(infoMessage)
                                .font(.subheadline)
                                .foregroundStyle(HBPalette.textSecondary)
                        }
                    }

                    Section("Settings Areas") {
                        settingsTabRail
                    }

                    settingsInlineAreaContent(selectedSettingsArea)

                }
                .hbFormStyle()
                .refreshable {
                    await loadSettings()
                }
            }
        }
        .padding()
        .task {
            await loadSettings()
        }
        .sheet(item: $presentedSettingsSurface) { surface in
            NavigationStack {
                settingsSurfaceView(surface)
                    .navigationTitle(surface.title)
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Close") {
                                presentedSettingsSurface = nil
                            }
                        }
                    }
            }
            .environmentObject(session)
        }
        .sheet(item: $presentedWebSettingsArea) { area in
            NavigationStack {
                settingsWebAreaView(area)
                    .navigationTitle(area.title)
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Close") {
                                presentedWebSettingsArea = nil
                            }
                        }
                    }
            }
            .environmentObject(session)
        }
    }

    @ViewBuilder
    private func settingsSurfaceView(_ surface: SettingsParitySurface) -> some View {
        switch surface {
        case .senseEnergy:
            SenseEnergyView()
        case .rainMachine:
            RainMachineView()
        case .ollama:
            OllamaView()
        case .whisper:
            WhisperView()
        case .platformDeploy:
            PlatformDeployView()
        case .operations:
            OperationsView()
        case .ssl:
            SSLView()
        }
    }

    private var availableSettingsAreas: [SettingsWebArea] {
        SettingsWebArea.allCases.filter { !$0.isAdminOnly || isAdmin }
    }

    private var settingsTabRail: some View {
        VStack(alignment: .leading, spacing: 10) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(availableSettingsAreas) { area in
                        Button {
                            selectedSettingsArea = area
                        } label: {
                            Label(area.title, systemImage: area.icon)
                                .font(.caption.weight(.semibold))
                                .lineLimit(1)
                                .padding(.horizontal, 11)
                                .padding(.vertical, 8)
                                .background(
                                    Capsule()
                                        .fill(selectedSettingsArea == area ? HBPalette.accentBlue.opacity(0.22) : HBPalette.panelSoft.opacity(0.72))
                                )
                                .overlay(
                                    Capsule()
                                        .stroke(selectedSettingsArea == area ? HBPalette.accentBlue.opacity(0.78) : HBPalette.panelStroke, lineWidth: 1)
                                )
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.vertical, 2)
            }

            HStack(alignment: .top, spacing: 10) {
                Image(systemName: selectedSettingsArea.icon)
                    .foregroundStyle(HBPalette.accentBlue)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 3) {
                    Text(selectedSettingsArea.title)
                        .font(.subheadline.weight(.semibold))
                    Text(selectedSettingsArea.subtitle)
                        .font(.caption)
                        .foregroundStyle(HBPalette.textSecondary)
                }
                Spacer()
                if selectedSettingsArea.isAdminOnly {
                    Button("Open Full") {
                        presentedWebSettingsArea = selectedSettingsArea
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            }
        }
    }

    @ViewBuilder
    private func settingsInlineAreaContent(_ area: SettingsWebArea) -> some View {
        switch area {
        case .general:
            settingsConnectionSection
            settingsGeneralSection
            settingsSaveRefreshSection

        case .voice:
            settingsVoiceSection
            settingsSTTSection
            settingsSaveRefreshSection

        case .integrations:
            settingsIntegrationBasicsSection
            settingsIntegrationTabsSection
            settingsSaveRefreshSection

        case .alexa, .codexSkill, .openClaw, .sense, .tempest, .rainMachine, .ecobee, .resources, .maintenance:
            settingsOpenFullAreaSection(area)

        case .deviceIntegrations:
            settingsIntegrationBasicsSection
            settingsOpenFullAreaSection(area)
            settingsSaveRefreshSection

        case .apiKeys:
            settingsAPIKeysSection
            settingsSaveRefreshSection

        case .aiProviders:
            settingsLLMSection
            settingsSaveRefreshSection

        case .llmPriority:
            settingsLLMPrioritySection
            settingsSaveRefreshSection

        case .hardwareOrbs:
            settingsHardwareOrbsSection

        case .security:
            settingsSecuritySection
            settingsSessionsSection
            settingsSaveRefreshSection

        case .platformAdmin:
            settingsPlatformAdminSection
        }
    }

    private var settingsConnectionSection: some View {
        Section("Connection") {
            TextField("Server URL", text: $serverURL)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .disableAutocorrection(true)

            Button("Apply Server URL") {
                if session.updateServerURL(serverURL) {
                    serverURL = session.serverURLString
                    infoMessage = "Server URL updated."
                    errorMessage = nil
                } else {
                    errorMessage = "Enter a valid server URL."
                }
            }
        }
    }

    private var settingsGeneralSection: some View {
        Section("General") {
            TextField("Location", text: $location)
            TextField("Timezone", text: $timezone)
            Toggle("Enable Notifications", isOn: $enableNotifications)
            Toggle("Enable Security Mode", isOn: $enableSecurityMode)
            Toggle("Enable Auto Discovery", isOn: $autoDiscoveryEnabled)
        }
    }

    private var settingsVoiceSection: some View {
        Section("Voice") {
            HStack {
                Text("Wake Word Sensitivity")
                Spacer()
                Text(String(format: "%.2f", wakeWordSensitivity))
                    .foregroundStyle(HBPalette.textSecondary)
            }
            Slider(value: $wakeWordSensitivity, in: 0.1...1)

            HStack {
                Text("Voice Volume")
                Spacer()
                Text(String(format: "%.2f", voiceVolume))
                    .foregroundStyle(HBPalette.textSecondary)
            }
            Slider(value: $voiceVolume, in: 0.1...1)

            HStack {
                Text("Mic Sensitivity")
                Spacer()
                Text(String(format: "%.2f", microphoneSensitivity))
                    .foregroundStyle(HBPalette.textSecondary)
            }
            Slider(value: $microphoneSensitivity, in: 0.1...1)

            Toggle("Enable Voice Confirmation", isOn: $enableVoiceConfirmation)
        }
    }

    private var settingsSTTSection: some View {
        Section("STT") {
            Picker("Provider", selection: $sttProvider) {
                ForEach(sttProviders, id: \.self) { provider in
                    Text(provider.capitalized).tag(provider)
                }
            }

            TextField("STT Model", text: $sttModel)
            TextField("STT Language", text: $sttLanguage)
        }
    }

    private var settingsLLMSection: some View {
        Section("AI / LLM Providers") {
            Picker("LLM Provider", selection: $llmProvider) {
                ForEach(llmProviders, id: \.self) { provider in
                    Text(provider.capitalized).tag(provider)
                }
            }

            TextField("OpenAI Model", text: $openaiModel)
            TextField("Codex Model", text: $codexModel)
            TextField("Anthropic Model", text: $anthropicModel)
            TextField("Local LLM Endpoint", text: $localLlmEndpoint)
                .textInputAutocapitalization(.never)
                .disableAutocorrection(true)
            TextField("Local LLM Model", text: $localLlmModel)
        }
    }

    private var settingsLLMPrioritySection: some View {
        Section("LLM Priority") {
            TextField("Provider order", text: $llmPriority)
                .textInputAutocapitalization(.never)
                .disableAutocorrection(true)
            Text("Comma-separated fallback order, for example local,codex,openai,anthropic.")
                .font(.footnote)
                .foregroundStyle(HBPalette.textSecondary)
        }
    }

    private var settingsIntegrationBasicsSection: some View {
        Section("Integration Basics") {
            Toggle("SmartThings uses OAuth", isOn: $smartthingsUseOAuth)
            TextField("Harmony Hub Addresses", text: $harmonyHubAddresses)
        }
    }

    private var settingsIntegrationTabsSection: some View {
        Section("Integration Tabs") {
            ForEach([
                SettingsWebArea.alexa,
                .codexSkill,
                .openClaw,
                .sense,
                .tempest,
                .rainMachine,
                .deviceIntegrations,
                .ecobee
            ].filter { !$0.isAdminOnly || isAdmin }) { area in
                Button {
                    selectedSettingsArea = area
                } label: {
                    HStack {
                        Label(area.title, systemImage: area.icon)
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(HBPalette.textMuted)
                    }
                }
            }
        }
    }

    private var settingsAPIKeysSection: some View {
        Section("API Keys & Tests") {
            SecureField("OpenAI API Key", text: $openaiApiKey)
            Button("Test OpenAI") {
                Task { await testOpenAI() }
            }

            SecureField("Anthropic API Key", text: $anthropicApiKey)
            Button("Test Anthropic") {
                Task { await testAnthropic() }
            }

            SecureField("ElevenLabs API Key", text: $elevenLabsApiKey)
            Button("Test ElevenLabs") {
                Task { await testElevenLabs() }
            }

            SecureField("SmartThings Token", text: $smartThingsToken)
            Button("Test SmartThings") {
                Task { await testSmartThings() }
            }
        }
    }

    private var settingsSecuritySection: some View {
        Section("Security") {
            Toggle("Enable Security Mode", isOn: $enableSecurityMode)

            Stepper(value: $authSessionMaxAgeDays, in: 30...3650, step: 30) {
                HStack {
                    Text("Session Lifetime")
                    Spacer()
                    Text("\(authSessionMaxAgeDays) days")
                        .foregroundStyle(HBPalette.textSecondary)
                }
            }

            Text("iOS refresh sessions remain configurable up to 365 days and beyond; browser defaults are handled separately by the backend.")
                .font(.footnote)
                .foregroundStyle(HBPalette.textSecondary)
        }
    }

    private func settingsOpenFullAreaSection(_ area: SettingsWebArea) -> some View {
        Section(area.title) {
            Text(area.subtitle)
                .font(.footnote)
                .foregroundStyle(HBPalette.textSecondary)

            Button {
                presentedWebSettingsArea = area
            } label: {
                Label("Open \(area.title) Controls", systemImage: area.icon)
            }
            .buttonStyle(.borderedProminent)
            .tint(HBPalette.accentBlue)
        }
    }

    private var settingsPlatformAdminSection: some View {
        Section("Platform Admin") {
            ForEach(SettingsParitySurface.allCases) { surface in
                Button {
                    presentedSettingsSurface = surface
                } label: {
                    Label(surface.title, systemImage: surface.icon)
                }
            }
        }
    }

    @ViewBuilder
    private func settingsWebAreaView(_ area: SettingsWebArea) -> some View {
        switch area {
        case .general:
            Form {
                Section("Connection") {
                    TextField("Server URL", text: $serverURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .disableAutocorrection(true)

                    Button("Apply Server URL") {
                        if session.updateServerURL(serverURL) {
                            serverURL = session.serverURLString
                            infoMessage = "Server URL updated."
                            errorMessage = nil
                        } else {
                            errorMessage = "Enter a valid server URL."
                        }
                    }
                }

                Section("General") {
                    TextField("Location", text: $location)
                    TextField("Timezone", text: $timezone)
                    Toggle("Enable Notifications", isOn: $enableNotifications)
                    Toggle("Enable Security Mode", isOn: $enableSecurityMode)
                    Toggle("Enable Auto Discovery", isOn: $autoDiscoveryEnabled)
                }

                settingsSaveRefreshSection
            }
            .hbFormStyle()

        case .voice:
            Form {
                Section("Voice") {
                    HStack {
                        Text("Wake Word Sensitivity")
                        Spacer()
                        Text(String(format: "%.2f", wakeWordSensitivity))
                            .foregroundStyle(HBPalette.textSecondary)
                    }
                    Slider(value: $wakeWordSensitivity, in: 0.1...1)

                    HStack {
                        Text("Voice Volume")
                        Spacer()
                        Text(String(format: "%.2f", voiceVolume))
                            .foregroundStyle(HBPalette.textSecondary)
                    }
                    Slider(value: $voiceVolume, in: 0.1...1)

                    HStack {
                        Text("Mic Sensitivity")
                        Spacer()
                        Text(String(format: "%.2f", microphoneSensitivity))
                            .foregroundStyle(HBPalette.textSecondary)
                    }
                    Slider(value: $microphoneSensitivity, in: 0.1...1)

                    Toggle("Enable Voice Confirmation", isOn: $enableVoiceConfirmation)
                }

                Section("STT") {
                    Picker("Provider", selection: $sttProvider) {
                        ForEach(sttProviders, id: \.self) { provider in
                            Text(provider.capitalized).tag(provider)
                        }
                    }

                    TextField("STT Model", text: $sttModel)
                    TextField("STT Language", text: $sttLanguage)
                }

                settingsSaveRefreshSection
            }
            .hbFormStyle()

        case .integrations:
            Form {
                Section("Integration Tabs") {
                    ForEach([
                        SettingsWebArea.alexa,
                        .codexSkill,
                        .openClaw,
                        .sense,
                        .tempest,
                        .rainMachine,
                        .deviceIntegrations,
                        .ecobee
                    ]) { child in
                        Button {
                            presentedWebSettingsArea = child
                        } label: {
                            Label(child.title, systemImage: child.icon)
                        }
                    }
                }
            }
            .hbFormStyle()

        case .alexa:
            SettingsEndpointPane(
                title: "Alexa",
                subtitle: "Broker pairing, link codes, discovery sync, and event delivery controls.",
                statusPath: "/api/alexa",
                actions: [
                    SettingsEndpointAction(title: "Generate Private Link Code", method: .post, path: "/api/alexa/link-codes", body: ["mode": "private"]),
                    SettingsEndpointAction(title: "Generate Public Link Code", method: .post, path: "/api/alexa/link-codes", body: ["mode": "public"]),
                    SettingsEndpointAction(title: "Force Discovery Sync", method: .post, path: "/api/alexa/discovery-sync", body: ["reason": "ios-settings"]),
                    SettingsEndpointAction(title: "Flush Broker Events", method: .post, path: "/api/alexa/events/flush", body: ["limit": 100])
                ]
            )

        case .codexSkill:
            SettingsEndpointPane(
                title: "Codex Skill",
                subtitle: "HomeBrain live skill status, token lifecycle, and bundle metadata.",
                statusPath: "/api/codex-skill",
                actions: [
                    SettingsEndpointAction(title: "Rotate Token", method: .post, path: "/api/codex-skill/token/rotate"),
                    SettingsEndpointAction(title: "Revoke Token", method: .delete, path: "/api/codex-skill/token")
                ]
            )

        case .openClaw:
            OpenClawIntegrationView()

        case .sense:
            SenseEnergyView()

        case .tempest:
            WeatherView()

        case .rainMachine:
            RainMachineView()

        case .deviceIntegrations:
            SettingsDeviceIntegrationsPane(
                harmonyHubAddresses: $harmonyHubAddresses,
                smartthingsUseOAuth: $smartthingsUseOAuth,
                smartThingsToken: $smartThingsToken,
                onSave: { Task { await saveSettings() } },
                onTestSmartThings: { Task { await testSmartThings() } }
            )

        case .ecobee:
            SettingsEndpointPane(
                title: "Ecobee",
                subtitle: "OAuth status, connection testing, and synced thermostat inventory.",
                statusPath: "/api/ecobee/status",
                actions: [
                    SettingsEndpointAction(title: "Get Auth URL", method: .get, path: "/api/ecobee/auth/url"),
                    SettingsEndpointAction(title: "Test Connection", method: .post, path: "/api/ecobee/test"),
                    SettingsEndpointAction(title: "Refresh Devices", method: .get, path: "/api/ecobee/devices", query: [URLQueryItem(name: "refresh", value: "1")]),
                    SettingsEndpointAction(title: "Disconnect", method: .post, path: "/api/ecobee/disconnect")
                ]
            )

        case .apiKeys:
            Form {
                Section("API Keys & Tests") {
                    SecureField("OpenAI API Key", text: $openaiApiKey)
                    Button("Test OpenAI") {
                        Task { await testOpenAI() }
                    }

                    SecureField("Anthropic API Key", text: $anthropicApiKey)
                    Button("Test Anthropic") {
                        Task { await testAnthropic() }
                    }

                    SecureField("ElevenLabs API Key", text: $elevenLabsApiKey)
                    Button("Test ElevenLabs") {
                        Task { await testElevenLabs() }
                    }

                    SecureField("SmartThings Token", text: $smartThingsToken)
                    Button("Test SmartThings") {
                        Task { await testSmartThings() }
                    }
                }

                settingsSaveRefreshSection
            }
            .hbFormStyle()

        case .aiProviders:
            Form {
                Section("LLM") {
                    Picker("LLM Provider", selection: $llmProvider) {
                        ForEach(llmProviders, id: \.self) { provider in
                            Text(provider.capitalized).tag(provider)
                        }
                    }

                    TextField("OpenAI Model", text: $openaiModel)
                    TextField("Codex Model", text: $codexModel)
                    TextField("Anthropic Model", text: $anthropicModel)
                    TextField("Local LLM Endpoint", text: $localLlmEndpoint)
                        .textInputAutocapitalization(.never)
                        .disableAutocorrection(true)
                    TextField("Local LLM Model", text: $localLlmModel)
                }

                settingsSaveRefreshSection
            }
            .hbFormStyle()

        case .llmPriority:
            Form {
                Section("LLM Priority") {
                    TextField("Provider order", text: $llmPriority)
                        .textInputAutocapitalization(.never)
                        .disableAutocorrection(true)
                    Text("Comma-separated fallback order, for example local,codex,openai,anthropic.")
                        .font(.footnote)
                        .foregroundStyle(HBPalette.textSecondary)
                }

                settingsSaveRefreshSection
            }
            .hbFormStyle()

        case .hardwareOrbs:
            Form {
                settingsHardwareOrbsSection
            }
            .hbFormStyle()

        case .security:
            Form {
                Section("Security") {
                    Toggle("Enable Security Mode", isOn: $enableSecurityMode)
                    Stepper(value: $authSessionMaxAgeDays, in: 30...3650, step: 30) {
                        HStack {
                            Text("Session Lifetime")
                            Spacer()
                            Text("\(authSessionMaxAgeDays) days")
                                .foregroundStyle(HBPalette.textSecondary)
                        }
                    }

                    Text("iOS refresh sessions remain configurable up to 365 days and beyond; browser defaults are handled separately by the backend.")
                        .font(.footnote)
                        .foregroundStyle(HBPalette.textSecondary)
                }

                settingsSessionsSection
                settingsSaveRefreshSection
            }
            .hbFormStyle()

        case .resources:
            SettingsEndpointPane(
                title: "Resources",
                subtitle: "Live platform resource utilization, including Jetson GPU telemetry where available.",
                statusPath: "/api/resources/utilization",
                actions: [
                    SettingsEndpointAction(title: "Refresh Resource Snapshot", method: .get, path: "/api/resources/utilization"),
                    SettingsEndpointAction(title: "Run Deploy Health", method: .get, path: "/api/platform-deploy/health")
                ]
            )

        case .maintenance:
            SettingsMaintenancePane()

        case .platformAdmin:
            Form {
                Section("Platform Admin") {
                    ForEach(SettingsParitySurface.allCases) { surface in
                        Button {
                            presentedSettingsSurface = surface
                            presentedWebSettingsArea = nil
                        } label: {
                            Label(surface.title, systemImage: surface.icon)
                        }
                    }
                }
            }
            .hbFormStyle()
        }
    }

    private var settingsSaveRefreshSection: some View {
        Section {
            Button("Save Settings") {
                Task { await saveSettings() }
            }
            .buttonStyle(.borderedProminent)
            .tint(HBPalette.accentBlue)

            Button("Refresh Settings") {
                Task { await loadSettings() }
            }
            .buttonStyle(.bordered)
        }
    }

    private var settingsSessionsSection: some View {
        Section("Sessions") {
            if authSessions.isEmpty {
                Text("No active sessions found for this account.")
                    .font(.subheadline)
                    .foregroundStyle(HBPalette.textSecondary)
            } else {
                ForEach(authSessions) { authSession in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(authSession.clientName)
                                .font(.headline)
                            Spacer()
                            if authSession.isCurrent {
                                Text("This device")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(HBPalette.accentBlue)
                            }
                        }

                        Text("Last used: \(settingsFormatDateTime(authSession.lastUsedAt))")
                            .font(.caption)
                            .foregroundStyle(HBPalette.textSecondary)
                        Text("Expires: \(settingsFormatDateTime(authSession.expiresAt))")
                            .font(.caption)
                            .foregroundStyle(HBPalette.textSecondary)

                        if !authSession.isCurrent {
                            Button("Revoke Session") {
                                Task { await revokeAuthSession(authSession) }
                            }
                            .disabled(revokingSessionIDs.contains(authSession.id))
                        }
                    }
                }
            }

            Button("Refresh Session List") {
                Task { await loadAuthSessions() }
            }
        }
    }

    private var settingsHardwareOrbsSection: some View {
        Section("Hardware Orbs") {
            Text("Rotate each orb UI in 0.5° steps to compensate for wall mounting. Changes save per device and sync through HomeBrain.")
                .font(.footnote)
                .foregroundStyle(HBPalette.textSecondary)

            if let hardwareOrbLoadError {
                Text(hardwareOrbLoadError)
                    .font(.footnote)
                    .foregroundStyle(HBPalette.accentRed)
            } else if hardwareOrbs.isEmpty {
                Text("No hardware orbs registered yet.")
                    .font(.subheadline)
                    .foregroundStyle(HBPalette.textSecondary)
            } else {
                ForEach(hardwareOrbs) { hardwareOrb in
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(hardwareOrb.name)
                                    .font(.headline)
                                Text("\(hardwareOrb.room) · \(hardwareOrb.statusLabel)")
                                    .font(.caption)
                                    .foregroundStyle(HBPalette.textSecondary)
                            }
                            Spacer()
                            Text(hardwareOrb.formattedMountOffset)
                                .font(.headline.monospacedDigit())
                        }

                        HStack(spacing: 8) {
                            Button {
                                Task {
                                    await adjustHardwareOrbRotation(
                                        hardwareOrb,
                                        deltaTenths: -HardwareOrbRecord.mountOffsetStepTenths
                                    )
                                }
                            } label: {
                                Label("Left", systemImage: "rotate.left")
                            }
                            .disabled(savingHardwareOrbIDs.contains(hardwareOrb.id))

                            Button("Reset") {
                                Task { await setHardwareOrbRotation(hardwareOrb, offsetTenths: 0) }
                            }
                            .disabled(savingHardwareOrbIDs.contains(hardwareOrb.id) || hardwareOrb.mountOffsetTenths == 0)

                            Button {
                                Task {
                                    await adjustHardwareOrbRotation(
                                        hardwareOrb,
                                        deltaTenths: HardwareOrbRecord.mountOffsetStepTenths
                                    )
                                }
                            } label: {
                                Label("Right", systemImage: "rotate.right")
                            }
                            .disabled(savingHardwareOrbIDs.contains(hardwareOrb.id))
                        }
                    }
                    .padding(.vertical, 4)
                }
            }

            Button("Refresh Hardware Orbs") {
                Task { await loadHardwareOrbs() }
            }
        }
    }

    private func loadSettings() async {
        isLoading = true
        errorMessage = nil

        do {
            let settingsResponse = try await session.apiClient.get("/api/settings")
            let object = JSON.object(settingsResponse)
            let settings = JSON.object(object["settings"])

            authSessionMaxAgeDays = max(1, JSON.int(settings, "authSessionMaxAgeDays", fallback: authSessionMaxAgeDays))
            location = JSON.string(settings, "location", fallback: location)
            timezone = JSON.string(settings, "timezone", fallback: TimeZone.current.identifier)
            wakeWordSensitivity = JSON.double(settings, "wakeWordSensitivity", fallback: wakeWordSensitivity)
            voiceVolume = JSON.double(settings, "voiceVolume", fallback: voiceVolume)
            microphoneSensitivity = JSON.double(settings, "microphoneSensitivity", fallback: microphoneSensitivity)
            enableVoiceConfirmation = JSON.bool(settings, "enableVoiceConfirmation", fallback: enableVoiceConfirmation)
            enableNotifications = JSON.bool(settings, "enableNotifications", fallback: enableNotifications)
            enableSecurityMode = JSON.bool(settings, "enableSecurityMode", fallback: enableSecurityMode)
            autoDiscoveryEnabled = JSON.bool(settings, "autoDiscoveryEnabled", fallback: autoDiscoveryEnabled)

            llmProvider = JSON.string(settings, "llmProvider", fallback: llmProvider)
            openaiModel = JSON.string(settings, "openaiModel", fallback: openaiModel)
            codexModel = JSON.string(settings, "codexModel", fallback: codexModel)
            anthropicModel = JSON.string(settings, "anthropicModel", fallback: anthropicModel)
            localLlmEndpoint = JSON.string(settings, "localLlmEndpoint", fallback: localLlmEndpoint)
            localLlmModel = JSON.string(settings, "localLlmModel", fallback: localLlmModel)

            sttProvider = JSON.string(settings, "sttProvider", fallback: sttProvider)
            sttModel = JSON.string(settings, "sttModel", fallback: sttModel)
            sttLanguage = JSON.string(settings, "sttLanguage", fallback: sttLanguage)

            smartthingsUseOAuth = JSON.bool(settings, "smartthingsUseOAuth", fallback: smartthingsUseOAuth)
            harmonyHubAddresses = JSON.string(settings, "harmonyHubAddresses", fallback: harmonyHubAddresses)

            if let priorityResponse = try? await session.apiClient.get("/api/settings/llm-priority") {
                let priorityObject = JSON.object(priorityResponse)
                if let list = priorityObject["priorityList"] as? [String], !list.isEmpty {
                    llmPriority = list.joined(separator: ",")
                }
            }

            serverURL = session.serverURLString
            await loadAuthSessions()
            await loadHardwareOrbs()
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    private func saveSettings() async {
        do {
            guard session.updateServerURL(serverURL) else {
                errorMessage = "Enter a valid server URL."
                return
            }
            serverURL = session.serverURLString

            let payload: [String: Any] = [
                "location": location,
                "timezone": timezone,
                "wakeWordSensitivity": wakeWordSensitivity,
                "voiceVolume": voiceVolume,
                "microphoneSensitivity": microphoneSensitivity,
                "enableVoiceConfirmation": enableVoiceConfirmation,
                "enableNotifications": enableNotifications,
                "enableSecurityMode": enableSecurityMode,
                "autoDiscoveryEnabled": autoDiscoveryEnabled,
                "llmProvider": llmProvider,
                "openaiModel": openaiModel,
                "codexModel": codexModel,
                "anthropicModel": anthropicModel,
                "localLlmEndpoint": localLlmEndpoint,
                "localLlmModel": localLlmModel,
                "sttProvider": sttProvider,
                "sttModel": sttModel,
                "sttLanguage": sttLanguage,
                "smartthingsUseOAuth": smartthingsUseOAuth,
                "harmonyHubAddresses": harmonyHubAddresses,
                "openaiApiKey": openaiApiKey,
                "anthropicApiKey": anthropicApiKey,
                "elevenlabsApiKey": elevenLabsApiKey,
                "smartthingsToken": smartThingsToken,
                "authSessionMaxAgeDays": authSessionMaxAgeDays
            ]

            let response = try await session.apiClient.put("/api/settings", body: payload)
            let object = JSON.object(response)
            infoMessage = JSON.string(object, "message", fallback: "Settings saved.")
            errorMessage = nil

            let priorityValues = llmPriority
                .split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }

            if !priorityValues.isEmpty {
                _ = try? await session.apiClient.put("/api/settings/llm-priority", body: ["priorityList": priorityValues])
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func testOpenAI() async {
        do {
            let payload: [String: Any] = ["apiKey": openaiApiKey, "model": openaiModel]
            let response = try await session.apiClient.post("/api/settings/test-openai", body: payload)
            let object = JSON.object(response)
            infoMessage = JSON.string(object, "message", fallback: "OpenAI test passed.")
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func testAnthropic() async {
        do {
            let payload: [String: Any] = ["apiKey": anthropicApiKey, "model": anthropicModel]
            let response = try await session.apiClient.post("/api/settings/test-anthropic", body: payload)
            let object = JSON.object(response)
            infoMessage = JSON.string(object, "message", fallback: "Anthropic test passed.")
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func testElevenLabs() async {
        do {
            let payload: [String: Any] = ["apiKey": elevenLabsApiKey]
            let response = try await session.apiClient.post("/api/settings/test-elevenlabs", body: payload)
            let object = JSON.object(response)
            infoMessage = JSON.string(object, "message", fallback: "ElevenLabs test passed.")
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func testSmartThings() async {
        do {
            let payload: [String: Any] = ["token": smartThingsToken, "useOAuth": smartthingsUseOAuth]
            let response = try await session.apiClient.post("/api/settings/test-smartthings", body: payload)
            let object = JSON.object(response)
            infoMessage = JSON.string(object, "message", fallback: "SmartThings test passed.")
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func loadAuthSessions() async {
        do {
            let response = try await session.apiClient.get("/api/auth/sessions")
            let object = JSON.object(response)
            authSessionMaxAgeDays = max(1, JSON.int(object, "lifetimeDays", fallback: authSessionMaxAgeDays))
            authSessions = (object["sessions"] as? [Any] ?? [])
                .compactMap { AuthSessionRecord.from(JSON.object($0)) }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func revokeAuthSession(_ authSession: AuthSessionRecord) async {
        revokingSessionIDs.insert(authSession.id)
        defer { revokingSessionIDs.remove(authSession.id) }

        do {
            let response = try await session.apiClient.delete("/api/auth/sessions/\(authSession.id)")
            let object = JSON.object(response)
            let message = JSON.string(object, "message", fallback: "Session revoked.")

            if JSON.bool(object, "signedOutCurrentSession") {
                session.expireAuthentication(message: message)
            } else {
                infoMessage = message
                authSessions.removeAll { $0.id == authSession.id }
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func loadHardwareOrbs() async {
        hardwareOrbLoadError = nil

        do {
            let response = try await session.apiClient.get("/api/panels")
            let object = JSON.object(response)
            hardwareOrbs = JSON.array(object["panels"])
                .compactMap(HardwareOrbRecord.from)
                .sorted { lhs, rhs in
                    if lhs.room.localizedCaseInsensitiveCompare(rhs.room) == .orderedSame {
                        return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
                    }
                    return lhs.room.localizedCaseInsensitiveCompare(rhs.room) == .orderedAscending
                }
        } catch {
            hardwareOrbs = []
            hardwareOrbLoadError = error.localizedDescription
        }
    }

    private func adjustHardwareOrbRotation(_ hardwareOrb: HardwareOrbRecord, deltaTenths: Int) async {
        await setHardwareOrbRotation(
            hardwareOrb,
            offsetTenths: hardwareOrb.mountOffsetTenths + deltaTenths
        )
    }

    private func setHardwareOrbRotation(_ hardwareOrb: HardwareOrbRecord, offsetTenths: Int) async {
        let clampedOffset = HardwareOrbRecord.clampMountOffset(offsetTenths)
        guard clampedOffset != hardwareOrb.mountOffsetTenths else {
            return
        }

        let previousHardwareOrbs = hardwareOrbs
        updateHardwareOrb(id: hardwareOrb.id) { current in
            var updated = current
            updated.mountOffsetTenths = clampedOffset
            return updated
        }

        savingHardwareOrbIDs.insert(hardwareOrb.id)
        defer { savingHardwareOrbIDs.remove(hardwareOrb.id) }

        do {
            let response = try await session.apiClient.put(
                "/api/panels/\(hardwareOrb.id)",
                body: [
                    "settings": [
                        "mountAlignment": [
                            "offsetTenths": clampedOffset
                        ]
                    ]
                ]
            )
            let object = JSON.object(response)
            if let refreshed = HardwareOrbRecord.from(JSON.object(object["panel"])) {
                updateHardwareOrb(id: refreshed.id) { _ in refreshed }
            }
            infoMessage = "\(hardwareOrb.name) mount offset updated to \(HardwareOrbRecord.formattedMountOffset(clampedOffset))."
            errorMessage = nil
        } catch {
            hardwareOrbs = previousHardwareOrbs
            hardwareOrbLoadError = error.localizedDescription
        }
    }

    private func updateHardwareOrb(
        id: String,
        transform: (HardwareOrbRecord) -> HardwareOrbRecord
    ) {
        hardwareOrbs = hardwareOrbs.map { hardwareOrb in
            guard hardwareOrb.id == id else {
                return hardwareOrb
            }
            return transform(hardwareOrb)
        }
    }
}

private struct SettingsEndpointAction: Identifiable {
    let id = UUID()
    let title: String
    let method: HTTPMethod
    let path: String
    var body: Any?
    var query: [URLQueryItem] = []
}

private struct SettingsEndpointPane: View {
    @EnvironmentObject private var session: SessionStore

    let title: String
    let subtitle: String
    let statusPath: String
    let actions: [SettingsEndpointAction]

    @State private var isLoading = true
    @State private var activeActionID: UUID?
    @State private var errorMessage: String?
    @State private var statusPayload: Any?
    @State private var actionPayload: Any?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                HBSectionHeader(title: title, subtitle: subtitle)

                if let errorMessage {
                    InlineErrorView(message: errorMessage) {
                        Task { await loadStatus() }
                    }
                }

                GroupBox("Status") {
                    VStack(alignment: .leading, spacing: 10) {
                        if isLoading {
                            ProgressView()
                        } else {
                            Text(JSON.prettyString(statusPayload))
                                .font(.system(.caption, design: .monospaced))
                                .textSelection(.enabled)
                                .foregroundStyle(HBPalette.textSecondary)
                        }

                        Button("Refresh Status") {
                            Task { await loadStatus() }
                        }
                        .buttonStyle(.bordered)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                if !actions.isEmpty {
                    GroupBox("Actions") {
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(actions) { action in
                                SettingsEndpointActionButton(
                                    action: action,
                                    isActive: activeActionID == action.id,
                                    isDisabled: activeActionID != nil
                                ) { selectedAction in
                                    trigger(selectedAction)
                                }
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }

                if let actionPayload {
                    GroupBox("Latest Result") {
                        Text(JSON.prettyString(actionPayload))
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                            .foregroundStyle(HBPalette.textSecondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .padding()
        }
        .groupBoxStyle(HBPanelGroupBoxStyle())
        .task {
            await loadStatus()
        }
        .refreshable {
            await loadStatus()
        }
    }

    private func loadStatus() async {
        isLoading = true
        errorMessage = nil

        do {
            statusPayload = try await session.apiClient.get(statusPath)
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    private func trigger(_ action: SettingsEndpointAction) {
        Task { await run(action) }
    }

    private func run(_ action: SettingsEndpointAction) async {
        activeActionID = action.id
        errorMessage = nil
        defer { activeActionID = nil }

        do {
            let response: Any
            switch action.method {
            case .get:
                response = try await session.apiClient.get(action.path, query: action.query)
            case .post:
                response = try await session.apiClient.post(action.path, body: action.body)
            case .put:
                response = try await session.apiClient.put(action.path, body: action.body)
            case .patch:
                response = try await session.apiClient.patch(action.path, body: action.body)
            case .delete:
                response = try await session.apiClient.delete(action.path)
            }

            actionPayload = response
            await loadStatus()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct SettingsEndpointActionButton: View {
    let action: SettingsEndpointAction
    let isActive: Bool
    let isDisabled: Bool
    let onTap: (SettingsEndpointAction) -> Void

    var body: some View {
        if action.method == .delete {
            Button {
                onTap(action)
            } label: {
                actionLabel
            }
            .buttonStyle(.bordered)
            .tint(HBPalette.accentRed)
            .disabled(isDisabled)
        } else {
            Button {
                onTap(action)
            } label: {
                actionLabel
            }
            .buttonStyle(.borderedProminent)
            .tint(HBPalette.accentBlue)
            .disabled(isDisabled)
        }
    }

    @ViewBuilder
    private var actionLabel: some View {
        if isActive {
            ProgressView()
        } else {
            Label(action.title, systemImage: iconName(for: action.method))
        }
    }

    private func iconName(for method: HTTPMethod) -> String {
        switch method {
        case .get: return "arrow.clockwise"
        case .post: return "play.fill"
        case .put, .patch: return "square.and.arrow.down"
        case .delete: return "trash"
        }
    }
}

private struct SettingsDeviceIntegrationsPane: View {
    @EnvironmentObject private var session: SessionStore

    @Binding var harmonyHubAddresses: String
    @Binding var smartthingsUseOAuth: Bool
    @Binding var smartThingsToken: String

    let onSave: () -> Void
    let onTestSmartThings: () -> Void

    @State private var activeAction = ""
    @State private var message = ""
    @State private var resultPayload: Any?

    var body: some View {
        Form {
            Section("SmartThings") {
                Toggle("Use OAuth", isOn: $smartthingsUseOAuth)
                SecureField("Legacy Token", text: $smartThingsToken)
                Button("Save SmartThings Settings") { onSave() }
                Button("Test SmartThings") { onTestSmartThings() }
                actionButton("Status", key: "smartthings-status", method: .get, path: "/api/smartthings/status")
                actionButton("Get Auth URL", key: "smartthings-auth-url", method: .get, path: "/api/smartthings/auth/url")
                actionButton("Refresh Devices", key: "smartthings-devices", method: .get, path: "/api/smartthings/devices")
                actionButton("Disconnect", key: "smartthings-disconnect", method: .post, path: "/api/smartthings/disconnect")
            }

            Section("Harmony") {
                TextField("Hub IPs / Hosts", text: $harmonyHubAddresses)
                    .textInputAutocapitalization(.never)
                    .disableAutocorrection(true)
                Button("Save Harmony Settings") { onSave() }
                actionButton("Harmony Status", key: "harmony-status", method: .get, path: "/api/harmony/status")
                actionButton("Discover Hubs", key: "harmony-discover", method: .post, path: "/api/harmony/discover", body: ["timeoutMs": 5000])
                actionButton("Sync Devices", key: "harmony-sync", method: .post, path: "/api/harmony/sync", body: ["timeoutMs": 6000])
                actionButton("Sync Activity State", key: "harmony-sync-state", method: .post, path: "/api/harmony/sync-state")
            }

            Section("INSTEON") {
                actionButton("Runtime Status", key: "insteon-status", method: .get, path: "/api/insteon/status")
                actionButton("Scan Serial Ports", key: "insteon-ports", method: .get, path: "/api/insteon/serial-ports")
                actionButton("Test PLM", key: "insteon-test", method: .get, path: "/api/insteon/test")
                actionButton("Soft Reset PLM", key: "insteon-soft-reset", method: .post, path: "/api/insteon/maintenance/soft-reset")
                actionButton("Cancel Active Command", key: "insteon-cancel", method: .post, path: "/api/insteon/maintenance/cancel-active")
                actionButton("Clear Queue", key: "insteon-clear-queue", method: .post, path: "/api/insteon/maintenance/clear-queue")
                actionButton("Pause Runtime Monitoring", key: "insteon-pause", method: .post, path: "/api/insteon/maintenance/runtime-monitoring/stop")
                actionButton("Resume Runtime Monitoring", key: "insteon-resume", method: .post, path: "/api/insteon/maintenance/runtime-monitoring/start", body: ["immediate": true])
            }

            if !message.isEmpty {
                Section("Message") {
                    Text(message)
                        .font(.subheadline)
                        .foregroundStyle(HBPalette.textSecondary)
                }
            }

            if let resultPayload {
                Section("Latest Result") {
                    Text(JSON.prettyString(resultPayload))
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .foregroundStyle(HBPalette.textSecondary)
                }
            }
        }
        .hbFormStyle()
    }

    private func actionButton(
        _ title: String,
        key: String,
        method: HTTPMethod,
        path: String,
        body: Any? = nil
    ) -> some View {
        Button {
            Task { await runAction(key: key, method: method, path: path, body: body) }
        } label: {
            if activeAction == key {
                ProgressView()
            } else {
                Label(title, systemImage: method == .get ? "arrow.clockwise" : "play.fill")
            }
        }
        .disabled(!activeAction.isEmpty)
    }

    private func runAction(key: String, method: HTTPMethod, path: String, body: Any?) async {
        activeAction = key
        message = ""
        defer { activeAction = "" }

        do {
            let response: Any
            switch method {
            case .get:
                response = try await session.apiClient.get(path)
            case .post:
                response = try await session.apiClient.post(path, body: body)
            case .put:
                response = try await session.apiClient.put(path, body: body)
            case .patch:
                response = try await session.apiClient.patch(path, body: body)
            case .delete:
                response = try await session.apiClient.delete(path)
            }

            resultPayload = response
            let object = JSON.object(response)
            message = JSON.string(object, "message", fallback: "Action completed.")
        } catch {
            message = error.localizedDescription
        }
    }
}

private struct SettingsMaintenancePane: View {
    @EnvironmentObject private var session: SessionStore

    @State private var activeAction = ""
    @State private var message = ""
    @State private var resultPayload: Any?

    var body: some View {
        Form {
            Section("Diagnostics") {
                actionButton("Run Health Check", key: "health", method: .get, path: "/api/maintenance/health")
                actionButton("Export Configuration", key: "export", method: .get, path: "/api/maintenance/export")
                actionButton("Latest Restore Status", key: "restore-latest", method: .get, path: "/api/maintenance/restore/latest")
            }

            Section("Sync") {
                actionButton("Sync SmartThings", key: "sync-smartthings", method: .post, path: "/api/maintenance/sync/smartthings")
                actionButton("Sync Harmony", key: "sync-harmony", method: .post, path: "/api/maintenance/sync/harmony")
                actionButton("Start INSTEON Sync", key: "sync-insteon", method: .post, path: "/api/maintenance/sync/insteon/start", body: ["skipExisting": false])
            }

            Section("Destructive Operations") {
                actionButton("Reset Settings", key: "reset-settings", method: .post, path: "/api/maintenance/reset/settings")
                actionButton("Clear Voice History", key: "clear-voice", method: .delete, path: "/api/maintenance/voice-commands")
                actionButton("Clear SmartThings Devices", key: "clear-smartthings", method: .delete, path: "/api/maintenance/devices/smartthings")
                actionButton("Clear Harmony Devices", key: "clear-harmony", method: .delete, path: "/api/maintenance/devices/harmony")
                actionButton("Clear INSTEON Devices", key: "clear-insteon", method: .delete, path: "/api/maintenance/devices/insteon")
            }

            if !message.isEmpty {
                Section("Message") {
                    Text(message)
                        .font(.subheadline)
                        .foregroundStyle(HBPalette.textSecondary)
                }
            }

            if let resultPayload {
                Section("Latest Result") {
                    Text(JSON.prettyString(resultPayload))
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .foregroundStyle(HBPalette.textSecondary)
                }
            }
        }
        .hbFormStyle()
    }

    private func actionButton(
        _ title: String,
        key: String,
        method: HTTPMethod,
        path: String,
        body: Any? = nil
    ) -> some View {
        Button(role: method == .delete ? .destructive : nil) {
            Task { await runAction(key: key, method: method, path: path, body: body) }
        } label: {
            if activeAction == key {
                ProgressView()
            } else {
                Label(title, systemImage: method == .delete ? "trash" : "play.fill")
            }
        }
        .disabled(!activeAction.isEmpty)
    }

    private func runAction(key: String, method: HTTPMethod, path: String, body: Any?) async {
        activeAction = key
        message = ""
        defer { activeAction = "" }

        do {
            let response: Any
            switch method {
            case .get:
                response = try await session.apiClient.get(path)
            case .post:
                response = try await session.apiClient.post(path, body: body)
            case .put:
                response = try await session.apiClient.put(path, body: body)
            case .patch:
                response = try await session.apiClient.patch(path, body: body)
            case .delete:
                response = try await session.apiClient.delete(path)
            }

            resultPayload = response
            let object = JSON.object(response)
            message = JSON.string(object, "message", fallback: "Action completed.")
        } catch {
            message = error.localizedDescription
        }
    }
}

private struct AuthSessionRecord: Identifiable {
    let id: String
    let clientType: String
    let clientName: String
    let createdAt: String
    let lastUsedAt: String
    let expiresAt: String
    let isCurrent: Bool

    static func from(_ object: [String: Any]) -> AuthSessionRecord? {
        let id = JSON.string(object, "id")
        guard !id.isEmpty else {
            return nil
        }

        return AuthSessionRecord(
            id: id,
            clientType: JSON.string(object, "clientType", fallback: "unknown"),
            clientName: JSON.string(object, "clientName", fallback: "Unknown device"),
            createdAt: JSON.string(object, "createdAt"),
            lastUsedAt: JSON.string(object, "lastUsedAt"),
            expiresAt: JSON.string(object, "expiresAt"),
            isCurrent: JSON.bool(object, "isCurrent")
        )
    }
}

private func settingsFormatDateTime(_ value: String) -> String {
    guard let date = ISO8601DateFormatter().date(from: value) else {
        return value.isEmpty ? "Unknown" : value
    }

    return date.formatted(date: .abbreviated, time: .shortened)
}

private struct HardwareOrbRecord: Identifiable {
    static let mountOffsetMinimumTenths = -150
    static let mountOffsetMaximumTenths = 150
    static let mountOffsetStepTenths = 5

    let id: String
    let name: String
    let room: String
    let status: String
    var mountOffsetTenths: Int
    let firmwareVersion: String
    let latestFirmwareVersion: String
    let updateAvailable: Bool

    var statusLabel: String {
        status.isEmpty ? "Unknown" : status.capitalized
    }

    var formattedMountOffset: String {
        Self.formattedMountOffset(mountOffsetTenths)
    }

    var firmwareVersionDisplay: String {
        firmwareVersion.isEmpty ? "older firmware" : firmwareVersion
    }

    var latestFirmwareVersionDisplay: String {
        latestFirmwareVersion.isEmpty ? "the latest OTA" : latestFirmwareVersion
    }

    var requiresFirmwareUpdate: Bool {
        updateAvailable || !firmwareVersion.isEmpty && firmwareVersion != latestFirmwareVersion
    }

    static func from(_ object: [String: Any]) -> HardwareOrbRecord? {
        let id = JSON.id(object)
        guard !id.isEmpty else {
            return nil
        }

        let settings = JSON.object(object["settings"])
        let mountAlignment = JSON.object(settings["mountAlignment"])

        return HardwareOrbRecord(
            id: id,
            name: JSON.string(object, "name", fallback: "Unnamed Orb"),
            room: JSON.string(object, "room", fallback: "Unassigned"),
            status: JSON.string(object, "status", fallback: "offline"),
            mountOffsetTenths: clampMountOffset(JSON.int(mountAlignment, "offsetTenths")),
            firmwareVersion: JSON.string(object, "firmwareVersion"),
            latestFirmwareVersion: JSON.string(object, "latestFirmwareVersion"),
            updateAvailable: JSON.bool(object, "updateAvailable")
        )
    }

    static func clampMountOffset(_ value: Int) -> Int {
        min(max(value, mountOffsetMinimumTenths), mountOffsetMaximumTenths)
    }

    static func formattedMountOffset(_ value: Int) -> String {
        let clamped = clampMountOffset(value)
        let sign = clamped > 0 ? "+" : ""
        return "\(sign)\(String(format: "%.1f", Double(clamped) / 10.0))°"
    }
}
