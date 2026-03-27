import SwiftUI

struct WhisperView: View {
    @EnvironmentObject private var session: SessionStore

    @State private var status: [String: Any] = [:]
    @State private var availableModels: [[String: Any]] = []
    @State private var logs: [String] = []

    @State private var selectedModel = "small"

    @State private var isLoading = true
    @State private var isActing = false
    @State private var errorMessage: String?
    @State private var infoMessage = ""

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                if isLoading {
                    LoadingView(title: "Loading Whisper status...")
                } else {
                    HBSectionHeader(
                        title: "Whisper STT",
                        subtitle: "Speech model controls and diagnostics"
                    )

                    if let errorMessage {
                        InlineErrorView(message: errorMessage) {
                            Task { await loadWhisperData() }
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
                    logsCard
                }
            }
            .padding()
        }
        .groupBoxStyle(HBPanelGroupBoxStyle())
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Refresh") {
                    Task { await loadWhisperData() }
                }
            }
        }
        .task {
            await loadWhisperData()
        }
        .refreshable {
            await loadWhisperData()
        }
    }

    private var statusCard: some View {
        GroupBox("Whisper Status") {
            VStack(alignment: .leading, spacing: 6) {
                Text("Installed: \(JSON.bool(status, "isInstalled") ? "Yes" : "No")")
                Text("Service Running: \(JSON.bool(status, "serviceRunning") ? "Yes" : "No")")
                Text("Service Status: \(JSON.string(status, "serviceStatus", fallback: "unknown"))")
                Text("Active Model: \(JSON.string(status, "activeModel", fallback: "none"))")
            }
            .font(.subheadline)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 4)
        }
    }

    private var controlsCard: some View {
        GroupBox("Whisper Controls") {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    actionButton("Install", path: "/api/whisper/install")
                    actionButton("Start", path: "/api/whisper/service/start", body: ["model": JSON.string(status, "activeModel", fallback: selectedModel)])
                    actionButton("Stop", path: "/api/whisper/service/stop")
                }

                Divider()

                Picker("Model", selection: $selectedModel) {
                    let names = availableModels.compactMap { JSON.optionalString($0, "name") }
                    ForEach(names, id: \.self) { name in
                        Text(name).tag(name)
                    }
                }

                HStack {
                    actionButton("Download", path: "/api/whisper/models/download", body: ["modelName": selectedModel])
                    actionButton("Activate", path: "/api/whisper/models/activate", body: ["modelName": selectedModel])
                }

                let installed = JSON.array(status["installedModels"])
                if !installed.isEmpty {
                    Text("Installed Models: \(installed.compactMap { JSON.optionalString($0, "name") }.joined(separator: ", "))")
                        .font(.caption)
                        .foregroundStyle(HBPalette.textSecondary)
                }
            }
            .padding(.top, 4)
        }
    }

    private var logsCard: some View {
        GroupBox("Whisper Logs") {
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

    private func actionButton(_ title: String, path: String, body: [String: Any] = [:]) -> some View {
        Button(title) {
            Task { await performAction(path: path, body: body) }
        }
        .buttonStyle(.bordered)
        .disabled(isActing)
    }

    private func loadWhisperData() async {
        isLoading = true
        errorMessage = nil

        do {
            async let statusTask = session.apiClient.get("/api/whisper/status")
            async let availableTask = session.apiClient.get("/api/whisper/models/available")
            async let logsTask = session.apiClient.get("/api/whisper/logs")

            let statusResponse = try await statusTask
            let availableResponse = try await availableTask
            let logsResponse = try await logsTask

            status = JSON.object(statusResponse)
            availableModels = JSON.array(JSON.object(availableResponse)["models"])

            let logsObject = JSON.object(logsResponse)
            logs = (logsObject["logs"] as? [String]) ?? []

            if let firstModel = availableModels.first {
                selectedModel = JSON.string(firstModel, "name", fallback: selectedModel)
            }
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    private func performAction(path: String, body: [String: Any] = [:]) async {
        do {
            isActing = true
            defer { isActing = false }
            let response = try await session.apiClient.post(path, body: body)
            let object = JSON.object(response)
            infoMessage = JSON.string(object, "message", fallback: "Action completed.")
            await loadWhisperData()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
