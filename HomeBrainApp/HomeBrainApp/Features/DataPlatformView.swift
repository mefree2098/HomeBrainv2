import Charts
import SwiftUI

private enum TelemetryRangeOption: String, CaseIterable, Identifiable {
    case day
    case week
    case month
    case quarter
    case year

    var id: String { rawValue }

    var title: String {
        switch self {
        case .day: return "24H"
        case .week: return "7D"
        case .month: return "30D"
        case .quarter: return "90D"
        case .year: return "1Y"
        }
    }

    var hours: Int {
        switch self {
        case .day: return 24
        case .week: return 24 * 7
        case .month: return 24 * 30
        case .quarter: return 24 * 90
        case .year: return 24 * 365
        }
    }
}

private struct TelemetryMetricDescriptor: Identifiable, Equatable {
    let key: String
    let label: String
    let unit: String
    let binary: Bool

    var id: String { key }

    static func from(_ object: [String: Any]) -> TelemetryMetricDescriptor {
        TelemetryMetricDescriptor(
            key: JSON.string(object, "key"),
            label: JSON.string(object, "label", fallback: "Metric"),
            unit: JSON.string(object, "unit"),
            binary: JSON.bool(object, "binary")
        )
    }
}

private struct TelemetrySourceSummary: Identifiable, Equatable {
    let sourceKey: String
    let sourceType: String
    let sourceId: String
    let name: String
    let category: String
    let room: String
    let origin: String
    let streamType: String
    let sampleCount: Int
    let metricCount: Int
    let lastSampleAt: String?
    let availableMetrics: [TelemetryMetricDescriptor]
    let featuredMetricKeys: [String]
    let lastValues: [String: Double]

    var id: String { sourceKey }

    static func from(_ object: [String: Any]) -> TelemetrySourceSummary {
        TelemetrySourceSummary(
            sourceKey: JSON.string(object, "sourceKey"),
            sourceType: JSON.string(object, "sourceType"),
            sourceId: JSON.string(object, "sourceId"),
            name: JSON.string(object, "name", fallback: "Unnamed Source"),
            category: JSON.string(object, "category"),
            room: JSON.string(object, "room"),
            origin: JSON.string(object, "origin"),
            streamType: JSON.string(object, "streamType"),
            sampleCount: JSON.int(object, "sampleCount"),
            metricCount: JSON.int(object, "metricCount"),
            lastSampleAt: JSON.optionalString(object, "lastSampleAt"),
            availableMetrics: JSON.array(object["availableMetrics"]).map(TelemetryMetricDescriptor.from),
            featuredMetricKeys: telemetryStringArray(object["featuredMetricKeys"]),
            lastValues: telemetryNumericMap(object["lastValues"])
        )
    }
}

private struct TelemetryOverviewSnapshot {
    let retentionDays: Int
    let totalSamples: Int
    let sourceCount: Int
    let lastSampleAt: String?
    let streamCounts: [String: Int]
    let storage: TelemetryStorageSummary
    let disk: TelemetryDiskSummary
    let sources: [TelemetrySourceSummary]

    static func from(_ object: [String: Any]) -> TelemetryOverviewSnapshot {
        TelemetryOverviewSnapshot(
            retentionDays: JSON.int(object, "retentionDays", fallback: 365),
            totalSamples: JSON.int(object, "totalSamples"),
            sourceCount: JSON.int(object, "sourceCount"),
            lastSampleAt: JSON.optionalString(object, "lastSampleAt"),
            streamCounts: telemetryIntMap(object["streamCounts"]),
            storage: TelemetryStorageSummary.from(JSON.object(object["storage"])),
            disk: TelemetryDiskSummary.from(JSON.object(object["disk"])),
            sources: JSON.array(object["sources"]).map(TelemetrySourceSummary.from)
        )
    }
}

private struct TelemetryStorageCollection: Identifiable, Equatable {
    let key: String
    let label: String
    let collectionName: String
    let documentCount: Int
    let logicalSizeBytes: Int
    let storageSizeBytes: Int
    let indexSizeBytes: Int
    let footprintBytes: Int
    let averageDocumentBytes: Int
    let available: Bool

    var id: String { key }

    static func from(_ object: [String: Any]) -> TelemetryStorageCollection {
        TelemetryStorageCollection(
            key: JSON.string(object, "key"),
            label: JSON.string(object, "label", fallback: "Telemetry Collection"),
            collectionName: JSON.string(object, "collectionName"),
            documentCount: JSON.int(object, "documentCount"),
            logicalSizeBytes: JSON.int(object, "logicalSizeBytes"),
            storageSizeBytes: JSON.int(object, "storageSizeBytes"),
            indexSizeBytes: JSON.int(object, "indexSizeBytes"),
            footprintBytes: JSON.int(object, "footprintBytes"),
            averageDocumentBytes: JSON.int(object, "averageDocumentBytes"),
            available: JSON.bool(object, "available", fallback: true)
        )
    }
}

private struct TelemetryStorageSummary: Equatable {
    let collectionCount: Int
    let totalDocumentCount: Int
    let logicalSizeBytes: Int
    let storageSizeBytes: Int
    let indexSizeBytes: Int
    let footprintBytes: Int
    let collections: [TelemetryStorageCollection]

    static func from(_ object: [String: Any]) -> TelemetryStorageSummary {
        TelemetryStorageSummary(
            collectionCount: JSON.int(object, "collectionCount"),
            totalDocumentCount: JSON.int(object, "totalDocumentCount"),
            logicalSizeBytes: JSON.int(object, "logicalSizeBytes"),
            storageSizeBytes: JSON.int(object, "storageSizeBytes"),
            indexSizeBytes: JSON.int(object, "indexSizeBytes"),
            footprintBytes: JSON.int(object, "footprintBytes"),
            collections: JSON.array(object["collections"]).map(TelemetryStorageCollection.from)
        )
    }
}

private struct TelemetryDiskSummary: Equatable {
    let totalBytes: Int
    let usedBytes: Int
    let freeBytes: Int
    let totalGB: Double
    let usedGB: Double
    let freeGB: Double
    let usagePercent: Double
    let totalLabel: String
    let usedLabel: String
    let freeLabel: String
    let available: Bool

    static func from(_ object: [String: Any]) -> TelemetryDiskSummary {
        TelemetryDiskSummary(
            totalBytes: JSON.int(object, "totalBytes"),
            usedBytes: JSON.int(object, "usedBytes"),
            freeBytes: JSON.int(object, "freeBytes"),
            totalGB: JSON.double(object, "totalGB"),
            usedGB: JSON.double(object, "usedGB"),
            freeGB: JSON.double(object, "freeGB"),
            usagePercent: JSON.double(object, "usagePercent"),
            totalLabel: JSON.string(object, "totalLabel"),
            usedLabel: JSON.string(object, "usedLabel"),
            freeLabel: JSON.string(object, "freeLabel"),
            available: JSON.bool(object, "available")
        )
    }
}

private struct TelemetrySeriesRangeSnapshot {
    let hours: Int
    let rawPointCount: Int
    let pointCount: Int
    let maxPoints: Int

    static func from(_ object: [String: Any]) -> TelemetrySeriesRangeSnapshot {
        TelemetrySeriesRangeSnapshot(
            hours: JSON.int(object, "hours", fallback: 24),
            rawPointCount: JSON.int(object, "rawPointCount"),
            pointCount: JSON.int(object, "pointCount"),
            maxPoints: JSON.int(object, "maxPoints", fallback: 240)
        )
    }
}

private struct TelemetrySeriesPoint: Identifiable {
    let observedAt: String
    let values: [String: Double]

    var id: String { observedAt }
    var date: Date? { JSON.date(from: observedAt) }

    static func from(_ object: [String: Any]) -> TelemetrySeriesPoint {
        TelemetrySeriesPoint(
            observedAt: JSON.string(object, "observedAt"),
            values: telemetryNumericMap(object["values"])
        )
    }
}

private struct TelemetryMetricStats: Equatable {
    let key: String
    let latest: Double?
    let min: Double?
    let max: Double?
    let average: Double?

    static func from(_ object: [String: Any]) -> TelemetryMetricStats {
        TelemetryMetricStats(
            key: JSON.string(object, "key"),
            latest: telemetryOptionalDouble(object["latest"]),
            min: telemetryOptionalDouble(object["min"]),
            max: telemetryOptionalDouble(object["max"]),
            average: telemetryOptionalDouble(object["average"])
        )
    }
}

private struct TelemetrySeriesSnapshot {
    let source: TelemetrySourceSummary
    let metrics: [TelemetryMetricDescriptor]
    let range: TelemetrySeriesRangeSnapshot
    let points: [TelemetrySeriesPoint]
    let stats: [TelemetryMetricStats]

    static func from(_ object: [String: Any]) -> TelemetrySeriesSnapshot {
        TelemetrySeriesSnapshot(
            source: TelemetrySourceSummary.from(JSON.object(object["source"])),
            metrics: JSON.array(object["metrics"]).map(TelemetryMetricDescriptor.from),
            range: TelemetrySeriesRangeSnapshot.from(JSON.object(object["range"])),
            points: JSON.array(object["points"]).map(TelemetrySeriesPoint.from),
            stats: JSON.array(object["stats"]).map(TelemetryMetricStats.from)
        )
    }
}

private func telemetryOptionalDouble(_ value: Any?) -> Double? {
    if let value = value as? Double {
        return value
    }
    if let value = value as? NSNumber {
        return value.doubleValue
    }
    if let value = value as? String, let parsed = Double(value) {
        return parsed
    }
    return nil
}

private func telemetryStringArray(_ value: Any?) -> [String] {
    if let strings = value as? [String] {
        return strings
    }
    if let array = value as? [Any] {
        return array.compactMap { item in
            if let string = item as? String {
                return string
            }
            return nil
        }
    }
    return []
}

private func telemetryIntMap(_ value: Any?) -> [String: Int] {
    let object = JSON.object(value)
    var result: [String: Int] = [:]
    object.forEach { key, rawValue in
        if let number = rawValue as? Int {
            result[key] = number
        } else if let number = rawValue as? NSNumber {
            result[key] = number.intValue
        } else if let string = rawValue as? String, let parsed = Int(string) {
            result[key] = parsed
        }
    }
    return result
}

private func telemetryNumericMap(_ value: Any?) -> [String: Double] {
    let object = JSON.object(value)
    var result: [String: Double] = [:]
    object.forEach { key, rawValue in
        if let number = telemetryOptionalDouble(rawValue) {
            result[key] = number
        }
    }
    return result
}

private func telemetryFormatDateTime(_ value: String?) -> String {
    guard let value, let date = JSON.date(from: value) else {
        return "Unknown"
    }
    return DateFormatter.localizedString(from: date, dateStyle: .medium, timeStyle: .short)
}

private func telemetryFormatChartDate(_ value: Date?) -> String {
    guard let value else { return "--" }
    return value.formatted(.dateTime.month(.abbreviated).day().hour())
}

private func telemetryFormatCompactCount(_ value: Int) -> String {
    if value >= 1000 {
        return value.formatted(.number.notation(.compactName))
    }
    return value.formatted()
}

private func telemetryFormatBytes(_ value: Int) -> String {
    if value < 0 {
        return "--"
    }

    if value == 0 {
        return "0 B"
    }

    let units = ["B", "KB", "MB", "GB", "TB"]
    var size = Double(value)
    var unitIndex = 0

    while size >= 1024, unitIndex < units.count - 1 {
        size /= 1024
        unitIndex += 1
    }

    let digits: Int
    if size >= 100 {
        digits = 0
    } else if size >= 10 {
        digits = 1
    } else {
        digits = 2
    }

    return "\(size.formatted(.number.precision(.fractionLength(0...digits)))) \(units[unitIndex])"
}

private func telemetryBinaryLabel(for metricKey: String, value: Double?) -> String {
    guard let value else { return "--" }
    let on = value >= 0.5

    switch metricKey {
    case "online":
        return on ? "Online" : "Offline"
    case "locked":
        return on ? "Locked" : "Unlocked"
    case "contact_open":
        return on ? "Open" : "Closed"
    case "motion_active":
        return on ? "Motion" : "Idle"
    case "occupancy_active":
        return on ? "Occupied" : "Clear"
    case "presence_present":
        return on ? "Present" : "Away"
    case "water_detected":
        return on ? "Wet" : "Dry"
    default:
        return on ? "On" : "Off"
    }
}

private func telemetryFormatMetricValue(_ metric: TelemetryMetricDescriptor, value: Double?) -> String {
    guard let value else { return "--" }

    if metric.binary {
        return telemetryBinaryLabel(for: metric.key, value: value)
    }

    let digits: Int
    let magnitude = abs(value)
    if magnitude >= 100 {
        digits = 0
    } else if magnitude >= 10 {
        digits = 1
    } else {
        digits = 2
    }

    let formatted = value.formatted(
        .number
            .precision(.fractionLength(0...digits))
    )
    return metric.unit.isEmpty ? formatted : "\(formatted) \(metric.unit)"
}

private struct TelemetryMetricPanel: View {
    let metric: TelemetryMetricDescriptor
    let stats: TelemetryMetricStats?
    let points: [TelemetrySeriesPoint]
    let color: Color

    private struct ChartPoint: Identifiable {
        let id = UUID()
        let date: Date
        let value: Double
    }

    private var chartPoints: [ChartPoint] {
        points.compactMap { point in
            guard let date = point.date,
                  let value = point.values[metric.key] else {
                return nil
            }

            return ChartPoint(date: date, value: value)
        }
    }

    var body: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(metric.label)
                            .font(.system(size: 18, weight: .bold, design: .rounded))
                            .foregroundStyle(HBPalette.textPrimary)

                        Text(metric.binary ? "State telemetry" : "Long-range metric history")
                            .font(.system(size: 12, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textMuted)
                    }

                    Spacer(minLength: 0)

                    Text(telemetryFormatMetricValue(metric, value: stats?.latest))
                        .font(.system(size: 13, weight: .bold, design: .rounded))
                        .foregroundStyle(HBPalette.textPrimary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(HBGlassBackground(cornerRadius: 14, variant: .panelSoft))
                }

                HStack(spacing: 10) {
                    telemetryStatPill(title: "Min", value: telemetryFormatMetricValue(metric, value: stats?.min))
                    telemetryStatPill(title: "Avg", value: telemetryFormatMetricValue(metric, value: stats?.average))
                    telemetryStatPill(title: "Max", value: telemetryFormatMetricValue(metric, value: stats?.max))
                }

                if chartPoints.isEmpty {
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(HBPalette.panelSoft.opacity(0.7))
                        .overlay(
                            Text("No samples in this window yet.")
                                .font(.system(size: 13, weight: .medium, design: .rounded))
                                .foregroundStyle(HBPalette.textMuted)
                        )
                        .frame(height: 210)
                } else {
                    Chart(chartPoints) { point in
                        if !metric.binary {
                            AreaMark(
                                x: .value("Observed", point.date),
                                y: .value(metric.label, point.value)
                            )
                            .foregroundStyle(
                                LinearGradient(
                                    colors: [color.opacity(0.35), color.opacity(0.04)],
                                    startPoint: .top,
                                    endPoint: .bottom
                                )
                            )
                        }

                        LineMark(
                            x: .value("Observed", point.date),
                            y: .value(metric.label, point.value)
                        )
                        .foregroundStyle(color)
                        .lineStyle(StrokeStyle(lineWidth: 2.4, lineCap: .round, lineJoin: .round))
                        .interpolationMethod(metric.binary ? .stepEnd : .catmullRom)
                    }
                    .frame(height: 210)
                    .chartXAxis {
                        AxisMarks(values: .automatic(desiredCount: 4)) { value in
                            AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [2, 4]))
                                .foregroundStyle(HBPalette.divider.opacity(0.5))
                            AxisValueLabel {
                                if let date = value.as(Date.self) {
                                    Text(telemetryFormatChartDate(date))
                                        .font(.system(size: 10, weight: .medium, design: .rounded))
                                        .foregroundStyle(HBPalette.textMuted)
                                }
                            }
                        }
                    }
                    .chartYAxis {
                        AxisMarks(position: .leading, values: .automatic(desiredCount: metric.binary ? 2 : 4)) { value in
                            AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [2, 4]))
                                .foregroundStyle(HBPalette.divider.opacity(0.35))
                            AxisValueLabel {
                                if let number = value.as(Double.self) {
                                    if metric.binary {
                                        Text(telemetryBinaryLabel(for: metric.key, value: number))
                                            .font(.system(size: 10, weight: .medium, design: .rounded))
                                            .foregroundStyle(HBPalette.textMuted)
                                    } else {
                                        Text(number.formatted(.number.precision(.fractionLength(0...1))))
                                            .font(.system(size: 10, weight: .medium, design: .rounded))
                                            .foregroundStyle(HBPalette.textMuted)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private func telemetryStatPill(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.system(size: 10, weight: .bold, design: .rounded))
                .textCase(.uppercase)
                .tracking(1.8)
                .foregroundStyle(HBPalette.textMuted)
            Text(value)
                .font(.system(size: 13, weight: .semibold, design: .rounded))
                .foregroundStyle(HBPalette.textPrimary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(HBGlassBackground(cornerRadius: 16, variant: .panelSoft))
    }
}

struct DataPlatformView: View {
    @EnvironmentObject private var session: SessionStore

    @State private var overview: TelemetryOverviewSnapshot?
    @State private var series: TelemetrySeriesSnapshot?
    @State private var selectedSourceKey: String?
    @State private var selectedMetricKeys: [String] = []
    @State private var selectedRange: TelemetryRangeOption = .week
    @State private var isLoadingOverview = true
    @State private var isLoadingSeries = false
    @State private var isRefreshing = false
    @State private var isClearing = false
    @State private var errorMessage: String?
    @State private var showClearSourceConfirmation = false
    @State private var showClearAllConfirmation = false

    private let metricColors: [Color] = [
        HBPalette.accentBlue,
        HBPalette.accentGreen,
        HBPalette.accentYellow,
        HBPalette.accentPurple
    ]

    private var isAdmin: Bool {
        session.currentUser?.role == "admin"
    }

    private var selectedSource: TelemetrySourceSummary? {
        overview?.sources.first(where: { $0.sourceKey == selectedSourceKey })
    }

    private var selectedMetricDescriptors: [TelemetryMetricDescriptor] {
        guard let selectedSource else { return [] }
        let metricsByKey = Dictionary(uniqueKeysWithValues: selectedSource.availableMetrics.map { ($0.key, $0) })
        return selectedMetricKeys.compactMap { metricsByKey[$0] }
    }

    private var statsByKey: [String: TelemetryMetricStats] {
        Dictionary(uniqueKeysWithValues: (series?.stats ?? []).map { ($0.key, $0) })
    }

    private var storageCollections: [TelemetryStorageCollection] {
        overview?.storage.collections ?? []
    }

    private var seriesTaskKey: String {
        "\(selectedSourceKey ?? "none")|\(selectedMetricKeys.joined(separator: ","))|\(selectedRange.rawValue)"
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                heroPanel

                if let errorMessage {
                    InlineErrorView(message: errorMessage) {
                        Task { await loadOverview(showLoading: true) }
                    }
                }

                sourceExplorerPanel
                storageFootprintPanel

                if isLoadingSeries, selectedSource != nil {
                    LoadingView(title: "Rendering telemetry window...")
                } else if selectedSource != nil, !selectedMetricDescriptors.isEmpty {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 280), spacing: 12)], spacing: 12) {
                        ForEach(Array(selectedMetricDescriptors.enumerated()), id: \.element.id) { index, metric in
                            TelemetryMetricPanel(
                                metric: metric,
                                stats: statsByKey[metric.key],
                                points: series?.points ?? [],
                                color: metricColors[index % metricColors.count]
                            )
                        }
                    }
                }

                footerPanels
            }
            .padding(16)
            .padding(.bottom, 8)
        }
        .scrollIndicators(.hidden)
        .refreshable {
            await loadOverview(showLoading: false)
        }
        .task {
            await loadOverview(showLoading: true)
        }
        .task(id: seriesTaskKey) {
            await loadSeriesIfNeeded()
        }
        .confirmationDialog(
            "Clear the selected telemetry source?",
            isPresented: $showClearSourceConfirmation,
            titleVisibility: .visible
        ) {
            Button("Clear Source Data", role: .destructive) {
                Task { await clearTelemetry(sourceKey: selectedSource?.sourceKey) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This clears the selected source history and any linked device or Tempest history that powers the charts.")
        }
        .confirmationDialog(
            "Clear all telemetry data?",
            isPresented: $showClearAllConfirmation,
            titleVisibility: .visible
        ) {
            Button("Clear All Data", role: .destructive) {
                Task { await clearTelemetry(sourceKey: nil) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This wipes the stored telemetry history across HomeBrain so the data platform starts from a clean slate.")
        }
    }

    private var heroPanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 18) {
                HStack(alignment: .top, spacing: 14) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Residence Telemetry Fabric")
                            .font(.system(size: 11, weight: .bold, design: .rounded))
                            .textCase(.uppercase)
                            .tracking(2.2)
                            .foregroundStyle(HBPalette.textMuted)

                        Text("Data Platform")
                            .font(.system(size: 30, weight: .bold, design: .rounded))
                            .foregroundStyle(HBPalette.textPrimary)

                        Text("HomeBrain now tracks one year of chart-ready device and Tempest history so trends, comparisons, and future automations can all draw from the same telemetry surface.")
                            .font(.system(size: 14, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    Spacer(minLength: 0)

                    VStack(alignment: .trailing, spacing: 10) {
                        Button {
                            Task { await loadOverview(showLoading: false) }
                        } label: {
                            Label(isRefreshing ? "Refreshing..." : "Refresh", systemImage: "arrow.clockwise")
                                .font(.system(size: 13, weight: .semibold, design: .rounded))
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(HBPalette.accentBlue)

                        if isAdmin {
                            Button(role: .destructive) {
                                showClearAllConfirmation = true
                            } label: {
                                Label("Clear All", systemImage: "trash")
                                    .font(.system(size: 13, weight: .semibold, design: .rounded))
                            }
                            .buttonStyle(.bordered)
                            .disabled(isClearing || (overview?.totalSamples ?? 0) == 0)
                        }
                    }
                }

                LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 12)], spacing: 12) {
                    telemetryOverviewTile(title: "Tracked Sources", value: telemetryFormatCompactCount(overview?.sourceCount ?? 0), subtitle: "Active telemetry feeds")
                    telemetryOverviewTile(title: "Samples Stored", value: telemetryFormatCompactCount(overview?.totalSamples ?? 0), subtitle: "\(overview?.retentionDays ?? 365)-day retention target")
                    telemetryOverviewTile(title: "Telemetry Footprint", value: telemetryFormatBytes(overview?.storage.footprintBytes ?? 0), subtitle: "Collections plus indexes on disk")
                    telemetryOverviewTile(
                        title: "Drive Free / Total",
                        value: "\(telemetryFormatBytes(overview?.disk.freeBytes ?? 0)) / \(telemetryFormatBytes(overview?.disk.totalBytes ?? 0))",
                        subtitle: overview?.disk.available == true
                            ? "\(String(format: "%.1f", overview?.disk.usagePercent ?? 0))% used on host drive"
                            : "Drive telemetry unavailable"
                    )
                    telemetryOverviewTile(title: "Last Ingest", value: telemetryFormatDateTime(overview?.lastSampleAt), subtitle: "Latest observed sample")
                }
            }
        }
    }

    private var storageFootprintPanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Storage Footprint")
                        .font(.system(size: 20, weight: .bold, design: .rounded))
                        .foregroundStyle(HBPalette.textPrimary)

                    Text("HomeBrain telemetry currently uses \(telemetryFormatBytes(overview?.storage.footprintBytes ?? 0)) on disk, with \(telemetryFormatBytes(overview?.disk.freeBytes ?? 0)) free out of \(telemetryFormatBytes(overview?.disk.totalBytes ?? 0)) on the host drive.")
                        .font(.system(size: 13, weight: .medium, design: .rounded))
                        .foregroundStyle(HBPalette.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }

                LazyVGrid(columns: [GridItem(.adaptive(minimum: 170), spacing: 12)], spacing: 12) {
                    telemetryOverviewTile(
                        title: "Logical Data",
                        value: telemetryFormatBytes(overview?.storage.logicalSizeBytes ?? 0),
                        subtitle: "Raw telemetry document payload"
                    )
                    telemetryOverviewTile(
                        title: "Allocated Storage",
                        value: telemetryFormatBytes(overview?.storage.storageSizeBytes ?? 0),
                        subtitle: "Collection storage reserved on disk"
                    )
                    telemetryOverviewTile(
                        title: "Indexes",
                        value: telemetryFormatBytes(overview?.storage.indexSizeBytes ?? 0),
                        subtitle: "Query and retention-policy overhead"
                    )
                }

                LazyVGrid(columns: [GridItem(.adaptive(minimum: 180), spacing: 12)], spacing: 12) {
                    ForEach(storageCollections) { collection in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(collection.label)
                                .font(.system(size: 14, weight: .bold, design: .rounded))
                                .foregroundStyle(HBPalette.textPrimary)

                            Text(telemetryFormatBytes(collection.footprintBytes))
                                .font(.system(size: 18, weight: .bold, design: .rounded))
                                .foregroundStyle(HBPalette.textPrimary)

                            VStack(alignment: .leading, spacing: 4) {
                                Text("\(telemetryFormatCompactCount(collection.documentCount)) docs")
                                Text("\(telemetryFormatBytes(collection.storageSizeBytes)) collection")
                                Text("\(telemetryFormatBytes(collection.indexSizeBytes)) indexes")
                            }
                            .font(.system(size: 12, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textSecondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(14)
                        .background(HBGlassBackground(cornerRadius: 18, variant: .panelSoft))
                    }
                }
            }
        }
    }

    private var sourceExplorerPanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Source Explorer")
                            .font(.system(size: 20, weight: .bold, design: .rounded))
                            .foregroundStyle(HBPalette.textPrimary)

                        Text("Choose a tracked source to inspect long-range device or weather history.")
                            .font(.system(size: 13, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textMuted)
                    }

                    Spacer(minLength: 0)

                    if isAdmin, selectedSource != nil {
                        Button(role: .destructive) {
                            showClearSourceConfirmation = true
                        } label: {
                            Label("Clear Source", systemImage: "trash")
                                .font(.system(size: 12, weight: .semibold, design: .rounded))
                        }
                        .buttonStyle(.bordered)
                        .disabled(isClearing)
                    }
                }

                if let overview, !overview.sources.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 12) {
                            ForEach(overview.sources) { source in
                                sourceCard(source)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                } else if isLoadingOverview {
                    LoadingView(title: "Loading telemetry sources...")
                } else {
                    EmptyStateView(
                        title: "No telemetry yet",
                        subtitle: "As Tempest observations and smart-device state changes arrive, they will appear here automatically."
                    )
                }

                if let selectedSource {
                    VStack(alignment: .leading, spacing: 14) {
                        HStack(spacing: 8) {
                            ForEach(TelemetryRangeOption.allCases) { option in
                                Button {
                                    selectedRange = option
                                } label: {
                                    Text(option.title)
                                        .font(.system(size: 12, weight: .bold, design: .rounded))
                                        .frame(minWidth: 48)
                                }
                                .buttonStyle(.borderedProminent)
                                .tint(selectedRange == option ? HBPalette.accentBlue : HBPalette.accentSlate)
                            }
                        }

                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 132), spacing: 10)], spacing: 10) {
                            ForEach(selectedSource.availableMetrics) { metric in
                                Button {
                                    toggleMetric(metric.key)
                                } label: {
                                    Text(metric.label)
                                        .font(.system(size: 12, weight: .semibold, design: .rounded))
                                        .foregroundStyle(selectedMetricKeys.contains(metric.key) ? HBPalette.textPrimary : HBPalette.textSecondary)
                                        .frame(maxWidth: .infinity)
                                        .padding(.horizontal, 12)
                                        .padding(.vertical, 10)
                                }
                                .buttonStyle(.plain)
                                .background(
                                    HBGlassBackground(
                                        cornerRadius: 16,
                                        variant: selectedMetricKeys.contains(metric.key) ? .panelStrong : .panelSoft
                                    )
                                )
                            }
                        }

                        HStack(spacing: 12) {
                            telemetryOverviewTile(
                                title: "Samples Returned",
                                value: telemetryFormatCompactCount(series?.range.pointCount ?? 0),
                                subtitle: "From \(telemetryFormatCompactCount(series?.range.rawPointCount ?? 0)) raw points"
                            )
                            telemetryOverviewTile(
                                title: "Window",
                                value: "\(selectedRange.title)",
                                subtitle: "Capped at \(series?.range.maxPoints ?? 240) chart points"
                            )
                        }
                    }
                }
            }
        }
    }

    private var footerPanels: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 220), spacing: 12)], spacing: 12) {
            footerPanel(
                title: "Tempest Ready",
                subtitle: "Weather-station observations now flow into the shared telemetry layer so historical atmospheric charts live alongside device data.",
                color: HBPalette.accentBlue
            )
            footerPanel(
                title: "Device State History",
                subtitle: "Device metrics and state transitions are chartable without digging through the raw device model or provider-specific payloads.",
                color: HBPalette.accentGreen
            )
            footerPanel(
                title: "Clean Slate Controls",
                subtitle: "Admins can clear one source or reset the entire telemetry store when they want to start a new baseline.",
                color: HBPalette.accentOrange
            )
        }
    }

    private func sourceCard(_ source: TelemetrySourceSummary) -> some View {
        let active = source.sourceKey == selectedSourceKey

        return Button {
            selectedSourceKey = source.sourceKey
        } label: {
            VStack(alignment: .leading, spacing: 10) {
                Text(source.sourceType == "tempest_station" ? "Weather Station" : "Device Stream")
                    .font(.system(size: 10, weight: .bold, design: .rounded))
                    .textCase(.uppercase)
                    .tracking(1.8)
                    .foregroundStyle(active ? Color.white.opacity(0.76) : HBPalette.textMuted)

                Text(source.name)
                    .font(.system(size: 17, weight: .bold, design: .rounded))
                    .foregroundStyle(active ? Color.white : HBPalette.textPrimary)
                    .multilineTextAlignment(.leading)

                VStack(alignment: .leading, spacing: 4) {
                    Text(source.category.isEmpty ? "General" : source.category)
                    Text("\(telemetryFormatCompactCount(source.sampleCount)) samples")
                    Text(telemetryFormatDateTime(source.lastSampleAt))
                }
                .font(.system(size: 12, weight: .medium, design: .rounded))
                .foregroundStyle(active ? Color.white.opacity(0.82) : HBPalette.textSecondary)
            }
            .frame(width: 220, alignment: .leading)
            .padding(16)
            .background(
                Group {
                    if active {
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .fill(
                                LinearGradient(
                                    colors: [HBPalette.accentBlue.opacity(0.68), HBPalette.accentPurple.opacity(0.42)],
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing
                                )
                            )
                    } else {
                        HBGlassBackground(cornerRadius: 20, variant: .panelSoft)
                    }
                }
            )
        }
        .buttonStyle(.plain)
    }

    private func telemetryOverviewTile(title: String, value: String, subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.system(size: 10, weight: .bold, design: .rounded))
                .textCase(.uppercase)
                .tracking(1.8)
                .foregroundStyle(HBPalette.textMuted)

            Text(value)
                .font(.system(size: 20, weight: .bold, design: .rounded))
                .foregroundStyle(HBPalette.textPrimary)
                .lineLimit(2)

            Text(subtitle)
                .font(.system(size: 11, weight: .medium, design: .rounded))
                .foregroundStyle(HBPalette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(HBGlassBackground(cornerRadius: 18, variant: .panelSoft))
    }

    private func footerPanel(title: String, subtitle: String, color: Color) -> some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 10) {
                Circle()
                    .fill(color.opacity(0.22))
                    .frame(width: 36, height: 36)
                    .overlay(
                        Circle()
                            .stroke(color.opacity(0.35), lineWidth: 1)
                    )

                Text(title)
                    .font(.system(size: 18, weight: .bold, design: .rounded))
                    .foregroundStyle(HBPalette.textPrimary)

                Text(subtitle)
                    .font(.system(size: 13, weight: .medium, design: .rounded))
                    .foregroundStyle(HBPalette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func toggleMetric(_ key: String) {
        if selectedMetricKeys.contains(key) {
            if selectedMetricKeys.count > 1 {
                selectedMetricKeys.removeAll { $0 == key }
            }
            return
        }

        guard selectedMetricKeys.count < 4 else {
            return
        }

        selectedMetricKeys.append(key)
    }

    private func loadOverview(showLoading: Bool) async {
        if showLoading {
            isLoadingOverview = true
        } else {
            isRefreshing = true
        }

        defer {
            isLoadingOverview = false
            isRefreshing = false
        }

        do {
            let response = try await session.apiClient.get("/api/telemetry/overview")
            let snapshot = TelemetryOverviewSnapshot.from(JSON.object(JSON.object(response)["data"]))
            overview = snapshot
            errorMessage = nil
            applySelection(using: snapshot)
        } catch {
            errorMessage = error.localizedDescription
            if showLoading {
                overview = nil
                series = nil
            }
        }
    }

    private func applySelection(using snapshot: TelemetryOverviewSnapshot) {
        guard !snapshot.sources.isEmpty else {
            selectedSourceKey = nil
            selectedMetricKeys = []
            return
        }

        let previousSourceKey = selectedSourceKey
        let resolvedSource = snapshot.sources.first(where: { $0.sourceKey == previousSourceKey }) ?? snapshot.sources.first
        selectedSourceKey = resolvedSource?.sourceKey

        guard let resolvedSource else {
            selectedMetricKeys = []
            return
        }

        let availableKeys = Set(resolvedSource.availableMetrics.map(\.key))
        let preservedMetrics = selectedMetricKeys.filter { availableKeys.contains($0) }

        if resolvedSource.sourceKey == previousSourceKey, !preservedMetrics.isEmpty {
            selectedMetricKeys = Array(preservedMetrics.prefix(4))
            return
        }

        let featuredKeys = resolvedSource.featuredMetricKeys.filter { availableKeys.contains($0) }
        if !featuredKeys.isEmpty {
            selectedMetricKeys = Array(featuredKeys.prefix(4))
            return
        }

        selectedMetricKeys = Array(resolvedSource.availableMetrics.prefix(4).map(\.key))
    }

    private func loadSeriesIfNeeded() async {
        guard let selectedSourceKey, !selectedMetricKeys.isEmpty else {
            series = nil
            return
        }

        isLoadingSeries = true
        defer { isLoadingSeries = false }

        do {
            let metricQuery = selectedMetricKeys.joined(separator: ",")
            let path = "/api/telemetry/series?sourceKey=\(selectedSourceKey.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? selectedSourceKey)&metricKeys=\(metricQuery.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? metricQuery)&hours=\(selectedRange.hours)&maxPoints=\(selectedRange.hours >= 24 * 90 ? 320 : 240)"
            let response = try await session.apiClient.get(path)
            series = TelemetrySeriesSnapshot.from(JSON.object(JSON.object(response)["data"]))
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
            series = nil
        }
    }

    private func clearTelemetry(sourceKey: String?) async {
        isClearing = true
        defer { isClearing = false }

        do {
            let path: String
            if let sourceKey, !sourceKey.isEmpty {
                let encoded = sourceKey.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? sourceKey
                path = "/api/telemetry?sourceKey=\(encoded)"
            } else {
                path = "/api/telemetry"
            }

            _ = try await session.apiClient.delete(path)
            await loadOverview(showLoading: true)
            series = nil
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
