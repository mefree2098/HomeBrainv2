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
    case modules
    case alexa
    case codexSkill
    case openClaw
    case sense
    case tempest
    case goveeIndoorAir
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
        case .modules: return "Modules"
        case .alexa: return "Alexa"
        case .codexSkill: return "Codex Skill"
        case .openClaw: return "OpenClaw"
        case .sense: return "Sense"
        case .tempest: return "Tempest"
        case .goveeIndoorAir: return "Govee Indoor Air"
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
        case .modules: return "Capability map, source selection, and module health"
        case .alexa: return "Broker, link codes, discovery, voice users"
        case .codexSkill: return "Codex live skill token and bundle status"
        case .openClaw: return "OpenClaw MCP, token, Jetson bundle"
        case .sense: return "Sense Energy monitor setup and sync"
        case .tempest: return "Tempest station setup and weather fusion"
        case .goveeIndoorAir: return "Govee H5106 indoor temperature, humidity, and air quality"
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
        case .modules: return "square.grid.3x3"
        case .alexa: return "waveform"
        case .codexSkill: return "terminal"
        case .openClaw: return "point.3.connected.trianglepath.dotted"
        case .sense: return "bolt.fill"
        case .tempest: return "cloud.sun"
        case .goveeIndoorAir: return "house.fill"
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
        case .modules, .alexa, .codexSkill, .openClaw, .sense, .tempest, .goveeIndoorAir, .rainMachine, .deviceIntegrations,
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

private struct SecurityMonitoringSensorDraft: Identifiable, Equatable {
    var id: String
    var deviceId: String
    var localDeviceId: String?
    var smartThingsDeviceId: String?
    var zoneDeviceId: String?
    var name: String
    var room: String?
    var source: String?
    var sourceLabel: String?
    var sensorType: String
    var sensorTypeLabel: String?
    var stateLabel: String?
    var isOnline: Bool
    var isBypassed: Bool
    var bypassable: Bool
    var armedStayEnabled: Bool
    var armedAwayEnabled: Bool

    static func from(_ object: [String: Any]) -> SecurityMonitoringSensorDraft? {
        let resolvedID = [
            JSON.string(object, "zoneDeviceId"),
            JSON.string(object, "localDeviceId"),
            JSON.string(object, "deviceId"),
            JSON.string(object, "smartThingsDeviceId")
        ].first { !$0.isEmpty } ?? ""

        guard !resolvedID.isEmpty else {
            return nil
        }

        let monitoredModes = JSON.stringArray(object["monitoredModes"])
        let resolvedSensorType = JSON.string(object, "sensorType", fallback: "security")

        return SecurityMonitoringSensorDraft(
            id: resolvedID,
            deviceId: JSON.string(object, "deviceId", fallback: resolvedID),
            localDeviceId: JSON.optionalString(object, "localDeviceId"),
            smartThingsDeviceId: JSON.optionalString(object, "smartThingsDeviceId"),
            zoneDeviceId: JSON.optionalString(object, "zoneDeviceId"),
            name: JSON.string(object, "name", fallback: "Unnamed security sensor"),
            room: JSON.optionalString(object, "room"),
            source: JSON.optionalString(object, "source"),
            sourceLabel: JSON.optionalString(object, "sourceLabel"),
            sensorType: resolvedSensorType.isEmpty ? "security" : resolvedSensorType,
            sensorTypeLabel: JSON.optionalString(object, "sensorTypeLabel"),
            stateLabel: JSON.optionalString(object, "stateLabel"),
            isOnline: JSON.bool(object, "isOnline", fallback: true),
            isBypassed: JSON.bool(object, "isBypassed"),
            bypassable: JSON.bool(object, "bypassable", fallback: true),
            armedStayEnabled: JSON.bool(object, "armedStayEnabled") || monitoredModes.contains("armedStay"),
            armedAwayEnabled: JSON.bool(object, "armedAwayEnabled") || monitoredModes.contains("armedAway")
        )
    }

    var detailText: String {
        [
            room,
            sensorTypeLabel,
            sourceLabel ?? source,
            isOnline ? stateLabel : "Offline"
        ]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: " / ")
    }

    var payload: [String: Any] {
        [
            "name": name.isEmpty ? "Security zone" : name,
            "deviceId": zoneDeviceId ?? localDeviceId ?? deviceId,
            "deviceType": sensorType.isEmpty ? "security" : sensorType,
            "enabled": armedStayEnabled || armedAwayEnabled,
            "armedStayEnabled": armedStayEnabled,
            "armedAwayEnabled": armedAwayEnabled,
            "bypassable": bypassable,
            "bypassed": isBypassed
        ]
    }
}

private struct DynamicDnsReverseProxyRoute: Identifiable, Hashable {
    let id: String
    let hostname: String
    var enabled: Bool
    var dynamicDnsEnabled: Bool

    static func from(_ object: [String: Any]) -> DynamicDnsReverseProxyRoute? {
        let id = JSON.string(object, "_id")
        guard !id.isEmpty else { return nil }
        return DynamicDnsReverseProxyRoute(
            id: id,
            hostname: JSON.string(object, "hostname", fallback: "unknown"),
            enabled: JSON.bool(object, "enabled", fallback: false),
            dynamicDnsEnabled: JSON.bool(object, "dynamicDnsEnabled", fallback: false)
        )
    }
}

struct SettingsView: View {
    let previewMode: Bool

    @EnvironmentObject private var session: SessionStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var infoMessage = ""
    @State private var presentedSettingsSurface: SettingsParitySurface?
    @State private var presentedWebSettingsArea: SettingsWebArea?
    @State private var selectedSettingsArea: SettingsWebArea = .general
    @State private var showingDeleteAccount = false
    @State private var deleteAccountPassword = ""
    @State private var deleteAccountConfirmation = ""
    @State private var deleteAccountError: String?
    @State private var isDeletingAccount = false

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
    @State private var securityMonitoringSensors: [SecurityMonitoringSensorDraft] = []
    @State private var autoDiscoveryEnabled = false
    @State private var dynamicDnsEnabled = false
    @State private var dynamicDnsCheckIntervalSeconds = 60
    @State private var dynamicDnsPublicIpUrl = "https://api.ipify.org?format=json"
    @State private var dynamicDnsPrimaryHostname = ""
    @State private var dynamicDnsAzureTenantId = ""
    @State private var dynamicDnsAzureClientId = ""
    @State private var dynamicDnsAzureClientSecret = ""
    @State private var dynamicDnsAzureClientSecretConfigured = false
    @State private var dynamicDnsAzureSubscriptionId = ""
    @State private var dynamicDnsAzureResourceGroup = ""
    @State private var dynamicDnsAzureZoneName = ""
    @State private var dynamicDnsAzureTtlSeconds = 60
    @State private var dynamicDnsLastPublicIp = ""
    @State private var dynamicDnsLastCheckedAt = ""
    @State private var dynamicDnsLastUpdatedAt = ""
    @State private var dynamicDnsLastStatus = "never"
    @State private var dynamicDnsLastError = ""
    @State private var dynamicDnsRoutes: [DynamicDnsReverseProxyRoute] = []
    @State private var loadingDynamicDnsRoutes = false
    @State private var pushingDynamicDns = false

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
    @State private var contentWidth: CGFloat = 0
    @State private var appliedPreviewLaunchActions = false

    private let llmProviders = ["openai", "codex", "anthropic", "local"]
    private let sttProviders = ["openai", "local"]
    private let securityExitDelayOptions = [0, 15, 30, 45, 60, 90, 120]

    init(previewMode: Bool = false) {
        self.previewMode = previewMode
    }

    private static func previewSettingsAreaFromLaunch() -> SettingsWebArea? {
        let processInfo = ProcessInfo.processInfo
        let rawArea: String?

        if let index = processInfo.arguments.firstIndex(of: "-ui-preview-settings-area"),
           processInfo.arguments.indices.contains(index + 1) {
            rawArea = processInfo.arguments[index + 1]
        } else {
            rawArea = processInfo.environment["UI_PREVIEW_SETTINGS_AREA"]
        }

        guard let normalized = rawArea?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "-", with: "")
            .replacingOccurrences(of: "_", with: "")
            .lowercased(),
              !normalized.isEmpty else {
            return nil
        }

        return SettingsWebArea.allCases.first { area in
            let rawValue = area.rawValue
                .replacingOccurrences(of: "-", with: "")
                .replacingOccurrences(of: "_", with: "")
                .lowercased()
            let title = area.title
                .replacingOccurrences(of: " ", with: "")
                .replacingOccurrences(of: "/", with: "")
                .replacingOccurrences(of: "-", with: "")
                .lowercased()
            return rawValue == normalized || title == normalized
        }
    }

    private static func previewShouldOpenSettingsAreaFromLaunch() -> Bool {
        let processInfo = ProcessInfo.processInfo
        if processInfo.arguments.contains("-ui-preview-open-settings-area") {
            return true
        }
        if let environmentValue = processInfo.environment["UI_PREVIEW_OPEN_SETTINGS_AREA"] {
            return ["1", "true", "yes"].contains(environmentValue.lowercased())
        }
        return false
    }

    private var isAdmin: Bool {
        previewMode || session.currentUser?.role == "admin"
    }

    private var isReviewSandbox: Bool {
        !previewMode && session.currentUser?.isReviewSandbox == true
    }

    private var usesCompactSettingsAreaSelector: Bool {
        horizontalSizeClass == .compact || contentWidth < 620
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
        GeometryReader { proxy in
            VStack(spacing: 12) {
                if isReviewSandbox {
                    reviewSandboxSettings
                } else if isLoading {
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
                                    .font(HBTypography.body(.subheadline))
                                    .foregroundStyle(HBPalette.textSecondary)
                            }
                        }

                        if session.currentUser != nil {
                            settingsAccountSection
                        }

                        Section(usesCompactSettingsAreaSelector ? "Area" : "Settings Areas") {
                            settingsAreaSelector
                        }

                        settingsInlineAreaContent(selectedSettingsArea)

                    }
                    .hbFormStyle()
                    .refreshable {
                        await loadSettings()
                    }
                }
            }
            .padding(usesCompactSettingsAreaSelector ? 12 : 16)
            .onAppear {
                contentWidth = proxy.size.width
            }
            .onChange(of: proxy.size.width) { _, newWidth in
                contentWidth = newWidth
            }
        }
        .task {
            guard !isReviewSandbox else {
                isLoading = false
                return
            }
            await loadSettings()
        }
        .sheet(isPresented: $showingDeleteAccount) {
            deleteAccountSheet
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
        .fullScreenCover(item: $presentedWebSettingsArea) { area in
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

    private var reviewSandboxSettings: some View {
        VStack(spacing: 12) {
            HBSectionHeader(
                title: "Settings",
                subtitle: "Apple App Review demo environment"
            )

            Form {
                Section("Review Sandbox") {
                    Label("Synthetic demo data", systemImage: "checkmark.shield")
                        .foregroundStyle(HBPalette.accentGreen)

                    Text("The rooms, devices, scenes, workflows, notifications, weather, and Watch content available to this account are virtual examples created for App Review.")
                        .font(HBTypography.body(.footnote))
                        .foregroundStyle(HBPalette.textSecondary)

                    Text("This sandbox is isolated from the owner's household. Actions taken here cannot view or control production devices, integrations, credentials, or global HomeBrain settings.")
                        .font(HBTypography.body(.footnote))
                        .foregroundStyle(HBPalette.textSecondary)
                }

                settingsAccountSection
            }
            .hbFormStyle()
        }
    }

    private var settingsAccountSection: some View {
        Section("Account") {
            LabeledContent("Signed in as", value: session.currentUser?.email ?? "")

            Text(isReviewSandbox
                 ? "Deleting this review account removes its login, sessions, and isolated demo data. It does not affect the owner's household or any production resources."
                 : "Deleting your account removes your login, sessions, notifications, push registrations, voice-command history, and security PIN. Devices, rooms, scenes, and workflows remain with the HomeBrain hub.")
                .font(HBTypography.body(.footnote))
                .foregroundStyle(HBPalette.textSecondary)

            Button(role: .destructive) {
                deleteAccountPassword = ""
                deleteAccountConfirmation = ""
                deleteAccountError = nil
                showingDeleteAccount = true
            } label: {
                Label("Delete Account", systemImage: "person.crop.circle.badge.xmark")
            }
        }
    }

    private var deleteAccountSheet: some View {
        NavigationStack {
            Form {
                Section {
                    Text(isReviewSandbox
                         ? "This permanently deletes the review account, signs it out on all devices, and removes its isolated demo data. No production household resources are affected."
                         : "This permanently deletes your HomeBrain account and signs it out on all devices. Household configuration remains available to other authorized hub accounts.")
                        .foregroundStyle(HBPalette.textSecondary)
                }

                Section("Confirm your identity") {
                    SecureField("Current password", text: $deleteAccountPassword)
                        .textContentType(.password)

                    TextField("Type DELETE", text: $deleteAccountConfirmation)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                }

                if let deleteAccountError, !deleteAccountError.isEmpty {
                    Section {
                        InlineErrorView(message: deleteAccountError, retry: nil)
                    }
                }
            }
            .hbFormStyle()
            .navigationTitle("Delete Account")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(isDeletingAccount)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        showingDeleteAccount = false
                    }
                    .disabled(isDeletingAccount)
                }

                ToolbarItem(placement: .confirmationAction) {
                    Button(role: .destructive) {
                        Task { await deleteCurrentAccount() }
                    } label: {
                        if isDeletingAccount {
                            ProgressView()
                        } else {
                            Text("Delete")
                        }
                    }
                    .disabled(
                        isDeletingAccount
                        || deleteAccountPassword.isEmpty
                        || deleteAccountConfirmation != "DELETE"
                    )
                }
            }
        }
    }

    private func deleteCurrentAccount() async {
        isDeletingAccount = true
        deleteAccountError = nil
        let deleted = await session.deleteAccount(password: deleteAccountPassword)
        isDeletingAccount = false

        if deleted {
            showingDeleteAccount = false
            deleteAccountPassword = ""
            deleteAccountConfirmation = ""
        } else {
            deleteAccountError = session.authError ?? "HomeBrain could not delete the account."
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

    @ViewBuilder
    private var settingsAreaSelector: some View {
        if usesCompactSettingsAreaSelector {
            compactSettingsAreaSelector
        } else {
            settingsTabRail
        }
    }

    private var compactSettingsAreaSelector: some View {
        VStack(alignment: .leading, spacing: 12) {
            Menu {
                Picker("Settings Area", selection: $selectedSettingsArea) {
                    ForEach(availableSettingsAreas) { area in
                        Label(area.title, systemImage: area.icon)
                            .tag(area)
                    }
                }
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: selectedSettingsArea.icon)
                        .foregroundStyle(HBPalette.accentBlue)
                        .frame(width: 24)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(selectedSettingsArea.title)
                            .font(HBTypography.body(.subheadline, weight: .semibold))
                            .foregroundStyle(HBPalette.textPrimary)
                        Text(selectedSettingsArea.subtitle)
                            .font(HBTypography.body(.caption))
                            .foregroundStyle(HBPalette.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.up.chevron.down")
                        .font(HBTypography.body(.caption, weight: .bold))
                        .foregroundStyle(HBPalette.textMuted)
                }
                .padding(12)
                .background(HBGlassBackground(cornerRadius: 16, variant: .panelSoft))
            }
            .buttonStyle(.plain)

            if selectedSettingsArea.isAdminOnly {
                Button {
                    presentedWebSettingsArea = selectedSettingsArea
                } label: {
                    Label("Open \(selectedSettingsArea.title) Controls", systemImage: "arrow.up.forward.square")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(HBSecondaryButtonStyle(compact: true))
            }
        }
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
                                .font(HBTypography.body(.caption, weight: .semibold))
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
                        .font(HBTypography.body(.subheadline, weight: .semibold))
                    Text(selectedSettingsArea.subtitle)
                        .font(HBTypography.body(.caption))
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
            settingsDynamicDnsSection
            settingsSaveRefreshSection

        case .voice:
            settingsVoiceSection
            settingsSTTSection
            settingsSaveRefreshSection

        case .integrations:
            settingsIntegrationBasicsSection
            settingsIntegrationTabsSection
            settingsSaveRefreshSection

        case .modules, .alexa, .codexSkill, .openClaw, .sense, .tempest, .goveeIndoorAir, .rainMachine, .ecobee, .resources, .maintenance:
            EmptyView()

        case .deviceIntegrations:
            settingsIntegrationBasicsSection
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

    @ViewBuilder
    private var settingsDynamicDnsSection: some View {
        Section("Dynamic DNS") {
            Toggle("Enable Dynamic DNS", isOn: $dynamicDnsEnabled)
            TextField("Primary Hostname", text: $dynamicDnsPrimaryHostname)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            TextField("Public IP URL", text: $dynamicDnsPublicIpUrl)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Stepper("Check every \(dynamicDnsCheckIntervalSeconds)s", value: $dynamicDnsCheckIntervalSeconds, in: 60...3600, step: 60)
            Stepper("Azure TTL \(dynamicDnsAzureTtlSeconds)s", value: $dynamicDnsAzureTtlSeconds, in: 30...86400, step: 30)
            TextField("Azure Tenant ID", text: $dynamicDnsAzureTenantId)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            TextField("Azure Client ID", text: $dynamicDnsAzureClientId)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            SecureField(dynamicDnsAzureClientSecretConfigured ? "Azure Client Secret Configured" : "Azure Client Secret", text: $dynamicDnsAzureClientSecret)
            TextField("Azure Subscription ID", text: $dynamicDnsAzureSubscriptionId)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            TextField("Azure Resource Group", text: $dynamicDnsAzureResourceGroup)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            TextField("Azure DNS Zone", text: $dynamicDnsAzureZoneName)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()

            Button {
                Task { await pushDynamicDnsUpdatesNow() }
            } label: {
                if pushingDynamicDns {
                    ProgressView()
                } else {
                    Label("Push DNS updates now", systemImage: "arrow.clockwise")
                }
            }
            .disabled(pushingDynamicDns)

            LabeledContent("Status", value: dynamicDnsLastStatus)
            LabeledContent("Current IP", value: dynamicDnsLastPublicIp.isEmpty ? "Unknown" : dynamicDnsLastPublicIp)
            LabeledContent("Last checked", value: settingsFormatDateTime(dynamicDnsLastCheckedAt))
            LabeledContent("Last pushed", value: settingsFormatDateTime(dynamicDnsLastUpdatedAt))
            if !dynamicDnsLastError.isEmpty {
                Text(dynamicDnsLastError)
                    .font(HBTypography.body(.caption))
                    .foregroundStyle(.red)
            }
        }

        Section("Reverse Proxy Dynamic DNS") {
            if loadingDynamicDnsRoutes {
                ProgressView()
            } else if dynamicDnsRoutes.isEmpty {
                Text("No reverse proxy routes found.")
                    .foregroundStyle(HBPalette.textSecondary)
            } else {
                ForEach(dynamicDnsRoutes) { route in
                    Toggle(isOn: Binding(
                        get: { route.dynamicDnsEnabled },
                        set: { enabled in
                            Task { await setDynamicDnsRoute(route, enabled: enabled) }
                        }
                    )) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(route.hostname)
                            Text(route.enabled ? "Enabled" : "Disabled")
                                .font(HBTypography.body(.caption))
                                .foregroundStyle(HBPalette.textSecondary)
                        }
                    }
                }
            }
            Button("Refresh Reverse Proxy Routes") {
                Task { await loadDynamicDnsRoutes() }
            }
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
                .font(HBTypography.body(.footnote))
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
                SettingsWebArea.modules,
                SettingsWebArea.alexa,
                .codexSkill,
                .openClaw,
                .sense,
                .tempest,
                .goveeIndoorAir,
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
                            .font(HBTypography.body(.caption, weight: .bold))
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

            Text("Alarm Monitoring")
                .font(HBTypography.body(.headline))

            if securityMonitoringSensors.isEmpty {
                Text("No security sensors available.")
                    .font(HBTypography.body(.footnote))
                    .foregroundStyle(.secondary)
            } else {
                ForEach(securityMonitoringSensors.indices, id: \.self) { index in
                    let sensor = securityMonitoringSensors[index]
                    VStack(alignment: .leading, spacing: 8) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(sensor.name)
                                .font(HBTypography.body(.subheadline))
                                .fontWeight(.semibold)
                            Text(sensor.detailText.isEmpty ? "Security sensor" : sensor.detailText)
                                .font(HBTypography.body(.caption))
                                .foregroundStyle(.secondary)
                        }

                        HStack {
                            Toggle("Stay", isOn: $securityMonitoringSensors[index].armedStayEnabled)
                            Toggle("Away", isOn: $securityMonitoringSensors[index].armedAwayEnabled)
                        }
                    }
                    .padding(.vertical, 4)
                }
            }

            Toggle("Require PIN to Arm", isOn: $securityRequirePinForArm)
            Toggle("Require PIN to Disarm", isOn: $securityRequirePinForDisarm)

            if securityPinDrafts.isEmpty {
                Text("No security PINs configured.")
                    .font(HBTypography.body(.footnote))
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
                .font(HBTypography.body(.footnote))
                .foregroundStyle(HBPalette.textSecondary)
        }
    }

    private func settingsOpenFullAreaSection(_ area: SettingsWebArea) -> some View {
        Section(area.title) {
            Text(area.subtitle)
                .font(HBTypography.body(.footnote))
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
                        SettingsWebArea.modules,
                        SettingsWebArea.alexa,
                        .codexSkill,
                        .openClaw,
                        .sense,
                        .tempest,
                        .goveeIndoorAir,
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

        case .modules:
            SettingsEndpointPane(
                title: "Integration Modules",
                subtitle: "Module health, capability providers, selected Climate sources, and telemetry-capable integrations.",
                statusPath: "/api/integrations",
                actions: [
                    SettingsEndpointAction(title: "Climate Outdoor Providers", method: .get, path: "/api/integrations/capabilities/outdoor_climate/providers"),
                    SettingsEndpointAction(title: "Climate Indoor Providers", method: .get, path: "/api/integrations/capabilities/indoor_climate/providers"),
                    SettingsEndpointAction(title: "Air Quality Providers", method: .get, path: "/api/integrations/capabilities/air_quality/providers")
                ]
            )

        case .alexa:
            SettingsEndpointPane(
                title: "Alexa",
                subtitle: "Broker pairing, link codes, discovery sync, and event delivery controls.",
                statusPath: "/api/alexa",
                actions: [
                    SettingsEndpointAction(title: "Generate Private Link Code", method: .post, path: "/api/alexa/link-codes", body: ["mode": "private"]),
                    SettingsEndpointAction(title: "Generate Public Link Code", method: .post, path: "/api/alexa/link-codes", body: ["mode": "public"]),
                    SettingsEndpointAction(title: "Force Discovery Sync", method: .post, path: "/api/alexa/discovery-sync", body: ["reason": "ios-settings"]),
                    SettingsEndpointAction(title: "Flush Broker Events", method: .post, path: "/api/alexa/events/flush", body: ["limit": 100]),
                    SettingsEndpointAction(title: "Add All INSTEON Devices", method: .post, path: "/api/alexa/exposures/devices/by-source/insteon", body: ["enabled": true]),
                    SettingsEndpointAction(title: "Add All Zigbee Devices", method: .post, path: "/api/alexa/exposures/devices/by-source/homebrain-zigbee", body: ["enabled": true]),
                    SettingsEndpointAction(title: "Add All Z-Wave Devices", method: .post, path: "/api/alexa/exposures/devices/by-source/homebrain-zwave", body: ["enabled": true]),
                    SettingsEndpointAction(title: "Add All Matter Devices", method: .post, path: "/api/alexa/exposures/devices/by-source/homebrain-matter", body: ["enabled": true]),
                    SettingsEndpointAction(title: "Add All Thread Devices", method: .post, path: "/api/alexa/exposures/devices/by-source/homebrain-thread", body: ["enabled": true]),
                    SettingsEndpointAction(title: "Add All SmartThings Devices", method: .post, path: "/api/alexa/exposures/devices/by-source/smartthings", body: ["enabled": true]),
                    SettingsEndpointAction(title: "Add All Harmony Devices", method: .post, path: "/api/alexa/exposures/devices/by-source/harmony", body: ["enabled": true]),
                    SettingsEndpointAction(title: "Add All Ecobee Devices", method: .post, path: "/api/alexa/exposures/devices/by-source/ecobee", body: ["enabled": true])
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

        case .goveeIndoorAir:
            WeatherView()

        case .rainMachine:
            RainMachineView()

        case .deviceIntegrations:
            SettingsDeviceIntegrationsPane(
                previewMode: previewMode,
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
                        .font(HBTypography.body(.footnote))
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
                    .font(HBTypography.body(.subheadline))
                    .foregroundStyle(HBPalette.textSecondary)
            } else {
                ForEach(authSessions) { authSession in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(authSession.clientName)
                                .font(HBTypography.display(.headline, weight: .semibold))
                            Spacer()
                            if authSession.isCurrent {
                                Text("This device")
                                    .font(HBTypography.body(.caption, weight: .semibold))
                                    .foregroundStyle(HBPalette.accentBlue)
                            }
                        }

                        Text("Last used: \(settingsFormatDateTime(authSession.lastUsedAt))")
                            .font(HBTypography.body(.caption))
                            .foregroundStyle(HBPalette.textSecondary)
                        Text("Expires: \(settingsFormatDateTime(authSession.expiresAt))")
                            .font(HBTypography.body(.caption))
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
                .font(HBTypography.body(.footnote))
                .foregroundStyle(HBPalette.textSecondary)

            Picker("Hardware Orb Settings", selection: $selectedHardwareOrbTab) {
                ForEach(HardwareOrbSettingsTab.allCases) { tab in
                    Text(tab.title).tag(tab)
                }
            }
            .pickerStyle(.segmented)

            if let hardwareOrbLoadError {
                Text(hardwareOrbLoadError)
                    .font(HBTypography.body(.footnote))
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
                    .font(HBTypography.body(.subheadline))
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
                        .font(HBTypography.body(.caption))
                        .foregroundStyle(HBPalette.textSecondary)
                }

                if !hardwareOrb.ota.lastError.isEmpty {
                    Text(hardwareOrb.ota.lastError)
                        .font(HBTypography.body(.caption))
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
                        .font(HBTypography.body(.caption))
                        .foregroundStyle(HBPalette.textSecondary)
                } else if !hardwareOrb.isRegistered {
                    Text("This orb must complete its first activation before Wi-Fi OTA firmware pushes are available.")
                        .font(HBTypography.body(.caption))
                        .foregroundStyle(HBPalette.textSecondary)
                }
            } else {
                Text("No hardware orb is selected.")
                    .font(HBTypography.body(.subheadline))
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
                .font(HBTypography.display(.headline, weight: .semibold))
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
                .font(HBTypography.display(.headline, weight: .semibold))
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
                .font(HBTypography.body(.footnote))
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
                    .font(HBTypography.body(.subheadline))
                    .foregroundStyle(HBPalette.textSecondary)
            }
        }
        .padding(.vertical, 4)
    }

    private var hardwareOrbAlignmentContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Rotate each orb UI in 0.5° steps to compensate for wall mounting. Changes save per device and sync through HomeBrain.")
                .font(HBTypography.body(.footnote))
                .foregroundStyle(HBPalette.textSecondary)

            if hardwareOrbs.isEmpty {
                Text("No hardware orbs registered yet.")
                    .font(HBTypography.body(.subheadline))
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
        guard !isReviewSandbox else {
            isLoading = false
            errorMessage = nil
            infoMessage = ""
            return
        }

        if previewMode {
            var previewAreaToOpen: SettingsWebArea?
            if !appliedPreviewLaunchActions {
                if let previewSettingsArea = Self.previewSettingsAreaFromLaunch() {
                    selectedSettingsArea = previewSettingsArea
                    if Self.previewShouldOpenSettingsAreaFromLaunch() {
                        previewAreaToOpen = previewSettingsArea
                    }
                }
                appliedPreviewLaunchActions = true
            }
            serverURL = "https://homebrain.local"
            location = "Home"
            timezone = TimeZone.current.identifier
            smartthingsUseOAuth = true
            harmonyHubAddresses = "192.168.2.43"
            hardwareOrbWifiSsid = "HomeBrain-IoT"
            hardwareOrbWifiSavedSsid = hardwareOrbWifiSsid
            hardwareOrbWifiPassword = ""
            hardwareOrbWifiPasswordConfigured = true
            securityPinDrafts = [
                SecurityPinDraft(id: "preview-pin", name: "Family", pin: "", enabled: true, existing: true)
            ]
            infoMessage = ""
            errorMessage = nil
            isLoading = false
            if let previewAreaToOpen {
                presentedWebSettingsArea = previewAreaToOpen
            }
            return
        }

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
            dynamicDnsEnabled = JSON.bool(settings, "dynamicDnsEnabled", fallback: dynamicDnsEnabled)
            dynamicDnsCheckIntervalSeconds = max(60, min(3600, JSON.int(settings, "dynamicDnsCheckIntervalSeconds", fallback: dynamicDnsCheckIntervalSeconds)))
            dynamicDnsPublicIpUrl = JSON.string(settings, "dynamicDnsPublicIpUrl", fallback: dynamicDnsPublicIpUrl)
            dynamicDnsPrimaryHostname = JSON.string(settings, "dynamicDnsPrimaryHostname")
            dynamicDnsAzureTenantId = JSON.string(settings, "dynamicDnsAzureTenantId")
            dynamicDnsAzureClientId = JSON.string(settings, "dynamicDnsAzureClientId")
            dynamicDnsAzureClientSecret = ""
            dynamicDnsAzureClientSecretConfigured = JSON.bool(settings, "dynamicDnsAzureClientSecretConfigured", fallback: dynamicDnsAzureClientSecretConfigured)
            dynamicDnsAzureSubscriptionId = JSON.string(settings, "dynamicDnsAzureSubscriptionId")
            dynamicDnsAzureResourceGroup = JSON.string(settings, "dynamicDnsAzureResourceGroup")
            dynamicDnsAzureZoneName = JSON.string(settings, "dynamicDnsAzureZoneName")
            dynamicDnsAzureTtlSeconds = max(30, min(86400, JSON.int(settings, "dynamicDnsAzureTtlSeconds", fallback: dynamicDnsAzureTtlSeconds)))
            dynamicDnsLastPublicIp = JSON.string(settings, "dynamicDnsLastPublicIp")
            dynamicDnsLastCheckedAt = JSON.string(settings, "dynamicDnsLastCheckedAt")
            dynamicDnsLastUpdatedAt = JSON.string(settings, "dynamicDnsLastUpdatedAt")
            dynamicDnsLastStatus = JSON.string(settings, "dynamicDnsLastStatus", fallback: dynamicDnsLastStatus)
            dynamicDnsLastError = JSON.string(settings, "dynamicDnsLastError")

            llmProvider = JSON.string(settings, "llmProvider", fallback: llmProvider)
            openaiModel = JSON.string(settings, "openaiModel", fallback: openaiModel)
            codexModel = JSON.string(settings, "codexModel", fallback: codexModel)
            anthropicModel = JSON.string(settings, "anthropicModel", fallback: anthropicModel)
            localLlmEndpoint = JSON.string(settings, "localLlmEndpoint", fallback: localLlmEndpoint)
            localLlmModel = JSON.string(settings, "localLlmModel", fallback: localLlmModel)

            sttProvider = JSON.string(settings, "sttProvider", fallback: sttProvider)
            sttModel = JSON.string(settings, "sttModel", fallback: sttModel)
            sttLanguage = JSON.string(settings, "sttLanguage", fallback: sttLanguage)
            await loadDynamicDnsRoutes()

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
            let statusResponse = try await session.apiClient.get("/api/security-alarm/status")
            let statusObject = JSON.object(statusResponse)
            let status = JSON.object(statusObject["status"])
            securityMonitoringSensors = JSON.array(status["sensors"]).compactMap(SecurityMonitoringSensorDraft.from)
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
                "dynamicDnsEnabled": dynamicDnsEnabled,
                "dynamicDnsProvider": "azure",
                "dynamicDnsCheckIntervalSeconds": dynamicDnsCheckIntervalSeconds,
                "dynamicDnsPublicIpUrl": dynamicDnsPublicIpUrl,
                "dynamicDnsPrimaryHostname": dynamicDnsPrimaryHostname,
                "dynamicDnsAzureTenantId": dynamicDnsAzureTenantId,
                "dynamicDnsAzureClientId": dynamicDnsAzureClientId,
                "dynamicDnsAzureClientSecret": dynamicDnsAzureClientSecret,
                "dynamicDnsAzureSubscriptionId": dynamicDnsAzureSubscriptionId,
                "dynamicDnsAzureResourceGroup": dynamicDnsAzureResourceGroup,
                "dynamicDnsAzureZoneName": dynamicDnsAzureZoneName,
                "dynamicDnsAzureTtlSeconds": dynamicDnsAzureTtlSeconds,
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
            let settings = JSON.object(object["settings"])
            dynamicDnsAzureClientSecret = ""
            dynamicDnsAzureClientSecretConfigured = JSON.bool(settings, "dynamicDnsAzureClientSecretConfigured", fallback: dynamicDnsAzureClientSecretConfigured)
            dynamicDnsLastPublicIp = JSON.string(settings, "dynamicDnsLastPublicIp", fallback: dynamicDnsLastPublicIp)
            dynamicDnsLastCheckedAt = JSON.string(settings, "dynamicDnsLastCheckedAt", fallback: dynamicDnsLastCheckedAt)
            dynamicDnsLastUpdatedAt = JSON.string(settings, "dynamicDnsLastUpdatedAt", fallback: dynamicDnsLastUpdatedAt)
            dynamicDnsLastStatus = JSON.string(settings, "dynamicDnsLastStatus", fallback: dynamicDnsLastStatus)
            dynamicDnsLastError = JSON.string(settings, "dynamicDnsLastError", fallback: dynamicDnsLastError)
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
        let zonesPayload = securityMonitoringSensors.map(\.payload)

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
            "pins": pinsPayload,
            "zones": zonesPayload
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
        let statusResponse = try await session.apiClient.get("/api/security-alarm/status")
        let statusObject = JSON.object(statusResponse)
        let status = JSON.object(statusObject["status"])
        securityMonitoringSensors = JSON.array(status["sensors"]).compactMap(SecurityMonitoringSensorDraft.from)
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

    private func pushDynamicDnsUpdatesNow() async {
        pushingDynamicDns = true
        defer { pushingDynamicDns = false }
        do {
            let response = try await session.apiClient.post("/api/settings/dynamic-dns/push", body: [:])
            let object = JSON.object(response)
            infoMessage = JSON.string(object, "message", fallback: "Dynamic DNS push complete.")
            errorMessage = nil
            await loadSettings()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func loadDynamicDnsRoutes() async {
        loadingDynamicDnsRoutes = true
        defer { loadingDynamicDnsRoutes = false }
        do {
            let response = try await session.apiClient.get("/api/admin/reverse-proxy/routes")
            let object = JSON.object(response)
            dynamicDnsRoutes = JSON.array(object["routes"]).compactMap {
                DynamicDnsReverseProxyRoute.from(JSON.object($0))
            }
        } catch {
            dynamicDnsRoutes = []
        }
    }

    private func setDynamicDnsRoute(_ route: DynamicDnsReverseProxyRoute, enabled: Bool) async {
        do {
            let response = try await session.apiClient.put(
                "/api/admin/reverse-proxy/routes/\(route.id)",
                body: ["dynamicDnsEnabled": enabled]
            )
            let object = JSON.object(response)
            if let updated = DynamicDnsReverseProxyRoute.from(JSON.object(object["route"])) {
                dynamicDnsRoutes = dynamicDnsRoutes.map { $0.id == route.id ? updated : $0 }
            } else {
                dynamicDnsRoutes = dynamicDnsRoutes.map {
                    var copy = $0
                    if copy.id == route.id {
                        copy.dynamicDnsEnabled = enabled
                    }
                    return copy
                }
            }
            infoMessage = "\(route.hostname) Dynamic DNS \(enabled ? "enabled" : "disabled")."
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
            await loadDynamicDnsRoutes()
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

    nonisolated static func from(_ object: [String: Any]) -> DirectRadioScoreSet {
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

    nonisolated static func from(_ object: [String: Any]) -> DirectRadioSerialPortRecord {
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

private struct DirectRadioChannelEnergyRecord: Identifiable {
    let channel: Int
    let energy: Int

    var id: Int { channel }

    nonisolated static func from(_ object: [String: Any]) -> DirectRadioChannelEnergyRecord {
        DirectRadioChannelEnergyRecord(
            channel: JSON.int(object, "channel"),
            energy: JSON.int(object, "energy")
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
    let networkChannel: Int
    let networkPanID: Int
    let firmwareVersion: String
    let sdkVersion: String

    var isReady: Bool {
        started && !detectedPort.isEmpty && error.isEmpty
    }

    // Zooz ZST39 / 800-series SDK builds with documented controller lockups,
    // fixed by Zooz firmware 1.50 (SDK 7.22.1) and newer.
    var hasKnownBadZWaveFirmware: Bool {
        sdkVersion.hasPrefix("7.21.") || sdkVersion == "7.22.0" || sdkVersion.hasPrefix("7.22.0.")
    }

    var activeWindow: String {
        if !permitJoinUntil.isEmpty { return permitJoinUntil }
        if !inclusionUntil.isEmpty { return inclusionUntil }
        if !exclusionUntil.isEmpty { return exclusionUntil }
        return ""
    }

    nonisolated static func from(_ object: [String: Any], protocolName: String) -> DirectRadioControllerRecord {
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
            lastStartResult: JSON.string(object, "lastStartResult"),
            networkChannel: JSON.int(JSON.object(object["network"]), "channel"),
            networkPanID: JSON.int(JSON.object(object["network"]), "panID"),
            firmwareVersion: JSON.string(object, "controllerFirmwareVersion"),
            sdkVersion: JSON.string(object, "controllerSdkVersion")
        )
    }
}

private struct DirectRadioControllerSet {
    let zigbee: DirectRadioControllerRecord
    let zwave: DirectRadioControllerRecord

    nonisolated static func from(_ object: [String: Any]) -> DirectRadioControllerSet {
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

    nonisolated static func from(_ object: [String: Any]) -> DirectRadioStatusSnapshot {
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

    nonisolated static func from(_ object: [String: Any]) -> DirectRadioLogEntryRecord {
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

private struct DeviceCatalogUpdateSourceRecord {
    let success: Bool
    let sourceUrl: String
    let existingCount: Int
    let fetchedCount: Int
    let addedCount: Int
    let totalCount: Int
    let error: String

    nonisolated static func from(_ object: [String: Any]) -> DeviceCatalogUpdateSourceRecord {
        DeviceCatalogUpdateSourceRecord(
            success: JSON.bool(object, "success", fallback: true),
            sourceUrl: JSON.string(object, "sourceUrl"),
            existingCount: JSON.int(object, "existingCount"),
            fetchedCount: JSON.int(object, "fetchedCount"),
            addedCount: JSON.int(object, "addedCount"),
            totalCount: JSON.int(object, "totalCount"),
            error: JSON.string(object, "error")
        )
    }
}

private struct DeviceCatalogUpdateStatusRecord {
    let running: Bool
    let scheduled: Bool
    let lastRunAt: String
    let lastSuccessAt: String
    let nextDueAt: String
    let due: Bool
    let errors: [[String: Any]]
    let sources: [String: DeviceCatalogUpdateSourceRecord]

    var addedLastRun: Int {
        sources.values.reduce(0) { total, source in
            total + source.addedCount
        }
    }

    var statusLabel: String {
        if running { return "Checking Now" }
        if !errors.isEmpty { return "Last Check Failed" }
        if !lastSuccessAt.isEmpty { return "Last Check Successful" }
        return "Not Checked Yet"
    }

    nonisolated static func from(_ object: [String: Any]) -> DeviceCatalogUpdateStatusRecord {
        let update = JSON.object(object["update"])
        let catalogUpdate = JSON.object(update["catalogUpdate"])
        let fallbackStatus = JSON.object(object["status"])
        let status = catalogUpdate.isEmpty ? fallbackStatus : catalogUpdate
        let sourceObjects = JSON.object(status["sources"])
        let sources = sourceObjects.reduce(into: [String: DeviceCatalogUpdateSourceRecord]()) { result, entry in
            result[entry.key] = DeviceCatalogUpdateSourceRecord.from(JSON.object(entry.value))
        }

        return DeviceCatalogUpdateStatusRecord(
            running: JSON.bool(update, "running"),
            scheduled: JSON.bool(update, "scheduled"),
            lastRunAt: JSON.string(status, "lastRunAt"),
            lastSuccessAt: JSON.string(status, "lastSuccessAt"),
            nextDueAt: JSON.string(status, "nextDueAt"),
            due: JSON.bool(status, "due"),
            errors: JSON.array(status["errors"]),
            sources: sources
        )
    }
}

private struct DeviceCatalogProtocolRecord: Identifiable {
    let id: String
    let title: String
    let source: String
    let primaryCount: Int
    let secondary: String
    let addedLastRun: Int
    let errors: Int

    nonisolated static func records(from object: [String: Any], update: DeviceCatalogUpdateStatusRecord?) -> [DeviceCatalogProtocolRecord] {
        [
            record(
                id: "zigbee",
                title: "Zigbee",
                object: JSON.object(object["zigbee"]),
                primaryKey: "definitionCount",
                secondary: { item in
                    "\(JSON.int(item, "vendorCount")) vendors, \(JSON.int(item, "exposesCount")) exposes"
                },
                update: update
            ),
            record(
                id: "zwave",
                title: "Z-Wave",
                object: JSON.object(object["zwave"]),
                primaryKey: "deviceConfigCount",
                secondary: { item in
                    "\(JSON.int(item, "manufacturerCount")) manufacturers"
                },
                update: update
            ),
            record(
                id: "matter",
                title: "Matter",
                object: JSON.object(object["matter"]),
                primaryKey: "certifiedProductCount",
                secondary: { item in
                    "\(JSON.int(item, "standardDeviceTypeCount")) standard types, \(JSON.int(item, "vendorProductCount")) vendors"
                },
                update: update
            ),
            record(
                id: "thread",
                title: "Thread",
                object: JSON.object(object["thread"]),
                primaryKey: "certifiedProductCount",
                secondary: { item in
                    let snapshot = JSON.object(item["snapshot"])
                    let updatedAt = JSON.string(snapshot, "updatedAt")
                    return updatedAt.isEmpty ? "Matter-over-Thread enrichment" : "Snapshot \(settingsFormatDateTime(updatedAt))"
                },
                update: update
            ),
            record(
                id: "insteon",
                title: "INSTEON",
                object: JSON.object(object["insteon"]),
                primaryKey: "productEntryCount",
                secondary: { item in
                    "\(JSON.int(item, "categoryCount")) categories, \(JSON.int(item, "entryCount")) profiles"
                },
                update: update
            )
        ]
    }

    private nonisolated static func record(
        id: String,
        title: String,
        object: [String: Any],
        primaryKey: String,
        secondary: ([String: Any]) -> String,
        update: DeviceCatalogUpdateStatusRecord?
    ) -> DeviceCatalogProtocolRecord {
        DeviceCatalogProtocolRecord(
            id: id,
            title: title,
            source: JSON.string(object, "source"),
            primaryCount: JSON.int(object, primaryKey),
            secondary: secondary(object),
            addedLastRun: update?.sources[id]?.addedCount ?? 0,
            errors: JSON.array(object["errors"]).count
        )
    }
}

private struct DeviceCatalogSummaryRecord {
    let generatedAt: String
    let protocols: [DeviceCatalogProtocolRecord]

    nonisolated static func from(_ object: [String: Any], update: DeviceCatalogUpdateStatusRecord?) -> DeviceCatalogSummaryRecord {
        DeviceCatalogSummaryRecord(
            generatedAt: JSON.string(object, "generatedAt"),
            protocols: DeviceCatalogProtocolRecord.records(from: object, update: update)
        )
    }
}

private struct SettingsDeviceIntegrationsPane: View {
    @EnvironmentObject private var session: SessionStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    let previewMode: Bool

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
    @State private var deviceCatalogSummary: DeviceCatalogSummaryRecord?
    @State private var deviceCatalogUpdate: DeviceCatalogUpdateStatusRecord?
    @State private var deviceCatalogLoading = false
    @State private var deviceCatalogChecking = false
    @State private var zigbeeEnergyResults: [DirectRadioChannelEnergyRecord] = []
    @State private var zigbeeEnergyCurrentChannel = 0
    @State private var zigbeeTargetChannel = 0
    @State private var zigbeeHardReset = false
    @State private var showZigbeeChannelConfirm = false
    @State private var showRadioRestartConfirm = false
    @State private var showFrameCounterConfirm = false

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                HBSectionHeader(
                    title: "Device Integrations",
                    subtitle: "Radio, hub, catalog, and recovery controls for HomeBrain-managed devices."
                )

                smartThingsPanel
                harmonyPanel
                insteonPanel
                deviceCatalogPanel
                directRadioOperationsPanel
                zigbeeRadioToolsPanel
                directRadioSerialPortsPanel
                directRadioLogsPanel
                integrationMessagePanel
                integrationResultPanel
            }
            .padding(horizontalSizeClass == .compact ? 12 : 16)
            .padding(.bottom, 20)
        }
        .scrollIndicators(.hidden)
        .task {
            if previewMode {
                loadPreviewIntegrationState()
            } else {
                await loadDirectRadioStatusAndLogs()
                await loadDeviceCatalogStatus()
            }
        }
        .task(id: directRadioLiveLogs) {
            guard directRadioLiveLogs, !previewMode else { return }
            await pollDirectRadioLogs()
        }
    }

    private var integrationActionColumns: [GridItem] {
        if horizontalSizeClass == .compact {
            return [GridItem(.flexible(), spacing: 8)]
        }
        return [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]
    }

    private func integrationPanel<Content: View>(
        _ title: String,
        icon: String,
        subtitle: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: icon)
                        .foregroundStyle(HBPalette.accentBlue)
                        .frame(width: 24)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(title)
                            .font(HBTypography.display(.headline, weight: .semibold))
                            .foregroundStyle(HBPalette.textPrimary)
                        Text(subtitle)
                            .font(HBTypography.body(.caption))
                            .foregroundStyle(HBPalette.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                content()
            }
        }
    }

    private func actionGrid<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        LazyVGrid(columns: integrationActionColumns, alignment: .leading, spacing: 8) {
            content()
        }
    }

    private var smartThingsPanel: some View {
        integrationPanel("SmartThings", icon: "house.and.flag", subtitle: "Cloud account settings and legacy token fallback.") {
            Toggle("Use OAuth", isOn: $smartthingsUseOAuth)
            SecureField("Legacy Token", text: $smartThingsToken)
                .textInputAutocapitalization(.never)
                .disableAutocorrection(true)

            actionGrid {
                plainIntegrationButton("Save Settings", systemImage: "square.and.arrow.down") { onSave() }
                plainIntegrationButton("Test Connection", systemImage: "checkmark.circle") { onTestSmartThings() }
                actionButton("Status", key: "smartthings-status", method: .get, path: "/api/smartthings/status")
                actionButton("Get Auth URL", key: "smartthings-auth-url", method: .get, path: "/api/smartthings/auth/url")
                actionButton("Refresh Devices", key: "smartthings-devices", method: .get, path: "/api/smartthings/devices")
                actionButton("Add All to Alexa", key: "smartthings-alexa-bulk", method: .post, path: "/api/alexa/exposures/devices/by-source/smartthings", body: ["enabled": true])
                actionButton("Disconnect", key: "smartthings-disconnect", method: .post, path: "/api/smartthings/disconnect")
            }
        }
    }

    private var harmonyPanel: some View {
        integrationPanel("Harmony", icon: "tv", subtitle: "Hub discovery, known addresses, device sync, and activity state.") {
            TextField("Hub IPs / Hosts", text: $harmonyHubAddresses)
                .textInputAutocapitalization(.never)
                .disableAutocorrection(true)

            actionGrid {
                plainIntegrationButton("Save Settings", systemImage: "square.and.arrow.down") { onSave() }
                actionButton("Harmony Status", key: "harmony-status", method: .get, path: "/api/harmony/status")
                actionButton("Discover Hubs", key: "harmony-discover", method: .post, path: "/api/harmony/discover", body: ["timeoutMs": 5000])
                actionButton("Sync Devices", key: "harmony-sync", method: .post, path: "/api/harmony/sync", body: ["timeoutMs": 6000])
                actionButton("Sync Activity State", key: "harmony-sync-state", method: .post, path: "/api/harmony/sync-state")
                actionButton("Add All to Alexa", key: "harmony-alexa-bulk", method: .post, path: "/api/alexa/exposures/devices/by-source/harmony", body: ["enabled": true])
            }
        }
    }

    private var insteonPanel: some View {
        integrationPanel("INSTEON", icon: "link", subtitle: "PLM health, runtime polling, queue recovery, and relinking.") {
            actionGrid {
                actionButton("Runtime Status", key: "insteon-status", method: .get, path: "/api/insteon/status")
                actionButton("Scan Serial Ports", key: "insteon-ports", method: .get, path: "/api/insteon/serial-ports")
                actionButton("Test PLM", key: "insteon-test", method: .get, path: "/api/insteon/test")
                actionButton("Soft Reset PLM", key: "insteon-soft-reset", method: .post, path: "/api/insteon/maintenance/soft-reset")
                actionButton("Cancel Active Command", key: "insteon-cancel", method: .post, path: "/api/insteon/maintenance/cancel-active")
                actionButton("Clear Queue", key: "insteon-clear-queue", method: .post, path: "/api/insteon/maintenance/clear-queue")
                actionButton("Pause Runtime Monitoring", key: "insteon-pause", method: .post, path: "/api/insteon/maintenance/runtime-monitoring/stop")
                actionButton("Resume Runtime Monitoring", key: "insteon-resume", method: .post, path: "/api/insteon/maintenance/runtime-monitoring/start", body: ["immediate": true])
                actionButton("Re-link All Devices to PLM", key: "insteon-relink", method: .post, path: "/api/insteon/maintenance/relink/start")
                actionButton("Add All to Alexa", key: "insteon-alexa-bulk", method: .post, path: "/api/alexa/exposures/devices/by-source/insteon", body: ["enabled": true])
            }

            Text("Re-linking rebuilds the PLM all-link database for every tracked device and can run for several minutes.")
                .font(HBTypography.body(.caption))
                .foregroundStyle(HBPalette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var deviceCatalogPanel: some View {
        integrationPanel("Device Catalog Library", icon: "books.vertical", subtitle: "Installed Zigbee/Z-Wave definitions and monthly catalog enrichment status.") {
            if deviceCatalogLoading && deviceCatalogSummary == nil {
                ProgressView("Loading catalog status...")
            } else if let update = deviceCatalogUpdate {
                deviceCatalogMetricRow(
                    title: "Status",
                    value: update.statusLabel,
                    detail: update.scheduled ? "Monthly job active" : "Scheduler inactive",
                    systemImage: update.errors.isEmpty ? "checkmark.circle" : "exclamationmark.triangle",
                    tint: update.errors.isEmpty ? HBPalette.accentGreen : HBPalette.accentOrange
                )
                deviceCatalogMetricRow(
                    title: "Last Run",
                    value: settingsFormatDateTime(update.lastRunAt),
                    detail: update.lastSuccessAt.isEmpty ? "No successful run yet" : "Last success \(settingsFormatDateTime(update.lastSuccessAt))",
                    systemImage: "clock",
                    tint: HBPalette.accentBlue
                )
                deviceCatalogMetricRow(
                    title: "Next Scheduled",
                    value: settingsFormatDateTime(update.nextDueAt),
                    detail: update.due ? "Due now" : "Monthly cadence",
                    systemImage: "calendar.badge.clock",
                    tint: HBPalette.accentBlue
                )
                deviceCatalogMetricRow(
                    title: "New Last Check",
                    value: "\(update.addedLastRun)",
                    detail: "Matter, Thread, and INSTEON sources",
                    systemImage: "plus.square.on.square",
                    tint: HBPalette.accentGreen
                )
            } else {
                Text("Catalog status has not loaded yet.")
                    .font(HBTypography.body(.footnote))
                    .foregroundStyle(HBPalette.textSecondary)
            }

            if let summary = deviceCatalogSummary {
                ForEach(summary.protocols) { catalog in
                    deviceCatalogProtocolRow(catalog)
                }
                if !summary.generatedAt.isEmpty {
                    Text("Generated \(settingsFormatDateTime(summary.generatedAt))")
                        .font(HBTypography.body(.caption))
                        .foregroundStyle(HBPalette.textSecondary)
                }
            }

            if let update = deviceCatalogUpdate {
                ForEach(["matter", "thread", "insteon"], id: \.self) { key in
                    if let source = update.sources[key] {
                        deviceCatalogSourceRow(key: key, source: source)
                    }
                }
            }

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    deviceCatalogRefreshButton
                    deviceCatalogCheckNowButton
                }

                VStack(spacing: 8) {
                    deviceCatalogRefreshButton
                        .frame(maxWidth: .infinity)
                    deviceCatalogCheckNowButton
                        .frame(maxWidth: .infinity)
                }
            }
        }
    }

    private var deviceCatalogRefreshButton: some View {
        Button {
            Task { await loadDeviceCatalogStatus() }
        } label: {
            if deviceCatalogLoading {
                ProgressView()
            } else {
                Label("Refresh Status", systemImage: "arrow.clockwise")
            }
        }
        .buttonStyle(HBSecondaryButtonStyle(compact: true))
        .disabled(deviceCatalogLoading || deviceCatalogChecking)
    }

    private var deviceCatalogCheckNowButton: some View {
        Button {
            Task { await checkDeviceCatalogNow() }
        } label: {
            if deviceCatalogChecking || deviceCatalogUpdate?.running == true {
                ProgressView()
            } else {
                Label("Check Now", systemImage: "arrow.triangle.2.circlepath")
            }
        }
        .buttonStyle(HBSecondaryButtonStyle(compact: true))
        .disabled(deviceCatalogLoading || deviceCatalogChecking || deviceCatalogUpdate?.running == true)
    }

    private func deviceCatalogMetricRow(
        title: String,
        value: String,
        detail: String,
        systemImage: String,
        tint: Color
    ) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: systemImage)
                .foregroundStyle(tint)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(HBTypography.body(.caption, weight: .semibold))
                    .foregroundStyle(HBPalette.textSecondary)
                Text(value)
                    .font(HBTypography.body(.subheadline, weight: .semibold))
                Text(detail)
                    .font(HBTypography.body(.caption))
                    .foregroundStyle(HBPalette.textSecondary)
            }
        }
        .padding(.vertical, 2)
    }

    private func deviceCatalogProtocolRow(_ catalog: DeviceCatalogProtocolRecord) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(catalog.title)
                    .font(HBTypography.body(.subheadline, weight: .semibold))
                Spacer()
                Text("\(catalog.primaryCount)")
                    .font(.subheadline.monospacedDigit().weight(.bold))
            }
            Text(catalog.secondary)
                .font(HBTypography.body(.caption))
                .foregroundStyle(HBPalette.textSecondary)
            HStack(spacing: 10) {
                Text(catalog.id == "zigbee" || catalog.id == "zwave"
                     ? "Package backed"
                     : "\(catalog.addedLastRun) new last check")
                if catalog.errors > 0 {
                    Text("\(catalog.errors) catalog errors")
                        .foregroundStyle(HBPalette.accentRed)
                }
            }
            .font(HBTypography.body(.caption2, weight: .semibold))
            .foregroundStyle(HBPalette.textMuted)
        }
        .padding(.vertical, 4)
    }

    private func deviceCatalogSourceRow(key: String, source: DeviceCatalogUpdateSourceRecord) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(key.uppercased())
                    .font(HBTypography.body(.caption, weight: .bold))
                Spacer()
                Text(source.success && source.error.isEmpty ? "Successful" : "Failed")
                    .font(HBTypography.body(.caption, weight: .semibold))
                    .foregroundStyle(source.success && source.error.isEmpty ? HBPalette.accentGreen : HBPalette.accentRed)
            }
            Text("Added \(source.addedCount) of \(source.fetchedCount) fetched; total \(source.totalCount).")
                .font(HBTypography.body(.caption))
                .foregroundStyle(HBPalette.textSecondary)
            if !source.sourceUrl.isEmpty {
                Text(source.sourceUrl)
                    .font(.system(.caption2, design: .monospaced))
                    .lineLimit(2)
                    .textSelection(.enabled)
                    .foregroundStyle(HBPalette.textMuted)
            }
            if !source.error.isEmpty {
                Text(source.error)
                    .font(HBTypography.body(.caption))
                    .foregroundStyle(HBPalette.accentRed)
            }
        }
        .padding(.vertical, 3)
    }

    private var directRadioOperationsPanel: some View {
        integrationPanel("Zigbee / Z-Wave", icon: "antenna.radiowaves.left.and.right", subtitle: "Coordinator status, pairing windows, exclusion, and adapter discovery.") {
            if directRadioLoading {
                ProgressView("Loading radio status...")
            } else if let status = directRadioStatus {
                directRadioControllerRow(status.controllers.zigbee)
                directRadioControllerRow(status.controllers.zwave)

                if !status.diagnostics.isEmpty {
                    ForEach(status.diagnostics, id: \.self) { diagnostic in
                        Label(diagnostic, systemImage: "exclamationmark.triangle")
                            .font(HBTypography.body(.footnote))
                            .foregroundStyle(HBPalette.accentOrange)
                    }
                }

                Text(status.enabled ? "Direct radio runtime is enabled." : "Direct radio runtime is disabled.")
                    .font(HBTypography.body(.footnote))
                    .foregroundStyle(HBPalette.textSecondary)
            } else {
                Text("Radio status has not loaded yet.")
                    .font(HBTypography.body(.footnote))
                    .foregroundStyle(HBPalette.textSecondary)
            }

            actionGrid {
                actionButton("Refresh Radio Status", key: "direct-radio-status", method: .get, path: "/api/direct-radios/status")
                actionButton("Scan USB Ports", key: "direct-radio-ports", method: .get, path: "/api/direct-radios/serial-ports")
                actionButton("Open Zigbee Pairing", key: "direct-radio-zigbee-pair", method: .post, path: "/api/direct-radios/pairing/start", body: ["protocol": "zigbee", "durationSeconds": 180])
                actionButton("Start Z-Wave Inclusion", key: "direct-radio-zwave-pair", method: .post, path: "/api/direct-radios/pairing/start", body: ["protocol": "zwave", "durationSeconds": 180])
                actionButton("Start Z-Wave Exclusion", key: "direct-radio-zwave-exclusion", method: .post, path: "/api/direct-radios/exclusion/start", body: ["durationSeconds": 120])
                actionButton("Stop Pairing / Exclusion", key: "direct-radio-stop", method: .post, path: "/api/direct-radios/pairing/stop", body: ["protocol": "all"])
                actionButton("Add Zigbee to Alexa", key: "zigbee-alexa-bulk", method: .post, path: "/api/alexa/exposures/devices/by-source/homebrain-zigbee", body: ["enabled": true])
                actionButton("Add Z-Wave to Alexa", key: "zwave-alexa-bulk", method: .post, path: "/api/alexa/exposures/devices/by-source/homebrain-zwave", body: ["enabled": true])
            }
        }
    }

    private var zigbeeRadioToolsPanel: some View {
        integrationPanel("Zigbee Radio Tools", icon: "gauge.with.dots.needle.50percent", subtitle: "Channel quality, network migration, and recovery for the Zigbee coordinator.") {
            Text("Run an energy scan first when sensors act up — USB 3 ports and 2.4 GHz Wi-Fi can jam Zigbee channels. 0 is quiet, 255 is saturated; channels 24–26 usually avoid Wi-Fi and USB-3 noise.")
                .font(HBTypography.body(.footnote))
                .foregroundStyle(HBPalette.textSecondary)

            if !zigbeeEnergyResults.isEmpty {
                ForEach(zigbeeEnergyResults) { entry in
                    HStack(spacing: 8) {
                        Text("ch \(entry.channel)")
                            .font(.system(.caption, design: .monospaced))
                            .frame(width: 44, alignment: .leading)
                        GeometryReader { proxy in
                            ZStack(alignment: .leading) {
                                RoundedRectangle(cornerRadius: 3)
                                    .fill(HBPalette.textSecondary.opacity(0.15))
                                RoundedRectangle(cornerRadius: 3)
                                    .fill(entry.energy >= 160 ? HBPalette.accentRed : entry.energy >= 110 ? HBPalette.accentOrange : HBPalette.accentGreen)
                                    .frame(width: max(3, proxy.size.width * CGFloat(min(255, entry.energy)) / 255))
                            }
                        }
                        .frame(height: 6)
                        Text("\(entry.energy)")
                            .font(.system(.caption2, design: .monospaced))
                            .frame(width: 30, alignment: .trailing)
                        if entry.channel == zigbeeEnergyCurrentChannel {
                            Text("current")
                                .font(HBTypography.body(.caption2, weight: .semibold))
                                .foregroundStyle(HBPalette.accentBlue)
                        }
                    }
                    .foregroundStyle(HBPalette.textSecondary)
                }
            }

            Picker("Migrate network to channel", selection: $zigbeeTargetChannel) {
                Text("Choose channel").tag(0)
                ForEach(11...26, id: \.self) { channel in
                    Text("Channel \(channel)").tag(channel)
                }
            }
            .pickerStyle(.menu)

            Toggle("Hardware-reset the Zigbee chip during restarts", isOn: $zigbeeHardReset)
                .font(HBTypography.body(.footnote))

            actionGrid {
                actionButton("Run Energy Scan", key: "zigbee-energy-scan", method: .post, path: "/api/direct-radios/zigbee/energy-scan")
                plainIntegrationButton("Migrate Channel", systemImage: "dot.radiowaves.right") {
                    showZigbeeChannelConfirm = true
                }
                plainIntegrationButton("Restart Radios", systemImage: "arrow.clockwise.circle") {
                    showRadioRestartConfirm = true
                }
                plainIntegrationButton("Replay-Drop Recovery", systemImage: "shield.lefthalf.filled") {
                    showFrameCounterConfirm = true
                }
            }

            Text("Pairing tips: SNZB-04PR2 door sensor — hold the button ~5s until the LED flashes while a pairing window is open (it keeps its name, room, and security zone). Aeotec Range Extender Zi — hold 10s to factory-reset until the LED fades, then a single tap joins. A device that keeps retrying its join is usually too far away: pair it next to the coordinator, then move it back.")
                .font(HBTypography.body(.caption2))
                .foregroundStyle(HBPalette.textSecondary)
        }
        .confirmationDialog(
            "Migrate the Zigbee network to channel \(zigbeeTargetChannel)?",
            isPresented: $showZigbeeChannelConfirm,
            titleVisibility: .visible
        ) {
            Button("Migrate Network", role: .destructive) {
                Task { await migrateZigbeeChannel() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Mains-powered devices follow automatically; battery sensors usually re-find the network on their own, or with a short button press. Takes about a minute.")
        }
        .confirmationDialog(
            zigbeeHardReset ? "Restart radios with a Zigbee hardware reset?" : "Restart the radio runtime?",
            isPresented: $showRadioRestartConfirm,
            titleVisibility: .visible
        ) {
            Button("Restart", role: .destructive) {
                Task { await restartDirectRadios() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Restarts the Zigbee and Z-Wave controllers in place; devices stay paired. Radios are unavailable for 30–60 seconds.")
        }
        .confirmationDialog(
            "Advance the Zigbee security frame counter?",
            isPresented: $showFrameCounterConfirm,
            titleVisibility: .visible
        ) {
            Button("Advance Counter", role: .destructive) {
                Task { await advanceZigbeeFrameCounter() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Recovery for a rare failure where the whole network silently ignores the coordinator (counter rollback after a power glitch). Safe to run; includes a hardware reset.")
        }
    }

    private func migrateZigbeeChannel() async {
        guard zigbeeTargetChannel >= 11 && zigbeeTargetChannel <= 26 else {
            message = "Pick a Zigbee channel between 11 and 26 first."
            return
        }
        await runAction(
            key: "zigbee-channel-migrate",
            method: .post,
            path: "/api/direct-radios/zigbee/channel",
            body: ["channel": zigbeeTargetChannel]
        )
        await loadDirectRadioStatusAndLogs()
    }

    private func restartDirectRadios() async {
        await runAction(
            key: "direct-radio-restart",
            method: .post,
            path: "/api/direct-radios/restart",
            body: ["reason": "ios_app", "hardResetZigbee": zigbeeHardReset]
        )
        await loadDirectRadioStatusAndLogs()
    }

    private func advanceZigbeeFrameCounter() async {
        await runAction(
            key: "zigbee-frame-counter",
            method: .post,
            path: "/api/direct-radios/zigbee/frame-counter/advance",
            body: [String: Any]()
        )
        await loadDirectRadioStatusAndLogs()
    }

    @ViewBuilder
    private var directRadioSerialPortsPanel: some View {
        if let status = directRadioStatus {
            integrationPanel("Direct Radio USB Ports", icon: "cable.connector", subtitle: "Detected serial adapters and HomeBrain protocol scoring.") {
                if status.serialPorts.isEmpty {
                    Text("No serial ports found.")
                        .font(HBTypography.body(.footnote))
                        .foregroundStyle(HBPalette.textSecondary)
                } else {
                    ForEach(status.serialPorts) { port in
                        directRadioSerialPortRow(port)
                    }
                }
            }
        }
    }

    private var directRadioLogsPanel: some View {
        integrationPanel("Direct Radio Logs", icon: "list.bullet.rectangle", subtitle: "Latest coordinator/runtime events for quick triage.") {
            Toggle("Live Updates", isOn: $directRadioLiveLogs)

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    directRadioReplayLogsButton
                    directRadioClearLogsButton
                }

                VStack(spacing: 8) {
                    directRadioReplayLogsButton
                        .frame(maxWidth: .infinity)
                    directRadioClearLogsButton
                        .frame(maxWidth: .infinity)
                }
            }

            if directRadioLogs.isEmpty {
                Text("No direct radio logs yet.")
                    .font(HBTypography.body(.footnote))
                    .foregroundStyle(HBPalette.textSecondary)
            } else {
                ForEach(directRadioLogs.prefix(40)) { entry in
                    directRadioLogRow(entry)
                }
            }
        }
    }

    private var directRadioReplayLogsButton: some View {
        Button {
            Task { await loadDirectRadioLogs() }
        } label: {
            if directRadioLogsLoading {
                ProgressView()
            } else {
                Label("Replay Latest", systemImage: "arrow.clockwise")
            }
        }
        .buttonStyle(HBSecondaryButtonStyle(compact: true))
        .disabled(directRadioLogsLoading)
    }

    private var directRadioClearLogsButton: some View {
        Button(role: .destructive) {
            Task { await clearDirectRadioLogs() }
        } label: {
            Label("Clear Logs", systemImage: "trash")
        }
        .buttonStyle(HBDestructiveButtonStyle(compact: true))
        .disabled(!activeAction.isEmpty)
    }

    private func directRadioControllerRow(_ controller: DirectRadioControllerRecord) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label(controller.protocolName == "zigbee" ? "Zigbee" : "Z-Wave", systemImage: controller.protocolName == "zigbee" ? "dot.radiowaves.left.and.right" : "wave.3.right")
                    .font(HBTypography.display(.headline, weight: .semibold))
                Spacer()
                Text(controller.isReady ? "Online" : controller.started ? "Starting" : "Offline")
                    .font(HBTypography.body(.caption, weight: .semibold))
                    .foregroundStyle(controller.isReady ? HBPalette.accentGreen : HBPalette.accentOrange)
            }

            Text(controller.expectedHardware)
                .font(HBTypography.body(.caption))
                .foregroundStyle(HBPalette.textSecondary)

            if !controller.detectedPort.isEmpty {
                Text(controller.detectedPort)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(HBPalette.textSecondary)
                    .textSelection(.enabled)
            } else {
                Text("No matching USB adapter detected.")
                    .font(HBTypography.body(.caption))
                    .foregroundStyle(HBPalette.accentOrange)
            }

            HStack(spacing: 12) {
                Text("\(controller.pairedCount) paired")
                if controller.protocolName == "zigbee" && controller.networkChannel > 0 {
                    Text("Channel \(controller.networkChannel)")
                }
                if controller.protocolName == "zwave" && !controller.firmwareVersion.isEmpty {
                    Text("FW \(controller.firmwareVersion)\(controller.sdkVersion.isEmpty ? "" : " (SDK \(controller.sdkVersion))")")
                }
                if !controller.activeWindow.isEmpty {
                    Text("Window open until \(JSON.displayDate(from: controller.activeWindow))")
                }
                if !controller.lastStartResult.isEmpty {
                    Text(controller.lastStartResult)
                }
            }
            .font(HBTypography.body(.caption))
            .foregroundStyle(HBPalette.textSecondary)

            if controller.protocolName == "zwave" && controller.hasKnownBadZWaveFirmware {
                Text("This Z-Wave stick firmware (SDK \(controller.sdkVersion)) has known lockup bugs — update the Zooz ZST39 to firmware 1.50+ via the Zooz support portal.")
                    .font(HBTypography.body(.caption))
                    .foregroundStyle(HBPalette.accentOrange)
            }

            if !controller.error.isEmpty {
                Text(controller.error)
                    .font(HBTypography.body(.caption))
                    .foregroundStyle(HBPalette.accentRed)
            }
        }
        .padding(.vertical, 4)
    }

    private func directRadioSerialPortRow(_ port: DirectRadioSerialPortRecord) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(port.preferredProtocol.isEmpty ? "Serial Port" : port.preferredProtocol.uppercased())
                    .font(HBTypography.body(.caption, weight: .bold))
                    .foregroundStyle(port.preferredProtocol == "zigbee" ? HBPalette.accentGreen : port.preferredProtocol == "zwave" ? HBPalette.accentBlue : HBPalette.textSecondary)
                Spacer()
                Text("ZB \(port.scores.zigbee) / ZW \(port.scores.zwave)")
                    .font(HBTypography.body(.caption2, weight: .semibold))
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
                    .font(HBTypography.body(.caption2))
                    .foregroundStyle(HBPalette.textMuted)
            }
        }
        .padding(.vertical, 3)
    }

    private func directRadioLogRow(_ entry: DirectRadioLogEntryRecord) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(entry.protocolName.uppercased())
                    .font(HBTypography.body(.caption2, weight: .bold))
                    .foregroundStyle(entry.protocolName == "zigbee" ? HBPalette.accentGreen : entry.protocolName == "zwave" ? HBPalette.accentBlue : HBPalette.textMuted)
                Text(entry.level.uppercased())
                    .font(HBTypography.body(.caption2, weight: .bold))
                    .foregroundStyle(entry.level == "error" ? HBPalette.accentRed : entry.level == "warn" ? HBPalette.accentOrange : HBPalette.textMuted)
                Spacer()
                Text(entry.displayTime)
                    .font(HBTypography.body(.caption2))
                    .foregroundStyle(HBPalette.textMuted)
            }

            Text(entry.message)
                .font(HBTypography.body(.subheadline, weight: .semibold))

            let metadata = [entry.stage, entry.operation, entry.target]
                .filter { !$0.isEmpty }
                .joined(separator: " · ")
            if !metadata.isEmpty {
                Text(metadata)
                    .font(HBTypography.body(.caption))
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

    @ViewBuilder
    private var integrationMessagePanel: some View {
        if !message.isEmpty {
            integrationPanel("Message", icon: "text.bubble", subtitle: "Latest action summary.") {
                Text(message)
                    .font(HBTypography.body(.subheadline))
                    .foregroundStyle(HBPalette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private var integrationResultPanel: some View {
        if let resultPayload {
            integrationPanel("Latest Result", icon: "curlybraces", subtitle: "Raw response from the most recent action.") {
                ScrollView(.horizontal, showsIndicators: true) {
                    Text(JSON.prettyString(resultPayload))
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .foregroundStyle(HBPalette.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
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
            HStack(spacing: 8) {
                if activeAction == key {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: method == .get ? "arrow.clockwise" : "play.fill")
                        .frame(width: 18)
                }
                Text(title)
                    .lineLimit(2)
                    .minimumScaleFactor(0.82)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(HBSecondaryButtonStyle(compact: true))
        .disabled(!activeAction.isEmpty)
    }

    private func plainIntegrationButton(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .lineLimit(2)
                .minimumScaleFactor(0.82)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(HBSecondaryButtonStyle(compact: true))
        .disabled(!activeAction.isEmpty)
    }

    private func loadPreviewIntegrationState() {
        let zigbeePath = "/dev/serial/by-id/usb-ITead_Sonoff_Zigbee_3.0_USB_Dongle_Plus"
        let zwavePath = "/dev/serial/by-id/usb-Zooz_800_Z-Wave_Stick"

        directRadioStatus = DirectRadioStatusSnapshot.from([
            "enabled": true,
            "dataDir": "/mnt/nvme/apps/HomeBrainv2/data/direct-radios",
            "diagnostics": [],
            "serialPorts": [
                [
                    "path": zigbeePath,
                    "manufacturer": "ITead",
                    "vendorId": "10c4",
                    "productId": "ea60",
                    "serialNumber": "preview-zigbee",
                    "preferredProtocol": "zigbee",
                    "likelyZigbee": true,
                    "likelyZWave": false,
                    "scores": ["zigbee": 16, "zwave": -6]
                ] as [String: Any],
                [
                    "path": zwavePath,
                    "manufacturer": "Zooz",
                    "vendorId": "1a86",
                    "productId": "55d4",
                    "serialNumber": "preview-zwave",
                    "preferredProtocol": "zwave",
                    "likelyZigbee": false,
                    "likelyZWave": true,
                    "scores": ["zigbee": -8, "zwave": 14]
                ] as [String: Any]
            ],
            "controllers": [
                "zigbee": [
                    "expectedHardware": "SONOFF ZBDongle-P / TI CC2652P Z-Stack coordinator",
                    "source": "auto-detected",
                    "detectedPort": zigbeePath,
                    "configuredPort": "",
                    "started": true,
                    "error": "",
                    "diagnostics": [],
                    "permitJoinUntil": "",
                    "pairedDeviceCount": 5,
                    "lastStartResult": "resumed"
                ] as [String: Any],
                "zwave": [
                    "expectedHardware": "Zooz ZST39 LR / 800-series Z-Wave SerialAPI USB stick",
                    "source": "auto-detected",
                    "detectedPort": zwavePath,
                    "configuredPort": "",
                    "started": true,
                    "error": "",
                    "diagnostics": [],
                    "inclusionUntil": "",
                    "exclusionUntil": "",
                    "pairedNodeCount": 8,
                    "lastStartResult": "ready"
                ] as [String: Any]
            ] as [String: Any]
        ])

        directRadioLogs = [
            DirectRadioLogEntryRecord.from([
                "id": "preview-log-1",
                "timestamp": "2026-05-30T15:06:00Z",
                "level": "info",
                "protocol": "zigbee",
                "stage": "interview",
                "operation": "permit_join",
                "target": "0x00158d0009abc123",
                "message": "Zigbee device joined; interview waiting for IAS enrollment.",
                "details": ["cluster": "ssIasZone"]
            ]),
            DirectRadioLogEntryRecord.from([
                "id": "preview-log-2",
                "timestamp": "2026-05-30T15:05:18Z",
                "level": "warn",
                "protocol": "zwave",
                "stage": "interview",
                "operation": "refresh_info",
                "target": "node 7",
                "message": "Node responded to ping; full interview skipped to avoid destabilizing a partially recovered node.",
                "details": ["skipRefreshIfPingSucceeds": true]
            ]),
            DirectRadioLogEntryRecord.from([
                "id": "preview-log-3",
                "timestamp": "2026-05-30T15:04:11Z",
                "level": "info",
                "protocol": "system",
                "stage": "serial",
                "operation": "scan",
                "target": "usb",
                "message": "Detected Zigbee and Z-Wave radio adapters.",
                "details": ["ports": 2]
            ])
        ]

        let update = DeviceCatalogUpdateStatusRecord.from([
            "update": [
                "running": false,
                "scheduled": true,
                "catalogUpdate": [
                    "lastRunAt": "2026-05-30T10:00:00Z",
                    "lastSuccessAt": "2026-05-30T10:00:04Z",
                    "nextDueAt": "2026-06-30T10:00:00Z",
                    "due": false,
                    "errors": [],
                    "sources": [
                        "matter": [
                            "success": true,
                            "sourceUrl": "https://csa-iot.org/csa-iot_products/",
                            "existingCount": 240,
                            "fetchedCount": 16,
                            "addedCount": 3,
                            "totalCount": 243,
                            "error": ""
                        ] as [String: Any],
                        "thread": [
                            "success": true,
                            "sourceUrl": "https://www.threadgroup.org/What-is-Thread/Certified-Products",
                            "existingCount": 89,
                            "fetchedCount": 6,
                            "addedCount": 1,
                            "totalCount": 90,
                            "error": ""
                        ] as [String: Any],
                        "insteon": [
                            "success": true,
                            "sourceUrl": "local-device-library",
                            "existingCount": 64,
                            "fetchedCount": 0,
                            "addedCount": 0,
                            "totalCount": 64,
                            "error": ""
                        ] as [String: Any]
                    ] as [String: Any]
                ] as [String: Any]
            ] as [String: Any]
        ])

        deviceCatalogUpdate = update
        deviceCatalogSummary = DeviceCatalogSummaryRecord.from([
            "generatedAt": "2026-05-30T10:00:04Z",
            "zigbee": [
                "source": "zigbee-herdsman-converters",
                "definitionCount": 4096,
                "vendorCount": 423,
                "exposesCount": 11872,
                "errors": []
            ] as [String: Any],
            "zwave": [
                "source": "zwave-js device config",
                "deviceConfigCount": 1584,
                "manufacturerCount": 322,
                "errors": []
            ] as [String: Any],
            "matter": [
                "source": "CSA certified product snapshot",
                "certifiedProductCount": 243,
                "standardDeviceTypeCount": 34,
                "vendorProductCount": 179,
                "errors": []
            ] as [String: Any],
            "thread": [
                "source": "Thread certified product snapshot",
                "certifiedProductCount": 90,
                "snapshot": ["updatedAt": "2026-05-30T10:00:04Z"],
                "errors": []
            ] as [String: Any],
            "insteon": [
                "source": "HomeBrain local catalog",
                "productEntryCount": 64,
                "categoryCount": 17,
                "entryCount": 64,
                "errors": []
            ] as [String: Any]
        ], update: update)

        directRadioLoading = false
        directRadioLogsLoading = false
        deviceCatalogLoading = false
        deviceCatalogChecking = false
    }

    private func runAction(key: String, method: HTTPMethod, path: String, body: Any?) async {
        activeAction = key
        message = ""
        defer { activeAction = "" }

        if previewMode {
            resultPayload = [
                "preview": true,
                "method": method.rawValue,
                "path": path,
                "body": body ?? NSNull()
            ]
            message = "\(method.rawValue) \(path) is available on a signed-in HomeBrain instance."
            return
        }

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
        if path.contains("/api/direct-radios/zigbee/energy-scan") {
            let root = JSON.object(resultPayload ?? [:])
            let result = JSON.object(root["result"])
            zigbeeEnergyCurrentChannel = JSON.int(result, "currentChannel")
            zigbeeEnergyResults = JSON.array(result["channelEnergy"]).map(DirectRadioChannelEnergyRecord.from)
            let quietest = zigbeeEnergyResults.min(by: { $0.energy < $1.energy })
            if let quietest {
                message = "Energy scan complete. Quietest channel right now: \(quietest.channel) (energy \(quietest.energy)/255)."
            }
        }
        if path.contains("/api/direct-radios") {
            await loadDirectRadioStatusAndLogs()
        }
        if path.contains("/api/direct-radios/catalog") {
            await loadDeviceCatalogStatus()
        }
    }

    private func loadDeviceCatalogStatus() async {
        deviceCatalogLoading = true
        defer { deviceCatalogLoading = false }

        do {
            let statusResponse = try await session.apiClient.get("/api/direct-radios/catalog/update/status")
            let statusRoot = JSON.object(statusResponse)
            let update = DeviceCatalogUpdateStatusRecord.from(statusRoot)
            deviceCatalogUpdate = update

            let summaryResponse = try await session.apiClient.get("/api/direct-radios/catalog/summary")
            let summaryRoot = JSON.object(summaryResponse)
            deviceCatalogSummary = DeviceCatalogSummaryRecord.from(JSON.object(summaryRoot["summary"]), update: update)
        } catch {
            message = error.localizedDescription
        }
    }

    private func checkDeviceCatalogNow() async {
        deviceCatalogChecking = true
        defer { deviceCatalogChecking = false }

        do {
            let response = try await session.apiClient.post(
                "/api/direct-radios/catalog/update/run",
                body: ["force": true]
            )
            resultPayload = response
            await loadDeviceCatalogStatus()
            let added = deviceCatalogUpdate?.addedLastRun ?? 0
            message = "Device catalog check complete. \(added) new external record\(added == 1 ? "" : "s") added."
        } catch {
            message = error.localizedDescription
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
                        .font(HBTypography.body(.subheadline))
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

nonisolated private func settingsFormatDateTime(_ value: String) -> String {
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
                .font(HBTypography.body(.caption2))
                .foregroundStyle(HBPalette.textSecondary)
            Text(value)
                .font(.headline.monospacedDigit())
            Text(subtitle)
                .font(HBTypography.body(.caption2))
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
                        .font(HBTypography.display(.headline, weight: .semibold))
                    Text("\(hardwareOrb.room) · \(hardwareOrb.statusLabel) · \(hardwareOrb.hardwareProfileLabel)")
                        .font(HBTypography.body(.caption))
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
            .font(HBTypography.body(.caption))
            .foregroundStyle(HBPalette.textSecondary)

            Text("Default \(hardwareOrb.defaultModeCategoryLabel) · \(hardwareOrb.modeCategorySummary)")
                .font(HBTypography.body(.caption))
                .foregroundStyle(HBPalette.textSecondary)
                .lineLimit(2)

            if hardwareOrb.requiresFirmwareUpdate || hardwareOrb.isOtaBusy {
                Text(hardwareOrb.isOtaBusy ? "OTA: \(hardwareOrb.ota.statusLabel)" : "Newer firmware available")
                    .font(HBTypography.body(.caption))
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
        .font(HBTypography.body(.subheadline))
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
                    .font(HBTypography.body(.caption))
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
                .font(HBTypography.body(.caption))
                .foregroundStyle(HBPalette.textSecondary)
            Spacer(minLength: 16)
            Text(value)
                .font(HBTypography.body(.caption))
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
                        .font(HBTypography.body(.subheadline, weight: .semibold))
                    if isDefault {
                        Text("Default")
                            .font(HBTypography.body(.caption2, weight: .semibold))
                            .foregroundStyle(HBPalette.accentBlue)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(HBPalette.accentBlue.opacity(0.12), in: Capsule())
                    }
                }
                Text(category.details)
                    .font(HBTypography.body(.caption))
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
                .font(HBTypography.display(.headline, weight: .semibold))
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
                        .font(HBTypography.display(.headline, weight: .semibold))
                    Text("\(hardwareOrb.room) · \(hardwareOrb.statusLabel)")
                        .font(HBTypography.body(.caption))
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
