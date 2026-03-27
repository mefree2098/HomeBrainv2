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
    @State private var createCategory = "custom"
    @State private var createPriority = 5
    @State private var editingWorkflow: WorkflowItem?

    private let triggerTypes = ["manual", "time", "schedule", "device_state", "sensor"]
    private let actionTypes = ["notification", "device_control", "scene_activate", "delay"]
    private let categories = ["security", "comfort", "energy", "convenience", "custom"]

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                if isLoading {
                    LoadingView(title: "Loading workflows...")
                } else {
                    HBSectionHeader(
                        title: "Workflows",
                        subtitle: "Orchestrate multi-step home routines",
                        buttonTitle: "New Workflow",
                        buttonIcon: "plus"
                    ) {
                        resetWorkflowEditor()
                        showCreateSheet = true
                    }

                    if let errorMessage {
                        InlineErrorView(message: errorMessage) {
                            Task { await loadWorkflows() }
                        }
                    }

                    metricsSection

                    GroupBox("Create from Text") {
                        VStack(alignment: .leading, spacing: 10) {
                            TextField("e.g. Start movie scene every day at 7 PM", text: $naturalLanguageText)
                                .hbPanelTextField()

                            Button("Generate Workflow") {
                                Task { await createFromText() }
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(HBPalette.accentBlue)
                            .disabled(naturalLanguageText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                        .padding(.top, 4)
                    }

                    if workflows.isEmpty {
                        EmptyStateView(title: "No workflows", subtitle: "Create one manually or from natural language.")
                    } else {
                        ForEach(workflows) { workflow in
                            HBCardRow {
                                workflowRow(workflow)
                            }
                        }
                    }
                }
            }
        }
        .groupBoxStyle(HBPanelGroupBoxStyle())
        .padding()
        .sheet(isPresented: $showCreateSheet) {
            createSheet
        }
        .refreshable {
            await loadWorkflows()
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
                        .font(.system(size: 20, weight: .bold, design: .rounded))
                        .foregroundStyle(HBPalette.textPrimary)
                    Text(workflow.details)
                        .font(.caption)
                        .foregroundStyle(HBPalette.textSecondary)
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
                    .foregroundStyle(HBPalette.textSecondary)
                Spacer()
                Text("Priority \(workflow.priority)")
                    .font(.caption2)
                    .foregroundStyle(HBPalette.textSecondary)
                Spacer()
                Text("Runs \(workflow.executionCount)")
                    .font(.caption2)
                    .foregroundStyle(HBPalette.textSecondary)
            }

            HStack(spacing: 10) {
                Button("Run") {
                    Task { await execute(workflow) }
                }
                .buttonStyle(.bordered)

                Button("Edit") {
                    beginEditing(workflow)
                }
                .buttonStyle(.bordered)

                Button("Delete", role: .destructive) {
                    Task { await delete(workflow) }
                }
                .buttonStyle(.bordered)
            }
        }
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

                Picker("Category", selection: $createCategory) {
                    ForEach(categories, id: \.self) { category in
                        Text(category.capitalized).tag(category)
                    }
                }

                Stepper("Priority: \(createPriority)", value: $createPriority, in: 1...10)

                TextField("Target (device/scene id if needed)", text: $target)
                TextField("Action value (optional)", text: $actionValue)
            }
            .hbFormStyle()
            .navigationTitle(editingWorkflow == nil ? "Create Workflow" : "Edit Workflow")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        showCreateSheet = false
                        resetWorkflowEditor()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(editingWorkflow == nil ? "Create" : "Save") {
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
        if let editingWorkflow {
            await updateWorkflow(editingWorkflow)
            return
        }

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
                "category": createCategory,
                "priority": createPriority,
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
            createCategory = "custom"
            createPriority = 5
            showCreateSheet = false

            await loadWorkflows()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func updateWorkflow(_ workflow: WorkflowItem) async {
        do {
            let payload: [String: Any] = [
                "name": createName,
                "description": createDescription,
                "category": createCategory,
                "priority": createPriority
            ]

            let response = try await session.apiClient.put("/api/workflows/\(workflow.id)", body: payload)
            let object = JSON.object(response)
            let updated = WorkflowItem.from(JSON.object(object["workflow"]))
            if let index = workflows.firstIndex(where: { $0.id == updated.id }) {
                workflows[index] = updated
            }

            showCreateSheet = false
            resetWorkflowEditor()
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

    private func beginEditing(_ workflow: WorkflowItem) {
        editingWorkflow = workflow
        createName = workflow.name
        createDescription = workflow.details
        createCategory = workflow.category
        createPriority = workflow.priority
        showCreateSheet = true
    }

    private func resetWorkflowEditor() {
        editingWorkflow = nil
        createName = ""
        createDescription = ""
        triggerType = "manual"
        actionType = "notification"
        target = ""
        actionValue = ""
        createCategory = "custom"
        createPriority = 5
    }
}
