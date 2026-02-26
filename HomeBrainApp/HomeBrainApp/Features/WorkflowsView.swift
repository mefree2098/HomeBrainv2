import SwiftUI

struct WorkflowsView: View {
    @EnvironmentObject private var session: SessionStore

    @State private var workflows: [WorkflowItem] = []
    @State private var stats: [String: Any] = [:]

    @State private var isLoading = true
    @State private var errorMessage: String?

    @State private var showCreateSheet = false
    @State private var naturalLanguageText = ""

    @State private var createName = ""
    @State private var createDescription = ""
    @State private var triggerType = "manual"
    @State private var actionType = "notification"
    @State private var target = ""
    @State private var actionValue = ""

    private let triggerTypes = ["manual", "time", "schedule", "device_state", "sensor"]
    private let actionTypes = ["notification", "device_control", "scene_activate", "delay"]

    var body: some View {
        Group {
            if isLoading {
                LoadingView(title: "Loading workflows...")
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        if let errorMessage {
                            InlineErrorView(message: errorMessage) {
                                Task { await loadWorkflows() }
                            }
                        }

                        metricsSection

                        GroupBox("Create from Text") {
                            VStack(alignment: .leading, spacing: 10) {
                                TextField("e.g. Start movie scene every day at 7 PM", text: $naturalLanguageText)
                                    .textFieldStyle(.roundedBorder)

                                Button("Generate Workflow") {
                                    Task { await createFromText() }
                                }
                                .buttonStyle(.borderedProminent)
                                .disabled(naturalLanguageText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            }
                            .padding(.top, 4)
                        }

                        if workflows.isEmpty {
                            EmptyStateView(title: "No workflows", subtitle: "Create one manually or from natural language.")
                        } else {
                            ForEach(workflows) { workflow in
                                workflowRow(workflow)
                            }
                        }
                    }
                    .padding()
                }
                .toolbar {
                    ToolbarItem(placement: .primaryAction) {
                        Button("New Workflow") {
                            showCreateSheet = true
                        }
                    }
                }
                .sheet(isPresented: $showCreateSheet) {
                    createSheet
                }
                .refreshable {
                    await loadWorkflows()
                }
            }
        }
        .task {
            await loadWorkflows()
        }
    }

    private var metricsSection: some View {
        let total = JSON.int(stats, "total", fallback: workflows.count)
        let enabled = JSON.int(stats, "enabled", fallback: workflows.filter(\.enabled).count)
        let disabled = JSON.int(stats, "disabled", fallback: max(total - enabled, 0))

        return HStack(spacing: 12) {
            MetricCard(title: "Total", value: "\(total)", subtitle: "Workflows", tint: .blue)
            MetricCard(title: "Enabled", value: "\(enabled)", subtitle: "Active", tint: .green)
            MetricCard(title: "Disabled", value: "\(disabled)", subtitle: "Paused", tint: .orange)
        }
    }

    private func workflowRow(_ workflow: WorkflowItem) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(workflow.name)
                        .font(.headline)
                    Text(workflow.details)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }

                Spacer()

                Toggle("", isOn: Binding(
                    get: { workflow.enabled },
                    set: { value in
                        Task { await toggle(workflow, enabled: value) }
                    }
                ))
                .labelsHidden()
            }

            HStack {
                Text("Category: \(workflow.category)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Spacer()
                Text("Priority \(workflow.priority)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Spacer()
                Text("Runs \(workflow.executionCount)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            HStack {
                Button("Run") {
                    Task { await execute(workflow) }
                }
                .buttonStyle(.bordered)

                Button("Delete", role: .destructive) {
                    Task { await delete(workflow) }
                }
                .buttonStyle(.bordered)
            }
        }
        .padding()
        .background(Color.secondary.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var createSheet: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $createName)
                TextField("Description", text: $createDescription)

                Picker("Trigger", selection: $triggerType) {
                    ForEach(triggerTypes, id: \.self) { type in
                        Text(type).tag(type)
                    }
                }

                Picker("Action", selection: $actionType) {
                    ForEach(actionTypes, id: \.self) { type in
                        Text(type).tag(type)
                    }
                }

                TextField("Target (device/scene id if needed)", text: $target)
                TextField("Action value (optional)", text: $actionValue)
            }
            .navigationTitle("Create Workflow")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        showCreateSheet = false
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        Task { await createManualWorkflow() }
                    }
                    .disabled(createName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private func loadWorkflows() async {
        isLoading = true
        errorMessage = nil

        do {
            async let workflowsTask = session.apiClient.get("/api/workflows")
            async let statsTask = session.apiClient.get("/api/workflows/stats")

            let workflowsResponse = try await workflowsTask
            let statsResponse = try await statsTask

            let workflowsObject = JSON.object(workflowsResponse)
            let list = JSON.array(workflowsObject["workflows"]).map(WorkflowItem.from)
            workflows = list.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }

            let statsObject = JSON.object(statsResponse)
            stats = JSON.object(statsObject["stats"])
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    private func createFromText() async {
        do {
            let payload: [String: Any] = ["text": naturalLanguageText, "source": "ios"]
            let response = try await session.apiClient.post("/api/workflows/create-from-text", body: payload)
            let object = JSON.object(response)

            if let workflowObject = object["workflow"] as? [String: Any] {
                let item = WorkflowItem.from(workflowObject)
                workflows.append(item)
                workflows.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            }

            naturalLanguageText = ""
            await loadWorkflows()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func createManualWorkflow() async {
        do {
            var actionParameters: [String: Any] = [:]

            switch actionType {
            case "notification":
                actionParameters["message"] = actionValue.isEmpty ? "Workflow triggered from iOS" : actionValue
            case "device_control":
                actionParameters["action"] = actionValue.isEmpty ? "toggle" : actionValue
            case "delay":
                actionParameters["seconds"] = Int(actionValue) ?? 10
            default:
                break
            }

            var action: [String: Any] = [
                "type": actionType,
                "parameters": actionParameters
            ]
            if !target.isEmpty {
                action["target"] = target
            }

            let payload: [String: Any] = [
                "name": createName,
                "description": createDescription,
                "source": "manual",
                "enabled": true,
                "category": "custom",
                "priority": 5,
                "cooldown": 0,
                "trigger": ["type": triggerType, "conditions": [:]],
                "actions": [action],
                "graph": ["nodes": [], "edges": []]
            ]

            let response = try await session.apiClient.post("/api/workflows", body: payload)
            let object = JSON.object(response)
            let created = WorkflowItem.from(JSON.object(object["workflow"]))
            workflows.append(created)
            workflows.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }

            createName = ""
            createDescription = ""
            triggerType = "manual"
            actionType = "notification"
            target = ""
            actionValue = ""
            showCreateSheet = false

            await loadWorkflows()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func toggle(_ workflow: WorkflowItem, enabled: Bool) async {
        do {
            let payload: [String: Any] = ["enabled": enabled]
            let response = try await session.apiClient.put("/api/workflows/\(workflow.id)/toggle", body: payload)
            let object = JSON.object(response)
            let updated = WorkflowItem.from(JSON.object(object["workflow"]))
            if let index = workflows.firstIndex(where: { $0.id == updated.id }) {
                workflows[index] = updated
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func execute(_ workflow: WorkflowItem) async {
        do {
            _ = try await session.apiClient.post("/api/workflows/\(workflow.id)/execute", body: ["context": [:]])
            await loadWorkflows()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func delete(_ workflow: WorkflowItem) async {
        do {
            _ = try await session.apiClient.delete("/api/workflows/\(workflow.id)")
            workflows.removeAll { $0.id == workflow.id }
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
