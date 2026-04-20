import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var session: SessionStore

    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var infoMessage = ""
    @State private var showingOpenClawSettings = false

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

                    Section("Sessions") {
                        Stepper(value: $authSessionMaxAgeDays, in: 30...3650, step: 30) {
                            HStack {
                                Text("Session Lifetime")
                                Spacer()
                                Text("\(authSessionMaxAgeDays) days")
                                    .foregroundStyle(HBPalette.textSecondary)
                            }
                        }

                        Text("Refresh sessions stay active for up to \(authSessionMaxAgeDays) days and renew on use. Each device now keeps its own session so signing into one iPad will not knock out the others.")
                            .font(.footnote)
                            .foregroundStyle(HBPalette.textSecondary)

                        if authSessions.isEmpty {
                            Text("No active sessions found for this account.")
                                .font(.subheadline)
                                .foregroundStyle(HBPalette.textSecondary)
                        } else {
                            ForEach(authSessions) { authSession in
                                VStack(alignment: .leading, spacing: 8) {
                                    HStack(alignment: .firstTextBaseline) {
                                        Text(authSession.clientName)
                                            .font(.headline)
                                        if authSession.isCurrent {
                                            Text("This device")
                                                .font(.caption.weight(.semibold))
                                                .padding(.horizontal, 8)
                                                .padding(.vertical, 3)
                                                .background(HBPalette.accentBlue.opacity(0.14))
                                                .foregroundStyle(HBPalette.accentBlue)
                                                .clipShape(Capsule())
                                        }
                                        Spacer()
                                    }

                                    VStack(alignment: .leading, spacing: 4) {
                                        Text("Type: \(authSession.clientType.capitalized)")
                                        Text("Last used: \(settingsFormatDateTime(authSession.lastUsedAt))")
                                        Text("Expires: \(settingsFormatDateTime(authSession.expiresAt))")
                                    }
                                    .font(.caption)
                                    .foregroundStyle(HBPalette.textSecondary)

                                    if !authSession.isCurrent {
                                        Button {
                                            Task { await revokeAuthSession(authSession) }
                                        } label: {
                                            if revokingSessionIDs.contains(authSession.id) {
                                                ProgressView()
                                            } else {
                                                Text("Revoke Session")
                                            }
                                        }
                                        .buttonStyle(.bordered)
                                        .disabled(revokingSessionIDs.contains(authSession.id))
                                    }
                                }
                                .padding(.vertical, 4)
                            }
                        }

                        Button("Refresh Session List") {
                            Task { await loadAuthSessions() }
                        }
                        .buttonStyle(.bordered)
                    }

                    Section("General") {
                        TextField("Location", text: $location)
                        TextField("Timezone", text: $timezone)
                        Toggle("Enable Notifications", isOn: $enableNotifications)
                        Toggle("Enable Security Mode", isOn: $enableSecurityMode)
                        Toggle("Enable Auto Discovery", isOn: $autoDiscoveryEnabled)
                    }

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

                        TextField("LLM Priority (comma-separated)", text: $llmPriority)
                    }

                    Section("Integrations") {
                        Toggle("SmartThings uses OAuth", isOn: $smartthingsUseOAuth)
                        TextField("Harmony Hub Addresses", text: $harmonyHubAddresses)
                    }

                    Section("OpenClaw") {
                        Text("Configure the external OpenClaw admin integration, rotate its HomeBrain token, and download the Jetson deployment bundle from here.")
                            .font(.footnote)
                            .foregroundStyle(HBPalette.textSecondary)

                        Button("Open OpenClaw Settings") {
                            showingOpenClawSettings = true
                        }
                        .buttonStyle(.bordered)
                    }

                    Section("Hardware Orbs") {
                        Text("Rotate each orb UI in 0.5° steps to compensate for wall mounting. Changes save per device, sync through HomeBrain immediately, and the orb keeps the latest offset across reloads.")
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
                                    HStack(alignment: .top, spacing: 12) {
                                        VStack(alignment: .leading, spacing: 4) {
                                            Text(hardwareOrb.name)
                                                .font(.headline)
                                            Text("\(hardwareOrb.room) • \(hardwareOrb.statusLabel)")
                                                .font(.caption)
                                                .foregroundStyle(HBPalette.textSecondary)
                                        }
                                        Spacer()
                                        if savingHardwareOrbIDs.contains(hardwareOrb.id) {
                                            ProgressView()
                                                .controlSize(.small)
                                        } else {
                                            Text("Saved")
                                                .font(.caption.weight(.semibold))
                                                .padding(.horizontal, 8)
                                                .padding(.vertical, 4)
                                                .background(HBPalette.panelSoft.opacity(0.92))
                                                .foregroundStyle(HBPalette.textSecondary)
                                                .clipShape(Capsule())
                                        }
                                    }

                                    HStack(alignment: .firstTextBaseline) {
                                        Text("Offset")
                                            .font(.subheadline.weight(.semibold))
                                        Spacer()
                                        Text(hardwareOrb.formattedMountOffset)
                                            .font(.title3.weight(.semibold))
                                            .monospacedDigit()
                                            .foregroundStyle(HBPalette.textPrimary)
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
                                            Label("Counterclockwise", systemImage: "rotate.left")
                                        }
                                        .buttonStyle(.bordered)
                                        .disabled(
                                            savingHardwareOrbIDs.contains(hardwareOrb.id)
                                            || hardwareOrb.mountOffsetTenths <= HardwareOrbRecord.mountOffsetMinimumTenths
                                        )

                                        Button("Reset") {
                                            Task {
                                                await setHardwareOrbRotation(hardwareOrb, offsetTenths: 0)
                                            }
                                        }
                                        .buttonStyle(.bordered)
                                        .disabled(
                                            savingHardwareOrbIDs.contains(hardwareOrb.id)
                                            || hardwareOrb.mountOffsetTenths == 0
                                        )

                                        Button {
                                            Task {
                                                await adjustHardwareOrbRotation(
                                                    hardwareOrb,
                                                    deltaTenths: HardwareOrbRecord.mountOffsetStepTenths
                                                )
                                            }
                                        } label: {
                                            Label("Clockwise", systemImage: "rotate.right")
                                        }
                                        .buttonStyle(.borderedProminent)
                                        .tint(HBPalette.accentBlue)
                                        .disabled(
                                            savingHardwareOrbIDs.contains(hardwareOrb.id)
                                            || hardwareOrb.mountOffsetTenths >= HardwareOrbRecord.mountOffsetMaximumTenths
                                        )
                                    }

                                    Text("Range \(HardwareOrbRecord.formattedMountOffset(HardwareOrbRecord.mountOffsetMinimumTenths)) to \(HardwareOrbRecord.formattedMountOffset(HardwareOrbRecord.mountOffsetMaximumTenths)); positive values rotate the visual layer clockwise.")
                                        .font(.caption)
                                        .foregroundStyle(HBPalette.textSecondary)
                                }
                                .padding(.vertical, 4)
                            }
                        }

                        Button("Refresh Hardware Orbs") {
                            Task { await loadHardwareOrbs() }
                        }
                        .buttonStyle(.bordered)
                    }

                    Section("API Keys & Tests") {
                        SecureField("OpenAI API Key", text: $openaiApiKey)
                        HStack {
                            Button("Test OpenAI") {
                                Task { await testOpenAI() }
                            }
                            .buttonStyle(.bordered)
                            Spacer()
                        }

                        SecureField("Anthropic API Key", text: $anthropicApiKey)
                        HStack {
                            Button("Test Anthropic") {
                                Task { await testAnthropic() }
                            }
                            .buttonStyle(.bordered)
                            Spacer()
                        }

                        SecureField("ElevenLabs API Key", text: $elevenLabsApiKey)
                        HStack {
                            Button("Test ElevenLabs") {
                                Task { await testElevenLabs() }
                            }
                            .buttonStyle(.bordered)
                            Spacer()
                        }

                        SecureField("SmartThings Token", text: $smartThingsToken)
                        HStack {
                            Button("Test SmartThings") {
                                Task { await testSmartThings() }
                            }
                            .buttonStyle(.bordered)
                            Spacer()
                        }
                    }

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
        .sheet(isPresented: $showingOpenClawSettings) {
            OpenClawIntegrationView()
                .environmentObject(session)
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

    var statusLabel: String {
        status.isEmpty ? "Unknown" : status.capitalized
    }

    var formattedMountOffset: String {
        Self.formattedMountOffset(mountOffsetTenths)
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
            mountOffsetTenths: clampMountOffset(JSON.int(mountAlignment, "offsetTenths"))
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
