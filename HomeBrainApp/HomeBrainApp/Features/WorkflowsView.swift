import SwiftUI
import Combine
import UIKit

private struct WorkflowTemplateDefinition: Identifiable {
    let id: String
    let name: String
    let description: String
    let build: () -> [String: Any]
}

private let workflowTemplateDefinitions: [WorkflowTemplateDefinition] = [
    WorkflowTemplateDefinition(
        id: "goodnight",
        name: "Goodnight Routine",
        description: "Run a night shutdown manually by button, chat, or voice."
    ) {
        [
            "name": "Goodnight Routine",
            "description": "Night shutdown routine for lights and household status.",
            "source": "manual",
            "enabled": true,
            "category": "comfort",
            "priority": 5,
            "cooldown": 0,
            "trigger": ["type": "manual", "conditions": [:]],
            "actions": [[
                "type": "notification",
                "target": "system",
                "parameters": ["message": "Goodnight routine executed."]
            ]],
            "graph": ["nodes": [], "edges": []]
        ]
    },
    WorkflowTemplateDefinition(
        id: "morning-weekday",
        name: "Weekday Morning Start",
        description: "Kick off a weekday morning routine at 6:30 AM."
    ) {
        [
            "name": "Weekday Morning Start",
            "description": "Starts key systems on weekdays at 6:30 AM.",
            "source": "manual",
            "enabled": true,
            "category": "convenience",
            "priority": 5,
            "cooldown": 0,
            "trigger": ["type": "schedule", "conditions": ["cron": "30 6 * * 1-5"]],
            "actions": [[
                "type": "notification",
                "target": "system",
                "parameters": ["message": "Morning routine triggered."]
            ]],
            "graph": ["nodes": [], "edges": []]
        ]
    },
    WorkflowTemplateDefinition(
        id: "away-alert",
        name: "Away Motion Alert",
        description: "Send a notification when motion is detected while away."
    ) {
        [
            "name": "Away Motion Alert",
            "description": "Alerts when motion is detected while away mode is active.",
            "source": "manual",
            "enabled": true,
            "category": "security",
            "priority": 5,
            "cooldown": 0,
            "trigger": ["type": "sensor", "conditions": ["sensorType": "motion", "condition": "detected"]],
            "actions": [[
                "type": "notification",
                "target": "system",
                "parameters": ["message": "Motion detected while away."]
            ]],
            "graph": ["nodes": [], "edges": []]
        ]
    },
    WorkflowTemplateDefinition(
        id: "night-energy",
        name: "Night Energy Saver",
        description: "Turn something off nightly to cut down on idle energy use."
    ) {
        [
            "name": "Night Energy Saver",
            "description": "Turns off devices nightly to reduce idle energy use.",
            "source": "manual",
            "enabled": true,
            "category": "energy",
            "priority": 5,
            "cooldown": 0,
            "trigger": ["type": "time", "conditions": ["hour": 23, "minute": 0]],
            "actions": [[
                "type": "notification",
                "target": "system",
                "parameters": ["message": "Night energy saver executed."]
            ]],
            "graph": ["nodes": [], "edges": []]
        ]
    }
]

struct WorkflowsView: View {
    @EnvironmentObject private var session: SessionStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    @State private var workflows: [WorkflowItem] = []
    @State private var stats: [String: Any] = [:]
    @State private var runningExecutions: [WorkflowExecutionHistoryItem] = []
    @State private var runtimeHistory: [WorkflowExecutionHistoryItem] = []
    @State private var runtimeTelemetry = WorkflowRuntimeTelemetryItem.empty
    @State private var runtimePagination = WorkflowRuntimePaginationItem.empty
    @State private var activityEvents: [PlatformEventItem] = []

    @State private var isLoading = true
    @State private var runtimeRefreshing = false
    @State private var errorMessage: String?

    @State private var showCreateSheet = false
    @State private var showReviseSheet = false
    @State private var selectedExecution: WorkflowExecutionHistoryItem?
    @State private var selectedExecutionEvents: [PlatformEventItem] = []
    @State private var loadingExecutionEvents = false
    @State private var workflowToRevise: WorkflowItem?
    @State private var workflowPendingDelete: WorkflowItem?

    @State private var naturalLanguageText = ""
    @State private var revisePrompt = ""
    @State private var chatCommand = ""
    @State private var lastChatResult = ""

    @State private var creatingFromText = false
    @State private var revisingWorkflow = false
    @State private var runningChatCommand = false
    @State private var runtimeLogLimit = 50
    @State private var runtimeWindowHours = 24
    @State private var runtimeHistoryPage = 1

    @State private var createName = ""
    @State private var createDescription = ""
    @State private var triggerType = "manual"
    @State private var actionType = "notification"
    @State private var target = ""
    @State private var actionValue = ""
    @State private var createCategory = "custom"
    @State private var createPriority = 5
    @State private var editingWorkflow: WorkflowItem?

    @State private var now = Date()

    private let triggerTypes = ["manual", "time", "schedule", "device_state", "sensor", "security_alarm_status"]
    private let actionTypes = ["notification", "device_control", "scene_activate", "delay"]
    private let categories = ["security", "comfort", "energy", "convenience", "custom"]
    private let runtimeLogLimitOptions = [10, 25, 50]
    private let runtimeWindowOptions: [(hours: Int, label: String)] = [
        (1, "Last Hour"),
        (24, "Last 24 Hours"),
        (24 * 7, "Last Week"),
        (24 * 30, "Last Month"),
        (24 * 365, "Last Year")
    ]
    private let refreshTimer = Timer.publish(every: 12, on: .main, in: .common).autoconnect()
    private let clockTimer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    private var isAdmin: Bool {
        session.currentUser?.role == "admin"
    }

    private var usesCompactLayout: Bool {
        horizontalSizeClass == .compact
    }

    private var workflowIdsRunning: Set<String> {
        Set(runningExecutions.compactMap { $0.workflowId })
    }

    private var runtimeWindowLabel: String {
        runtimeWindowOptions.first(where: { $0.hours == (runtimeTelemetry.timeRangeHours ?? runtimeWindowHours) })?.label ?? "Selected Range"
    }

    private var runtimePageSummary: String {
        guard runtimePagination.total > 0 else {
            return "No runtime logs in this range."
        }

        let start = ((runtimePagination.page - 1) * runtimePagination.limit) + 1
        let end = min(runtimePagination.total, start + max(runtimeHistory.count - 1, 0))
        return "Showing \(start)-\(end) of \(runtimePagination.total) logs."
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                if isLoading {
                    LoadingView(title: "Loading workflow studio...")
                } else {
                    HBSectionHeader(
                        title: "Workflow Studio",
                        subtitle: isAdmin
                            ? "Build workflows, revise them with AI, and watch automations run live."
                            : "Review, run, and inspect workflow-backed automations.",
                        buttonTitle: isAdmin ? "New Workflow" : nil,
                        buttonIcon: isAdmin ? "plus" : nil
                    ) {
                        resetWorkflowEditor()
                        showCreateSheet = true
                    }

                    if let errorMessage {
                        InlineErrorView(message: errorMessage) {
                            Task { await refreshWorkflowScreen(silent: false) }
                        }
                    }

                    metricsSection

                    if isAdmin {
                        templatesSection
                        createFromTextSection
                    } else {
                        adminCapabilitiesNote
                    }

                    commandSection
                    runtimeSection
                    workflowsSection
                }
            }
            .padding()
        }
        .scrollIndicators(.hidden)
        .groupBoxStyle(HBPanelGroupBoxStyle())
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button(runtimeRefreshing ? "Refreshing..." : "Refresh") {
                    Task { await refreshWorkflowScreen(silent: false) }
                }
            }
        }
        .sheet(isPresented: $showCreateSheet) {
            createSheet
                .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $showReviseSheet) {
            reviseSheet
                .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: selectedExecutionSheetBinding) {
            if let selectedExecution {
                executionLogsSheet(for: selectedExecution)
                    .presentationDetents([.large])
            }
        }
        .alert(
            workflowPendingDelete == nil ? "Delete Workflow" : "Delete \(workflowPendingDelete?.name ?? "Workflow")?",
            isPresented: workflowDeleteAlertBinding(),
            presenting: workflowPendingDelete
        ) { workflow in
            Button("Delete", role: .destructive) {
                Task { await delete(workflow) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { workflow in
            Text("This removes \(workflow.name) and its current configuration from HomeBrain.")
        }
        .onReceive(refreshTimer) { _ in
            Task {
                await refreshWorkflowScreen(silent: true)
            }
        }
        .onReceive(clockTimer) { _ in
            now = Date()
        }
        .task {
            await refreshWorkflowScreen(silent: false)
        }
        .refreshable {
            await refreshWorkflowScreen(silent: false)
        }
        .onChange(of: runtimeLogLimit) { _ in
            if runtimeHistoryPage == 1 {
                Task { await refreshWorkflowScreen(silent: false) }
            } else {
                runtimeHistoryPage = 1
            }
        }
        .onChange(of: runtimeWindowHours) { _ in
            if runtimeHistoryPage == 1 {
                Task { await refreshWorkflowScreen(silent: false) }
            } else {
                runtimeHistoryPage = 1
            }
        }
        .onChange(of: runtimeHistoryPage) { _ in
            Task { await refreshWorkflowScreen(silent: false) }
        }
    }

    private var metricsSection: some View {
        let total = JSON.int(stats, "total", fallback: workflows.count)
        let enabled = JSON.int(stats, "enabled", fallback: workflows.filter(\.enabled).count)
        let disabled = JSON.int(stats, "disabled", fallback: max(total - enabled, 0))
        let voiceReady = workflows.filter { !$0.voiceAliases.isEmpty }.count

        return LazyVGrid(
            columns: [GridItem(.adaptive(minimum: usesCompactLayout ? 118 : 154), spacing: 12, alignment: .leading)],
            alignment: .leading,
            spacing: 12
        ) {
            MetricCard(title: "Total", value: "\(total)", subtitle: "Workflows", tint: .blue)
            MetricCard(title: "Enabled", value: "\(enabled)", subtitle: "Active", tint: .green)
            MetricCard(title: "Disabled", value: "\(disabled)", subtitle: "Paused", tint: .orange)
            MetricCard(title: "Voice Ready", value: "\(voiceReady)", subtitle: "Aliases", tint: .purple)
        }
    }

    private var templatesSection: some View {
        GroupBox("Quick Templates") {
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: usesCompactLayout ? 148 : 188), spacing: 12, alignment: .leading)],
                alignment: .leading,
                spacing: 12
            ) {
                ForEach(workflowTemplateDefinitions) { template in
                    Button {
                        Task { await createTemplateWorkflow(template) }
                    } label: {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(template.name)
                                .font(.system(size: 15, weight: .semibold, design: .rounded))
                                .foregroundStyle(HBPalette.textPrimary)

                            Text(template.description)
                                .font(.caption)
                                .foregroundStyle(HBPalette.textSecondary)
                                .multilineTextAlignment(.leading)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(14)
                        .background(HBGlassBackground(cornerRadius: 20, variant: .panelSoft))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.top, 4)
        }
    }

    private var createFromTextSection: some View {
        GroupBox("Create with AI") {
            VStack(alignment: .leading, spacing: 12) {
                Text("Describe a new workflow in plain English and HomeBrain will draft it for you.")
                    .font(.caption)
                    .foregroundStyle(HBPalette.textSecondary)

                TextField(
                    "Every weekday at 6:30 AM, turn on kitchen lights and set thermostat to 71.",
                    text: $naturalLanguageText,
                    axis: .vertical
                )
                .hbPanelTextField()
                .lineLimit(3, reservesSpace: true)

                Button {
                    Task { await createFromText() }
                } label: {
                    Label(creatingFromText ? "Creating..." : "Generate Workflow", systemImage: "wand.and.stars")
                }
                .buttonStyle(HBPrimaryButtonStyle(compact: true))
                .disabled(creatingFromText || naturalLanguageText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(.top, 4)
        }
    }

    private var adminCapabilitiesNote: some View {
        GroupBox("Workflow Permissions") {
            Text("Standard users can run workflows and use command chat, while admins can create, revise, and reconfigure workflow templates.")
                .font(.caption)
                .foregroundStyle(HBPalette.textSecondary)
                .padding(.top, 4)
        }
    }

    private var commandSection: some View {
        GroupBox("Chat / Voice Command") {
            VStack(alignment: .leading, spacing: 12) {
                Text("Use the same command parser as remote voice devices to create, revise, or run workflows from text.")
                    .font(.caption)
                    .foregroundStyle(HBPalette.textSecondary)

                TextField(
                    isAdmin
                        ? #"Try: "fix the Alarm Armed workflow so it uses the Interior Lights group""#
                        : #"Try: "turn on the living room lights""#,
                    text: $chatCommand,
                    axis: .vertical
                )
                .hbPanelTextField()
                .lineLimit(2, reservesSpace: true)

                Button {
                    Task { await runChatCommand() }
                } label: {
                    Label(runningChatCommand ? "Processing..." : "Send Command", systemImage: "bubble.left.and.exclamationmark.bubble.right")
                }
                .buttonStyle(HBPrimaryButtonStyle(compact: true))
                .disabled(runningChatCommand || chatCommand.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                if !lastChatResult.isEmpty {
                    Text(lastChatResult)
                        .font(.caption)
                        .foregroundStyle(HBPalette.textSecondary)
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(HBGlassBackground(cornerRadius: 18, variant: .panelSoft))
                }
            }
            .padding(.top, 4)
        }
    }

    private var runtimeSection: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Automation Runtime")
                            .font(.system(size: 18, weight: .bold, design: .rounded))
                            .foregroundStyle(HBPalette.textPrimary)

                        Text("Live execution state, recent trigger evaluations, and detailed runtime logs for workflow-backed automations.")
                            .font(.caption)
                            .foregroundStyle(HBPalette.textSecondary)
                    }

                    Spacer()

                    Button {
                        Task { await refreshWorkflowScreen(silent: false) }
                    } label: {
                        Label(runtimeRefreshing ? "Refreshing" : "Refresh", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(HBSecondaryButtonStyle(compact: true))
                    .disabled(runtimeRefreshing)
                }

                VStack(alignment: .leading, spacing: 10) {
                    Text("Runtime Dashboard")
                        .font(.system(size: 16, weight: .semibold, design: .rounded))
                        .foregroundStyle(HBPalette.textPrimary)

                    LazyVGrid(
                        columns: [GridItem(.adaptive(minimum: usesCompactLayout ? 128 : 148), spacing: 12, alignment: .leading)],
                        alignment: .leading,
                        spacing: 12
                    ) {
                        runtimeMetricCard(title: "Running Now", value: "\(runtimeTelemetry.runningNow)", subtitle: "Live workflow executions")
                        runtimeMetricCard(title: "Logs in Range", value: "\(runtimeTelemetry.executionCount)", subtitle: "\(runtimeWindowLabel)\(runtimeTelemetry.cancelledCount > 0 ? " · \(runtimeTelemetry.cancelledCount) stopped" : "")")
                        runtimeMetricCard(title: "Succeeded", value: "\(runtimeTelemetry.successCount)", subtitle: "Completed successfully")
                        runtimeMetricCard(title: "Failed", value: "\(runtimeTelemetry.failedCount)", subtitle: "\(String(format: "%.1f", runtimeTelemetry.failureRatePct))% failure rate")
                        runtimeMetricCard(title: "Partial", value: "\(runtimeTelemetry.partialSuccessCount)", subtitle: "Completed with issues")
                        runtimeMetricCard(
                            title: "Avg Duration",
                            value: runtimeTelemetry.averageDurationMs == nil ? "No data" : formatDuration(runtimeTelemetry.averageDurationMs),
                            subtitle: runtimeTelemetry.lastCompletedAt == nil ? "Awaiting completed runs" : "Last finished \(formatDateTime(runtimeTelemetry.lastCompletedAt))"
                        )
                    }
                }

                VStack(alignment: .leading, spacing: 10) {
                    sectionHeading("Running Now", count: runningExecutions.count)

                    if runningExecutions.isEmpty {
                        EmptyStateView(
                            title: "Nothing running",
                            subtitle: "No workflow-backed automations are active right now."
                        )
                    } else {
                        ForEach(runningExecutions) { execution in
                            HBCardRow {
                                runningExecutionCard(for: execution)
                            }
                        }
                    }
                }

                VStack(alignment: .leading, spacing: 10) {
                    sectionHeading("Live Activity", count: activityEvents.count)

                    if activityEvents.isEmpty {
                        EmptyStateView(
                            title: "No runtime activity",
                            subtitle: "Automation activity will appear here as workflows trigger and run."
                        )
                    } else {
                        ForEach(activityEvents.prefix(12)) { event in
                            HBCardRow {
                                activityEventCard(for: event)
                            }
                        }
                    }
                }

                VStack(alignment: .leading, spacing: 10) {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Recent Executions")
                                    .font(.system(size: 16, weight: .semibold, design: .rounded))
                                    .foregroundStyle(HBPalette.textPrimary)

                                Text("Filter persisted runtime records by time period and how many logs appear per page.")
                                    .font(.caption2)
                                    .foregroundStyle(HBPalette.textSecondary)
                            }

                            Spacer()
                        }

                        if usesCompactLayout {
                            VStack(alignment: .leading, spacing: 10) {
                                runtimeLogFilterControls
                            }
                        } else {
                            HStack(alignment: .bottom, spacing: 12) {
                                runtimeLogFilterControls
                                Spacer()
                            }
                        }
                    }

                    if runtimeHistory.isEmpty {
                        EmptyStateView(
                            title: "No execution history",
                            subtitle: "No workflow execution history was recorded in the selected time period."
                        )
                    } else {
                        ForEach(runtimeHistory) { execution in
                            HBCardRow {
                                executionHistoryCard(for: execution)
                            }
                        }
                    }

                    HStack {
                        Text(runtimePageSummary)
                            .font(.caption)
                            .foregroundStyle(HBPalette.textSecondary)

                        Spacer()

                        Button("Previous") {
                            runtimeHistoryPage = max(1, runtimeHistoryPage - 1)
                        }
                        .buttonStyle(HBSecondaryButtonStyle(compact: true))
                        .disabled(!runtimePagination.hasPreviousPage || runtimeRefreshing)

                        Text("Page \(runtimePagination.page) of \(runtimePagination.totalPages)")
                            .font(.caption2)
                            .foregroundStyle(HBPalette.textSecondary)

                        Button("Next") {
                            runtimeHistoryPage += 1
                        }
                        .buttonStyle(HBSecondaryButtonStyle(compact: true))
                        .disabled(!runtimePagination.hasNextPage || runtimeRefreshing)
                    }
                }
            }
            .padding(.top, 4)
        } label: {
            Label("Runtime", systemImage: "waveform.path.ecg")
        }
    }

    private var workflowsSection: some View {
        GroupBox("Workflows") {
            VStack(alignment: .leading, spacing: 12) {
                if workflows.isEmpty {
                    EmptyStateView(
                        title: "No workflows",
                        subtitle: isAdmin
                            ? "Start by generating one with AI or creating one manually."
                            : "No workflows are available to run yet."
                    )
                } else {
                    ForEach(workflows) { workflow in
                        HBCardRow {
                            workflowCard(for: workflow)
                        }
                    }
                }
            }
            .padding(.top, 4)
        }
    }

    private var createSheet: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $createName)
                TextField("Description", text: $createDescription)

                Picker("Trigger", selection: $triggerType) {
                    ForEach(triggerTypes, id: \.self) { type in
                        Text(type.replacingOccurrences(of: "_", with: " ").capitalized).tag(type)
                    }
                }

                Picker("Action", selection: $actionType) {
                    ForEach(actionTypes, id: \.self) { type in
                        Text(type.replacingOccurrences(of: "_", with: " ").capitalized).tag(type)
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

    private var reviseSheet: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                if let workflowToRevise {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(workflowToRevise.name)
                            .font(.system(size: 18, weight: .bold, design: .rounded))
                            .foregroundStyle(HBPalette.textPrimary)

                        Text(workflowToRevise.details.isEmpty ? "No description provided." : workflowToRevise.details)
                            .font(.caption)
                            .foregroundStyle(HBPalette.textSecondary)
                    }
                    .padding(14)
                    .background(HBGlassBackground(cornerRadius: 20, variant: .panelSoft))
                }

                TextField(
                    #"Example: Fix this workflow so it turns off all interior Insteon lights and uses the "Interior Lights" device group when possible."#,
                    text: $revisePrompt,
                    axis: .vertical
                )
                .hbPanelTextField()
                .lineLimit(5, reservesSpace: true)

                Button {
                    Task { await reviseWorkflow() }
                } label: {
                    Label(revisingWorkflow ? "Revising..." : "Revise Workflow", systemImage: "wand.and.stars.inverse")
                }
                .buttonStyle(HBPrimaryButtonStyle())
                .disabled(revisingWorkflow || revisePrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || workflowToRevise == nil)

                Spacer(minLength: 0)
            }
            .padding()
            .navigationTitle("Revise with AI")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") {
                        showReviseSheet = false
                        workflowToRevise = nil
                        revisePrompt = ""
                    }
                }
            }
        }
    }

    private func executionLogsSheet(for execution: WorkflowExecutionHistoryItem) -> some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    LazyVGrid(
                        columns: [GridItem(.adaptive(minimum: usesCompactLayout ? 128 : 156), spacing: 12, alignment: .leading)],
                        alignment: .leading,
                        spacing: 12
                    ) {
                        runtimeMetricCard(title: "Status", value: runtimeStatusLabel(execution.status), subtitle: "")
                        runtimeMetricCard(title: "Started", value: formatDateTime(execution.startedAt), subtitle: "")
                        runtimeMetricCard(
                            title: "Duration",
                            value: execution.status == "running"
                                ? formatRunningSince(execution.startedAt)
                                : formatDuration(execution.durationMs),
                            subtitle: ""
                        )
                        runtimeMetricCard(
                            title: "Result",
                            value: execution.failedActions > 0
                                ? "\(execution.failedActions) failed"
                                : "\(execution.successfulActions) succeeded",
                            subtitle: ""
                        )
                    }

                    if let countdownText = countdownText(for: execution.currentAction) {
                        HStack(spacing: 12) {
                            runtimeMetricCard(title: "Timer Countdown", value: countdownText, subtitle: "")
                            runtimeMetricCard(title: "When Timer Ends", value: nextActionMessage(for: execution.currentAction), subtitle: "")
                        }
                    }

                    GroupBox("Execution Summary") {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Trigger: \(execution.triggerType.replacingOccurrences(of: "_", with: " ")) via \(execution.triggerSource.replacingOccurrences(of: "_", with: " "))")
                                .font(.caption)
                                .foregroundStyle(HBPalette.textSecondary)

                            if let lastEvent = execution.lastEvent?.message, !lastEvent.isEmpty {
                                Text("Latest update: \(lastEvent)")
                                    .font(.caption)
                                    .foregroundStyle(HBPalette.textSecondary)
                            }

                            if let currentAction = execution.currentAction {
                                Text("Current step: \(currentAction.message)")
                                    .font(.caption)
                                    .foregroundStyle(HBPalette.textSecondary)
                            }
                        }
                        .padding(.top, 4)
                    }

                    GroupBox("Runtime Events") {
                        VStack(alignment: .leading, spacing: 10) {
                            if loadingExecutionEvents {
                                ProgressView("Loading runtime logs...")
                                    .tint(HBPalette.accentBlue)
                            } else if selectedExecutionEvents.isEmpty {
                                EmptyStateView(
                                    title: "No detailed logs",
                                    subtitle: "No detailed runtime events were recorded for this execution."
                                )
                            } else {
                                ForEach(selectedExecutionEvents) { event in
                                    HBCardRow {
                                        activityEventCard(for: event)
                                    }
                                }
                            }
                        }
                        .padding(.top, 4)
                    }
                }
                .padding()
            }
            .navigationTitle(execution.displayName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") {
                        selectedExecution = nil
                        selectedExecutionEvents = []
                    }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button("Copy Logs") {
                        copyExecutionLogs()
                    }
                    .disabled(loadingExecutionEvents || selectedExecution == nil)
                }
            }
        }
    }

    @ViewBuilder
    private func sectionHeading(_ title: String, count: Int) -> some View {
        HStack {
            Text(title)
                .font(.system(size: 16, weight: .semibold, design: .rounded))
                .foregroundStyle(HBPalette.textPrimary)

            Spacer()

            HBBadge(
                text: "\(count)",
                foreground: HBPalette.accentBlue,
                background: HBPalette.accentBlue.opacity(0.12),
                stroke: HBPalette.accentBlue.opacity(0.65)
            )
        }
    }

    private var runtimeLogFilterControls: some View {
        Group {
            VStack(alignment: .leading, spacing: 6) {
                Text("How Many Logs")
                    .font(.caption2)
                    .foregroundStyle(HBPalette.textSecondary)
                    .textCase(.uppercase)
                    .tracking(1.1)

                Picker("How Many Logs", selection: $runtimeLogLimit) {
                    ForEach(runtimeLogLimitOptions, id: \.self) { option in
                        Text("\(option) logs").tag(option)
                    }
                }
                .pickerStyle(.menu)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Time Period")
                    .font(.caption2)
                    .foregroundStyle(HBPalette.textSecondary)
                    .textCase(.uppercase)
                    .tracking(1.1)

                Picker("Time Period", selection: $runtimeWindowHours) {
                    ForEach(Array(runtimeWindowOptions.enumerated()), id: \.offset) { _, option in
                        Text(option.label).tag(option.hours)
                    }
                }
                .pickerStyle(.menu)
            }
        }
    }

    private func runningExecutionCard(for execution: WorkflowExecutionHistoryItem) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(execution.displayName)
                        .font(.system(size: 20, weight: .bold, design: .rounded))
                        .foregroundStyle(HBPalette.textPrimary)

                    Text("Trigger: \(execution.triggerType.replacingOccurrences(of: "_", with: " ")) via \(execution.triggerSource.replacingOccurrences(of: "_", with: " "))")
                        .font(.caption)
                        .foregroundStyle(HBPalette.textSecondary)
                }

                Spacer()

                runtimeStatusBadge(execution.status)
            }

            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: usesCompactLayout ? 128 : 152), spacing: 12, alignment: .leading)],
                alignment: .leading,
                spacing: 12
            ) {
                runtimeMetricCard(title: "Started", value: execution.startedAtDisplay, subtitle: "")
                runtimeMetricCard(title: "Elapsed", value: formatRunningSince(execution.startedAt), subtitle: "")
                runtimeMetricCard(
                    title: "Current Step",
                    value: execution.currentAction?.message ?? execution.lastEvent?.message ?? "Waiting for next action",
                    subtitle: ""
                )
            }

            if let countdownText = countdownText(for: execution.currentAction) {
                HStack(spacing: 12) {
                    runtimeMetricCard(title: "Timer Countdown", value: countdownText, subtitle: "")
                    runtimeMetricCard(title: "When Timer Ends", value: nextActionMessage(for: execution.currentAction), subtitle: "")
                }
            }

            if let lastEvent = execution.lastEvent?.message, !lastEvent.isEmpty {
                Text("Latest update: \(lastEvent)")
                    .font(.caption)
                    .foregroundStyle(HBPalette.textSecondary)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(HBGlassBackground(cornerRadius: 18, variant: .panelSoft))
            }

            HStack {
                Text("Progress: \(execution.successfulActions)/\(execution.totalActions) steps finished")
                    .font(.caption)
                    .foregroundStyle(HBPalette.textSecondary)

                Spacer()

                Button("View Logs") {
                    Task { await openExecutionLogs(execution) }
                }
                .buttonStyle(HBSecondaryButtonStyle(compact: true))
            }
        }
    }

    private func activityEventCard(for event: PlatformEventItem) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(activitySummary(for: event))
                        .font(.system(size: 15, weight: .semibold, design: .rounded))
                        .foregroundStyle(HBPalette.textPrimary)

                    Text("\(event.source) · #\(event.sequence) · \(event.createdAt)")
                        .font(.caption2)
                        .foregroundStyle(HBPalette.textSecondary)
                }

                Spacer()

                severityBadge(for: event.severity)
            }

            if let payloadMessage = event.payloadMessage, !payloadMessage.isEmpty {
                Text(payloadMessage)
                    .font(.caption)
                    .foregroundStyle(HBPalette.textSecondary)
            }
        }
    }

    private func executionHistoryCard(for execution: WorkflowExecutionHistoryItem) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(execution.displayName)
                        .font(.system(size: 18, weight: .bold, design: .rounded))
                        .foregroundStyle(HBPalette.textPrimary)

                    Text(execution.automationName)
                        .font(.caption)
                        .foregroundStyle(HBPalette.textSecondary)
                }

                Spacer()

                runtimeStatusBadge(execution.status)
            }

            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: usesCompactLayout ? 128 : 152), spacing: 12, alignment: .leading)],
                alignment: .leading,
                spacing: 12
            ) {
                runtimeMetricCard(title: "Trigger", value: execution.triggerType.replacingOccurrences(of: "_", with: " "), subtitle: "")
                runtimeMetricCard(title: "Started", value: execution.startedAtDisplay, subtitle: "")
                runtimeMetricCard(
                    title: "Duration",
                    value: execution.status == "running"
                        ? formatRunningSince(execution.startedAt)
                        : formatDuration(execution.durationMs),
                    subtitle: ""
                )
                runtimeMetricCard(
                    title: "Result",
                    value: execution.lastEvent?.message ?? (execution.failedActions > 0
                        ? "\(execution.failedActions) step(s) failed"
                        : "\(execution.successfulActions) step(s) succeeded"),
                    subtitle: ""
                )
            }

            HStack {
                Spacer()

                Button("View Logs") {
                    Task { await openExecutionLogs(execution) }
                }
                .buttonStyle(HBSecondaryButtonStyle(compact: true))
            }
        }
    }

    private func workflowCard(for workflow: WorkflowItem) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(workflow.name)
                        .font(.system(size: 20, weight: .bold, design: .rounded))
                        .foregroundStyle(HBPalette.textPrimary)

                    Text(workflow.details.isEmpty ? "No description provided." : workflow.details)
                        .font(.caption)
                        .foregroundStyle(HBPalette.textSecondary)
                }

                Spacer()

                VStack(alignment: .trailing, spacing: 8) {
                    if workflowIdsRunning.contains(workflow.id) {
                        HBBadge(
                            text: "Running",
                            foreground: HBPalette.accentBlue,
                            background: HBPalette.accentBlue.opacity(0.12),
                            stroke: HBPalette.accentBlue.opacity(0.7)
                        )
                    }

                    Toggle("", isOn: Binding(
                        get: { workflow.enabled },
                        set: { value in
                            Task { await toggle(workflow, enabled: value) }
                        }
                    ))
                    .labelsHidden()
                    .disabled(!isAdmin)
                }
            }

            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: usesCompactLayout ? 120 : 150), spacing: 12, alignment: .leading)],
                alignment: .leading,
                spacing: 12
            ) {
                runtimeMetricCard(title: "Trigger", value: workflow.triggerType.replacingOccurrences(of: "_", with: " "), subtitle: "")
                runtimeMetricCard(title: "Steps", value: "\(workflow.actionCount)", subtitle: "")
                runtimeMetricCard(title: "Last Run", value: workflow.lastRun, subtitle: "")
                runtimeMetricCard(title: "Runs", value: "\(workflow.executionCount)", subtitle: "")
            }

            if workflow.voiceAliases.isEmpty {
                Text("No voice alias set yet.")
                    .font(.caption)
                    .foregroundStyle(HBPalette.textSecondary)
            } else {
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: 110), spacing: 8, alignment: .leading)],
                    alignment: .leading,
                    spacing: 8
                ) {
                    ForEach(workflow.voiceAliases, id: \.self) { alias in
                        HBBadge(
                            text: alias,
                            foreground: HBPalette.textPrimary,
                            background: HBPalette.panelSoft.opacity(0.92),
                            stroke: HBPalette.panelStrokeStrong
                        )
                    }
                }
            }

            if let lastErrorMessage = workflow.lastErrorMessage, !lastErrorMessage.isEmpty {
                Text("Last error: \(lastErrorMessage)")
                    .font(.caption)
                    .foregroundStyle(HBPalette.accentRed)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(HBPalette.accentRed.opacity(0.08), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            }

            HStack(spacing: 10) {
                Button("Run Now") {
                    Task { await execute(workflow) }
                }
                .buttonStyle(HBPrimaryButtonStyle(compact: true))

                if isAdmin {
                    Button("Edit") {
                        beginEditing(workflow)
                    }
                    .buttonStyle(HBSecondaryButtonStyle(compact: true))

                    Button("AI Revise") {
                        workflowToRevise = workflow
                        revisePrompt = ""
                        showReviseSheet = true
                    }
                    .buttonStyle(HBSecondaryButtonStyle(compact: true))

                    Button("Clone") {
                        Task { await cloneWorkflow(workflow) }
                    }
                    .buttonStyle(HBSecondaryButtonStyle(compact: true))

                    Button("Delete") {
                        workflowPendingDelete = workflow
                    }
                    .buttonStyle(HBSecondaryButtonStyle(compact: true))
                }
            }
        }
    }

    private func runtimeMetricCard(title: String, value: String, subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption2)
                .foregroundStyle(HBPalette.textSecondary)
                .textCase(.uppercase)
                .tracking(1.2)

            Text(value)
                .font(.system(size: 14, weight: .semibold, design: .rounded))
                .foregroundStyle(HBPalette.textPrimary)

            if !subtitle.isEmpty {
                Text(subtitle)
                    .font(.caption2)
                    .foregroundStyle(HBPalette.textSecondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(HBGlassBackground(cornerRadius: 18, variant: .panelSoft))
    }

    private func runtimeStatusBadge(_ status: String) -> some View {
        let palette = runtimeStatusPalette(for: status)
        return HBBadge(
            text: runtimeStatusLabel(status),
            foreground: palette.foreground,
            background: palette.background,
            stroke: palette.stroke
        )
    }

    private func severityBadge(for severity: String) -> some View {
        let palette: (foreground: Color, background: Color, stroke: Color)
        switch severity {
        case "error":
            palette = (HBPalette.accentRed, HBPalette.accentRed.opacity(0.14), HBPalette.accentRed.opacity(0.68))
        case "warn":
            palette = (HBPalette.accentOrange, HBPalette.accentOrange.opacity(0.14), HBPalette.accentOrange.opacity(0.68))
        default:
            palette = (HBPalette.accentBlue, HBPalette.accentBlue.opacity(0.14), HBPalette.accentBlue.opacity(0.68))
        }

        return HBBadge(
            text: severity,
            foreground: palette.foreground,
            background: palette.background,
            stroke: palette.stroke
        )
    }

    private func runtimeStatusPalette(for status: String) -> (foreground: Color, background: Color, stroke: Color) {
        switch status {
        case "success":
            return (HBPalette.accentGreen, HBPalette.accentGreen.opacity(0.14), HBPalette.accentGreen.opacity(0.68))
        case "partial_success":
            return (HBPalette.accentOrange, HBPalette.accentOrange.opacity(0.14), HBPalette.accentOrange.opacity(0.68))
        case "failed":
            return (HBPalette.accentRed, HBPalette.accentRed.opacity(0.14), HBPalette.accentRed.opacity(0.68))
        case "cancelled":
            return (HBPalette.accentSlate, HBPalette.accentSlate.opacity(0.14), HBPalette.accentSlate.opacity(0.68))
        default:
            return (HBPalette.accentBlue, HBPalette.accentBlue.opacity(0.14), HBPalette.accentBlue.opacity(0.68))
        }
    }

    private var selectedExecutionSheetBinding: Binding<Bool> {
        Binding(
            get: { selectedExecution != nil },
            set: { open in
                if !open {
                    selectedExecution = nil
                    selectedExecutionEvents = []
                }
            }
        )
    }

    private func workflowDeleteAlertBinding() -> Binding<Bool> {
        Binding(
            get: { workflowPendingDelete != nil },
            set: { open in
                if !open {
                    workflowPendingDelete = nil
                }
            }
        )
    }

    private func refreshWorkflowScreen(silent: Bool) async {
        if !silent {
            isLoading = workflows.isEmpty
            runtimeRefreshing = true
            errorMessage = nil
        }

        do {
            async let workflowsTask = session.apiClient.get("/api/workflows")
            async let statsTask = session.apiClient.get("/api/workflows/stats")
            async let runningTask = session.apiClient.get("/api/workflows/running", query: [URLQueryItem(name: "limit", value: "20")])
            async let historyTask = session.apiClient.get("/api/workflows/runtime-history", query: [
                URLQueryItem(name: "limit", value: "\(runtimeLogLimit)"),
                URLQueryItem(name: "page", value: "\(runtimeHistoryPage)"),
                URLQueryItem(name: "hours", value: "\(runtimeWindowHours)")
            ])
            async let telemetryTask = session.apiClient.get("/api/workflows/runtime-telemetry", query: [
                URLQueryItem(name: "hours", value: "\(runtimeWindowHours)")
            ])
            async let eventsTask = session.apiClient.get("/api/events/latest", query: [
                URLQueryItem(name: "limit", value: "80"),
                URLQueryItem(name: "category", value: "automation")
            ])

            let workflowsResponse = try await workflowsTask
            let statsResponse = try await statsTask
            let runningResponse = try await runningTask
            let historyResponse = try await historyTask
            let telemetryResponse = try await telemetryTask
            let eventsResponse = try await eventsTask

            workflows = JSON.array(JSON.object(workflowsResponse)["workflows"])
                .map(WorkflowItem.from)
                .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            stats = JSON.object(JSON.object(statsResponse)["stats"])
            runningExecutions = JSON.array(JSON.object(runningResponse)["executions"]).map(WorkflowExecutionHistoryItem.from)
            runtimeHistory = JSON.array(JSON.object(historyResponse)["history"]).map(WorkflowExecutionHistoryItem.from)
            runtimePagination = WorkflowRuntimePaginationItem.from(JSON.object(JSON.object(historyResponse)["pagination"]))
            runtimeTelemetry = WorkflowRuntimeTelemetryItem.from(JSON.object(JSON.object(telemetryResponse)["telemetry"]))
            activityEvents = JSON.array(JSON.object(eventsResponse)["events"])
                .map(PlatformEventItem.from)
                .sorted { $0.sequence > $1.sequence }

            if runtimePagination.page != runtimeHistoryPage {
                runtimeHistoryPage = runtimePagination.page
            }

            if let selectedExecution {
                if let refreshed = (runningExecutions + runtimeHistory).first(where: { $0.id == selectedExecution.id }) {
                    self.selectedExecution = refreshed
                }

                if !loadingExecutionEvents {
                    await refreshSelectedExecutionEvents()
                }
            }
        } catch {
            if !silent || workflows.isEmpty {
                errorMessage = error.localizedDescription
            }
        }

        isLoading = false
        runtimeRefreshing = false
    }

    private func refreshSelectedExecutionEvents() async {
        guard let selectedExecution else {
            return
        }

        guard let correlationId = selectedExecution.correlationId,
              !correlationId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            selectedExecutionEvents = []
            loadingExecutionEvents = false
            return
        }

        do {
            let response = try await session.apiClient.get("/api/events/latest", query: [
                URLQueryItem(name: "limit", value: "200"),
                URLQueryItem(name: "category", value: "automation"),
                URLQueryItem(name: "correlationId", value: correlationId)
            ])
            selectedExecutionEvents = JSON.array(JSON.object(response)["events"])
                .map(PlatformEventItem.from)
                .sorted { $0.sequence < $1.sequence }
        } catch {
            errorMessage = error.localizedDescription
        }

        loadingExecutionEvents = false
    }

    private func openExecutionLogs(_ execution: WorkflowExecutionHistoryItem) async {
        selectedExecution = execution
        selectedExecutionEvents = []
        loadingExecutionEvents = true
        await refreshSelectedExecutionEvents()
    }

    private func copyExecutionLogs() {
        guard let selectedExecution else {
            return
        }

        let lines: [String] = [
            "HomeBrain Automation Runtime Logs",
            "Copied: \(DateFormatter.localizedString(from: Date(), dateStyle: .short, timeStyle: .short))",
            "",
            "Execution Summary",
            "Workflow: \(selectedExecution.displayName)",
            "Automation: \(selectedExecution.automationName)",
            "Execution ID: \(selectedExecution.id)",
            "Status: \(runtimeStatusLabel(selectedExecution.status))",
            "Trigger Type: \(selectedExecution.triggerType.replacingOccurrences(of: "_", with: " "))",
            "Trigger Source: \(selectedExecution.triggerSource.replacingOccurrences(of: "_", with: " "))",
            "Started: \(formatDateTime(selectedExecution.startedAt))",
            "Completed: \(formatDateTime(selectedExecution.completedAt))",
            "Duration: \(selectedExecution.status == "running" ? formatRunningSince(selectedExecution.startedAt) : formatDuration(selectedExecution.durationMs))",
            "Successful Actions: \(selectedExecution.successfulActions)",
            "Failed Actions: \(selectedExecution.failedActions)",
            "Total Actions: \(selectedExecution.totalActions)",
            selectedExecution.currentAction == nil ? "" : "\nCurrent Action\n\(JSON.prettyString(selectedExecution.currentAction?.message))",
            selectedExecution.currentAction == nil ? "" : "Next Action: \(nextActionMessage(for: selectedExecution.currentAction))",
            selectedExecution.currentAction == nil ? "" : "Timer Remaining: \(countdownText(for: selectedExecution.currentAction) ?? "No active timer")",
            selectedExecution.errorDetails.isEmpty ? "" : "\nExecution Error\n\(JSON.prettyString(selectedExecution.errorDetails))",
            selectedExecution.actionResults.isEmpty ? "" : "\nAction Results\n\(JSON.prettyString(selectedExecution.actionResults))",
            "",
            "Event Stream Logs (\(selectedExecutionEvents.count))"
        ]

        let eventLines = selectedExecutionEvents.flatMap { event in
            [
                "",
                "#\(event.sequence) \(event.type)",
                "Created: \(event.createdAt)",
                "Severity: \(event.severity)",
                "Source: \(event.source)",
                "Category: \(event.category)",
                "Correlation ID: \(event.correlationId ?? "None")",
                "Summary: \(activitySummary(for: event))",
                "Payload:",
                JSON.prettyString(event.payload)
            ]
        }

        let finalText = (lines + eventLines + ["", "Raw Execution Record JSON", JSON.prettyString(selectedExecution.rawObject)])
            .filter { !$0.isEmpty || $0 == "" }
            .joined(separator: "\n")

        UIPasteboard.general.string = finalText
    }

    private func createTemplateWorkflow(_ template: WorkflowTemplateDefinition) async {
        do {
            let response = try await session.apiClient.post("/api/workflows", body: template.build())
            let object = JSON.object(response)
            let created = WorkflowItem.from(JSON.object(object["workflow"]))
            workflows.insert(created, at: 0)
            workflows.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            await refreshWorkflowScreen(silent: true)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func createFromText() async {
        let text = naturalLanguageText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        creatingFromText = true
        defer { creatingFromText = false }

        do {
            let payload: [String: Any] = ["text": text, "source": "chat"]
            let response = try await session.apiClient.post("/api/workflows/create-from-text", body: payload)
            let object = JSON.object(response)

            if JSON.bool(object, "handledDirectCommand") {
                lastChatResult = JSON.string(object, "message", fallback: "Command handled directly.")
            } else {
                let createdWorkflows = JSON.array(object["workflows"]).map(WorkflowItem.from)
                if !createdWorkflows.isEmpty {
                    workflows.insert(contentsOf: createdWorkflows, at: 0)
                } else if object["workflow"] != nil {
                    workflows.insert(WorkflowItem.from(JSON.object(object["workflow"])), at: 0)
                }
            }

            naturalLanguageText = ""
            await refreshWorkflowScreen(silent: true)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func reviseWorkflow() async {
        let text = revisePrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let workflowToRevise, !text.isEmpty else { return }

        revisingWorkflow = true
        defer { revisingWorkflow = false }

        do {
            let payload: [String: Any] = ["text": text, "source": "chat"]
            let response = try await session.apiClient.post("/api/workflows/\(workflowToRevise.id)/revise-from-text", body: payload)
            let object = JSON.object(response)
            let updated = WorkflowItem.from(JSON.object(object["workflow"]))

            if let index = workflows.firstIndex(where: { $0.id == updated.id }) {
                workflows[index] = updated
            }

            showReviseSheet = false
            self.workflowToRevise = nil
            revisePrompt = ""
            await refreshWorkflowScreen(silent: true)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func runChatCommand() async {
        let text = chatCommand.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        runningChatCommand = true
        defer { runningChatCommand = false }

        do {
            let payload: [String: Any] = [
                "commandText": text,
                "wakeWord": "dashboard",
                "room": NSNull()
            ]
            let response = try await session.apiClient.post("/api/voice/commands/interpret", body: payload)
            let object = JSON.object(response)
            lastChatResult = JSON.string(object, "responseText", fallback: "Command processed.")
            chatCommand = ""
            await refreshWorkflowScreen(silent: true)
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

            _ = try await session.apiClient.post("/api/workflows", body: payload)
            showCreateSheet = false
            resetWorkflowEditor()
            await refreshWorkflowScreen(silent: false)
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

            _ = try await session.apiClient.put("/api/workflows/\(workflow.id)", body: payload)
            showCreateSheet = false
            resetWorkflowEditor()
            await refreshWorkflowScreen(silent: false)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func toggle(_ workflow: WorkflowItem, enabled: Bool) async {
        guard isAdmin else { return }

        do {
            let payload: [String: Any] = ["enabled": enabled]
            let response = try await session.apiClient.put("/api/workflows/\(workflow.id)/toggle", body: payload)
            let updated = WorkflowItem.from(JSON.object(JSON.object(response)["workflow"]))
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
            await refreshWorkflowScreen(silent: false)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func delete(_ workflow: WorkflowItem) async {
        do {
            _ = try await session.apiClient.delete("/api/workflows/\(workflow.id)")
            workflows.removeAll { $0.id == workflow.id }
            workflowPendingDelete = nil
            await refreshWorkflowScreen(silent: true)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func cloneWorkflow(_ workflow: WorkflowItem) async {
        do {
            let response = try await session.apiClient.get("/api/workflows/\(workflow.id)")
            let source = JSON.object(JSON.object(response)["workflow"])

            let payload: [String: Any] = [
                "name": "\(workflow.name) Copy",
                "description": JSON.string(source, "description"),
                "source": "import",
                "enabled": JSON.bool(source, "enabled", fallback: true),
                "category": JSON.string(source, "category", fallback: "custom"),
                "priority": JSON.int(source, "priority", fallback: 5),
                "cooldown": JSON.int(source, "cooldown"),
                "trigger": JSON.object(source["trigger"]),
                "actions": JSON.array(source["actions"]),
                "graph": JSON.object(source["graph"]),
                "voiceAliases": (source["voiceAliases"] as? [String]) ?? []
            ]

            _ = try await session.apiClient.post("/api/workflows", body: payload)
            await refreshWorkflowScreen(silent: false)
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
        target = ""
        actionValue = ""
        triggerType = workflow.triggerType
        actionType = "notification"
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

    private func activitySummary(for event: PlatformEventItem) -> String {
        let workflowName = JSON.optionalString(event.payload, "workflowName") ?? ""
        let automationName = JSON.optionalString(event.payload, "automationName") ?? ""
        let name = !workflowName.isEmpty ? workflowName : (!automationName.isEmpty ? automationName : "Automation")

        switch event.type {
        case "automation.trigger.security_alarm_evaluated":
            let currentState = JSON.string(event.payload, "currentState", fallback: "unknown")
            let configuredStates = (event.payload["configuredStates"] as? [String])?.joined(separator: ", ") ?? "none"
            return "\(name): alarm state \(currentState), watching \(configuredStates)"
        case "automation.trigger.skipped":
            return "\(name): trigger skipped"
        case "automation.trigger.matched":
            return "\(name): trigger matched"
        case "automation.execution.started":
            return "\(name): execution started"
        case "automation.execution.completed":
            let status = JSON.string(event.payload, "status", fallback: "finished").replacingOccurrences(of: "_", with: " ")
            return "\(name): execution \(status)"
        case "automation.action.started", "automation.action.completed", "automation.action.failed":
            let actionType = JSON.string(event.payload, "actionType", fallback: "action").replacingOccurrences(of: "_", with: " ")
            return "\(name): \(actionType)"
        default:
            return "\(name): \(event.type)"
        }
    }

    private func runtimeStatusLabel(_ status: String) -> String {
        switch status {
        case "success":
            return "Success"
        case "partial_success":
            return "Partial"
        case "failed":
            return "Failed"
        case "cancelled":
            return "Stopped"
        default:
            return "Running"
        }
    }

    private func formatDateTime(_ value: String?) -> String {
        JSON.displayDate(from: value)
    }

    private func formatDuration(_ durationMs: Double?) -> String {
        guard let durationMs, durationMs >= 0 else {
            return "In progress"
        }

        if durationMs < 1000 {
            return "\(Int(durationMs.rounded())) ms"
        }

        let totalSeconds = Int((durationMs / 1000).rounded())
        if totalSeconds < 60 {
            return "\(totalSeconds)s"
        }

        let minutes = totalSeconds / 60
        let seconds = totalSeconds % 60
        if minutes < 60 {
            return seconds > 0 ? "\(minutes)m \(seconds)s" : "\(minutes)m"
        }

        let hours = minutes / 60
        let remainingMinutes = minutes % 60
        return remainingMinutes > 0 ? "\(hours)h \(remainingMinutes)m" : "\(hours)h"
    }

    private func formatRunningSince(_ startedAt: String?) -> String {
        guard let startedDate = JSON.date(from: startedAt) else {
            return "Just now"
        }

        return formatDuration(now.timeIntervalSince(startedDate) * 1000)
    }

    private func countdownMilliseconds(for currentAction: WorkflowCurrentActionItem?) -> Double? {
        guard let currentAction else {
            return nil
        }

        if let endsAt = currentAction.timer?.endsAtDate {
            return max(0, endsAt.timeIntervalSince(now) * 1000)
        }

        if let startedAt = currentAction.startedAtDate,
           let durationMs = currentAction.timer?.durationMs {
            let endsAt = startedAt.addingTimeInterval(durationMs / 1000)
            return max(0, endsAt.timeIntervalSince(now) * 1000)
        }

        return nil
    }

    private func countdownText(for currentAction: WorkflowCurrentActionItem?) -> String? {
        guard let remainingMs = countdownMilliseconds(for: currentAction) else {
            return nil
        }

        let totalSeconds = max(0, Int(ceil(remainingMs / 1000)))
        if totalSeconds < 60 {
            return "\(totalSeconds)s"
        }

        let minutes = totalSeconds / 60
        let seconds = totalSeconds % 60
        if minutes < 60 {
            return String(format: "%dm %02ds", minutes, seconds)
        }

        let hours = minutes / 60
        let remainingMinutes = minutes % 60
        return String(format: "%dh %02dm", hours, remainingMinutes)
    }

    private func nextActionMessage(for currentAction: WorkflowCurrentActionItem?) -> String {
        if let message = currentAction?.nextAction?.message, !message.isEmpty {
            return message
        }

        if let actionType = currentAction?.nextAction?.actionType, !actionType.isEmpty {
            return actionType.replacingOccurrences(of: "_", with: " ").capitalized
        }

        return "Workflow completes"
    }
}
