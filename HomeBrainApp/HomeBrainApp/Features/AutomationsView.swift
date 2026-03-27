import SwiftUI

struct AutomationsView: View {
    @EnvironmentObject private var session: SessionStore

    @State private var automations: [AutomationItem] = []
    @State private var stats: [String: Any] = [:]

    @State private var isLoading = true
    @State private var errorMessage: String?

    @State private var showCreateSheet = false
    @State private var showHistorySheet = false
    @State private var naturalLanguageText = ""
    @State private var selectedAutomationForHistory: AutomationItem?
    @State private var historyEntries: [AutomationHistoryEntry] = []
    @State private var historyLoading = false

    @State private var createName = ""
    @State private var createDescription = ""
    @State private var triggerType = "manual"
    @State private var actionType = "notification"
    @State private var target = ""
    @State private var actionValue = ""
    @State private var createCategory = "custom"
    @State private var createPriority = 5
    @State private var editingAutomation: AutomationItem?

    private let triggerTypes = ["manual", "time", "schedule", "device_state", "sensor"]
    private let actionTypes = ["notification", "device_control", "scene_activate", "delay"]
    private let categories = ["security", "comfort", "energy", "convenience", "custom"]

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                if isLoading {
                    LoadingView(title: "Loading automations...")
                } else {
                    HBSectionHeader(
                        title: "Automations",
                        subtitle: "Smart triggers and actions",
                        buttonTitle: "New Automation",
                        buttonIcon: "plus"
                    ) {
                        resetAutomationEditor()
                        showCreateSheet = true
                    }

                    if let errorMessage {
                        InlineErrorView(message: errorMessage) {
                            Task { await loadAutomations() }
                        }
                    }

                    metricsSection

                    GroupBox("Create from Text") {
                        VStack(alignment: .leading, spacing: 10) {
                            TextField("e.g. Turn all outdoor lights on at sunset", text: $naturalLanguageText)
                                .hbPanelTextField()

                            Button("Generate Automation") {
                                Task { await createFromText() }
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(HBPalette.accentBlue)
                            .disabled(naturalLanguageText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                        .padding(.top, 4)
                    }

                    if automations.isEmpty {
                        EmptyStateView(title: "No automations", subtitle: "Create one manually or from natural language.")
                    } else {
                        ForEach(automations) { automation in
                            HBCardRow {
                                automationRow(automation)
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
        .sheet(isPresented: $showHistorySheet) {
            historySheet
        }
        .refreshable {
            await loadAutomations()
        }
        .task {
            await loadAutomations()
        }
    }

    private var metricsSection: some View {
        let total = JSON.int(stats, "total", fallback: automations.count)
        let enabled = JSON.int(stats, "enabled", fallback: automations.filter(\.enabled).count)
        let disabled = JSON.int(stats, "disabled", fallback: max(total - enabled, 0))

        return HStack(spacing: 12) {
            MetricCard(title: "Total", value: "\(total)", subtitle: "Automations", tint: .blue)
            MetricCard(title: "Enabled", value: "\(enabled)", subtitle: "Running", tint: .green)
            MetricCard(title: "Disabled", value: "\(disabled)", subtitle: "Paused", tint: .orange)
        }
    }

    private func automationRow(_ automation: AutomationItem) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(automation.name)
                        .font(.system(size: 20, weight: .bold, design: .rounded))
                        .foregroundStyle(HBPalette.textPrimary)
                    Text(automation.details)
                        .font(.caption)
                        .foregroundStyle(HBPalette.textSecondary)
                        .lineLimit(2)
                }

                Spacer()

                Toggle("", isOn: Binding(
                    get: { automation.enabled },
                    set: { value in
                        Task { await toggle(automation, enabled: value) }
                    }
                ))
                .labelsHidden()
            }

            HStack {
                Text("Category: \(automation.category)")
                    .font(.caption2)
                    .foregroundStyle(HBPalette.textSecondary)
                Spacer()
                Text("Priority \(automation.priority)")
                    .font(.caption2)
                    .foregroundStyle(HBPalette.textSecondary)
                Spacer()
                Text("Runs \(automation.executionCount)")
                    .font(.caption2)
                    .foregroundStyle(HBPalette.textSecondary)
                Spacer()
                Text("Last run \(automation.lastRun)")
                    .font(.caption2)
                    .foregroundStyle(HBPalette.textSecondary)
            }

            HStack(spacing: 10) {
                Button("Run") {
                    Task { await execute(automation) }
                }
                .buttonStyle(.bordered)

                Button("Edit") {
                    beginEditing(automation)
                }
                .buttonStyle(.bordered)

                Button("History") {
                    Task { await openHistory(for: automation) }
                }
                .buttonStyle(.bordered)

                Button("Delete", role: .destructive) {
                    Task { await delete(automation) }
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
            .navigationTitle(editingAutomation == nil ? "Create Automation" : "Edit Automation")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        showCreateSheet = false
                        resetAutomationEditor()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(editingAutomation == nil ? "Create" : "Save") {
                        Task { await createManualAutomation() }
                    }
                    .disabled(createName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private func loadAutomations() async {
        isLoading = true
        errorMessage = nil

        do {
            async let automationsTask = session.apiClient.get("/api/automations")
            async let statsTask = session.apiClient.get("/api/automations/stats")

            let automationsResponse = try await automationsTask
            let statsResponse = try await statsTask

            let automationsObject = JSON.object(automationsResponse)
            let list = JSON.array(automationsObject["automations"]).map(AutomationItem.from)
            automations = list.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }

            let statsObject = JSON.object(statsResponse)
            stats = JSON.object(statsObject["stats"])
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    private func createFromText() async {
        do {
            let payload: [String: Any] = ["text": naturalLanguageText]
            let response = try await session.apiClient.post("/api/automations/create-from-text", body: payload)
            let object = JSON.object(response)

            if let createdObject = object["automation"] as? [String: Any] {
                let item = AutomationItem.from(createdObject)
                automations.append(item)
                automations.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            }

            naturalLanguageText = ""
            await loadAutomations()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func createManualAutomation() async {
        if let editingAutomation {
            await updateAutomation(editingAutomation)
            return
        }

        do {
            var actionParameters: [String: Any] = [:]

            switch actionType {
            case "notification":
                actionParameters["message"] = actionValue.isEmpty ? "Automation triggered from iOS" : actionValue
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
                "trigger": ["type": triggerType, "conditions": [:]],
                "actions": [action],
                "enabled": true,
                "priority": createPriority,
                "category": createCategory
            ]

            let response = try await session.apiClient.post("/api/automations", body: payload)
            let object = JSON.object(response)
            let created = AutomationItem.from(JSON.object(object["automation"]))
            automations.append(created)
            automations.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }

            createName = ""
            createDescription = ""
            triggerType = "manual"
            actionType = "notification"
            target = ""
            actionValue = ""
            createCategory = "custom"
            createPriority = 5
            showCreateSheet = false

            await loadAutomations()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func updateAutomation(_ automation: AutomationItem) async {
        do {
            let payload: [String: Any] = [
                "name": createName,
                "description": createDescription,
                "category": createCategory,
                "priority": createPriority
            ]

            let response = try await session.apiClient.put("/api/automations/\(automation.id)", body: payload)
            let object = JSON.object(response)
            let updated = AutomationItem.from(JSON.object(object["automation"]))
            if let index = automations.firstIndex(where: { $0.id == updated.id }) {
                automations[index] = updated
            }

            showCreateSheet = false
            resetAutomationEditor()
            await loadAutomations()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func toggle(_ automation: AutomationItem, enabled: Bool) async {
        do {
            let payload: [String: Any] = ["enabled": enabled]
            let response = try await session.apiClient.put("/api/automations/\(automation.id)/toggle", body: payload)
            let object = JSON.object(response)
            let updated = AutomationItem.from(JSON.object(object["automation"]))
            if let index = automations.firstIndex(where: { $0.id == updated.id }) {
                automations[index] = updated
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func execute(_ automation: AutomationItem) async {
        do {
            _ = try await session.apiClient.post("/api/automations/\(automation.id)/execute")
            await loadAutomations()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func delete(_ automation: AutomationItem) async {
        do {
            _ = try await session.apiClient.delete("/api/automations/\(automation.id)")
            automations.removeAll { $0.id == automation.id }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func beginEditing(_ automation: AutomationItem) {
        editingAutomation = automation
        createName = automation.name
        createDescription = automation.details
        createCategory = automation.category
        createPriority = automation.priority
        showCreateSheet = true
    }

    private func resetAutomationEditor() {
        editingAutomation = nil
        createName = ""
        createDescription = ""
        triggerType = "manual"
        actionType = "notification"
        target = ""
        actionValue = ""
        createCategory = "custom"
        createPriority = 5
    }

    private func openHistory(for automation: AutomationItem) async {
        selectedAutomationForHistory = automation
        showHistorySheet = true
        historyLoading = true

        defer {
            historyLoading = false
        }

        do {
            let response = try await session.apiClient.get(
                "/api/automations/history/\(automation.id)",
                query: [URLQueryItem(name: "limit", value: "20")]
            )
            let object = JSON.object(response)
            let entries = JSON.array(object["history"]).map(AutomationHistoryEntry.from)
            historyEntries = entries
        } catch {
            errorMessage = error.localizedDescription
            historyEntries = []
        }
    }

    @ViewBuilder
    private var historySheet: some View {
        NavigationStack {
            List {
                if historyLoading {
                    HStack {
                        Spacer()
                        ProgressView("Loading history...")
                        Spacer()
                    }
                } else if historyEntries.isEmpty {
                    Text("No execution history available.")
                        .foregroundStyle(HBPalette.textSecondary)
                } else {
                    ForEach(historyEntries) { entry in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(entry.statusLabel)
                                    .font(.system(size: 13, weight: .semibold, design: .rounded))
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 4)
                                    .background(entry.statusColor.opacity(0.2), in: Capsule())
                                Spacer()
                                Text(entry.startedAtLabel)
                                    .font(.caption)
                                    .foregroundStyle(HBPalette.textSecondary)
                            }

                            HStack(spacing: 12) {
                                Text("Actions \(entry.totalActions)")
                                    .font(.caption)
                                Text("Success \(entry.successfulActions)")
                                    .font(.caption)
                                Text("Failed \(entry.failedActions)")
                                    .font(.caption)
                                if let durationMs = entry.durationMs {
                                    Text("\(durationMs) ms")
                                        .font(.caption)
                                }
                            }
                            .foregroundStyle(HBPalette.textSecondary)

                            if !entry.errorMessage.isEmpty {
                                Text(entry.errorMessage)
                                    .font(.caption)
                                    .foregroundStyle(.red)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
            .navigationTitle(selectedAutomationForHistory.map { "\($0.name) History" } ?? "Execution History")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") {
                        showHistorySheet = false
                    }
                }
            }
        }
    }
}

private struct AutomationHistoryEntry: Identifiable {
    let id: String
    let status: String
    let startedAtLabel: String
    let durationMs: Int?
    let totalActions: Int
    let successfulActions: Int
    let failedActions: Int
    let errorMessage: String

    var statusLabel: String {
        switch status {
        case "success":
            return "Success"
        case "partial_success":
            return "Partial"
        case "failed":
            return "Failed"
        default:
            return status.capitalized
        }
    }

    var statusColor: Color {
        switch status {
        case "success":
            return .green
        case "partial_success":
            return .orange
        case "failed":
            return .red
        default:
            return .gray
        }
    }

    static func from(_ object: [String: Any]) -> AutomationHistoryEntry {
        let durationValue: Int?
        let rawDuration = JSON.int(object, "durationMs", fallback: -1)
        durationValue = rawDuration >= 0 ? rawDuration : nil

        let errorObject = JSON.object(object["error"])
        return AutomationHistoryEntry(
            id: JSON.id(object),
            status: JSON.string(object, "status", fallback: "unknown"),
            startedAtLabel: JSON.displayDate(from: object["startedAt"]),
            durationMs: durationValue,
            totalActions: JSON.int(object, "totalActions"),
            successfulActions: JSON.int(object, "successfulActions"),
            failedActions: JSON.int(object, "failedActions"),
            errorMessage: JSON.string(errorObject, "message")
        )
    }
}
