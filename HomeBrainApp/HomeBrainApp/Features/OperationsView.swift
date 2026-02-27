import SwiftUI
import Combine

struct OperationsView: View {
    @EnvironmentObject private var session: SessionStore

    @State private var summary: [String: Any] = [:]
    @State private var events: [PlatformEventItem] = []
    @State private var resourceUtilization: [String: Any] = [:]

    @State private var isLoading = true
    @State private var errorMessage: String?

    private let timer = Timer.publish(every: 15, on: .main, in: .common).autoconnect()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if isLoading {
                    LoadingView(title: "Loading operations data...")
                } else {
                    HBSectionHeader(
                        title: "Operations",
                        subtitle: "Live events and system health telemetry"
                    )

                    if let errorMessage {
                        InlineErrorView(message: errorMessage) {
                            Task { await loadOperations() }
                        }
                    }

                    summaryCards
                    resourceCards

                    GroupBox("Live Events") {
                        if events.isEmpty {
                            EmptyStateView(title: "No events", subtitle: "No recent operations events were returned.")
                        } else {
                            VStack(spacing: 10) {
                                ForEach(events) { event in
                                    HBCardRow {
                                        VStack(alignment: .leading, spacing: 6) {
                                            HStack {
                                                Text(event.type)
                                                    .font(.headline)
                                                    .foregroundStyle(HBPalette.textPrimary)
                                                Spacer()
                                                Text(event.severity.uppercased())
                                                    .font(.caption2)
                                                    .padding(.horizontal, 8)
                                                    .padding(.vertical, 3)
                                                    .background(severityColor(event.severity).opacity(0.2))
                                                    .clipShape(Capsule())
                                            }

                                            Text("\(event.source) · #\(event.sequence) · \(event.createdAt)")
                                                .font(.caption2)
                                                .foregroundStyle(HBPalette.textSecondary)

                                            if !event.payloadSummary.isEmpty {
                                                Text(event.payloadSummary)
                                                    .font(.caption)
                                                    .foregroundStyle(HBPalette.textSecondary)
                                                    .lineLimit(4)
                                            }
                                        }
                                    }
                                }
                            }
                            .padding(.top, 4)
                        }
                    }
                }
            }
            .padding()
        }
        .groupBoxStyle(HBPanelGroupBoxStyle())
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Refresh") {
                    Task { await loadOperations() }
                }
            }
        }
        .onReceive(timer) { _ in
            Task { await loadOperations() }
        }
        .task {
            await loadOperations()
        }
        .refreshable {
            await loadOperations()
        }
    }

    private var summaryCards: some View {
        let total = JSON.int(summary, "total")
        let windowMinutes = JSON.int(summary, "windowMinutes", fallback: 60)
        let bySeverity = JSON.object(summary["bySeverity"])

        let infoCount = JSON.int(bySeverity, "info")
        let warnCount = JSON.int(bySeverity, "warn")
        let errorCount = JSON.int(bySeverity, "error")

        return GroupBox("Event Summary (\(windowMinutes)m)") {
            HStack(spacing: 12) {
                MetricCard(title: "Total", value: "\(total)", subtitle: "All events", tint: .blue)
                MetricCard(title: "Warnings", value: "\(warnCount)", subtitle: "Warn", tint: .orange)
                MetricCard(title: "Errors", value: "\(errorCount)", subtitle: "Error", tint: .red)
                MetricCard(title: "Info", value: "\(infoCount)", subtitle: "Info", tint: .green)
            }
            .padding(.top, 4)
        }
    }

    private var resourceCards: some View {
        let cpu = JSON.double(JSON.object(resourceUtilization["cpu"]), "usagePercent")
        let memory = JSON.double(JSON.object(resourceUtilization["memory"]), "usagePercent")
        let disk = JSON.double(JSON.object(resourceUtilization["disk"]), "usagePercent")

        return GroupBox("Resource Utilization") {
            HStack(spacing: 12) {
                MetricCard(title: "CPU", value: String(format: "%.1f%%", cpu), subtitle: "Current", tint: .purple)
                MetricCard(title: "Memory", value: String(format: "%.1f%%", memory), subtitle: "Current", tint: .teal)
                MetricCard(title: "Disk", value: String(format: "%.1f%%", disk), subtitle: "Current", tint: .indigo)
            }
            .padding(.top, 4)
        }
    }

    private func severityColor(_ severity: String) -> Color {
        switch severity {
        case "error": return .red
        case "warn": return .orange
        default: return .blue
        }
    }

    private func loadOperations() async {
        isLoading = true
        errorMessage = nil

        do {
            async let summaryTask = session.apiClient.get("/api/events/summary", query: [URLQueryItem(name: "windowMinutes", value: "60")])
            async let latestTask = session.apiClient.get("/api/events/latest", query: [URLQueryItem(name: "limit", value: "60")])
            async let resourcesTask = session.apiClient.get("/api/resources/utilization")

            let summaryResponse = try await summaryTask
            let latestResponse = try await latestTask
            let resourcesResponse = try await resourcesTask

            summary = JSON.object(summaryResponse)
            resourceUtilization = JSON.object(resourcesResponse)

            let latestObject = JSON.object(latestResponse)
            events = JSON.array(latestObject["events"])
                .map(PlatformEventItem.from)
                .sorted { $0.sequence > $1.sequence }
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }
}
