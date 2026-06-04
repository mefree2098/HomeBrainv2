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

private enum WorkflowStudioTab: String, CaseIterable, Identifiable {
    case overview
    case workflows
    case logs

    var id: String { rawValue }

    var title: String {
        rawValue.capitalized
    }
}

private enum WorkflowEditorError: LocalizedError {
    case invalidJSON(String)

    var errorDescription: String? {
        switch self {
        case .invalidJSON(let label):
            return "\(label) must be valid JSON."
        }
    }
}

private enum WorkflowTriggerPropertyKind {
    case boolean
    case number
    case string
}

private struct WorkflowTriggerPropertyOption: Identifiable {
    let key: String
    let label: String
    let kind: WorkflowTriggerPropertyKind
    let unit: String?
    let batteryMetric: Bool
    let energyMetric: Bool

    var id: String { key }

    init(
        key: String,
        label: String,
        kind: WorkflowTriggerPropertyKind,
        unit: String? = nil,
        batteryMetric: Bool = false,
        energyMetric: Bool = false
    ) {
        self.key = key
        self.label = label
        self.kind = kind
        self.unit = unit
        self.batteryMetric = batteryMetric
        self.energyMetric = energyMetric
    }
}

struct WorkflowsView: View {
    @EnvironmentObject private var session: SessionStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    @State private var workflows: [WorkflowItem] = []
    @State private var devices: [DeviceItem] = []
    @State private var stats: [String: Any] = [:]
    @State private var runningExecutions: [WorkflowExecutionHistoryItem] = []
    @State private var runtimeHistory: [WorkflowExecutionHistoryItem] = []
    @State private var runtimeTelemetry = WorkflowRuntimeTelemetryItem.empty
    @State private var runtimePagination = WorkflowRuntimePaginationItem.empty
    @State private var activityEvents: [PlatformEventItem] = []

    @State private var isLoading = true
    @State private var isWorkflowScreenRefreshInFlight = false
    @State private var runtimeRefreshing = false
    @State private var errorMessage: String?

    @State private var showCreateSheet = false
    @State private var showReviseSheet = false
    @State private var selectedExecution: WorkflowExecutionHistoryItem?
    @State private var selectedExecutionEvents: [PlatformEventItem] = []
    @State private var loadingExecutionEvents = false
    @State private var executionPendingStop: WorkflowExecutionHistoryItem?
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
    @State private var selectedTab: WorkflowStudioTab = .overview
    @State private var stoppingExecutionIds: Set<String> = []

    @State private var createName = ""
    @State private var createDescription = ""
    @State private var triggerType = "manual"
    @State private var actionType = "notification"
    @State private var target = ""
    @State private var actionValue = ""
    @State private var createCategory = "custom"
    @State private var createPriority = 5
    @State private var createCooldown = 0
    @State private var triggerDeviceId = ""
    @State private var triggerDeviceSearch = ""
    @State private var triggerDeviceSource = DeviceItem.allSelectionSourcesValue
    @State private var triggerProperty = "status"
    @State private var triggerOperator = "eq"
    @State private var triggerValue = "true"
    @State private var triggerHoldSeconds = 0
    @State private var triggerTime = "07:00"
    @State private var triggerScheduleCron = "0 7 * * 1-5"
    @State private var triggerAlarmStates = "armedStay, armedAway"
    @State private var delaySeconds = 0
    @State private var deviceActionName = "turn_off"
    @State private var targetDeviceSearch = ""
    @State private var targetDeviceSource = DeviceItem.allSelectionSourcesValue
    @State private var useTriggeringDeviceTarget = true
    @State private var useAdvancedTriggerJSON = false
    @State private var useAdvancedActionsJSON = false
    @State private var triggerConditionsJSON = "{}"
    @State private var actionsJSON = "[]"
    @State private var editingWorkflow: WorkflowItem?

    @State private var now = Date()

    private let triggerTypes = ["manual", "time", "schedule", "device_state", "sensor", "security_alarm_status"]
    private let actionTypes = ["notification", "device_control", "scene_activate", "delay", "condition", "workflow_control", "variable_control", "repeat", "isy_network_resource", "http_request"]
    private let triggerOperators = ["eq", "neq", "gt", "gte", "lt", "lte", "contains"]
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

    private var sortedDevices: [DeviceItem] {
        devices.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    private var filteredTriggerDevices: [DeviceItem] {
        sortedDevices.filter {
            $0.matchesSelectionFilters(searchText: triggerDeviceSearch, sourceFilter: triggerDeviceSource)
        }
    }

    private var selectedTriggerDevice: DeviceItem? {
        devices.first { $0.id == triggerDeviceId }
    }

    private var currentTriggerPropertyOptions: [WorkflowTriggerPropertyOption] {
        var options = triggerPropertyOptions(for: selectedTriggerDevice)
        let current = triggerProperty.trimmingCharacters(in: .whitespacesAndNewlines)
        if !current.isEmpty, !options.contains(where: { $0.key == current }) {
            options.append(WorkflowTriggerPropertyOption(
                key: current,
                label: "Custom: \(current)",
                kind: .string
            ))
        }
        return options
    }

    private var triggerPropertySelection: Binding<String> {
        Binding(
            get: { triggerProperty },
            set: { newValue in
                triggerProperty = newValue
                applyTriggerPropertyDefaults(for: newValue)
            }
        )
    }

    private var filteredTargetDevices: [DeviceItem] {
        sortedDevices.filter {
            $0.matchesSelectionFilters(searchText: targetDeviceSearch, sourceFilter: targetDeviceSource)
        }
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

                    Picker("Workflow Section", selection: $selectedTab) {
                        ForEach(WorkflowStudioTab.allCases) { tab in
                            Text(tab.title).tag(tab)
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .accessibilityLabel("Workflow studio sections")

                    selectedTabContent
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
        .confirmationDialog(
            executionPendingStop == nil ? "Stop workflow execution?" : "Stop \(executionPendingStop?.displayName ?? "workflow")?",
            isPresented: stopExecutionConfirmationBinding(),
            titleVisibility: .visible,
            presenting: executionPendingStop
        ) { execution in
            Button("Stop Workflow", role: .destructive) {
                Task { await stop(execution) }
            }
            .disabled(stoppingExecutionIds.contains(execution.id))
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("This requests that HomeBrain stop the running workflow and records the stop request in the runtime logs.")
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
        .onChange(of: runtimeLogLimit) { _, _ in
            handleRuntimeLogLimitChange()
        }
        .onChange(of: runtimeWindowHours) { _, _ in
            handleRuntimeWindowChange()
        }
        .onChange(of: runtimeHistoryPage) { _, _ in
            handleRuntimeHistoryPageChange()
        }
        .onChange(of: triggerDeviceId) { _, _ in
            normalizeTriggerPropertyForSelectedDevice()
        }
    }

    @ViewBuilder
    private var selectedTabContent: some View {
        switch selectedTab {
        case .overview:
            metricsSection

            if isAdmin {
                templatesSection
                createFromTextSection
            } else {
                adminCapabilitiesNote
            }

            commandSection

        case .workflows:
            workflowsSection

        case .logs:
            runtimeSection
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
                                .font(HBTypography.body(size: 15, weight: .semibold))
                                .foregroundStyle(HBPalette.textPrimary)

                            Text(template.description)
                                .font(HBTypography.body(.caption))
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
                    .font(HBTypography.body(.caption))
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
                .font(HBTypography.body(.caption))
                .foregroundStyle(HBPalette.textSecondary)
                .padding(.top, 4)
        }
    }

    private var commandSection: some View {
        GroupBox("Chat / Voice Command") {
            VStack(alignment: .leading, spacing: 12) {
                Text("Use the same command parser as remote voice devices to create, revise, or run workflows from text.")
                    .font(HBTypography.body(.caption))
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
                        .font(HBTypography.body(.caption))
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
                            .font(HBTypography.display(size: 18, weight: .bold))
                            .foregroundStyle(HBPalette.textPrimary)

                        Text("Live execution state, recent trigger evaluations, and detailed runtime logs for workflow-backed automations.")
                            .font(HBTypography.body(.caption))
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
                        .font(HBTypography.body(size: 16, weight: .semibold))
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
                                    .font(HBTypography.body(size: 16, weight: .semibold))
                                    .foregroundStyle(HBPalette.textPrimary)

                                Text("Filter persisted runtime records by time period and how many logs appear per page.")
                                    .font(HBTypography.body(.caption2))
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
                            .font(HBTypography.body(.caption))
                            .foregroundStyle(HBPalette.textSecondary)

                        Spacer()

                        Button("Previous") {
                            runtimeHistoryPage = max(1, runtimeHistoryPage - 1)
                        }
                        .buttonStyle(HBSecondaryButtonStyle(compact: true))
                        .disabled(!runtimePagination.hasPreviousPage || runtimeRefreshing)

                        Text("Page \(runtimePagination.page) of \(runtimePagination.totalPages)")
                            .font(HBTypography.body(.caption2))
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
                Section("Basics") {
                    TextField("Name", text: $createName)
                    TextField("Description", text: $createDescription, axis: .vertical)
                        .lineLimit(2, reservesSpace: true)

                    Picker("Category", selection: $createCategory) {
                        ForEach(categories, id: \.self) { category in
                            Text(category.capitalized).tag(category)
                        }
                    }

                    Stepper("Priority: \(createPriority)", value: $createPriority, in: 1...10)
                    Stepper("Cooldown: \(createCooldown) min", value: $createCooldown, in: 0...1440)
                }

                Section("Trigger") {
                    Picker("Trigger", selection: $triggerType) {
                        ForEach(triggerTypes, id: \.self) { type in
                            Text(type.replacingOccurrences(of: "_", with: " ").capitalized).tag(type)
                        }
                    }

                    if triggerType == "time" {
                        TextField("Time (HH:mm)", text: $triggerTime)
                            .textInputAutocapitalization(.never)
                    } else if triggerType == "schedule" {
                        TextField("Cron", text: $triggerScheduleCron)
                            .textInputAutocapitalization(.never)
                    } else if triggerType == "device_state" || triggerType == "sensor" {
                        TextField("Search devices", text: $triggerDeviceSearch)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Picker("Source", selection: $triggerDeviceSource) {
                            ForEach(DeviceItem.selectionSourceOptions(for: sortedDevices)) { option in
                                Text(option.label).tag(option.value)
                            }
                        }
                        Picker("Device", selection: $triggerDeviceId) {
                            Text("Select a device").tag("")
                            ForEach(filteredTriggerDevices) { device in
                                Text("\(device.name) · \(device.room) · \(device.selectionSourceLabel)").tag(device.id)
                            }
                        }
                        if currentTriggerPropertyOptions.isEmpty {
                            TextField("Property", text: $triggerProperty)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                        } else {
                            Picker("Property", selection: triggerPropertySelection) {
                                ForEach(currentTriggerPropertyOptions) { option in
                                    Text(option.label).tag(option.key)
                                }
                            }
                        }
                        Picker("Operator", selection: $triggerOperator) {
                            ForEach(triggerOperators, id: \.self) { item in
                                Text(item).tag(item)
                            }
                        }
                        TextField("Value", text: $triggerValue)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Stepper("Hold: \(triggerHoldSeconds) sec", value: $triggerHoldSeconds, in: 0...86400)
                    } else if triggerType == "security_alarm_status" {
                        TextField("Alarm states", text: $triggerAlarmStates)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }

                    Toggle("Raw trigger JSON", isOn: $useAdvancedTriggerJSON)
                    if useAdvancedTriggerJSON {
                        TextField("Trigger conditions JSON", text: $triggerConditionsJSON, axis: .vertical)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .lineLimit(4, reservesSpace: true)
                    }
                }

                Section("Actions") {
                    Stepper("Delay before action: \(delaySeconds) sec", value: $delaySeconds, in: 0...86400)

                    Picker("Action", selection: $actionType) {
                        ForEach(actionTypes, id: \.self) { type in
                            Text(type.replacingOccurrences(of: "_", with: " ").capitalized).tag(type)
                        }
                    }

                    if actionType == "device_control" {
                        Toggle("Use triggering device", isOn: $useTriggeringDeviceTarget)
                        if !useTriggeringDeviceTarget {
                            TextField("Search devices", text: $targetDeviceSearch)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                            Picker("Source", selection: $targetDeviceSource) {
                                ForEach(DeviceItem.selectionSourceOptions(for: sortedDevices)) { option in
                                    Text(option.label).tag(option.value)
                                }
                            }
                            Picker("Device", selection: $target) {
                                Text("Select a device").tag("")
                                ForEach(filteredTargetDevices) { device in
                                    Text("\(device.name) · \(device.room) · \(device.selectionSourceLabel)").tag(device.id)
                                }
                            }
                        }
                        TextField("Device action", text: $deviceActionName)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }

                    if actionType != "device_control" && (actionType != "delay" || delaySeconds == 0) {
                        TextField("Target", text: $target)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }

                    if actionType != "delay" || delaySeconds == 0 {
                        TextField("Value", text: $actionValue, axis: .vertical)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .lineLimit(2, reservesSpace: true)
                    }

                    Toggle("Raw actions JSON", isOn: $useAdvancedActionsJSON)
                    if useAdvancedActionsJSON {
                        TextField("Actions JSON", text: $actionsJSON, axis: .vertical)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .lineLimit(6, reservesSpace: true)
                    }
                }
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
                            .font(HBTypography.display(size: 18, weight: .bold))
                            .foregroundStyle(HBPalette.textPrimary)

                        Text(workflowToRevise.details.isEmpty ? "No description provided." : workflowToRevise.details)
                            .font(HBTypography.body(.caption))
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
                                .font(HBTypography.body(.caption))
                                .foregroundStyle(HBPalette.textSecondary)

                            if let lastEvent = execution.lastEvent?.message, !lastEvent.isEmpty {
                                Text("Latest update: \(lastEvent)")
                                    .font(HBTypography.body(.caption))
                                    .foregroundStyle(HBPalette.textSecondary)
                            }

                            if let currentAction = execution.currentAction {
                                Text("Current step: \(currentAction.message)")
                                    .font(HBTypography.body(.caption))
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
                ToolbarItemGroup(placement: .primaryAction) {
                    if execution.status == "running" {
                        Button(stoppingExecutionIds.contains(execution.id) ? "Stopping..." : "Stop") {
                            requestStop(execution)
                        }
                        .disabled(loadingExecutionEvents || stoppingExecutionIds.contains(execution.id))
                        .tint(HBPalette.accentRed)
                    }

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
                .font(HBTypography.body(size: 16, weight: .semibold))
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
                    .font(HBTypography.body(.caption2))
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
                    .font(HBTypography.body(.caption2))
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
        let isStopping = stoppingExecutionIds.contains(execution.id)

        return VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(execution.displayName)
                        .font(HBTypography.display(size: 20, weight: .bold))
                        .foregroundStyle(HBPalette.textPrimary)

                    Text("Trigger: \(execution.triggerType.replacingOccurrences(of: "_", with: " ")) via \(execution.triggerSource.replacingOccurrences(of: "_", with: " "))")
                        .font(HBTypography.body(.caption))
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
                    .font(HBTypography.body(.caption))
                    .foregroundStyle(HBPalette.textSecondary)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(HBGlassBackground(cornerRadius: 18, variant: .panelSoft))
            }

            HStack {
                Text("Progress: \(execution.successfulActions)/\(execution.totalActions) steps finished")
                    .font(HBTypography.body(.caption))
                    .foregroundStyle(HBPalette.textSecondary)

                Spacer()

                Button("View Logs") {
                    Task { await openExecutionLogs(execution) }
                }
                .buttonStyle(HBSecondaryButtonStyle(compact: true))

                Button {
                    requestStop(execution)
                } label: {
                    Label(isStopping ? "Stopping..." : "Stop", systemImage: isStopping ? "hourglass" : "stop.fill")
                }
                .buttonStyle(HBDestructiveButtonStyle(compact: true))
                .disabled(isStopping)
            }
        }
    }

    private func activityEventCard(for event: PlatformEventItem) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(activitySummary(for: event))
                        .font(HBTypography.body(size: 15, weight: .semibold))
                        .foregroundStyle(HBPalette.textPrimary)

                    Text("\(event.source) · #\(event.sequence) · \(event.createdAt)")
                        .font(HBTypography.body(.caption2))
                        .foregroundStyle(HBPalette.textSecondary)
                }

                Spacer()

                severityBadge(for: event.severity)
            }

            if let payloadMessage = event.payloadMessage, !payloadMessage.isEmpty {
                Text(payloadMessage)
                    .font(HBTypography.body(.caption))
                    .foregroundStyle(HBPalette.textSecondary)
            }
        }
    }

    private func executionHistoryCard(for execution: WorkflowExecutionHistoryItem) -> some View {
        let isStopping = stoppingExecutionIds.contains(execution.id)

        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(execution.displayName)
                        .font(HBTypography.display(size: 18, weight: .bold))
                        .foregroundStyle(HBPalette.textPrimary)

                    Text(execution.automationName)
                        .font(HBTypography.body(.caption))
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

                if execution.status == "running" {
                    Button {
                        requestStop(execution)
                    } label: {
                        Label(isStopping ? "Stopping..." : "Stop", systemImage: isStopping ? "hourglass" : "stop.fill")
                    }
                    .buttonStyle(HBDestructiveButtonStyle(compact: true))
                    .disabled(isStopping)
                }
            }
        }
    }

    private func workflowTriggerSummary(_ workflow: WorkflowItem) -> String {
        let conditions = workflow.triggerConditions
        switch workflow.triggerType {
        case "time":
            let hour = JSON.int(conditions, "hour", fallback: 7)
            let minute = JSON.int(conditions, "minute", fallback: 0)
            return String(format: "Trigger details: %02d:%02d", hour, minute)
        case "schedule":
            return "Trigger details: \(JSON.string(conditions, "cron", fallback: "schedule"))"
        case "device_state", "sensor":
            let deviceId = JSON.string(conditions, "deviceId", fallback: "device")
            let property = JSON.string(conditions, "property", fallback: "status")
            let triggerOperator = JSON.string(conditions, "operator", fallback: "eq")
            let value = editorString(from: conditions["value"] ?? conditions["state"], fallback: "true")
            let hold = JSON.int(conditions, "forSeconds", fallback: JSON.int(conditions, "holdSeconds"))
            return "Trigger details: \(deviceId) \(property) \(triggerOperator) \(value)\(hold > 0 ? " for \(hold)s" : "")"
        case "security_alarm_status":
            let states = (conditions["states"] as? [String])?.joined(separator: ", ") ?? "alarm state"
            return "Trigger details: \(states)"
        default:
            return "Trigger details: manual"
        }
    }

    private func workflowActionSummary(_ workflow: WorkflowItem) -> String? {
        guard !workflow.actions.isEmpty else {
            return nil
        }

        let labels = workflow.actions.prefix(3).map { action -> String in
            let type = JSON.string(action, "type", fallback: "action")
            let parameters = JSON.object(action["parameters"])
            switch type {
            case "delay":
                return "delay \(JSON.int(parameters, "seconds", fallback: 10))s"
            case "device_control":
                return JSON.string(parameters, "action", fallback: type).replacingOccurrences(of: "_", with: " ")
            case "notification":
                return "notify"
            default:
                return type.replacingOccurrences(of: "_", with: " ")
            }
        }

        let suffix = workflow.actions.count > 3 ? " +\(workflow.actions.count - 3)" : ""
        return "Actions: \(labels.joined(separator: " -> "))\(suffix)"
    }

    private func workflowCard(for workflow: WorkflowItem) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(workflow.name)
                        .font(HBTypography.display(size: 20, weight: .bold))
                        .foregroundStyle(HBPalette.textPrimary)

                    Text(workflow.details.isEmpty ? "No description provided." : workflow.details)
                        .font(HBTypography.body(.caption))
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
                runtimeMetricCard(title: "Source", value: workflow.source.replacingOccurrences(of: "_", with: " "), subtitle: "")
                runtimeMetricCard(title: "Cooldown", value: workflow.cooldown > 0 ? "\(workflow.cooldown)m" : "None", subtitle: "")
                runtimeMetricCard(title: "Last Run", value: workflow.lastRun, subtitle: "")
                runtimeMetricCard(title: "Runs", value: "\(workflow.executionCount)", subtitle: "")
            }

            Text(workflowTriggerSummary(workflow))
                .font(HBTypography.body(.caption))
                .foregroundStyle(HBPalette.textSecondary)

            if let actionSummary = workflowActionSummary(workflow), !actionSummary.isEmpty {
                Text(actionSummary)
                    .font(HBTypography.body(.caption))
                    .foregroundStyle(HBPalette.textSecondary)
            }

            if workflow.voiceAliases.isEmpty {
                Text("No voice alias set yet.")
                    .font(HBTypography.body(.caption))
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
                    .font(HBTypography.body(.caption))
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
                .font(HBTypography.body(.caption2))
                .foregroundStyle(HBPalette.textSecondary)
                .textCase(.uppercase)
                .tracking(1.2)

            Text(value)
                .font(HBTypography.body(size: 14, weight: .semibold))
                .foregroundStyle(HBPalette.textPrimary)

            if !subtitle.isEmpty {
                Text(subtitle)
                    .font(HBTypography.body(.caption2))
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

    private func stopExecutionConfirmationBinding() -> Binding<Bool> {
        Binding(
            get: { executionPendingStop != nil },
            set: { open in
                if !open {
                    executionPendingStop = nil
                }
            }
        )
    }

    private func requestStop(_ execution: WorkflowExecutionHistoryItem) {
        guard execution.status == "running",
              !stoppingExecutionIds.contains(execution.id) else {
            return
        }

        executionPendingStop = execution
    }

    private func handleRuntimeLogLimitChange() {
        if runtimeHistoryPage == 1 {
            Task { await refreshWorkflowScreen(silent: false) }
        } else {
            runtimeHistoryPage = 1
        }
    }

    private func handleRuntimeWindowChange() {
        if runtimeHistoryPage == 1 {
            Task { await refreshWorkflowScreen(silent: false) }
        } else {
            runtimeHistoryPage = 1
        }
    }

    private func handleRuntimeHistoryPageChange() {
        Task { await refreshWorkflowScreen(silent: false) }
    }

    private func refreshWorkflowScreen(silent: Bool) async {
        guard !isWorkflowScreenRefreshInFlight else {
            return
        }
        isWorkflowScreenRefreshInFlight = true
        defer { isWorkflowScreenRefreshInFlight = false }

        if !silent {
            isLoading = workflows.isEmpty
            runtimeRefreshing = true
            errorMessage = nil
        }

            do {
                async let workflowsTask = session.apiClient.get("/api/workflows")
                async let devicesTask = session.apiClient.get("/api/devices")
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
                let devicesResponse = try await devicesTask
                let statsResponse = try await statsTask
            let runningResponse = try await runningTask
            let historyResponse = try await historyTask
            let telemetryResponse = try await telemetryTask
            let eventsResponse = try await eventsTask

                workflows = JSON.array(JSON.object(workflowsResponse)["workflows"])
                    .map(WorkflowItem.from)
                    .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
                devices = JSON.array(JSON.object(JSON.object(devicesResponse)["data"])["devices"])
                    .map(DeviceItem.from)
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

    private func stop(_ execution: WorkflowExecutionHistoryItem) async {
        guard execution.status == "running",
              !stoppingExecutionIds.contains(execution.id) else {
            executionPendingStop = nil
            return
        }

        executionPendingStop = nil
        stoppingExecutionIds.insert(execution.id)
        defer { stoppingExecutionIds.remove(execution.id) }

        do {
            let response = try await session.apiClient.post(
                "/api/workflows/executions/\(execution.id)/stop",
                body: ["reason": "Stopped from workflow logs"]
            )
            let object = JSON.object(response)
            let updatedExecution = WorkflowExecutionHistoryItem.from(JSON.object(object["execution"]))
            applyExecutionUpdate(updatedExecution)

            if selectedExecution?.id == execution.id {
                loadingExecutionEvents = true
                await refreshSelectedExecutionEvents()
            }

            await refreshWorkflowScreen(silent: true)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func applyExecutionUpdate(_ updatedExecution: WorkflowExecutionHistoryItem) {
        if updatedExecution.status == "running" {
            if let index = runningExecutions.firstIndex(where: { $0.id == updatedExecution.id }) {
                runningExecutions[index] = updatedExecution
            } else {
                runningExecutions.insert(updatedExecution, at: 0)
            }
        } else {
            runningExecutions.removeAll { $0.id == updatedExecution.id }
        }

        if let index = runtimeHistory.firstIndex(where: { $0.id == updatedExecution.id }) {
            runtimeHistory[index] = updatedExecution
        }

        if selectedExecution?.id == updatedExecution.id {
            selectedExecution = updatedExecution
        }
    }

    private func copyExecutionLogs() {
        guard let selectedExecution else {
            return
        }

        let persistedRuntimeEventSummary: String
        if selectedExecution.runtimeEvents.isEmpty {
            persistedRuntimeEventSummary = ""
        } else {
            let runtimeEventPayloads = selectedExecution.runtimeEvents.map { event in
                [
                    "type": event.type,
                    "level": event.level,
                    "message": event.message,
                    "details": event.details,
                    "createdAt": event.createdAt ?? ""
                ]
            }
            persistedRuntimeEventSummary = "\nPersisted Runtime Event Summaries\n\(JSON.prettyString(runtimeEventPayloads))"
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
            selectedExecution.workflowId == nil ? "" : "Workflow ID: \(selectedExecution.workflowId ?? "")",
            selectedExecution.correlationId == nil ? "" : "Correlation ID: \(selectedExecution.correlationId ?? "")",
            selectedExecution.lastEvent?.message == nil ? "" : "Last Event: \(selectedExecution.lastEvent?.message ?? "")",
            selectedExecution.currentAction == nil ? "" : "\nCurrent Action\n\(JSON.prettyString(selectedExecution.currentAction))",
            selectedExecution.currentAction == nil ? "" : "Next Action: \(nextActionMessage(for: selectedExecution.currentAction))",
            selectedExecution.currentAction == nil ? "" : "Timer Remaining: \(countdownText(for: selectedExecution.currentAction) ?? "No active timer")",
            selectedExecution.triggerContext.isEmpty ? "" : "\nTrigger Context\n\(JSON.prettyString(selectedExecution.triggerContext))",
            selectedExecution.errorDetails.isEmpty ? "" : "\nExecution Error\n\(JSON.prettyString(selectedExecution.errorDetails))",
            selectedExecution.actionResults.isEmpty ? "" : "\nAction Results\n\(JSON.prettyString(selectedExecution.actionResults))",
            persistedRuntimeEventSummary,
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
            selectedTab = .workflows
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
                    selectedTab = .workflows
                } else if object["workflow"] != nil {
                    workflows.insert(WorkflowItem.from(JSON.object(object["workflow"])), at: 0)
                    selectedTab = .workflows
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

            selectedTab = .workflows
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

    private func triggerFeatureToken(_ value: Any?) -> String {
        String(describing: value ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: #"[\s_-]+"#, with: "", options: .regularExpression)
            .lowercased()
    }

    private func triggerFeatureMatches(_ value: Any?, feature: String) -> Bool {
        let normalized = triggerFeatureToken(value)
        let target = triggerFeatureToken(feature)
        guard !normalized.isEmpty, !target.isEmpty else { return false }
        if normalized == target {
            return true
        }

        let aliases: [String: [String]] = [
            "battery": ["batterysensor"],
            "contact": ["contactsensor"],
            "motion": ["motionsensor", "occupancy", "occupancysensor"],
            "vibration": ["vibrationsensor"],
            "acceleration": ["accelerationsensor"],
            "tamper": ["tampersensor", "tamperalert"],
            "water": ["watersensor", "leak", "leaksensor"],
            "temperature": ["temperaturemeasurement", "temperaturesensor"],
            "humidity": ["relativehumiditymeasurement", "humiditysensor"],
            "illuminance": ["illuminancemeasurement", "illuminancesensor", "lightsensor"],
            "colortemperature": ["colortemperature", "whitetemperature"],
            "power": ["powermeter", "powersensor"],
            "energy": ["energymeter", "energysensor"],
            "voltage": ["voltagemeasurement", "voltagesensor"],
            "current": ["currentmeasurement", "currentsensor"]
        ]

        return aliases[target]?.contains(normalized) == true
    }

    private func directFeatureSupported(_ device: DeviceItem?, feature: String, supportFlags: [String] = []) -> Bool {
        guard let device else { return false }

        if supportFlags.contains(where: { JSON.bool(device.properties, $0) }) {
            return true
        }

        if JSON.stringArray(device.properties["directRadioFeatures"]).contains(where: { triggerFeatureMatches($0, feature: feature) }) {
            return true
        }

        return JSON.array(device.properties["directRadioCapabilities"]).contains { capability in
            triggerFeatureMatches(capability["type"], feature: feature)
                || triggerFeatureMatches(capability["property"], feature: feature)
        }
    }

    private func directRadioState(for device: DeviceItem?) -> [String: Any] {
        JSON.object(device?.properties["directRadioState"])
    }

    private func isDirectRadioBackedDevice(_ device: DeviceItem?) -> Bool {
        guard let device else { return false }
        let source = (device.properties["source"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let direct = JSON.object(device.properties["homebrainDirect"])
        let protocolName = (direct["protocol"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return source == "homebrain-zigbee"
            || source == "homebrain-zwave"
            || protocolName == "zigbee"
            || protocolName == "zwave"
    }

    private func nestedValue(_ source: [String: Any], path: [String]) -> Any? {
        var current: Any? = source
        for segment in path {
            guard let object = current as? [String: Any],
                  let value = object[segment] else {
                return nil
            }
            current = value
        }
        return current
    }

    private func hasDirectRadioStateValue(_ state: [String: Any], key: String) -> Bool {
        let path = key
            .replacingOccurrences(of: "directRadioState.", with: "")
            .split(separator: ".")
            .map(String.init)
        return nestedValue(state, path: path) != nil
    }

    private func propertyKind(for value: Any?) -> WorkflowTriggerPropertyKind {
        switch value {
        case is Bool:
            return .boolean
        case is NSNumber:
            return .number
        case is Int, is Double, is Float:
            return .number
        default:
            return .string
        }
    }

    private func finiteDouble(_ value: Any?) -> Double? {
        if let raw = value as? Double, raw.isFinite {
            return raw
        }
        if let raw = value as? NSNumber {
            let parsed = raw.doubleValue
            return parsed.isFinite ? parsed : nil
        }
        if let raw = value as? String, let parsed = Double(raw), parsed.isFinite {
            return parsed
        }
        return nil
    }

    private func triggerPropertyLabel(_ key: String) -> String {
        switch key {
        case "status":
            return "Status"
        case "isOnline":
            return "Online state"
        case "brightness":
            return "Brightness (%)"
        case "temperature":
            return "Temperature"
        case "targetTemperature":
            return "Target temperature"
        case "colorTemperature", "directRadioState.colorTemperatureK":
            return "White temperature (K)"
        case "directRadioState.batteryLevel", "homeBrainBatteryLevel", "directBatteryLevel", "batteryLevel", "matterBatteryLevel", "smartThingsBatteryLevel":
            return "Battery level (%)"
        case "directRadioState.batteryLow":
            return "Battery low"
        case "directRadioState.batteryVoltage":
            return "Battery voltage (V)"
        case "directRadioState.contactOpen":
            return "Contact open"
        case "directRadioState.motionActive":
            return "Motion active"
        case "directRadioState.vibrationActive":
            return "Vibration active"
        case "directRadioState.accelerationActive":
            return "Acceleration active"
        case "directRadioState.tamperActive":
            return "Tamper active"
        case "directRadioState.waterDetected":
            return "Water detected"
        case "directRadioState.temperatureF":
            return "Temperature (deg F)"
        case "directRadioState.humidity":
            return "Humidity (%)"
        case "directRadioState.illuminance":
            return "Illuminance (lx)"
        case "directRadioState.powerW":
            return "Power draw (W)"
        case "directRadioState.energyKwh":
            return "Energy total (kWh)"
        case "directRadioState.voltageV":
            return "Voltage (V)"
        case "directRadioState.currentA":
            return "Current (A)"
        default:
            return key
                .replacingOccurrences(of: "smartThingsAttributeValues.", with: "")
                .replacingOccurrences(of: ".", with: " / ")
                .replacingOccurrences(of: "_", with: " ")
                .capitalized
        }
    }

    private func collectBatteryTriggerOptions(for device: DeviceItem?) -> [WorkflowTriggerPropertyOption] {
        guard let device else { return [] }
        let state = directRadioState(for: device)
        var candidates: [(key: String, value: Any?)] = [
            ("directRadioState.batteryLevel", state["batteryLevel"]),
            ("homeBrainBatteryLevel", device.properties["homeBrainBatteryLevel"]),
            ("directBatteryLevel", device.properties["directBatteryLevel"]),
            ("batteryLevel", device.properties["batteryLevel"]),
            ("matterBatteryLevel", device.properties["matterBatteryLevel"])
        ]
        if !isDirectRadioBackedDevice(device) {
            candidates.append(("smartThingsBatteryLevel", device.properties["smartThingsBatteryLevel"]))
        }
        let match = candidates.first { finiteDouble($0.value) != nil }
        let supportsBattery = match != nil || directFeatureSupported(device, feature: "battery", supportFlags: ["supportsBattery"])
        guard supportsBattery else { return [] }

        var options = [
            WorkflowTriggerPropertyOption(
                key: match?.key ?? "directRadioState.batteryLevel",
                label: "Battery level (%)",
                kind: .number,
                unit: "%",
                batteryMetric: true
            )
        ]
        options.append(WorkflowTriggerPropertyOption(
            key: "directRadioState.batteryLow",
            label: "Battery low",
            kind: .boolean
        ))
        options.append(WorkflowTriggerPropertyOption(
            key: "directRadioState.batteryVoltage",
            label: "Battery voltage (V)",
            kind: .number,
            unit: "V"
        ))
        return options
    }

    private func collectDirectRadioTriggerOptions(for device: DeviceItem?) -> [WorkflowTriggerPropertyOption] {
        let state = directRadioState(for: device)
        let candidates: [(option: WorkflowTriggerPropertyOption, feature: String, supportFlags: [String])] = [
            (WorkflowTriggerPropertyOption(key: "directRadioState.contactOpen", label: "Contact open", kind: .boolean), "contact", ["supportsContactSensor"]),
            (WorkflowTriggerPropertyOption(key: "directRadioState.motionActive", label: "Motion active", kind: .boolean), "motion", ["supportsMotionSensor"]),
            (WorkflowTriggerPropertyOption(key: "directRadioState.vibrationActive", label: "Vibration active", kind: .boolean), "vibration", ["supportsVibrationSensor"]),
            (WorkflowTriggerPropertyOption(key: "directRadioState.accelerationActive", label: "Acceleration active", kind: .boolean), "acceleration", ["supportsAccelerationSensor"]),
            (WorkflowTriggerPropertyOption(key: "directRadioState.tamperActive", label: "Tamper active", kind: .boolean), "tamper", ["supportsTamperSensor"]),
            (WorkflowTriggerPropertyOption(key: "directRadioState.waterDetected", label: "Water detected", kind: .boolean), "water", ["supportsWaterSensor"]),
            (WorkflowTriggerPropertyOption(key: "directRadioState.temperatureF", label: "Temperature (deg F)", kind: .number, unit: "deg F"), "temperature", ["supportsTemperatureSensor"]),
            (WorkflowTriggerPropertyOption(key: "directRadioState.humidity", label: "Humidity (%)", kind: .number, unit: "%"), "humidity", ["supportsHumiditySensor"]),
            (WorkflowTriggerPropertyOption(key: "directRadioState.illuminance", label: "Illuminance (lx)", kind: .number, unit: "lx"), "illuminance", ["supportsIlluminanceSensor"]),
            (WorkflowTriggerPropertyOption(key: "directRadioState.colorTemperatureK", label: "White temperature (K)", kind: .number, unit: "K"), "colorTemperature", ["supportsColorTemperature"]),
            (WorkflowTriggerPropertyOption(key: "directRadioState.powerW", label: "Power draw (W)", kind: .number, unit: "W", energyMetric: true), "power", ["supportsPowerMeter"]),
            (WorkflowTriggerPropertyOption(key: "directRadioState.energyKwh", label: "Energy total (kWh)", kind: .number, unit: "kWh", energyMetric: true), "energy", ["supportsEnergyMeter"]),
            (WorkflowTriggerPropertyOption(key: "directRadioState.voltageV", label: "Voltage (V)", kind: .number, unit: "V"), "voltage", ["supportsVoltage"]),
            (WorkflowTriggerPropertyOption(key: "directRadioState.currentA", label: "Current (A)", kind: .number, unit: "A", energyMetric: true), "current", ["supportsCurrent"])
        ]

        return candidates
            .filter { hasDirectRadioStateValue(state, key: $0.option.key) || directFeatureSupported(device, feature: $0.feature, supportFlags: $0.supportFlags) }
            .map(\.option)
    }

    private func collectSmartThingsAttributeOptions(from node: [String: Any], prefix: [String] = []) -> [WorkflowTriggerPropertyOption] {
        var options: [WorkflowTriggerPropertyOption] = []

        for key in node.keys.sorted() {
            guard let value = node[key] else { continue }
            if key == "byComponent", let components = value as? [String: Any] {
                for componentKey in components.keys.sorted() {
                    guard componentKey != "main",
                          let componentValue = components[componentKey] as? [String: Any] else {
                        continue
                    }
                    options.append(contentsOf: collectSmartThingsAttributeOptions(from: componentValue, prefix: prefix + [key, componentKey]))
                }
                continue
            }

            let nextPrefix = prefix + [key]
            if let child = value as? [String: Any], !child.isEmpty {
                options.append(contentsOf: collectSmartThingsAttributeOptions(from: child, prefix: nextPrefix))
                continue
            }

            let optionKey = "smartThingsAttributeValues.\(nextPrefix.joined(separator: "."))"
            options.append(WorkflowTriggerPropertyOption(
                key: optionKey,
                label: triggerPropertyLabel(optionKey),
                kind: propertyKind(for: value),
                batteryMetric: nextPrefix.suffix(2).joined(separator: ".") == "battery.battery",
                energyMetric: optionKey.contains("powerMeter.power") || optionKey.contains("energyMeter.energy")
            ))
        }

        return options
    }

    private func triggerPropertyOptions(for device: DeviceItem?) -> [WorkflowTriggerPropertyOption] {
        var options: [WorkflowTriggerPropertyOption] = [
            WorkflowTriggerPropertyOption(key: "status", label: "Status", kind: .boolean),
            WorkflowTriggerPropertyOption(key: "isOnline", label: "Online state", kind: .boolean)
        ]

        if let device {
            if device.brightness > 0 || directFeatureSupported(device, feature: "brightness", supportFlags: ["supportsBrightness"]) {
                options.append(WorkflowTriggerPropertyOption(key: "brightness", label: "Brightness (%)", kind: .number, unit: "%"))
            }
            if device.temperature != nil {
                options.append(WorkflowTriggerPropertyOption(key: "temperature", label: "Temperature", kind: .number))
            }
            if device.targetTemperature != nil {
                options.append(WorkflowTriggerPropertyOption(key: "targetTemperature", label: "Target temperature", kind: .number))
            }
            if device.colorTemperature != nil || directFeatureSupported(device, feature: "colorTemperature", supportFlags: ["supportsColorTemperature"]) {
                options.append(WorkflowTriggerPropertyOption(key: "colorTemperature", label: "White temperature (K)", kind: .number, unit: "K"))
            }

            options.append(contentsOf: collectBatteryTriggerOptions(for: device))
            options.append(contentsOf: collectDirectRadioTriggerOptions(for: device))
            options.append(contentsOf: collectSmartThingsAttributeOptions(from: JSON.object(device.properties["smartThingsAttributeValues"])))
        }

        var seen = Set<String>()
        return options.filter { option in
            if seen.contains(option.key) {
                return false
            }
            seen.insert(option.key)
            return true
        }
    }

    private func defaultTriggerOperator(for option: WorkflowTriggerPropertyOption) -> String {
        if option.kind == .number, option.batteryMetric {
            return "lt"
        }
        if option.kind == .number, option.energyMetric {
            return "gt"
        }
        return "eq"
    }

    private func defaultTriggerValue(for option: WorkflowTriggerPropertyOption) -> String {
        switch option.kind {
        case .boolean:
            return "true"
        case .number:
            if option.batteryMetric {
                return "20"
            }
            return option.energyMetric ? "25" : "0"
        case .string:
            return ""
        }
    }

    private func applyTriggerPropertyDefaults(for key: String) {
        guard let option = currentTriggerPropertyOptions.first(where: { $0.key == key }) else {
            return
        }
        triggerOperator = defaultTriggerOperator(for: option)
        triggerValue = defaultTriggerValue(for: option)
    }

    private func normalizeTriggerPropertyForSelectedDevice() {
        let options = triggerPropertyOptions(for: selectedTriggerDevice)
        guard !options.isEmpty else {
            triggerProperty = "status"
            return
        }
        if !options.contains(where: { $0.key == triggerProperty }) {
            let option = options.first { $0.key == "status" } ?? options[0]
            triggerProperty = option.key
            triggerOperator = defaultTriggerOperator(for: option)
            triggerValue = defaultTriggerValue(for: option)
        }
    }

    private func parseEditorJSONObject(_ text: String, label: String, fallback: [String: Any]) throws -> [String: Any] {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return fallback
        }

        guard let data = trimmed.data(using: .utf8),
              let parsed = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) as? [String: Any] else {
            throw WorkflowEditorError.invalidJSON(label)
        }
        return parsed
    }

    private func parseEditorJSONArray(_ text: String, label: String, fallback: [[String: Any]]) throws -> [[String: Any]] {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return fallback
        }

        guard let data = trimmed.data(using: .utf8),
              let parsed = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) as? [[String: Any]] else {
            throw WorkflowEditorError.invalidJSON(label)
        }
        return parsed
    }

    private func editorScalarValue(_ value: String) -> Any {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized = trimmed.lowercased()

        if normalized == "true" || normalized == "on" || normalized == "yes" {
            return true
        }
        if normalized == "false" || normalized == "off" || normalized == "no" {
            return false
        }
        if normalized == "null" || normalized == "none" {
            return NSNull()
        }
        if let intValue = Int(trimmed) {
            return intValue
        }
        if let doubleValue = Double(trimmed) {
            return doubleValue
        }
        return trimmed
    }

    private func parseTimeInput(_ value: String) -> (hour: Int, minute: Int) {
        let parts = value
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: ":")
            .map(String.init)
        guard parts.count >= 2,
              let hour = Int(parts[0]),
              let minute = Int(parts[1]) else {
            return (7, 0)
        }
        return (
            min(max(hour, 0), 23),
            min(max(minute, 0), 59)
        )
    }

    private func buildTriggerConditionsPayload() throws -> [String: Any] {
        if useAdvancedTriggerJSON {
            return try parseEditorJSONObject(triggerConditionsJSON, label: "Trigger conditions JSON", fallback: [:])
        }

        switch triggerType {
        case "time":
            let parsed = parseTimeInput(triggerTime)
            return ["hour": parsed.hour, "minute": parsed.minute]
        case "schedule":
            let cron = triggerScheduleCron.trimmingCharacters(in: .whitespacesAndNewlines)
            return cron.isEmpty ? [:] : ["cron": cron]
        case "device_state", "sensor":
            var conditions: [String: Any] = [
                "property": triggerProperty.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "status" : triggerProperty,
                "operator": triggerOperator,
                "value": editorScalarValue(triggerValue)
            ]
            let deviceId = triggerDeviceId.trimmingCharacters(in: .whitespacesAndNewlines)
            if !deviceId.isEmpty {
                conditions["deviceId"] = deviceId
            }
            if triggerProperty == "status" {
                if let boolValue = conditions["value"] as? Bool {
                    conditions["state"] = boolValue ? "on" : "off"
                }
            }
            if triggerHoldSeconds > 0 {
                conditions["forSeconds"] = triggerHoldSeconds
            }
            return conditions
        case "security_alarm_status":
            let states = triggerAlarmStates
                .split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
            return states.isEmpty ? [:] : ["states": states]
        default:
            return [:]
        }
    }

    private func buildPrimaryActionPayload() -> [String: Any] {
        let trimmedTarget = target.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedValue = actionValue.trimmingCharacters(in: .whitespacesAndNewlines)
        var parameters: [String: Any] = [:]
        var resolvedTarget: Any = trimmedTarget.isEmpty ? NSNull() : trimmedTarget

        switch actionType {
        case "notification":
            resolvedTarget = trimmedTarget.isEmpty ? "system" : trimmedTarget
            parameters["message"] = trimmedValue.isEmpty ? "Workflow triggered from iOS" : trimmedValue
        case "device_control":
            if useTriggeringDeviceTarget && (triggerType == "device_state" || triggerType == "sensor") {
                resolvedTarget = ["kind": "context", "key": "triggeringDeviceId"]
            }
            let actionName = deviceActionName.trimmingCharacters(in: .whitespacesAndNewlines)
            parameters["action"] = actionName.isEmpty ? (trimmedValue.isEmpty ? "toggle" : trimmedValue) : actionName
            if !trimmedValue.isEmpty {
                parameters["value"] = editorScalarValue(trimmedValue)
            }
        case "delay":
            let seconds = delaySeconds > 0 ? delaySeconds : (Int(trimmedValue) ?? 10)
            parameters["seconds"] = max(seconds, 1)
        case "scene_activate":
            resolvedTarget = trimmedTarget.isEmpty ? trimmedValue : trimmedTarget
        case "http_request":
            if !trimmedValue.isEmpty {
                parameters["url"] = trimmedValue
            }
        default:
            if !trimmedValue.isEmpty {
                parameters["value"] = editorScalarValue(trimmedValue)
            }
        }

        return [
            "type": actionType,
            "target": resolvedTarget,
            "parameters": parameters
        ]
    }

    private func buildActionsPayload() throws -> [[String: Any]] {
        if useAdvancedActionsJSON {
            let actions = try parseEditorJSONArray(actionsJSON, label: "Actions JSON", fallback: [])
            if actions.isEmpty {
                throw WorkflowEditorError.invalidJSON("Actions JSON")
            }
            return actions
        }

        var actions: [[String: Any]] = []
        if delaySeconds > 0 && actionType != "delay" {
            actions.append([
                "type": "delay",
                "target": NSNull(),
                "parameters": ["seconds": delaySeconds]
            ])
        }
        actions.append(buildPrimaryActionPayload())
        return actions
    }

    private func buildManualWorkflowPayload(enabled: Bool) throws -> [String: Any] {
        let trigger = [
            "type": triggerType,
            "conditions": try buildTriggerConditionsPayload()
        ] as [String: Any]
        let actions = try buildActionsPayload()

        return [
            "name": createName.trimmingCharacters(in: .whitespacesAndNewlines),
            "description": createDescription,
            "source": "manual",
            "enabled": enabled,
            "category": createCategory,
            "priority": createPriority,
            "cooldown": createCooldown,
            "trigger": trigger,
            "actions": actions,
            "graph": ["nodes": [], "edges": []]
        ]
    }

    private func createManualWorkflow() async {
        if let editingWorkflow {
            await updateWorkflow(editingWorkflow)
            return
        }

        do {
            let payload = try buildManualWorkflowPayload(enabled: true)
            _ = try await session.apiClient.post("/api/workflows", body: payload)
            selectedTab = .workflows
            showCreateSheet = false
            resetWorkflowEditor()
            await refreshWorkflowScreen(silent: false)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func updateWorkflow(_ workflow: WorkflowItem) async {
        do {
            let payload = try buildManualWorkflowPayload(enabled: workflow.enabled)
            _ = try await session.apiClient.put("/api/workflows/\(workflow.id)", body: payload)
            selectedTab = .workflows
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

    private func editorString(from value: Any?, fallback: String = "") -> String {
        guard let value, !(value is NSNull) else {
            return fallback
        }
        if let boolValue = value as? Bool {
            return boolValue ? "true" : "false"
        }
        if let numberValue = value as? NSNumber {
            return numberValue.stringValue
        }
        if let stringValue = value as? String {
            return stringValue
        }
        return JSON.prettyString(value)
    }

    private func isTriggeringDeviceTarget(_ value: Any?) -> Bool {
        let object = JSON.object(value)
        let kind = JSON.string(object, "kind", fallback: JSON.string(object, "type")).lowercased()
        let key = JSON.string(object, "key", fallback: JSON.string(object, "contextKey"))
        return kind == "context" && key == "triggeringDeviceId"
    }

    private func targetString(from value: Any?) -> String {
        if isTriggeringDeviceTarget(value) {
            return ""
        }
        if let stringValue = value as? String {
            return stringValue
        }
        guard let value, !(value is NSNull) else {
            return ""
        }
        return JSON.prettyString(value)
    }

    private func populateEditorFields(from workflow: WorkflowItem) {
        let conditions = workflow.triggerConditions
        triggerConditionsJSON = JSON.prettyString(conditions.isEmpty ? [:] : conditions)
        actionsJSON = JSON.prettyString(workflow.actions)
        useAdvancedTriggerJSON = !conditions.isEmpty
        useAdvancedActionsJSON = !workflow.actions.isEmpty

        switch workflow.triggerType {
        case "time":
            let hour = JSON.int(conditions, "hour", fallback: 7)
            let minute = JSON.int(conditions, "minute", fallback: 0)
            triggerTime = String(format: "%02d:%02d", hour, minute)
        case "schedule":
            triggerScheduleCron = JSON.string(conditions, "cron", fallback: triggerScheduleCron)
        case "device_state", "sensor":
            triggerDeviceId = JSON.string(conditions, "deviceId")
            triggerProperty = JSON.string(conditions, "property", fallback: "status")
            triggerOperator = JSON.string(conditions, "operator", fallback: "eq")
            triggerValue = editorString(from: conditions["value"] ?? conditions["state"], fallback: "true")
            triggerHoldSeconds = JSON.int(conditions, "forSeconds", fallback: JSON.int(conditions, "holdSeconds"))
        case "security_alarm_status":
            let states = (conditions["states"] as? [String]) ?? []
            triggerAlarmStates = states.isEmpty ? triggerAlarmStates : states.joined(separator: ", ")
        default:
            break
        }

        var primaryAction = workflow.actions.first ?? [:]
        if JSON.string(primaryAction, "type") == "delay", workflow.actions.count > 1 {
            delaySeconds = JSON.int(JSON.object(primaryAction["parameters"]), "seconds")
            primaryAction = workflow.actions[1]
        } else {
            delaySeconds = JSON.string(primaryAction, "type") == "delay"
                ? JSON.int(JSON.object(primaryAction["parameters"]), "seconds")
                : 0
        }

        if !primaryAction.isEmpty {
            actionType = JSON.string(primaryAction, "type", fallback: "notification")
            let parameters = JSON.object(primaryAction["parameters"])
            target = targetString(from: primaryAction["target"])
            useTriggeringDeviceTarget = isTriggeringDeviceTarget(primaryAction["target"])

            switch actionType {
            case "notification":
                actionValue = JSON.string(parameters, "message")
            case "device_control":
                deviceActionName = JSON.string(parameters, "action", fallback: "turn_off")
                actionValue = editorString(from: parameters["value"])
            case "delay":
                actionValue = "\(delaySeconds)"
            case "http_request":
                actionValue = JSON.string(parameters, "url", fallback: editorString(from: parameters["value"]))
            default:
                actionValue = editorString(from: parameters["value"])
            }
        }
    }

    private func beginEditing(_ workflow: WorkflowItem) {
        editingWorkflow = workflow
        createName = workflow.name
        createDescription = workflow.details
        createCategory = workflow.category
        createPriority = workflow.priority
        createCooldown = workflow.cooldown
        triggerType = workflow.triggerType
        populateEditorFields(from: workflow)
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
        createCooldown = 0
        triggerDeviceId = ""
        triggerProperty = "status"
        triggerOperator = "eq"
        triggerValue = "true"
        triggerHoldSeconds = 0
        triggerTime = "07:00"
        triggerScheduleCron = "0 7 * * 1-5"
            triggerAlarmStates = "armedStay, armedAway"
            delaySeconds = 0
            deviceActionName = "turn_off"
            triggerDeviceSearch = ""
            triggerDeviceSource = DeviceItem.allSelectionSourcesValue
            targetDeviceSearch = ""
            targetDeviceSource = DeviceItem.allSelectionSourcesValue
            useTriggeringDeviceTarget = true
        useAdvancedTriggerJSON = false
        useAdvancedActionsJSON = false
        triggerConditionsJSON = "{}"
        actionsJSON = "[]"
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
        case "automation.execution.stop_requested":
            return "\(name): stop requested"
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
