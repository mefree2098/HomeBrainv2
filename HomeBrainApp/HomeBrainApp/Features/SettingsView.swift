import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var session: SessionStore

    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var infoMessage = ""

    @State private var serverURL = ""

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

    @State private var llmPriority = "local,openai,anthropic"

    private let llmProviders = ["openai", "anthropic", "local"]
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
                            session.updateServerURL(serverURL)
                            infoMessage = "Server URL updated."
                        }
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
    }

    private func loadSettings() async {
        isLoading = true
        errorMessage = nil

        do {
            let settingsResponse = try await session.apiClient.get("/api/settings")
            let object = JSON.object(settingsResponse)
            let settings = JSON.object(object["settings"])

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
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    private func saveSettings() async {
        do {
            session.updateServerURL(serverURL)

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
                "smartthingsToken": smartThingsToken
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
}
