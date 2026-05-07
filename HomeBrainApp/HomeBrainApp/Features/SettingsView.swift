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
        case .deviceIntegrations: return "INSTEON, SmartThings, Harmony, Zigbee, Z-Wave"
        case .ecobee: return "Ecobee OAuth and thermostat sync"
        case .apiKeys: return "OpenAI, Anthropic, ElevenLabs, SmartThings"
        case .aiProviders: return "OpenAI, Codex, Anthropic, local LLM"
        case .llmPriority: return "Provider fallback order"
        case .hardwareOrbs: return "Orb provisioning, categories, and mount alignment"
        case .security: return "Security platforms, away delay, and sessions"
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
    case categories
    case alignment

    var id: String { rawValue }

    var title: String {
        switch self {
        case .fleet: return "Fleet"
        case .firmware: return "Firmware"
        case .provisioning: return "Setup"
        case .categories: return "Categories"
        case .alignment: return "Align"
        }
    }
}

private struct SecurityPinDraft: Identifiable, Equatable {
    var id: String
    var name: String
    var pin: String
    var enabled: Bool
    var existing: Bool

    static func empty() -> SecurityPinDraft {
        SecurityPinDraft(id: UUID().uuidString, name: "", pin: "", enabled: true, existing: false)
    }

    static func from(_ object: [String: Any]) -> SecurityPinDraft {
        let resolvedID = JSON.string(object, "id", fallback: JSON.string(object, "_id", fallback: UUID().uuidString))
        return SecurityPinDraft(
            id: resolvedID,
            name: JSON.string(object, "name"),
            pin: "",
            enabled: JSON.bool(object, "enabled", fallback: true),
            existing: true
        )
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
    @State private var securityHomeBrainEnabled = true
    @State private var securitySmartThingsEnabled = true
    @State private var securityArmAwayExitDelaySeconds = 30
    @State private var securityRequirePinForArm = false
    @State private var securityRequirePinForDisarm = false
    @State private var securityPinDrafts: [SecurityPinDraft] = []
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
    private let securityExitDelayOptions = [0, 15, 30, 45, 60, 90, 120]

    private var isAdmin: Bool {
        session.currentUser?.role == "admin"
    }

    private var securityHomeBrainBinding: Binding<Bool> {
        Binding {
            securityHomeBrainEnabled
        } set: { newValue in
            if !newValue && !securitySmartThingsEnabled {
                return
            }
            securityHomeBrainEnabled = newValue
        }
    }

    private var securitySmartThingsBinding: Binding<Bool> {
        Binding {
            securitySmartThingsEnabled
        } set: { newValue in
            if !newValue && !securityHomeBrainEnabled {
                return
            }
            securitySmartThingsEnabled = newValue
        }
    }

    private var securityDelayPickerOptions: [Int] {
        Array(Set(securityExitDelayOptions + [securityArmAwayExitDelaySeconds])).sorted()
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
            Toggle("HomeBrain Security", isOn: securityHomeBrainBinding)
                .disabled(!securitySmartThingsEnabled)
            Toggle("SmartThings Security", isOn: securitySmartThingsBinding)
                .disabled(!securityHomeBrainEnabled)

            Picker("Arm Away Delay", selection: $securityArmAwayExitDelaySeconds) {
                ForEach(securityDelayPickerOptions, id: \.self) { seconds in
                    Text(seconds == 0 ? "No delay" : "\(seconds) seconds").tag(seconds)
                }
            }
            .pickerStyle(.menu)

            Toggle("Require PIN to Arm", isOn: $securityRequirePinForArm)
            Toggle("Require PIN to Disarm", isOn: $securityRequirePinForDisarm)

            if securityPinDrafts.isEmpty {
                Text("No security PINs configured.")
                    .font(.footnote)
                    .foregroundStyle(HBPalette.textSecondary)
            } else {
                ForEach($securityPinDrafts) { $pin in
                    VStack(alignment: .leading, spacing: 8) {
                        TextField("PIN Name", text: $pin.name)
                            .textInputAutocapitalization(.words)
                        SecureField(pin.existing ? "Leave blank to keep PIN" : "4-8 digit PIN", text: $pin.pin)
                            .keyboardType(.numberPad)
                        Toggle("Enabled", isOn: $pin.enabled)
                    }
                    .padding(.vertical, 4)
                    .swipeActions {
                        Button(role: .destructive) {
                            securityPinDrafts.removeAll { $0.id == pin.id }
                        } label: {
                            Label("Remove", systemImage: "trash")
                        }
                    }
                }
            }

            Button {
                securityPinDrafts.append(SecurityPinDraft.empty())
            } label: {
                Label("Add Security PIN", systemImage: "plus")
            }

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
                settingsSecuritySection
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
        case .categories:
            hardwareOrbCategoriesContent
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

    private var hardwareOrbCategoriesContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Turn orb categories on or off and choose the swipe order. The first enabled category is the default surface.")
                .font(.footnote)
                .foregroundStyle(HBPalette.textSecondary)

            hardwareOrbPicker

            if let hardwareOrb = selectedHardwareOrb {
                HardwareOrbValueRow(title: "Default", value: hardwareOrb.defaultModeCategoryLabel)

                ForEach(HardwareOrbModeCategory.orderedForDisplay(modeOrder: hardwareOrb.modeOrder)) { category in
                    let enabledIndex = hardwareOrb.modeOrder.firstIndex(of: category.id)
                    HardwareOrbCategoryRow(
                        category: category,
                        enabledIndex: enabledIndex,
                        enabledCount: hardwareOrb.modeOrder.count,
                        isSaving: savingHardwareOrbIDs.contains(hardwareOrb.id),
                        onToggle: { enabled in
                            Task {
                                await setHardwareOrbCategory(
                                    hardwareOrb,
                                    categoryID: category.id,
                                    enabled: enabled
                                )
                            }
                        },
                        onMoveUp: {
                            Task {
                                await moveHardwareOrbCategory(
                                    hardwareOrb,
                                    categoryID: category.id,
                                    direction: -1
                                )
                            }
                        },
                        onMoveDown: {
                            Task {
                                await moveHardwareOrbCategory(
                                    hardwareOrb,
                                    categoryID: category.id,
                                    direction: 1
                                )
                            }
                        }
                    )
                }
            } else {
                Text("No hardware orb is selected.")
                    .font(.subheadline)
                    .foregroundStyle(HBPalette.textSecondary)
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
            await loadSecurityAlarmSettings()
            await loadAuthSessions()
            await loadHardwareOrbs()
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    private func loadSecurityAlarmSettings() async {
        do {
            let response = try await session.apiClient.get("/api/security-alarm/settings")
            let object = JSON.object(response)
            let settings = JSON.object(object["settings"])
            let platforms = JSON.object(settings["enabledPlatforms"])
            let pinSettings = JSON.object(settings["pinSettings"])
            securityHomeBrainEnabled = JSON.bool(platforms, "homebrain", fallback: true)
            securitySmartThingsEnabled = JSON.bool(platforms, "smartthings", fallback: true)
            securityArmAwayExitDelaySeconds = min(
                300,
                max(0, JSON.int(settings, "exitDelaySeconds", fallback: securityArmAwayExitDelaySeconds))
            )
            securityRequirePinForArm = JSON.bool(pinSettings, "requireForArm")
            securityRequirePinForDisarm = JSON.bool(pinSettings, "requireForDisarm")
            securityPinDrafts = JSON.array(settings["pins"]).map(SecurityPinDraft.from)
        } catch {
            errorMessage = error.localizedDescription
        }
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
            try await saveSecurityAlarmSettings()

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

    private func saveSecurityAlarmSettings() async throws {
        let pinsPayload = try securityPinsPayload()
        if (securityRequirePinForArm || securityRequirePinForDisarm)
            && !pinsPayload.contains(where: { JSON.bool($0, "enabled", fallback: true) }) {
            throw NSError(
                domain: "HomeBrainSettings",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Add at least one enabled security PIN before requiring PIN entry."]
            )
        }

        let payload: [String: Any] = [
            "enabledPlatforms": [
                "homebrain": securityHomeBrainEnabled,
                "smartthings": securitySmartThingsEnabled
            ],
            "exitDelaySeconds": min(300, max(0, securityArmAwayExitDelaySeconds)),
            "pinSettings": [
                "requireForArm": securityRequirePinForArm,
                "requireForDisarm": securityRequirePinForDisarm
            ],
            "pins": pinsPayload
        ]
        let response = try await session.apiClient.put("/api/security-alarm/settings", body: payload)
        let object = JSON.object(response)
        let settings = JSON.object(object["settings"])
        let platforms = JSON.object(settings["enabledPlatforms"])
        let pinSettings = JSON.object(settings["pinSettings"])
        securityHomeBrainEnabled = JSON.bool(platforms, "homebrain", fallback: securityHomeBrainEnabled)
        securitySmartThingsEnabled = JSON.bool(platforms, "smartthings", fallback: securitySmartThingsEnabled)
        securityArmAwayExitDelaySeconds = min(
            300,
            max(0, JSON.int(settings, "exitDelaySeconds", fallback: securityArmAwayExitDelaySeconds))
        )
        securityRequirePinForArm = JSON.bool(pinSettings, "requireForArm", fallback: securityRequirePinForArm)
        securityRequirePinForDisarm = JSON.bool(pinSettings, "requireForDisarm", fallback: securityRequirePinForDisarm)
        securityPinDrafts = JSON.array(settings["pins"]).map(SecurityPinDraft.from)
    }

    private func securityPinsPayload() throws -> [[String: Any]] {
        var seenNames = Set<String>()
        var payload: [[String: Any]] = []

        for draft in securityPinDrafts {
            let name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
            let pin = draft.pin.trimmingCharacters(in: .whitespacesAndNewlines)
            if name.isEmpty && pin.isEmpty && !draft.existing {
                continue
            }
            if name.isEmpty {
                throw NSError(
                    domain: "HomeBrainSettings",
                    code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "Each security PIN needs a name."]
                )
            }

            let nameKey = name.lowercased()
            if seenNames.contains(nameKey) {
                throw NSError(
                    domain: "HomeBrainSettings",
                    code: 3,
                    userInfo: [NSLocalizedDescriptionKey: "Security PIN names must be unique."]
                )
            }
            seenNames.insert(nameKey)

            if !pin.isEmpty && pin.range(of: #"^\d{4,8}$"#, options: .regularExpression) == nil {
                throw NSError(
                    domain: "HomeBrainSettings",
                    code: 4,
                    userInfo: [NSLocalizedDescriptionKey: "Security PINs must be 4-8 digits."]
                )
            }

            if !draft.existing && pin.isEmpty {
                throw NSError(
                    domain: "HomeBrainSettings",
                    code: 5,
                    userInfo: [NSLocalizedDescriptionKey: "Enter a PIN for \(name)."]
                )
            }

            var item: [String: Any] = [
                "name": name,
                "enabled": draft.enabled
            ]
            if draft.existing {
                item["id"] = draft.id
            }
            if !pin.isEmpty {
                item["pin"] = pin
            }
            payload.append(item)
        }

        return payload
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

    private func setHardwareOrbCategory(
        _ hardwareOrb: HardwareOrbRecord,
        categoryID: String,
        enabled: Bool
    ) async {
        var nextModeOrder = HardwareOrbModeCategory.normalizedOrder(hardwareOrb.modeOrder)
        let isEnabled = nextModeOrder.contains(categoryID)

        if enabled {
            guard !isEnabled else {
                return
            }
            nextModeOrder.append(categoryID)
        } else {
            guard isEnabled, nextModeOrder.count > 1 else {
                return
            }
            nextModeOrder.removeAll { $0 == categoryID }
        }

        await saveHardwareOrbModeOrder(hardwareOrb, modeOrder: nextModeOrder)
    }

    private func moveHardwareOrbCategory(
        _ hardwareOrb: HardwareOrbRecord,
        categoryID: String,
        direction: Int
    ) async {
        var nextModeOrder = HardwareOrbModeCategory.normalizedOrder(hardwareOrb.modeOrder)
        guard let fromIndex = nextModeOrder.firstIndex(of: categoryID) else {
            return
        }

        let toIndex = fromIndex + direction
        guard nextModeOrder.indices.contains(toIndex) else {
            return
        }

        let moved = nextModeOrder.remove(at: fromIndex)
        nextModeOrder.insert(moved, at: toIndex)
        await saveHardwareOrbModeOrder(hardwareOrb, modeOrder: nextModeOrder)
    }

    private func saveHardwareOrbModeOrder(_ hardwareOrb: HardwareOrbRecord, modeOrder: [String]) async {
        let normalizedModeOrder = HardwareOrbModeCategory.normalizedOrder(modeOrder)
        guard normalizedModeOrder != hardwareOrb.modeOrder else {
            return
        }

        let previousHardwareOrbs = hardwareOrbs
        updateHardwareOrb(id: hardwareOrb.id) { current in
            var updated = current
            updated.modeOrder = normalizedModeOrder
            return updated
        }

        savingHardwareOrbIDs.insert(hardwareOrb.id)
        defer { savingHardwareOrbIDs.remove(hardwareOrb.id) }

        do {
            let response = try await session.apiClient.put(
                "/api/panels/\(settingsPathComponent(hardwareOrb.id))",
                body: [
                    "settings": [
                        "modeOrder": normalizedModeOrder
                    ]
                ]
            )
            let object = JSON.object(response)
            if let refreshed = HardwareOrbRecord.from(JSON.object(object["panel"])) {
                updateHardwareOrb(id: refreshed.id) { _ in refreshed }
            }
            infoMessage = "\(hardwareOrb.name) category order saved."
            errorMessage = nil
            hardwareOrbLoadError = nil
        } catch {
            hardwareOrbs = previousHardwareOrbs
            errorMessage = error.localizedDescription
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

private struct DirectRadioScoreSet {
    let zigbee: Int
    let zwave: Int

    static func from(_ object: [String: Any]) -> DirectRadioScoreSet {
        DirectRadioScoreSet(
            zigbee: JSON.int(object, "zigbee"),
            zwave: JSON.int(object, "zwave")
        )
    }
}

private struct DirectRadioSerialPortRecord: Identifiable {
    let id: String
    let path: String
    let rawPath: String
    let stablePath: String
    let realPath: String
    let manufacturer: String
    let vendorId: String
    let productId: String
    let serialNumber: String
    let preferredProtocol: String
    let likelyZigbee: Bool
    let likelyZWave: Bool
    let scores: DirectRadioScoreSet

    static func from(_ object: [String: Any]) -> DirectRadioSerialPortRecord {
        let path = JSON.string(object, "path")
        return DirectRadioSerialPortRecord(
            id: path.isEmpty ? UUID().uuidString : path,
            path: path,
            rawPath: JSON.string(object, "rawPath"),
            stablePath: JSON.string(object, "stablePath"),
            realPath: JSON.string(object, "realPath"),
            manufacturer: JSON.string(object, "manufacturer"),
            vendorId: JSON.string(object, "vendorId"),
            productId: JSON.string(object, "productId"),
            serialNumber: JSON.string(object, "serialNumber"),
            preferredProtocol: JSON.string(object, "preferredProtocol"),
            likelyZigbee: JSON.bool(object, "likelyZigbee"),
            likelyZWave: JSON.bool(object, "likelyZWave"),
            scores: DirectRadioScoreSet.from(JSON.object(object["scores"]))
        )
    }
}

private struct DirectRadioControllerRecord {
    let protocolName: String
    let expectedHardware: String
    let source: String
    let detectedPort: String
    let configuredPort: String
    let started: Bool
    let error: String
    let diagnostics: [String]
    let permitJoinUntil: String
    let inclusionUntil: String
    let exclusionUntil: String
    let pairedCount: Int
    let lastStartResult: String

    var isReady: Bool {
        started && !detectedPort.isEmpty && error.isEmpty
    }

    var activeWindow: String {
        if !permitJoinUntil.isEmpty { return permitJoinUntil }
        if !inclusionUntil.isEmpty { return inclusionUntil }
        if !exclusionUntil.isEmpty { return exclusionUntil }
        return ""
    }

    static func from(_ object: [String: Any], protocolName: String) -> DirectRadioControllerRecord {
        DirectRadioControllerRecord(
            protocolName: protocolName,
            expectedHardware: JSON.string(object, "expectedHardware"),
            source: JSON.string(object, "source"),
            detectedPort: JSON.string(object, "detectedPort"),
            configuredPort: JSON.string(object, "configuredPort"),
            started: JSON.bool(object, "started"),
            error: JSON.string(object, "error"),
            diagnostics: JSON.stringArray(object["diagnostics"]),
            permitJoinUntil: JSON.string(object, "permitJoinUntil"),
            inclusionUntil: JSON.string(object, "inclusionUntil"),
            exclusionUntil: JSON.string(object, "exclusionUntil"),
            pairedCount: protocolName == "zigbee"
                ? JSON.int(object, "pairedDeviceCount")
                : JSON.int(object, "pairedNodeCount"),
            lastStartResult: JSON.string(object, "lastStartResult")
        )
    }
}

private struct DirectRadioControllerSet {
    let zigbee: DirectRadioControllerRecord
    let zwave: DirectRadioControllerRecord

    static func from(_ object: [String: Any]) -> DirectRadioControllerSet {
        DirectRadioControllerSet(
            zigbee: DirectRadioControllerRecord.from(JSON.object(object["zigbee"]), protocolName: "zigbee"),
            zwave: DirectRadioControllerRecord.from(JSON.object(object["zwave"]), protocolName: "zwave")
        )
    }
}

private struct DirectRadioStatusSnapshot {
    let enabled: Bool
    let dataDir: String
    let serialPorts: [DirectRadioSerialPortRecord]
    let diagnostics: [String]
    let controllers: DirectRadioControllerSet

    static func from(_ object: [String: Any]) -> DirectRadioStatusSnapshot {
        DirectRadioStatusSnapshot(
            enabled: JSON.bool(object, "enabled"),
            dataDir: JSON.string(object, "dataDir"),
            serialPorts: JSON.array(object["serialPorts"]).map(DirectRadioSerialPortRecord.from),
            diagnostics: JSON.stringArray(object["diagnostics"]),
            controllers: DirectRadioControllerSet.from(JSON.object(object["controllers"]))
        )
    }
}

private struct DirectRadioLogEntryRecord: Identifiable {
    let id: String
    let timestamp: String
    let level: String
    let protocolName: String
    let stage: String
    let operation: String
    let target: String
    let message: String
    let details: [String: Any]

    var displayTime: String {
        JSON.displayDate(from: timestamp)
    }

    static func from(_ object: [String: Any]) -> DirectRadioLogEntryRecord {
        DirectRadioLogEntryRecord(
            id: JSON.string(object, "id", fallback: UUID().uuidString),
            timestamp: JSON.string(object, "timestamp"),
            level: JSON.string(object, "level", fallback: "info"),
            protocolName: JSON.string(object, "protocol", fallback: "system"),
            stage: JSON.string(object, "stage"),
            operation: JSON.string(object, "operation"),
            target: JSON.string(object, "target"),
            message: JSON.string(object, "message"),
            details: JSON.object(object["details"])
        )
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
    @State private var directRadioStatus: DirectRadioStatusSnapshot?
    @State private var directRadioLogs: [DirectRadioLogEntryRecord] = []
    @State private var directRadioLoading = false
    @State private var directRadioLogsLoading = false
    @State private var directRadioLiveLogs = true

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

            directRadioOperationsSection
            directRadioSerialPortsSection
            directRadioLogsSection

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
        .task {
            await loadDirectRadioStatusAndLogs()
        }
        .task(id: directRadioLiveLogs) {
            guard directRadioLiveLogs else { return }
            await pollDirectRadioLogs()
        }
    }

    private var directRadioOperationsSection: some View {
        Section("Zigbee / Z-Wave") {
            if directRadioLoading {
                ProgressView("Loading radio status...")
            } else if let status = directRadioStatus {
                directRadioControllerRow(status.controllers.zigbee)
                directRadioControllerRow(status.controllers.zwave)

                if !status.diagnostics.isEmpty {
                    ForEach(status.diagnostics, id: \.self) { diagnostic in
                        Label(diagnostic, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(HBPalette.accentOrange)
                    }
                }

                Text(status.enabled ? "Direct radio runtime is enabled." : "Direct radio runtime is disabled.")
                    .font(.footnote)
                    .foregroundStyle(HBPalette.textSecondary)
            } else {
                Text("Radio status has not loaded yet.")
                    .font(.footnote)
                    .foregroundStyle(HBPalette.textSecondary)
            }

            actionButton("Refresh Radio Status", key: "direct-radio-status", method: .get, path: "/api/direct-radios/status")
            actionButton("Scan Zigbee/Z-Wave USB Ports", key: "direct-radio-ports", method: .get, path: "/api/direct-radios/serial-ports")
            actionButton("Open Zigbee Pairing", key: "direct-radio-zigbee-pair", method: .post, path: "/api/direct-radios/pairing/start", body: ["protocol": "zigbee", "durationSeconds": 180])
            actionButton("Start Z-Wave Inclusion", key: "direct-radio-zwave-pair", method: .post, path: "/api/direct-radios/pairing/start", body: ["protocol": "zwave", "durationSeconds": 180])
            actionButton("Start Z-Wave Exclusion", key: "direct-radio-zwave-exclusion", method: .post, path: "/api/direct-radios/exclusion/start", body: ["durationSeconds": 120])
            actionButton("Stop Pairing / Exclusion", key: "direct-radio-stop", method: .post, path: "/api/direct-radios/pairing/stop", body: ["protocol": "all"])
        }
    }

    @ViewBuilder
    private var directRadioSerialPortsSection: some View {
        if let status = directRadioStatus {
            Section("Direct Radio USB Ports") {
                if status.serialPorts.isEmpty {
                    Text("No serial ports found.")
                        .font(.footnote)
                        .foregroundStyle(HBPalette.textSecondary)
                } else {
                    ForEach(status.serialPorts) { port in
                        directRadioSerialPortRow(port)
                    }
                }
            }
        }
    }

    private var directRadioLogsSection: some View {
        Section("Direct Radio Logs") {
            Toggle("Live Updates", isOn: $directRadioLiveLogs)

            HStack {
                Button {
                    Task { await loadDirectRadioLogs() }
                } label: {
                    if directRadioLogsLoading {
                        ProgressView()
                    } else {
                        Label("Replay Latest", systemImage: "arrow.clockwise")
                    }
                }
                .disabled(directRadioLogsLoading)

                Button(role: .destructive) {
                    Task { await clearDirectRadioLogs() }
                } label: {
                    Label("Clear Logs", systemImage: "trash")
                }
                .disabled(!activeAction.isEmpty)
            }

            if directRadioLogs.isEmpty {
                Text("No direct radio logs yet.")
                    .font(.footnote)
                    .foregroundStyle(HBPalette.textSecondary)
            } else {
                ForEach(directRadioLogs.prefix(80)) { entry in
                    directRadioLogRow(entry)
                }
            }
        }
    }

    private func directRadioControllerRow(_ controller: DirectRadioControllerRecord) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label(controller.protocolName == "zigbee" ? "Zigbee" : "Z-Wave", systemImage: controller.protocolName == "zigbee" ? "dot.radiowaves.left.and.right" : "wave.3.right")
                    .font(.headline)
                Spacer()
                Text(controller.isReady ? "Online" : controller.started ? "Starting" : "Offline")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(controller.isReady ? HBPalette.accentGreen : HBPalette.accentOrange)
            }

            Text(controller.expectedHardware)
                .font(.caption)
                .foregroundStyle(HBPalette.textSecondary)

            if !controller.detectedPort.isEmpty {
                Text(controller.detectedPort)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(HBPalette.textSecondary)
                    .textSelection(.enabled)
            } else {
                Text("No matching USB adapter detected.")
                    .font(.caption)
                    .foregroundStyle(HBPalette.accentOrange)
            }

            HStack(spacing: 12) {
                Text("\(controller.pairedCount) paired")
                if !controller.activeWindow.isEmpty {
                    Text("Window open until \(JSON.displayDate(from: controller.activeWindow))")
                }
                if !controller.lastStartResult.isEmpty {
                    Text(controller.lastStartResult)
                }
            }
            .font(.caption)
            .foregroundStyle(HBPalette.textSecondary)

            if !controller.error.isEmpty {
                Text(controller.error)
                    .font(.caption)
                    .foregroundStyle(HBPalette.accentRed)
            }
        }
        .padding(.vertical, 4)
    }

    private func directRadioSerialPortRow(_ port: DirectRadioSerialPortRecord) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(port.preferredProtocol.isEmpty ? "Serial Port" : port.preferredProtocol.uppercased())
                    .font(.caption.weight(.bold))
                    .foregroundStyle(port.preferredProtocol == "zigbee" ? HBPalette.accentGreen : port.preferredProtocol == "zwave" ? HBPalette.accentBlue : HBPalette.textSecondary)
                Spacer()
                Text("ZB \(port.scores.zigbee) / ZW \(port.scores.zwave)")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(HBPalette.textMuted)
            }

            Text(port.path)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .foregroundStyle(HBPalette.textSecondary)

            let descriptor = [port.manufacturer, port.vendorId, port.productId, port.serialNumber]
                .filter { !$0.isEmpty }
                .joined(separator: " · ")
            if !descriptor.isEmpty {
                Text(descriptor)
                    .font(.caption2)
                    .foregroundStyle(HBPalette.textMuted)
            }
        }
        .padding(.vertical, 3)
    }

    private func directRadioLogRow(_ entry: DirectRadioLogEntryRecord) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(entry.protocolName.uppercased())
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(entry.protocolName == "zigbee" ? HBPalette.accentGreen : entry.protocolName == "zwave" ? HBPalette.accentBlue : HBPalette.textMuted)
                Text(entry.level.uppercased())
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(entry.level == "error" ? HBPalette.accentRed : entry.level == "warn" ? HBPalette.accentOrange : HBPalette.textMuted)
                Spacer()
                Text(entry.displayTime)
                    .font(.caption2)
                    .foregroundStyle(HBPalette.textMuted)
            }

            Text(entry.message)
                .font(.subheadline.weight(.semibold))

            let metadata = [entry.stage, entry.operation, entry.target]
                .filter { !$0.isEmpty }
                .joined(separator: " · ")
            if !metadata.isEmpty {
                Text(metadata)
                    .font(.caption)
                    .foregroundStyle(HBPalette.textSecondary)
            }

            if !entry.details.isEmpty {
                Text(JSON.prettyString(entry.details))
                    .font(.system(.caption2, design: .monospaced))
                    .lineLimit(5)
                    .foregroundStyle(HBPalette.textMuted)
            }
        }
        .padding(.vertical, 5)
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
            await refreshAfterAction(path: path)
        } catch {
            message = error.localizedDescription
        }
    }

    private func refreshAfterAction(path: String) async {
        if path.contains("/api/direct-radios") {
            await loadDirectRadioStatusAndLogs()
        }
    }

    private func loadDirectRadioStatusAndLogs() async {
        await loadDirectRadioStatus()
        await loadDirectRadioLogs()
    }

    private func loadDirectRadioStatus() async {
        directRadioLoading = true
        defer { directRadioLoading = false }

        do {
            let response = try await session.apiClient.get("/api/direct-radios/status")
            let root = JSON.object(response)
            directRadioStatus = DirectRadioStatusSnapshot.from(JSON.object(root["status"]))
        } catch {
            message = error.localizedDescription
        }
    }

    private func loadDirectRadioLogs() async {
        directRadioLogsLoading = true
        defer { directRadioLogsLoading = false }

        do {
            let response = try await session.apiClient.get(
                "/api/direct-radios/logs/latest",
                query: [URLQueryItem(name: "limit", value: "120")]
            )
            let root = JSON.object(response)
            directRadioLogs = JSON.array(root["logs"])
                .map(DirectRadioLogEntryRecord.from)
                .sorted { $0.timestamp > $1.timestamp }
        } catch {
            message = error.localizedDescription
        }
    }

    private func clearDirectRadioLogs() async {
        activeAction = "direct-radio-clear-logs"
        defer { activeAction = "" }

        do {
            resultPayload = try await session.apiClient.post("/api/direct-radios/logs/clear")
            message = "Direct radio logs cleared."
            await loadDirectRadioLogs()
        } catch {
            message = error.localizedDescription
        }
    }

    private func pollDirectRadioLogs() async {
        while !Task.isCancelled && directRadioLiveLogs {
            await loadDirectRadioLogs()
            try? await Task.sleep(nanoseconds: 2_000_000_000)
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

private struct HardwareOrbModeCategory: Identifiable {
    let id: String
    let label: String
    let details: String

    static let all: [HardwareOrbModeCategory] = [
        HardwareOrbModeCategory(
            id: "thermostat",
            label: "Thermostat",
            details: "Temperature, HVAC mode, and bedtime long-press."
        ),
        HardwareOrbModeCategory(
            id: "room",
            label: "Room",
            details: "Primary room light or switch control."
        ),
        HardwareOrbModeCategory(
            id: "home",
            label: "Home",
            details: "Security state and alarm shortcuts."
        ),
        HardwareOrbModeCategory(
            id: "media",
            label: "Media",
            details: "Harmony hub power and volume control."
        ),
        HardwareOrbModeCategory(
            id: "quiet",
            label: "Quiet",
            details: "Bedtime, morning, lock-up, and night-light actions."
        )
    ]

    static let defaultOrder = all.map(\.id)

    static func category(for id: String) -> HardwareOrbModeCategory? {
        all.first { $0.id == id }
    }

    static func normalizedOrder(_ value: Any?) -> [String] {
        let rawValues: [String]
        if let values = value as? [String] {
            rawValues = values
        } else if let values = value as? [Any] {
            rawValues = values.compactMap { value in
                if value is NSNull {
                    return nil
                }
                if let stringValue = value as? String {
                    return stringValue
                }
                return String(describing: value)
            }
        } else {
            rawValues = []
        }

        let allowedIDs = Set(defaultOrder)
        var seen = Set<String>()
        let modeOrder = rawValues.compactMap { value -> String? in
            let modeID = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard allowedIDs.contains(modeID), !seen.contains(modeID) else {
                return nil
            }
            seen.insert(modeID)
            return modeID
        }

        return modeOrder.isEmpty ? defaultOrder : modeOrder
    }

    static func orderedForDisplay(modeOrder: [String]) -> [HardwareOrbModeCategory] {
        let normalizedModeOrder = normalizedOrder(modeOrder)
        let enabledIDs = Set(normalizedModeOrder)
        let enabledCategories = normalizedModeOrder.compactMap { category(for: $0) }
        let disabledCategories = all.filter { !enabledIDs.contains($0.id) }
        return enabledCategories + disabledCategories
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
    var modeOrder: [String]

    var statusLabel: String {
        status.isEmpty ? "Unknown" : status.capitalized
    }

    var hardwareProfileLabel: String {
        hardwareProfile == "elecrow-crowpanel-1.28-rotary" ? "ELECROW 1.28\" Rotary" : "ELECROW 2.1\" Rotary"
    }

    var formattedMountOffset: String {
        Self.formattedMountOffset(mountOffsetTenths)
    }

    var enabledModeCategories: [HardwareOrbModeCategory] {
        modeOrder.compactMap { HardwareOrbModeCategory.category(for: $0) }
    }

    var defaultModeCategoryLabel: String {
        enabledModeCategories.first?.label ?? "Thermostat"
    }

    var modeCategorySummary: String {
        let labels = enabledModeCategories.map(\.label)
        return labels.isEmpty ? "Thermostat > Room > Home > Media > Quiet" : labels.joined(separator: " > ")
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
            ota: HardwareOrbOTA.from(JSON.object(object["ota"])),
            modeOrder: HardwareOrbModeCategory.normalizedOrder(settings["modeOrder"])
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

            Text("Default \(hardwareOrb.defaultModeCategoryLabel) · \(hardwareOrb.modeCategorySummary)")
                .font(.caption)
                .foregroundStyle(HBPalette.textSecondary)
                .lineLimit(2)

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
            HardwareOrbValueRow(title: "Default Category", value: hardwareOrb.defaultModeCategoryLabel)
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

private struct HardwareOrbCategoryRow: View {
    let category: HardwareOrbModeCategory
    let enabledIndex: Int?
    let enabledCount: Int
    let isSaving: Bool
    let onToggle: (Bool) -> Void
    let onMoveUp: () -> Void
    let onMoveDown: () -> Void

    private var isEnabled: Bool {
        enabledIndex != nil
    }

    private var isDefault: Bool {
        enabledIndex == 0
    }

    private var isLastEnabled: Bool {
        guard let enabledIndex else {
            return false
        }
        return enabledIndex == enabledCount - 1
    }

    private var isOnlyEnabled: Bool {
        isEnabled && enabledCount <= 1
    }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Text(enabledIndex.map { "\($0 + 1)" } ?? "Off")
                .font(.caption.monospacedDigit())
                .foregroundStyle(isEnabled ? HBPalette.accentBlue : HBPalette.textSecondary)
                .frame(width: 44, height: 32)
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(isEnabled ? HBPalette.accentBlue.opacity(0.12) : HBPalette.panelSoft.opacity(0.62))
                )

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(category.label)
                        .font(.subheadline.weight(.semibold))
                    if isDefault {
                        Text("Default")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(HBPalette.accentBlue)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(HBPalette.accentBlue.opacity(0.12), in: Capsule())
                    }
                }
                Text(category.details)
                    .font(.caption)
                    .foregroundStyle(HBPalette.textSecondary)
            }

            Spacer(minLength: 8)

            HStack(spacing: 6) {
                Button {
                    onMoveUp()
                } label: {
                    Image(systemName: "arrow.up")
                }
                .buttonStyle(.bordered)
                .disabled(isSaving || !isEnabled || isDefault)
                .accessibilityLabel("Move \(category.label) earlier")

                Button {
                    onMoveDown()
                } label: {
                    Image(systemName: "arrow.down")
                }
                .buttonStyle(.bordered)
                .disabled(isSaving || !isEnabled || isLastEnabled)
                .accessibilityLabel("Move \(category.label) later")

                Toggle("", isOn: Binding(
                    get: { isEnabled },
                    set: { onToggle($0) }
                ))
                .labelsHidden()
                .disabled(isSaving || isOnlyEnabled)
                .accessibilityLabel("\(isEnabled ? "Disable" : "Enable") \(category.label)")
            }
        }
        .padding(.vertical, 6)
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
