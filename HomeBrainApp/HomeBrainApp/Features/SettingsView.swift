import SwiftUI
import UIKit

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

private enum HardwareOrbSettingsTab: String, CaseIterable, Identifiable {
    case fleet
    case firmware
    case provisioning
    case alignment

    var id: String { rawValue }

    var title: String {
        switch self {
        case .fleet: return "Fleet"
        case .firmware: return "Firmware"
        case .provisioning: return "Provisioning"
        case .alignment: return "Alignment"
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
    @State private var selectedHardwareOrbID = ""
    @State private var selectedHardwareOrbTab: HardwareOrbSettingsTab = .firmware
    @State private var hardwareOrbWifiSsid = ""
    @State private var hardwareOrbWifiSavedSsid = ""
    @State private var hardwareOrbWifiPassword = ""
    @State private var hardwareOrbWifiPasswordConfigured = false
    @State private var savingHardwareOrbWifi = false
    @State private var pushingHardwareOrbFirmwareIDs: Set<String> = []
    @State private var provisioningHardwareOrbIDs: Set<String> = []
    @State private var rotatingHardwareOrbIDs: Set<String> = []
    @State private var creatingHardwareOrb = false
    @State private var usbProvisioningHardwareOrb = false
    @State private var hardwareOrbProvisioningPacket: HardwareOrbProvisioningPacket?
    @State private var newHardwareOrbName = ""
    @State private var newHardwareOrbRoom = ""
    @State private var newHardwareOrbHardwareProfile = "elecrow-crowpanel-2.1-rotary"
    @State private var newHardwareOrbPowerSource = "wired"

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

    private var selectedHardwareOrb: HardwareOrbRecord? {
        if let selected = hardwareOrbs.first(where: { $0.id == selectedHardwareOrbID }) {
            return selected
        }
        return hardwareOrbs.first
    }

    private var hardwareOrbWifiConfigured: Bool {
        !hardwareOrbWifiSsid.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && (hardwareOrbWifiPasswordConfigured || !hardwareOrbWifiPassword.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    private var hardwareOrbWifiDirty: Bool {
        hardwareOrbWifiSsid.trimmingCharacters(in: .whitespacesAndNewlines) != hardwareOrbWifiSavedSsid
            || !hardwareOrbWifiPassword.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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
            Text("Manage the orb fleet from iOS: firmware pushes, OTA status, setup tokens, Wi-Fi credentials, USB provisioning, and mount alignment.")
                .font(.footnote)
                .foregroundStyle(HBPalette.textSecondary)

            Picker("Hardware Orb Settings", selection: $selectedHardwareOrbTab) {
                ForEach(HardwareOrbSettingsTab.allCases) { tab in
                    Text(tab.title).tag(tab)
                }
            }
            .pickerStyle(.segmented)

            if let hardwareOrbLoadError {
                Text(hardwareOrbLoadError)
                    .font(.footnote)
                    .foregroundStyle(HBPalette.accentRed)
            }

            hardwareOrbTabContent

            Button("Refresh Hardware Orbs") {
                Task { await loadHardwareOrbs() }
            }
        }
    }

    @ViewBuilder
    private var hardwareOrbTabContent: some View {
        switch selectedHardwareOrbTab {
        case .fleet:
            hardwareOrbFleetContent
        case .firmware:
            hardwareOrbFirmwareContent
        case .provisioning:
            hardwareOrbProvisioningContent
        case .alignment:
            hardwareOrbAlignmentContent
        }
    }

    private var hardwareOrbFleetContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                HardwareOrbMetricView(title: "Fleet", value: "\(hardwareOrbs.count)", subtitle: "Configured")
                HardwareOrbMetricView(
                    title: "Provisioned",
                    value: "\(hardwareOrbs.filter { $0.isRegistered }.count)",
                    subtitle: "Activated"
                )
                HardwareOrbMetricView(
                    title: "Live",
                    value: "\(hardwareOrbs.filter { $0.status == "online" }.count)",
                    subtitle: "Online"
                )
            }

            if hardwareOrbs.isEmpty {
                Text("No hardware orbs registered yet. Use Provisioning to create a setup token or start a USB flash.")
                    .font(.subheadline)
                    .foregroundStyle(HBPalette.textSecondary)
            } else {
                ForEach(hardwareOrbs) { hardwareOrb in
                    Button {
                        selectedHardwareOrbID = hardwareOrb.id
                        selectedHardwareOrbTab = .firmware
                    } label: {
                        HardwareOrbFleetRow(hardwareOrb: hardwareOrb, isSelected: selectedHardwareOrbID == hardwareOrb.id)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private var hardwareOrbFirmwareContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            hardwareOrbPicker

            if let hardwareOrb = selectedHardwareOrb {
                HardwareOrbFirmwareStatusView(hardwareOrb: hardwareOrb)

                if hardwareOrb.hasOtaActivity {
                    ProgressView(value: Double(hardwareOrb.ota.progress), total: 100)
                    Text(hardwareOrb.ota.detailText)
                        .font(.caption)
                        .foregroundStyle(HBPalette.textSecondary)
                }

                if !hardwareOrb.ota.lastError.isEmpty {
                    Text(hardwareOrb.ota.lastError)
                        .font(.caption)
                        .foregroundStyle(HBPalette.accentRed)
                }

                Button {
                    Task { await pushHardwareOrbFirmwareUpdate(hardwareOrb) }
                } label: {
                    Label(
                        pushingHardwareOrbFirmwareIDs.contains(hardwareOrb.id)
                            ? "Pushing Firmware Update"
                            : "Push Firmware Update",
                        systemImage: "arrow.up.circle"
                    )
                }
                .disabled(!hardwareOrbWifiConfigured
                    || !hardwareOrb.isRegistered
                    || hardwareOrb.isOtaBusy
                    || pushingHardwareOrbFirmwareIDs.contains(hardwareOrb.id))

                if !hardwareOrbWifiConfigured {
                    Text("Save Hardware Orb Wi-Fi in Provisioning before building USB or OTA firmware images.")
                        .font(.caption)
                        .foregroundStyle(HBPalette.textSecondary)
                } else if !hardwareOrb.isRegistered {
                    Text("This orb must complete its first activation before Wi-Fi OTA firmware pushes are available.")
                        .font(.caption)
                        .foregroundStyle(HBPalette.textSecondary)
                }
            } else {
                Text("No hardware orb is selected.")
                    .font(.subheadline)
                    .foregroundStyle(HBPalette.textSecondary)
            }
        }
        .padding(.vertical, 4)
    }

    private var hardwareOrbProvisioningContent: some View {
        VStack(alignment: .leading, spacing: 14) {
            HardwareOrbWifiStatusView(isConfigured: hardwareOrbWifiConfigured)

            TextField("Hardware Orb Wi-Fi SSID", text: $hardwareOrbWifiSsid)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            SecureField(
                hardwareOrbWifiPasswordConfigured ? "Saved password unchanged" : "Hardware Orb Wi-Fi Password",
                text: $hardwareOrbWifiPassword
            )
            Button {
                Task { await saveHardwareOrbWifi() }
            } label: {
                Label(savingHardwareOrbWifi ? "Saving Wi-Fi" : "Save Wi-Fi", systemImage: "wifi")
            }
            .disabled(!hardwareOrbWifiDirty || savingHardwareOrbWifi)

            Divider()

            Text("New Orb")
                .font(.headline)
            TextField("Orb name", text: $newHardwareOrbName)
            TextField("Room", text: $newHardwareOrbRoom)
            Picker("Hardware Profile", selection: $newHardwareOrbHardwareProfile) {
                Text("ELECROW 2.1\" Rotary").tag("elecrow-crowpanel-2.1-rotary")
                Text("ELECROW 1.28\" Rotary").tag("elecrow-crowpanel-1.28-rotary")
            }
            .pickerStyle(.menu)
            Picker("Power Source", selection: $newHardwareOrbPowerSource) {
                Text("Wired USB").tag("wired")
                Text("Battery").tag("battery")
                Text("Both").tag("both")
            }
            .pickerStyle(.menu)

            HStack {
                Button {
                    Task { await createHardwareOrbSetupToken() }
                } label: {
                    Label(creatingHardwareOrb ? "Creating" : "Create Setup Token", systemImage: "plus.circle")
                }
                .disabled(creatingHardwareOrb || usbProvisioningHardwareOrb)

                Button {
                    Task { await provisionHardwareOrbOverUSB() }
                } label: {
                    Label(usbProvisioningHardwareOrb ? "Starting USB Flash" : "Provision and Flash USB", systemImage: "externaldrive.connected.to.line.below")
                }
                .disabled(!hardwareOrbWifiConfigured || creatingHardwareOrb || usbProvisioningHardwareOrb)
            }

            Divider()

            Text("Selected Orb Setup")
                .font(.headline)
            hardwareOrbPicker

            if let hardwareOrb = selectedHardwareOrb {
                HStack {
                    Button {
                        Task { await loadHardwareOrbProvisioning(hardwareOrb) }
                    } label: {
                        Label("Reveal Setup Packet", systemImage: "doc.text")
                    }
                    .disabled(provisioningHardwareOrbIDs.contains(hardwareOrb.id))

                    Button {
                        Task { await rotateHardwareOrbSetupToken(hardwareOrb) }
                    } label: {
                        Label("New Setup Token", systemImage: "arrow.triangle.2.circlepath")
                    }
                    .disabled(rotatingHardwareOrbIDs.contains(hardwareOrb.id))
                }
            }

            if let packet = hardwareOrbProvisioningPacket {
                HardwareOrbProvisioningPacketView(packet: packet)
                HStack {
                    Button("Copy Setup Packet") {
                        copyHardwareOrbText(packet.setupPacketText, label: "Setup packet")
                    }
                    Button("Copy Header Snippet") {
                        copyHardwareOrbText(packet.headerSnippet, label: "Firmware header snippet")
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }

    private var hardwareOrbAlignmentContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Rotate each orb UI in 0.5° steps to compensate for wall mounting. Changes save per device and sync through HomeBrain.")
                .font(.footnote)
                .foregroundStyle(HBPalette.textSecondary)

            if hardwareOrbs.isEmpty {
                Text("No hardware orbs registered yet.")
                    .font(.subheadline)
                    .foregroundStyle(HBPalette.textSecondary)
            } else {
                ForEach(hardwareOrbs) { hardwareOrb in
                    HardwareOrbAlignmentRow(
                        hardwareOrb: hardwareOrb,
                        isSaving: savingHardwareOrbIDs.contains(hardwareOrb.id),
                        onRotateLeft: {
                            Task {
                                await adjustHardwareOrbRotation(
                                    hardwareOrb,
                                    deltaTenths: -HardwareOrbRecord.mountOffsetStepTenths
                                )
                            }
                        },
                        onReset: {
                            Task { await setHardwareOrbRotation(hardwareOrb, offsetTenths: 0) }
                        },
                        onRotateRight: {
                            Task {
                                await adjustHardwareOrbRotation(
                                    hardwareOrb,
                                    deltaTenths: HardwareOrbRecord.mountOffsetStepTenths
                                )
                            }
                        }
                    )
                }
            }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private var hardwareOrbPicker: some View {
        if !hardwareOrbs.isEmpty {
            Picker("Orb", selection: $selectedHardwareOrbID) {
                ForEach(hardwareOrbs) { hardwareOrb in
                    Text(hardwareOrb.name).tag(hardwareOrb.id)
                }
            }
            .pickerStyle(.menu)
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
            let savedHardwareOrbWifiSsid = JSON.string(settings, "hardwareOrbWifiSsid")
            hardwareOrbWifiSsid = savedHardwareOrbWifiSsid
            hardwareOrbWifiSavedSsid = savedHardwareOrbWifiSsid
            hardwareOrbWifiPassword = ""
            hardwareOrbWifiPasswordConfigured = JSON.bool(settings, "hardwareOrbWifiPasswordConfigured")
                || !JSON.string(settings, "hardwareOrbWifiPassword").isEmpty

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
            let nextHardwareOrbs = JSON.array(object["panels"])
                .compactMap(HardwareOrbRecord.from)
                .sorted { lhs, rhs in
                    if lhs.room.localizedCaseInsensitiveCompare(rhs.room) == .orderedSame {
                        return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
                    }
                    return lhs.room.localizedCaseInsensitiveCompare(rhs.room) == .orderedAscending
                }
            hardwareOrbs = nextHardwareOrbs
            if !nextHardwareOrbs.contains(where: { $0.id == selectedHardwareOrbID }) {
                selectedHardwareOrbID = nextHardwareOrbs.first?.id ?? ""
            }
        } catch {
            hardwareOrbs = []
            hardwareOrbLoadError = error.localizedDescription
        }
    }

    private func saveHardwareOrbWifi() async {
        let ssid = hardwareOrbWifiSsid.trimmingCharacters(in: .whitespacesAndNewlines)
        let password = hardwareOrbWifiPassword.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !ssid.isEmpty, !password.isEmpty || hardwareOrbWifiPasswordConfigured else {
            errorMessage = "Save the Hardware Orb Wi-Fi SSID and password before building orb firmware."
            return
        }

        savingHardwareOrbWifi = true
        defer { savingHardwareOrbWifi = false }

        var payload: [String: Any] = ["hardwareOrbWifiSsid": ssid]
        if !password.isEmpty {
            payload["hardwareOrbWifiPassword"] = password
        }

        do {
            let response = try await session.apiClient.put("/api/settings", body: payload)
            let object = JSON.object(response)
            let settings = JSON.object(object["settings"])
            let savedSsid = JSON.string(settings, "hardwareOrbWifiSsid", fallback: ssid)
            hardwareOrbWifiSsid = savedSsid
            hardwareOrbWifiSavedSsid = savedSsid
            hardwareOrbWifiPassword = ""
            hardwareOrbWifiPasswordConfigured = JSON.bool(settings, "hardwareOrbWifiPasswordConfigured")
                || !password.isEmpty
                || !JSON.string(settings, "hardwareOrbWifiPassword").isEmpty
            infoMessage = "Hardware Orb Wi-Fi saved for USB provisioning and OTA firmware builds."
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func pushHardwareOrbFirmwareUpdate(_ hardwareOrb: HardwareOrbRecord) async {
        guard hardwareOrbWifiConfigured else {
            errorMessage = "Save Hardware Orb Wi-Fi before building orb firmware."
            return
        }

        pushingHardwareOrbFirmwareIDs.insert(hardwareOrb.id)
        defer { pushingHardwareOrbFirmwareIDs.remove(hardwareOrb.id) }

        do {
            let response = try await session.apiClient.post("/api/panels/\(settingsPathComponent(hardwareOrb.id))/ota/push")
            let object = JSON.object(response)
            if let refreshed = HardwareOrbRecord.from(JSON.object(object["panel"])) {
                replaceHardwareOrb(refreshed)
            }
            infoMessage = JSON.string(object, "message", fallback: "\(hardwareOrb.name) firmware update queued.")
            errorMessage = nil
            await loadHardwareOrbs()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func loadHardwareOrbProvisioning(_ hardwareOrb: HardwareOrbRecord) async {
        provisioningHardwareOrbIDs.insert(hardwareOrb.id)
        defer { provisioningHardwareOrbIDs.remove(hardwareOrb.id) }

        do {
            let response = try await session.apiClient.get("/api/panels/\(settingsPathComponent(hardwareOrb.id))/provisioning")
            applyHardwareOrbProvisioningResponse(response)
            infoMessage = "\(hardwareOrb.name) setup packet loaded."
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func rotateHardwareOrbSetupToken(_ hardwareOrb: HardwareOrbRecord) async {
        rotatingHardwareOrbIDs.insert(hardwareOrb.id)
        defer { rotatingHardwareOrbIDs.remove(hardwareOrb.id) }

        do {
            let response = try await session.apiClient.post("/api/panels/\(settingsPathComponent(hardwareOrb.id))/registration-code/rotate")
            applyHardwareOrbProvisioningResponse(response)
            infoMessage = "\(hardwareOrb.name) generated a new setup token."
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func createHardwareOrbSetupToken() async {
        let name = newHardwareOrbName.trimmingCharacters(in: .whitespacesAndNewlines)
        let room = newHardwareOrbRoom.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !name.isEmpty, !room.isEmpty else {
            errorMessage = "Enter a name and room before creating a Hardware Orb setup token."
            return
        }

        creatingHardwareOrb = true
        defer { creatingHardwareOrb = false }

        do {
            let response = try await session.apiClient.post(
                "/api/panels/register",
                body: hardwareOrbCreatePayload(name: name, room: room)
            )
            let object = JSON.object(response)
            if let panel = HardwareOrbRecord.from(JSON.object(object["panel"])) {
                replaceHardwareOrb(panel)
                await loadHardwareOrbProvisioning(panel)
            }
            clearNewHardwareOrbDraft()
            infoMessage = "Hardware Orb setup token created."
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func provisionHardwareOrbOverUSB() async {
        let name = newHardwareOrbName.trimmingCharacters(in: .whitespacesAndNewlines)
        let room = newHardwareOrbRoom.trimmingCharacters(in: .whitespacesAndNewlines)

        guard hardwareOrbWifiConfigured else {
            errorMessage = "Save Hardware Orb Wi-Fi before USB provisioning."
            return
        }

        guard !name.isEmpty, !room.isEmpty else {
            errorMessage = "Enter a name and room before starting USB provisioning."
            return
        }

        usbProvisioningHardwareOrb = true
        defer { usbProvisioningHardwareOrb = false }

        do {
            let response = try await session.apiClient.post(
                "/api/panels/provisioning/usb",
                body: hardwareOrbCreatePayload(name: name, room: room)
            )
            applyHardwareOrbProvisioningResponse(response)
            clearNewHardwareOrbDraft()
            infoMessage = "USB firmware provisioning started. Refresh Firmware to follow OTA/provisioning status."
            errorMessage = nil
            await loadHardwareOrbs()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func hardwareOrbCreatePayload(name: String, room: String) -> [String: Any] {
        [
            "name": name,
            "room": room,
            "hardwareProfile": newHardwareOrbHardwareProfile,
            "powerSource": newHardwareOrbPowerSource
        ]
    }

    private func clearNewHardwareOrbDraft() {
        newHardwareOrbName = ""
        newHardwareOrbRoom = ""
        newHardwareOrbHardwareProfile = "elecrow-crowpanel-2.1-rotary"
        newHardwareOrbPowerSource = "wired"
    }

    private func applyHardwareOrbProvisioningResponse(_ response: Any) {
        let object = JSON.object(response)
        if let refreshed = HardwareOrbRecord.from(JSON.object(object["panel"])) {
            replaceHardwareOrb(refreshed)
        }
        if let packet = HardwareOrbProvisioningPacket.from(object) {
            hardwareOrbProvisioningPacket = packet
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
                "/api/panels/\(settingsPathComponent(hardwareOrb.id))",
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

    private func replaceHardwareOrb(_ updated: HardwareOrbRecord) {
        if hardwareOrbs.contains(where: { $0.id == updated.id }) {
            updateHardwareOrb(id: updated.id) { _ in updated }
        } else {
            hardwareOrbs.append(updated)
        }
        hardwareOrbs.sort { lhs, rhs in
            if lhs.room.localizedCaseInsensitiveCompare(rhs.room) == .orderedSame {
                return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
            }
            return lhs.room.localizedCaseInsensitiveCompare(rhs.room) == .orderedAscending
        }
        selectedHardwareOrbID = updated.id
    }

    private func copyHardwareOrbText(_ value: String, label: String) {
        UIPasteboard.general.string = value
        infoMessage = "\(label) copied."
        errorMessage = nil
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

private func settingsPathComponent(_ value: String) -> String {
    let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
    return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
}

private struct HardwareOrbOTA {
    let status: String
    let phase: String
    let progress: Int
    let targetVersion: String
    let currentVersion: String
    let message: String
    let lastError: String
    let requestedAt: String
    let startedAt: String
    let completedAt: String
    let updatedAt: String

    var isBusy: Bool {
        ["queued", "building", "ready", "flashing", "downloading", "installing", "rebooting"].contains(status)
    }

    var hasActivity: Bool {
        !status.isEmpty && status != "idle" || !message.isEmpty || !targetVersion.isEmpty || !completedAt.isEmpty || !lastError.isEmpty
    }

    var statusLabel: String {
        switch status {
        case "queued": return "Queued"
        case "building": return "Building"
        case "ready": return "Ready for Orb"
        case "flashing": return "Flashing over USB"
        case "downloading": return "Downloading"
        case "installing": return "Installing"
        case "rebooting": return "Rebooting"
        case "provisioned": return "USB Flash Complete"
        case "completed": return "Completed"
        case "failed": return "Failed"
        case "idle", "": return "Idle"
        default: return status.capitalized
        }
    }

    var lastActivityText: String {
        if !completedAt.isEmpty {
            return settingsFormatDateTime(completedAt)
        }
        if !updatedAt.isEmpty {
            return settingsFormatDateTime(updatedAt)
        }
        if !startedAt.isEmpty {
            return settingsFormatDateTime(startedAt)
        }
        if !requestedAt.isEmpty {
            return settingsFormatDateTime(requestedAt)
        }
        return "No firmware update reported"
    }

    var detailText: String {
        if !message.isEmpty {
            return message
        }
        if !phase.isEmpty {
            return phase
        }
        return "HomeBrain is coordinating this firmware job."
    }

    static func from(_ object: [String: Any]) -> HardwareOrbOTA {
        HardwareOrbOTA(
            status: JSON.string(object, "status", fallback: "idle"),
            phase: JSON.string(object, "phase"),
            progress: max(0, min(100, JSON.int(object, "progress"))),
            targetVersion: JSON.string(object, "targetVersion"),
            currentVersion: JSON.string(object, "currentVersion"),
            message: JSON.string(object, "message"),
            lastError: JSON.string(object, "lastError"),
            requestedAt: JSON.string(object, "requestedAt"),
            startedAt: JSON.string(object, "startedAt"),
            completedAt: JSON.string(object, "completedAt"),
            updatedAt: JSON.string(object, "updatedAt")
        )
    }
}

private struct HardwareOrbRecord: Identifiable {
    static let mountOffsetMinimumTenths = -150
    static let mountOffsetMaximumTenths = 150
    static let mountOffsetStepTenths = 5

    let id: String
    let name: String
    let room: String
    let status: String
    let hardwareProfile: String
    let powerSource: String
    let connectionType: String
    let ipAddress: String
    let lastSeen: String
    let isRegistered: Bool
    var mountOffsetTenths: Int
    let firmwareVersion: String
    let latestFirmwareVersion: String
    let updateAvailable: Bool
    let ota: HardwareOrbOTA

    var statusLabel: String {
        status.isEmpty ? "Unknown" : status.capitalized
    }

    var hardwareProfileLabel: String {
        hardwareProfile == "elecrow-crowpanel-1.28-rotary" ? "ELECROW 1.28\" Rotary" : "ELECROW 2.1\" Rotary"
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
        updateAvailable || !firmwareVersion.isEmpty && !latestFirmwareVersion.isEmpty && firmwareVersion != latestFirmwareVersion
    }

    var isOtaBusy: Bool {
        ota.isBusy
    }

    var hasOtaActivity: Bool {
        ota.hasActivity
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
            hardwareProfile: JSON.string(object, "hardwareProfile", fallback: "elecrow-crowpanel-2.1-rotary"),
            powerSource: JSON.string(object, "powerSource", fallback: "wired"),
            connectionType: JSON.string(object, "connectionType", fallback: "wifi"),
            ipAddress: JSON.string(object, "ipAddress"),
            lastSeen: JSON.string(object, "lastSeen"),
            isRegistered: JSON.bool(settings, "registered"),
            mountOffsetTenths: clampMountOffset(JSON.int(mountAlignment, "offsetTenths")),
            firmwareVersion: JSON.string(object, "firmwareVersion"),
            latestFirmwareVersion: JSON.string(object, "latestFirmwareVersion"),
            updateAvailable: JSON.bool(object, "updateAvailable"),
            ota: HardwareOrbOTA.from(JSON.object(object["ota"]))
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

private struct HardwareOrbProvisioningPacket: Identifiable {
    let id: String
    let panelName: String
    let panelRoom: String
    let hubURL: String
    let panelID: String
    let registrationCode: String
    let hardwareProfile: String
    let headerHubURL: String
    let headerPanelID: String
    let headerRegistrationCode: String

    var setupPacketText: String {
        [
            "HOMEBRAIN_PANEL_HUB_URL=\(headerHubURL)",
            "HOMEBRAIN_PANEL_ID=\(headerPanelID)",
            "HOMEBRAIN_PANEL_REGISTRATION_CODE=\(headerRegistrationCode)"
        ].joined(separator: "\n")
    }

    var headerSnippet: String {
        [
            "#define HOMEBRAIN_PANEL_HUB_URL \"\(headerHubURL)\"",
            "#define HOMEBRAIN_PANEL_ID \"\(headerPanelID)\"",
            "#define HOMEBRAIN_PANEL_REGISTRATION_CODE \"\(headerRegistrationCode)\""
        ].joined(separator: "\n")
    }

    static func from(_ object: [String: Any]) -> HardwareOrbProvisioningPacket? {
        let panel = JSON.object(object["panel"])
        let provisioning = JSON.object(object["provisioning"])
        let firmwareHeader = JSON.object(provisioning["firmwareHeader"])
        let panelID = JSON.string(provisioning, "panelId", fallback: JSON.id(panel))
        guard !panelID.isEmpty else {
            return nil
        }

        return HardwareOrbProvisioningPacket(
            id: panelID,
            panelName: JSON.string(panel, "name", fallback: "Hardware Orb"),
            panelRoom: JSON.string(panel, "room", fallback: "Unassigned"),
            hubURL: JSON.string(provisioning, "hubUrl"),
            panelID: panelID,
            registrationCode: JSON.string(provisioning, "registrationCode"),
            hardwareProfile: JSON.string(provisioning, "hardwareProfile", fallback: JSON.string(panel, "hardwareProfile")),
            headerHubURL: JSON.string(firmwareHeader, "HOMEBRAIN_PANEL_HUB_URL"),
            headerPanelID: JSON.string(firmwareHeader, "HOMEBRAIN_PANEL_ID", fallback: panelID),
            headerRegistrationCode: JSON.string(firmwareHeader, "HOMEBRAIN_PANEL_REGISTRATION_CODE")
        )
    }
}

private struct HardwareOrbMetricView: View {
    let title: String
    let value: String
    let subtitle: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title.uppercased())
                .font(.caption2)
                .foregroundStyle(HBPalette.textSecondary)
            Text(value)
                .font(.headline.monospacedDigit())
            Text(subtitle)
                .font(.caption2)
                .foregroundStyle(HBPalette.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct HardwareOrbFleetRow: View {
    let hardwareOrb: HardwareOrbRecord
    let isSelected: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(hardwareOrb.name)
                        .font(.headline)
                    Text("\(hardwareOrb.room) · \(hardwareOrb.statusLabel) · \(hardwareOrb.hardwareProfileLabel)")
                        .font(.caption)
                        .foregroundStyle(HBPalette.textSecondary)
                }
                Spacer()
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(isSelected ? HBPalette.accentBlue : HBPalette.textSecondary)
            }

            HStack {
                Text(hardwareOrb.isRegistered ? "Provisioned" : "Awaiting first activation")
                Spacer()
                Text("Firmware \(hardwareOrb.firmwareVersionDisplay)")
            }
            .font(.caption)
            .foregroundStyle(HBPalette.textSecondary)

            if hardwareOrb.requiresFirmwareUpdate || hardwareOrb.isOtaBusy {
                Text(hardwareOrb.isOtaBusy ? "OTA: \(hardwareOrb.ota.statusLabel)" : "Newer firmware available")
                    .font(.caption)
                    .foregroundStyle(hardwareOrb.isOtaBusy ? HBPalette.accentBlue : HBPalette.accentRed)
            }
        }
        .padding(.vertical, 6)
    }
}

private struct HardwareOrbWifiStatusView: View {
    let isConfigured: Bool

    var body: some View {
        HStack {
            Label(
                isConfigured ? "Ready for firmware builds" : "Required before firmware builds",
                systemImage: isConfigured ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"
            )
            .foregroundStyle(isConfigured ? HBPalette.accentGreen : HBPalette.accentRed)
            Spacer()
        }
        .font(.subheadline)
    }
}

private struct HardwareOrbFirmwareStatusView: View {
    let hardwareOrb: HardwareOrbRecord

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HardwareOrbValueRow(title: "Orb", value: "\(hardwareOrb.name) · \(hardwareOrb.room)")
            HardwareOrbValueRow(title: "Status", value: "\(hardwareOrb.statusLabel) · \(hardwareOrb.ipAddress.isEmpty ? "Awaiting Wi-Fi" : hardwareOrb.ipAddress)")
            HardwareOrbValueRow(title: "Running Firmware", value: hardwareOrb.firmwareVersion.isEmpty ? "Not reported yet" : hardwareOrb.firmwareVersion)
            HardwareOrbValueRow(title: "Available Firmware", value: hardwareOrb.latestFirmwareVersion.isEmpty ? "Not available yet" : hardwareOrb.latestFirmwareVersion)
            HardwareOrbValueRow(title: "Target Firmware", value: hardwareOrb.ota.targetVersion.isEmpty ? "No pending OTA job" : hardwareOrb.ota.targetVersion)
            HardwareOrbValueRow(title: "OTA State", value: hardwareOrb.ota.statusLabel)
            HardwareOrbValueRow(title: "Last Firmware Update", value: hardwareOrb.ota.lastActivityText)
            HardwareOrbValueRow(title: "Last Seen", value: settingsFormatDateTime(hardwareOrb.lastSeen))

            if hardwareOrb.requiresFirmwareUpdate {
                Label("Newer firmware available on this HomeBrain host", systemImage: "arrow.up.circle.fill")
                    .font(.caption)
                    .foregroundStyle(HBPalette.accentRed)
            }
        }
    }
}

private struct HardwareOrbValueRow: View {
    let title: String
    let value: String

    var body: some View {
        HStack(alignment: .top) {
            Text(title)
                .font(.caption)
                .foregroundStyle(HBPalette.textSecondary)
            Spacer(minLength: 16)
            Text(value)
                .font(.caption)
                .multilineTextAlignment(.trailing)
        }
    }
}

private struct HardwareOrbProvisioningPacketView: View {
    let packet: HardwareOrbProvisioningPacket

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Setup Packet")
                .font(.headline)
            HardwareOrbValueRow(title: "Orb", value: "\(packet.panelName) · \(packet.panelRoom)")
            HardwareOrbValueRow(title: "Hub URL", value: packet.hubURL.isEmpty ? packet.headerHubURL : packet.hubURL)
            HardwareOrbValueRow(title: "Panel ID", value: packet.panelID)
            HardwareOrbValueRow(title: "Setup Token", value: packet.registrationCode)
            Text(packet.headerSnippet)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .foregroundStyle(HBPalette.textSecondary)
                .padding(.top, 4)
        }
        .padding(.vertical, 4)
    }
}

private struct HardwareOrbAlignmentRow: View {
    let hardwareOrb: HardwareOrbRecord
    let isSaving: Bool
    let onRotateLeft: () -> Void
    let onReset: () -> Void
    let onRotateRight: () -> Void

    var body: some View {
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
                    onRotateLeft()
                } label: {
                    Label("Left", systemImage: "rotate.left")
                }
                .disabled(isSaving)

                Button("Reset") {
                    onReset()
                }
                .disabled(isSaving || hardwareOrb.mountOffsetTenths == 0)

                Button {
                    onRotateRight()
                } label: {
                    Label("Right", systemImage: "rotate.right")
                }
                .disabled(isSaving)
            }
        }
        .padding(.vertical, 4)
    }
}
