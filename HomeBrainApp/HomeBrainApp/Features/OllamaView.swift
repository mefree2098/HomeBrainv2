import SwiftUI

struct OllamaView: View {
    @EnvironmentObject private var session: SessionStore

    @State private var status: [String: Any] = [:]
    @State private var installedModels: [[String: Any]] = []
    @State private var availableModels: [[String: Any]] = []
    @State private var logs: [String] = []

    @State private var chatPrompt = ""
    @State private var chatOutput = ""
    @State private var pullModelName = ""
    @State private var activateModelName = ""

    @State private var isLoading = true
    @State private var isActing = false
    @State private var errorMessage: String?
    @State private var infoMessage = ""

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                if isLoading {
                    LoadingView(title: "Loading Ollama status...")
                } else {
                    HBSectionHeader(
                        title: "Ollama / LLM",
                        subtitle: "Model lifecycle, prompts, and logs"
                    )

                    if let errorMessage {
                        InlineErrorView(message: errorMessage) {
                            Task { await loadOllamaData() }
                        }
                    }

                    if !infoMessage.isEmpty {
                        HBPanel {
                            Text(infoMessage)
                                .font(.subheadline)
                                .foregroundStyle(HBPalette.textSecondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }

                    statusCard
                    controlsCard
                    modelsCard
                    chatCard
                    logsCard
                }
            }
            .padding()
        }
        .groupBoxStyle(HBPanelGroupBoxStyle())
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Refresh") {
                    Task { await loadOllamaData() }
                }
            }
        }
        .task {
            await loadOllamaData()
        }
        .refreshable {
            await loadOllamaData()
        }
    }

    private var statusCard: some View {
        GroupBox("Ollama Status") {
            VStack(alignment: .leading, spacing: 6) {
                Text("Installed: \(JSON.bool(status, "isInstalled") ? "Yes" : "No")")
                Text("Version: \(JSON.string(status, "version", fallback: "Unknown"))")
                Text("Service Running: \(JSON.bool(status, "serviceRunning") ? "Yes" : "No")")
                Text("Active Model: \(JSON.string(status, "activeModel", fallback: "None"))")
                Text("Update Available: \(JSON.bool(status, "updateAvailable") ? "Yes" : "No")")
            }
            .font(.subheadline)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 4)
        }
    }

    private var controlsCard: some View {
        GroupBox("Service Controls") {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    actionButton("Install", path: "/api/ollama/install")
                    actionButton("Start", path: "/api/ollama/service/start")
                    actionButton("Stop", path: "/api/ollama/service/stop")
                }

                HStack {
                    actionButton("Check Updates", path: "/api/ollama/updates/check", method: .get)
                    actionButton("Update", path: "/api/ollama/update")
                }
            }
            .padding(.top, 4)
        }
    }

    private var modelsCard: some View {
        GroupBox("Models") {
            VStack(alignment: .leading, spacing: 12) {
                TextField("Model to pull (e.g. llama3.1:8b)", text: $pullModelName)
                    .textFieldStyle(.roundedBorder)

                HStack {
                    Button("Pull Model") {
                        Task {
                            await performAction(path: "/api/ollama/models/pull", body: ["modelName": pullModelName])
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(pullModelName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isActing)

                    TextField("Model to activate", text: $activateModelName)
                        .textFieldStyle(.roundedBorder)

                    Button("Activate") {
                        Task {
                            await performAction(path: "/api/ollama/models/activate", body: ["modelName": activateModelName])
                        }
                    }
                    .buttonStyle(.bordered)
                    .disabled(activateModelName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isActing)
                }

                Text("Installed")
                    .font(.headline)
                if installedModels.isEmpty {
                    Text("No installed models")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(Array(installedModels.enumerated()), id: \.offset) { _, model in
                        HStack {
                            Text(JSON.string(model, "name", fallback: "unknown"))
                            Spacer()
                            Button("Delete", role: .destructive) {
                                let modelName = JSON.string(model, "name")
                                Task {
                                    await performDeleteModel(modelName)
                                }
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                }

                Text("Available")
                    .font(.headline)
                ForEach(Array(availableModels.prefix(12).enumerated()), id: \.offset) { _, model in
                    Text(JSON.string(model, "name", fallback: "unknown"))
                        .font(.caption)
                }
            }
            .padding(.top, 4)
        }
    }

    private var chatCard: some View {
        GroupBox("Model Chat") {
            VStack(alignment: .leading, spacing: 10) {
                TextField("Prompt", text: $chatPrompt)
                    .textFieldStyle(.roundedBorder)

                Button("Send Prompt") {
                    Task { await sendChatPrompt() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(chatPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isActing)

                if !chatOutput.isEmpty {
                    Text(chatOutput)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.top, 4)
        }
    }

    private var logsCard: some View {
        GroupBox("Recent Logs") {
            if logs.isEmpty {
                Text("No logs available")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                TextEditor(text: .constant(logs.joined(separator: "\n")))
                    .frame(minHeight: 180)
                    .font(.caption.monospaced())
            }
        }
    }

    private func actionButton(_ title: String, path: String, method: HTTPMethod = .post) -> some View {
        Button(title) {
            Task {
                if method == .get {
                    await performGetAction(path: path)
                } else {
                    await performAction(path: path)
                }
            }
        }
        .buttonStyle(.bordered)
        .disabled(isActing)
    }

    private func loadOllamaData() async {
        isLoading = true
        errorMessage = nil

        do {
            async let statusTask = session.apiClient.get("/api/ollama/status")
            async let modelsTask = session.apiClient.get("/api/ollama/models")
            async let availableTask = session.apiClient.get("/api/ollama/models/available")
            async let logsTask = session.apiClient.get("/api/ollama/logs", query: [URLQueryItem(name: "lines", value: "200")])

            let statusResponse = try await statusTask
            let modelsResponse = try await modelsTask
            let availableResponse = try await availableTask
            let logsResponse = try await logsTask

            status = JSON.object(statusResponse)
            installedModels = JSON.array(JSON.object(modelsResponse)["models"])
            availableModels = JSON.array(JSON.object(availableResponse)["models"])

            let logsObject = JSON.object(logsResponse)
            logs = (logsObject["lines"] as? [String]) ?? []

            if activateModelName.isEmpty {
                activateModelName = JSON.string(status, "activeModel")
            }
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    private func sendChatPrompt() async {
        do {
            isActing = true
            defer { isActing = false }

            var payload: [String: Any] = ["message": chatPrompt]
            let model = JSON.string(status, "activeModel")
            if !model.isEmpty {
                payload["model"] = model
            }

            let response = try await session.apiClient.post("/api/ollama/chat", body: payload)
            let object = JSON.object(response)
            chatOutput = JSON.string(object, "response", fallback: JSON.string(object, "message", fallback: "Response received."))
            chatPrompt = ""
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func performAction(path: String, body: [String: Any] = [:]) async {
        do {
            isActing = true
            defer { isActing = false }
            let response = try await session.apiClient.post(path, body: body)
            let object = JSON.object(response)
            infoMessage = JSON.string(object, "message", fallback: "Action completed.")
            await loadOllamaData()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func performGetAction(path: String) async {
        do {
            isActing = true
            defer { isActing = false }
            let response = try await session.apiClient.get(path)
            let object = JSON.object(response)
            infoMessage = JSON.string(object, "message", fallback: JSON.prettyString(response))
            await loadOllamaData()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func performDeleteModel(_ modelName: String) async {
        guard !modelName.isEmpty else { return }

        do {
            isActing = true
            defer { isActing = false }
            let encodedName = modelName.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? modelName
            let response = try await session.apiClient.delete("/api/ollama/models/\(encodedName)")
            let object = JSON.object(response)
            infoMessage = JSON.string(object, "message", fallback: "Model deleted.")
            await loadOllamaData()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
