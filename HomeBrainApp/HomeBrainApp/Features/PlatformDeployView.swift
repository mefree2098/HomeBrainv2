import SwiftUI

struct PlatformDeployView: View {
    @EnvironmentObject private var session: SessionStore

    @State private var deployStatus: [String: Any] = [:]
    @State private var repo: [String: Any] = [:]
    @State private var latestJob: [String: Any] = [:]
    @State private var health: [String: Any] = [:]
    @State private var presets: [[String: Any]] = []

    @State private var selectedPreset = "safe"
    @State private var allowDirty = false
    @State private var installDependencies = true
    @State private var runServerTests = true
    @State private var runClientLint = true
    @State private var restartServices = true

    @State private var isLoading = true
    @State private var isRunning = false
    @State private var errorMessage: String?
    @State private var infoMessage = ""

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                if isLoading {
                    LoadingView(title: "Loading deploy status...")
                } else {
                    HBSectionHeader(
                        title: "Platform Deploy",
                        subtitle: "Release controls and post-deploy checks"
                    )

                    if let errorMessage {
                        InlineErrorView(message: errorMessage) {
                            Task { await loadDeployData() }
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

                    repoStatusCard
                    deployControlsCard
                    healthCard
                    latestJobCard
                }
            }
            .padding()
        }
        .groupBoxStyle(HBPanelGroupBoxStyle())
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Refresh") {
                    Task { await loadDeployData() }
                }
            }
        }
        .task {
            await loadDeployData()
        }
        .refreshable {
            await loadDeployData()
        }
    }

    private var repoStatusCard: some View {
        GroupBox("Repository Status") {
            VStack(alignment: .leading, spacing: 6) {
                Text("Branch: \(JSON.string(repo, "branch", fallback: "unknown"))")
                Text("Commit: \(JSON.string(repo, "shortCommit", fallback: "unknown"))")
                Text("Dirty: \(JSON.bool(repo, "dirty") ? "Yes" : "No")")
                Text("Ahead: \(JSON.int(repo, "ahead")) · Behind: \(JSON.int(repo, "behind"))")
                Text("Running: \(JSON.bool(deployStatus, "running") ? "Yes" : "No")")
            }
            .font(.subheadline)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 4)
        }
    }

    private var deployControlsCard: some View {
        GroupBox("Deploy Controls") {
            VStack(alignment: .leading, spacing: 10) {
                Picker("Preset", selection: $selectedPreset) {
                    ForEach(presets, id: \.self.description) { preset in
                        let id = JSON.string(preset, "id", fallback: "safe")
                        let label = JSON.string(preset, "label", fallback: id.capitalized)
                        Text(label).tag(id)
                    }
                }

                Toggle("Allow dirty repo", isOn: $allowDirty)
                Toggle("Install dependencies", isOn: $installDependencies)
                Toggle("Run server tests", isOn: $runServerTests)
                Toggle("Run client lint", isOn: $runClientLint)
                Toggle("Restart services", isOn: $restartServices)

                HStack {
                    Button {
                        Task { await runDeploy() }
                    } label: {
                        if isRunning {
                            HStack {
                                ProgressView()
                                Text("Deploying...")
                            }
                        } else {
                            Text("Run Deploy")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(isRunning)

                    Button("Restart Services") {
                        Task { await triggerRestart() }
                    }
                    .buttonStyle(.bordered)
                }
            }
            .padding(.top, 4)
        }
    }

    private var healthCard: some View {
        let overall = JSON.string(health, "overallStatus", fallback: "unknown")
        let checks = JSON.object(health["checks"])

        return GroupBox("Post-Deploy Health") {
            VStack(alignment: .leading, spacing: 6) {
                Text("Overall: \(overall)")
                    .font(.headline)
                Text("API: \(JSON.string(JSON.object(checks["api"]), "status", fallback: "unknown"))")
                Text("WebSocket: \(JSON.string(JSON.object(checks["websocket"]), "status", fallback: "unknown"))")
                Text("Database: \(JSON.string(JSON.object(checks["database"]), "status", fallback: "unknown"))")
                Text("Wake Word Worker: \(JSON.string(JSON.object(checks["wakeWordWorker"]), "status", fallback: "unknown"))")
            }
            .font(.subheadline)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 4)
        }
    }

    private var latestJobCard: some View {
        let steps = JSON.array(latestJob["steps"])

        return GroupBox("Latest Job") {
            if latestJob.isEmpty {
                EmptyStateView(title: "No jobs", subtitle: "Run your first deploy from this page.")
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Status: \(JSON.string(latestJob, "status", fallback: "unknown"))")
                    Text("Current Step: \(JSON.string(latestJob, "currentStep", fallback: "-"))")
                    Text("Created: \(JSON.displayDate(from: latestJob["createdAt"]))")

                    if !JSON.string(latestJob, "error").isEmpty {
                        Text("Error: \(JSON.string(latestJob, "error"))")
                            .foregroundStyle(.red)
                    }

                    if !steps.isEmpty {
                        ForEach(Array(steps.enumerated()), id: \.offset) { _, rawStep in
                            let step = JSON.object(rawStep)
                            HStack {
                                Text(JSON.string(step, "name", fallback: "step"))
                                Spacer()
                                Text(JSON.string(step, "status", fallback: "unknown"))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }

                    let logTail = JSON.string(latestJob, "logTail")
                    if !logTail.isEmpty {
                        TextEditor(text: .constant(logTail))
                            .frame(minHeight: 140)
                            .font(.caption.monospaced())
                    }
                }
                .font(.subheadline)
                .padding(.top, 4)
            }
        }
    }

    private func loadDeployData() async {
        isLoading = true
        errorMessage = nil

        do {
            async let statusTask = session.apiClient.get("/api/platform-deploy/status")
            async let healthTask = session.apiClient.get("/api/platform-deploy/health")
            async let presetsTask = session.apiClient.get("/api/platform-deploy/presets")

            let statusResponse = try await statusTask
            let healthResponse = try await healthTask
            let presetsResponse = try await presetsTask

            deployStatus = JSON.object(statusResponse)
            repo = JSON.object(deployStatus["repo"])
            latestJob = JSON.object(deployStatus["latestJob"])

            health = JSON.object(healthResponse)

            let presetsObject = JSON.object(presetsResponse)
            presets = JSON.array(presetsObject["presets"])

            if selectedPreset.isEmpty, let first = presets.first {
                selectedPreset = JSON.string(first, "id", fallback: "safe")
            }
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    private func runDeploy() async {
        isRunning = true
        defer { isRunning = false }

        do {
            let payload: [String: Any] = [
                "preset": selectedPreset,
                "allowDirty": allowDirty,
                "installDependencies": installDependencies,
                "runServerTests": runServerTests,
                "runClientLint": runClientLint,
                "restartServices": restartServices
            ]

            let response = try await session.apiClient.post("/api/platform-deploy/run", body: payload)
            let object = JSON.object(response)
            let job = JSON.object(object["job"])
            let jobId = JSON.string(job, "id")

            infoMessage = "Deploy job started."
            if !jobId.isEmpty {
                await pollJob(jobId)
            } else {
                await loadDeployData()
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func triggerRestart() async {
        do {
            let response = try await session.apiClient.post("/api/platform-deploy/restart-services")
            let object = JSON.object(response)
            infoMessage = JSON.string(object, "message", fallback: "Restart command queued.")
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func pollJob(_ jobId: String) async {
        for _ in 0..<30 {
            do {
                let response = try await session.apiClient.get("/api/platform-deploy/jobs/\(jobId)")
                let object = JSON.object(response)
                let job = JSON.object(object["job"])
                latestJob = job

                let status = JSON.string(job, "status")
                if status == "completed" || status == "failed" {
                    await loadDeployData()
                    return
                }
            } catch {
                errorMessage = error.localizedDescription
                break
            }

            try? await Task.sleep(for: .seconds(2))
        }

        await loadDeployData()
    }
}
