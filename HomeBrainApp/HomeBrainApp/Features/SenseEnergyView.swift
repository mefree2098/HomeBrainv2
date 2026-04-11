import Charts
import SwiftUI

private nonisolated let senseConfiguredSecretPlaceholder = "••••••••••••••••"
private let senseDeviceLineColors: [Color] = [
    HBPalette.accentOrange,
    HBPalette.accentGreen,
    HBPalette.accentBlue,
    HBPalette.accentRed,
    HBPalette.accentYellow,
    HBPalette.accentPurple
]

private nonisolated enum SenseDashboardRange: Int, CaseIterable, Identifiable {
    case twoHours = 2
    case sixHours = 6
    case twentyFourHours = 24

    var id: Int { rawValue }

    var title: String {
        switch self {
        case .twoHours: return "2H"
        case .sixHours: return "6H"
        case .twentyFourHours: return "24H"
        }
    }
}

private nonisolated enum SenseTrendScale: String, CaseIterable, Identifiable {
    case day
    case week
    case month
    case year
    case cycle

    var id: String { rawValue }

    var title: String {
        switch self {
        case .day: return "Day Window"
        case .week: return "Week Window"
        case .month: return "Month Window"
        case .year: return "Year Window"
        case .cycle: return "Billing Cycle"
        }
    }
}

private nonisolated func senseOptionalDouble(_ value: Any?) -> Double? {
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

private nonisolated func senseOptionalInt(_ value: Any?) -> Int? {
    if let value = value as? Int {
        return value
    }
    if let value = value as? NSNumber {
        return value.intValue
    }
    if let value = value as? String, let parsed = Int(value) {
        return parsed
    }
    return nil
}

private nonisolated func senseIsMaskedSecret(_ value: String) -> Bool {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return false }
    return trimmed.allSatisfy { $0 == "*" || $0 == "•" }
}

private nonisolated func senseDate(from value: String?) -> Date? {
    guard let value, !value.isEmpty else {
        return nil
    }
    return JSON.date(from: value)
}

private nonisolated func senseFormatDateTime(_ value: String?) -> String {
    guard let date = senseDate(from: value) else {
        return value?.isEmpty == false ? value ?? "Unknown" : "Never"
    }

    return DateFormatter.localizedString(from: date, dateStyle: .medium, timeStyle: .short)
}

private nonisolated func senseFormatChartTime(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeStyle = .short
    formatter.dateStyle = .none
    return formatter.string(from: date)
}

private nonisolated func senseFormatPower(_ value: Double?) -> String {
    guard let value else { return "--" }
    return "\(Int(value.rounded()).formatted()) W"
}

private nonisolated func senseFormatEnergy(_ value: Double?) -> String {
    guard let value else { return "--" }

    let magnitude = abs(value)
    let digits: Int
    if magnitude >= 100 {
        digits = 0
    } else if magnitude >= 10 {
        digits = 1
    } else {
        digits = 2
    }

    return "\(value.formatted(.number.precision(.fractionLength(0...digits)))) kWh"
}

private nonisolated func senseFormatPercent(_ value: Double?, digits: Int = 0) -> String {
    guard let value else { return "--" }
    return "\(value.formatted(.number.precision(.fractionLength(0...digits))))%"
}

private nonisolated func senseFormatVoltage(_ values: [Double]) -> String {
    guard !values.isEmpty else { return "--" }
    return values.map { "\($0.formatted(.number.precision(.fractionLength(0...1))))V" }.joined(separator: " / ")
}

private nonisolated func sensePowerAxisLabel(_ value: Double) -> String {
    let rounded = (value / 100).rounded() * 100
    return "\(Int(rounded).formatted())W"
}

private nonisolated func senseBarColor(_ ratio: Double) -> Color {
    let bounded = max(0, min(1, ratio))
    let hue = 0.40 - (bounded * 0.38)
    return Color(hue: hue, saturation: 0.84, brightness: 0.98)
}

private nonisolated struct SenseMonitorOption: Identifiable, Equatable {
    let id: String
    let name: String
    let timezone: String
    let solarConfigured: Bool

    static func from(_ object: [String: Any]) -> SenseMonitorOption {
        SenseMonitorOption(
            id: JSON.string(object, "id"),
            name: JSON.string(object, "name", fallback: "Sense Monitor"),
            timezone: JSON.string(object, "timezone"),
            solarConfigured: JSON.bool(object, "solarConfigured")
        )
    }
}

private nonisolated struct SenseTrendWindowSummary: Equatable {
    let startAt: String?
    let syncedAt: String?
    let consumptionTotalKwh: Double?
    let productionTotalKwh: Double?
    let productionPct: Double?
    let netProductionKwh: Double?
    let fromGridKwh: Double?
    let toGridKwh: Double?
    let solarPoweredPct: Double?

    static func from(_ object: [String: Any]) -> SenseTrendWindowSummary {
        SenseTrendWindowSummary(
            startAt: JSON.optionalString(object, "startAt"),
            syncedAt: JSON.optionalString(object, "syncedAt"),
            consumptionTotalKwh: senseOptionalDouble(object["consumptionTotalKwh"]),
            productionTotalKwh: senseOptionalDouble(object["productionTotalKwh"]),
            productionPct: senseOptionalDouble(object["productionPct"]),
            netProductionKwh: senseOptionalDouble(object["netProductionKwh"]),
            fromGridKwh: senseOptionalDouble(object["fromGridKwh"]),
            toGridKwh: senseOptionalDouble(object["toGridKwh"]),
            solarPoweredPct: senseOptionalDouble(object["solarPoweredPct"])
        )
    }
}

private nonisolated struct SenseIntegrationStatus: Equatable {
    let email: String
    let password: String
    let passwordConfigured: Bool
    let monitorId: String
    let monitorName: String
    let enabled: Bool
    let realtimeEnabled: Bool
    let room: String
    let pollIntervalSeconds: Int
    let trendSyncIntervalMinutes: Int
    let availableMonitors: [SenseMonitorOption]
    let solarConfigured: Bool
    let isConnected: Bool
    let lastAuthenticatedAt: String?
    let lastRealtimeAt: String?
    let lastTrendSyncAt: String?
    let lastSyncAt: String?
    let lastError: String

    static func from(_ object: [String: Any]) -> SenseIntegrationStatus {
        SenseIntegrationStatus(
            email: JSON.string(object, "email"),
            password: JSON.string(object, "password"),
            passwordConfigured: JSON.bool(object, "passwordConfigured"),
            monitorId: JSON.string(object, "monitorId"),
            monitorName: JSON.string(object, "monitorName"),
            enabled: JSON.bool(object, "enabled"),
            realtimeEnabled: JSON.bool(object, "realtimeEnabled", fallback: true),
            room: JSON.string(object, "room", fallback: "Electrical Panel"),
            pollIntervalSeconds: JSON.int(object, "pollIntervalSeconds", fallback: 10),
            trendSyncIntervalMinutes: JSON.int(object, "trendSyncIntervalMinutes", fallback: 15),
            availableMonitors: JSON.array(object["availableMonitors"]).map(SenseMonitorOption.from),
            solarConfigured: JSON.bool(object, "solarConfigured"),
            isConnected: JSON.bool(object, "isConnected"),
            lastAuthenticatedAt: JSON.optionalString(object, "lastAuthenticatedAt"),
            lastRealtimeAt: JSON.optionalString(object, "lastRealtimeAt"),
            lastTrendSyncAt: JSON.optionalString(object, "lastTrendSyncAt"),
            lastSyncAt: JSON.optionalString(object, "lastSyncAt"),
            lastError: JSON.string(object, "lastError")
        )
    }
}

private nonisolated struct SenseStatusHealthSnapshot: Equatable {
    let isConnected: Bool
    let websocketConnected: Bool
    let websocketLastConnectedAt: String?
    let websocketLastMessageAt: String?
    let websocketReconnectCount: Int
    let lastAuthenticatedAt: String?
    let lastRealtimeAt: String?
    let lastTrendSyncAt: String?
    let lastError: String

    static func from(_ object: [String: Any]) -> SenseStatusHealthSnapshot {
        SenseStatusHealthSnapshot(
            isConnected: JSON.bool(object, "isConnected"),
            websocketConnected: JSON.bool(object, "websocketConnected"),
            websocketLastConnectedAt: JSON.optionalString(object, "websocketLastConnectedAt"),
            websocketLastMessageAt: JSON.optionalString(object, "websocketLastMessageAt"),
            websocketReconnectCount: JSON.int(object, "websocketReconnectCount"),
            lastAuthenticatedAt: JSON.optionalString(object, "lastAuthenticatedAt"),
            lastRealtimeAt: JSON.optionalString(object, "lastRealtimeAt"),
            lastTrendSyncAt: JSON.optionalString(object, "lastTrendSyncAt"),
            lastError: JSON.string(object, "lastError")
        )
    }
}

private nonisolated struct SenseLatestSnapshot: Equatable {
    let observedAt: String?
    let powerW: Double?
    let solarW: Double?
    let netW: Double?
    let alwaysOnW: Double?
    let activeDeviceCount: Int

    static func from(_ object: [String: Any]) -> SenseLatestSnapshot {
        SenseLatestSnapshot(
            observedAt: JSON.optionalString(object, "observedAt"),
            powerW: senseOptionalDouble(object["powerW"]),
            solarW: senseOptionalDouble(object["solarW"]),
            netW: senseOptionalDouble(object["netW"]),
            alwaysOnW: senseOptionalDouble(object["alwaysOnW"]),
            activeDeviceCount: JSON.int(object, "activeDeviceCount")
        )
    }
}

private nonisolated struct SenseStatusSnapshot {
    let integration: SenseIntegrationStatus
    let health: SenseStatusHealthSnapshot
    let latestSnapshot: SenseLatestSnapshot?
    let latestTrends: [String: SenseTrendWindowSummary]
    let monitors: [SenseMonitorOption]

    static func from(_ object: [String: Any]) -> SenseStatusSnapshot {
        let integration = SenseIntegrationStatus.from(JSON.object(object["integration"]))
        let topLevelMonitors = JSON.array(object["monitors"]).map(SenseMonitorOption.from)
        return SenseStatusSnapshot(
            integration: integration,
            health: SenseStatusHealthSnapshot.from(JSON.object(object["health"])),
            latestSnapshot: JSON.object(object["latestSnapshot"]).isEmpty ? nil : SenseLatestSnapshot.from(JSON.object(object["latestSnapshot"])),
            latestTrends: SenseStatusSnapshot.trendMap(from: object["latestTrends"]),
            monitors: topLevelMonitors.isEmpty ? integration.availableMonitors : topLevelMonitors
        )
    }

    private static func trendMap(from value: Any?) -> [String: SenseTrendWindowSummary] {
        let object = JSON.object(value)
        var result: [String: SenseTrendWindowSummary] = [:]
        object.forEach { key, rawValue in
            result[key] = SenseTrendWindowSummary.from(JSON.object(rawValue))
        }
        return result
    }
}

private nonisolated struct SenseDashboardMonitor: Equatable {
    let monitorId: String
    let name: String
    let room: String
    let solarConfigured: Bool

    static func from(_ object: [String: Any]) -> SenseDashboardMonitor {
        SenseDashboardMonitor(
            monitorId: JSON.string(object, "monitorId"),
            name: JSON.string(object, "name", fallback: "Sense Monitor"),
            room: JSON.string(object, "room", fallback: "Electrical Panel"),
            solarConfigured: JSON.bool(object, "solarConfigured")
        )
    }
}

private nonisolated struct SenseDashboardHealthSnapshot: Equatable {
    let isConnected: Bool
    let websocketConnected: Bool
    let lastRealtimeAt: String?
    let lastTrendSyncAt: String?
    let lastError: String

    static func from(_ object: [String: Any]) -> SenseDashboardHealthSnapshot {
        SenseDashboardHealthSnapshot(
            isConnected: JSON.bool(object, "isConnected"),
            websocketConnected: JSON.bool(object, "websocketConnected"),
            lastRealtimeAt: JSON.optionalString(object, "lastRealtimeAt"),
            lastTrendSyncAt: JSON.optionalString(object, "lastTrendSyncAt"),
            lastError: JSON.string(object, "lastError")
        )
    }
}

private nonisolated struct SenseDashboardDevice: Identifiable, Equatable {
    let senseDeviceId: String
    let name: String
    let icon: String
    let powerW: Double
    let sharePct: Double
    let alwaysOn: Bool
    let synthetic: Bool

    var id: String { senseDeviceId }

    static func from(_ object: [String: Any]) -> SenseDashboardDevice {
        SenseDashboardDevice(
            senseDeviceId: JSON.string(object, "senseDeviceId"),
            name: JSON.string(object, "name", fallback: "Detected Load"),
            icon: JSON.string(object, "icon"),
            powerW: senseOptionalDouble(object["powerW"]) ?? 0,
            sharePct: senseOptionalDouble(object["sharePct"]) ?? 0,
            alwaysOn: JSON.bool(object, "alwaysOn"),
            synthetic: JSON.bool(object, "synthetic")
        )
    }
}

private nonisolated struct SenseDashboardLiveSnapshot: Equatable {
    let monitorId: String
    let monitorName: String
    let observedAt: String?
    let powerW: Double
    let solarW: Double
    let netW: Double
    let alwaysOnW: Double?
    let otherW: Double
    let untrackedW: Double
    let activeDeviceCount: Int
    let frequencyHz: Double?
    let voltage: [Double]
    let activeDevices: [SenseDashboardDevice]

    static func from(_ object: [String: Any]) -> SenseDashboardLiveSnapshot {
        SenseDashboardLiveSnapshot(
            monitorId: JSON.string(object, "monitorId"),
            monitorName: JSON.string(object, "monitorName", fallback: "Sense Monitor"),
            observedAt: JSON.optionalString(object, "observedAt"),
            powerW: senseOptionalDouble(object["powerW"]) ?? 0,
            solarW: senseOptionalDouble(object["solarW"]) ?? 0,
            netW: senseOptionalDouble(object["netW"]) ?? 0,
            alwaysOnW: senseOptionalDouble(object["alwaysOnW"]),
            otherW: senseOptionalDouble(object["otherW"]) ?? 0,
            untrackedW: senseOptionalDouble(object["untrackedW"]) ?? 0,
            activeDeviceCount: JSON.int(object, "activeDeviceCount"),
            frequencyHz: senseOptionalDouble(object["frequencyHz"]),
            voltage: (object["voltage"] as? [Any] ?? []).compactMap(senseOptionalDouble),
            activeDevices: JSON.array(object["activeDevices"]).map(SenseDashboardDevice.from)
        )
    }
}

private nonisolated struct SenseDashboardSnapshotPoint: Identifiable, Equatable {
    let observedAt: String
    let powerW: Double
    let solarW: Double
    let netW: Double
    let alwaysOnW: Double?
    let otherW: Double
    let activeDevices: [SenseDashboardDevice]

    var id: String { observedAt }
    var date: Date? { senseDate(from: observedAt) }

    func power(for senseDeviceId: String) -> Double? {
        activeDevices.first(where: { $0.senseDeviceId == senseDeviceId })?.powerW
    }

    static func from(_ object: [String: Any]) -> SenseDashboardSnapshotPoint {
        SenseDashboardSnapshotPoint(
            observedAt: JSON.string(object, "observedAt"),
            powerW: senseOptionalDouble(object["powerW"]) ?? 0,
            solarW: senseOptionalDouble(object["solarW"]) ?? 0,
            netW: senseOptionalDouble(object["netW"]) ?? 0,
            alwaysOnW: senseOptionalDouble(object["alwaysOnW"]),
            otherW: senseOptionalDouble(object["otherW"]) ?? 0,
            activeDevices: JSON.array(object["activeDevices"]).map(SenseDashboardDevice.from)
        )
    }
}

private nonisolated struct SenseRecentSnapshots: Equatable {
    let hours: Int
    let pointCount: Int
    let rawPointCount: Int
    let points: [SenseDashboardSnapshotPoint]

    static func from(_ object: [String: Any]) -> SenseRecentSnapshots {
        SenseRecentSnapshots(
            hours: JSON.int(object, "hours", fallback: 6),
            pointCount: JSON.int(object, "pointCount"),
            rawPointCount: JSON.int(object, "rawPointCount"),
            points: JSON.array(object["points"]).map(SenseDashboardSnapshotPoint.from)
        )
    }
}

private nonisolated struct SenseDeviceUsageWindow: Equatable {
    let energyKwh: Double?
    let sharePct: Double?

    static func from(_ object: [String: Any]) -> SenseDeviceUsageWindow {
        SenseDeviceUsageWindow(
            energyKwh: senseOptionalDouble(object["energyKwh"]),
            sharePct: senseOptionalDouble(object["sharePct"])
        )
    }
}

private nonisolated struct SenseDashboardDeviceUsage: Identifiable, Equatable {
    let senseDeviceId: String
    let name: String
    let icon: String
    let room: String
    let currentPowerW: Double
    let currentSharePct: Double
    let day: SenseDeviceUsageWindow?
    let week: SenseDeviceUsageWindow?
    let month: SenseDeviceUsageWindow?
    let year: SenseDeviceUsageWindow?
    let cycle: SenseDeviceUsageWindow?

    var id: String { senseDeviceId }

    static func from(_ object: [String: Any]) -> SenseDashboardDeviceUsage {
        let dayObject = JSON.object(object["day"])
        let weekObject = JSON.object(object["week"])
        let monthObject = JSON.object(object["month"])
        let yearObject = JSON.object(object["year"])
        let cycleObject = JSON.object(object["cycle"])

        return SenseDashboardDeviceUsage(
            senseDeviceId: JSON.string(object, "senseDeviceId"),
            name: JSON.string(object, "name", fallback: "Detected Load"),
            icon: JSON.string(object, "icon"),
            room: JSON.string(object, "room"),
            currentPowerW: senseOptionalDouble(object["currentPowerW"]) ?? 0,
            currentSharePct: senseOptionalDouble(object["currentSharePct"]) ?? 0,
            day: dayObject.isEmpty ? nil : SenseDeviceUsageWindow.from(dayObject),
            week: weekObject.isEmpty ? nil : SenseDeviceUsageWindow.from(weekObject),
            month: monthObject.isEmpty ? nil : SenseDeviceUsageWindow.from(monthObject),
            year: yearObject.isEmpty ? nil : SenseDeviceUsageWindow.from(yearObject),
            cycle: cycleObject.isEmpty ? nil : SenseDeviceUsageWindow.from(cycleObject)
        )
    }
}

private nonisolated struct SenseDashboardSnapshot {
    let integration: SenseIntegrationStatus
    let generatedAt: String?
    let monitor: SenseDashboardMonitor
    let health: SenseDashboardHealthSnapshot
    let live: SenseDashboardLiveSnapshot?
    let recentSnapshots: SenseRecentSnapshots
    let trends: [String: SenseTrendWindowSummary]
    let activeDevices: [SenseDashboardDevice]
    let deviceUsage: [SenseDashboardDeviceUsage]

    static func from(_ object: [String: Any]) -> SenseDashboardSnapshot {
        SenseDashboardSnapshot(
            integration: SenseIntegrationStatus.from(JSON.object(object["integration"])),
            generatedAt: JSON.optionalString(object, "generatedAt"),
            monitor: SenseDashboardMonitor.from(JSON.object(object["monitor"])),
            health: SenseDashboardHealthSnapshot.from(JSON.object(object["health"])),
            live: JSON.object(object["live"]).isEmpty ? nil : SenseDashboardLiveSnapshot.from(JSON.object(object["live"])),
            recentSnapshots: SenseRecentSnapshots.from(JSON.object(object["recentSnapshots"])),
            trends: SenseDashboardSnapshot.trendMap(from: object["trends"]),
            activeDevices: JSON.array(object["activeDevices"]).map(SenseDashboardDevice.from),
            deviceUsage: JSON.array(object["deviceUsage"]).map(SenseDashboardDeviceUsage.from)
        )
    }

    private static func trendMap(from value: Any?) -> [String: SenseTrendWindowSummary] {
        let object = JSON.object(value)
        var result: [String: SenseTrendWindowSummary] = [:]
        object.forEach { key, rawValue in
            result[key] = SenseTrendWindowSummary.from(JSON.object(rawValue))
        }
        return result
    }
}

private nonisolated struct SenseConnectionTestResult {
    let monitors: [SenseMonitorOption]
    let monitorName: String
    let monitorId: String
    let solarConfigured: Bool
    let timezone: String
    let model: String

    static func from(_ object: [String: Any]) -> SenseConnectionTestResult {
        let monitor = JSON.object(object["monitor"])
        return SenseConnectionTestResult(
            monitors: JSON.array(object["monitors"]).map(SenseMonitorOption.from),
            monitorName: JSON.string(monitor, "name", fallback: "Sense Monitor"),
            monitorId: JSON.string(monitor, "monitorId"),
            solarConfigured: JSON.bool(monitor, "solarConfigured"),
            timezone: JSON.string(monitor, "timezone"),
            model: JSON.string(monitor, "model", fallback: "Home Energy Monitor")
        )
    }
}

private nonisolated struct SenseConfigForm {
    var email = ""
    var password = ""
    var mfaCode = ""
    var monitorId = ""
    var enabled = false
    var realtimeEnabled = true
    var room = "Electrical Panel"
    var pollIntervalSeconds = 10
    var trendSyncIntervalMinutes = 15

    mutating func apply(_ integration: SenseIntegrationStatus) {
        email = integration.email
        password = integration.passwordConfigured || senseIsMaskedSecret(integration.password)
            ? senseConfiguredSecretPlaceholder
            : integration.password
        mfaCode = ""
        monitorId = integration.monitorId
        enabled = integration.enabled
        realtimeEnabled = integration.realtimeEnabled
        room = integration.room
        pollIntervalSeconds = integration.pollIntervalSeconds
        trendSyncIntervalMinutes = integration.trendSyncIntervalMinutes
    }
}

private nonisolated struct SenseDisplayCard: Identifiable {
    let id: String
    let title: String
    let value: String
    let detail: String
    let color: Color
}

private nonisolated struct SenseChartDeviceLine: Identifiable {
    let id: String
    let senseDeviceId: String
    let name: String
    let color: Color
}

struct SenseEnergyView: View {
    @EnvironmentObject private var session: SessionStore
    @Environment(\.scenePhase) private var scenePhase

    @State private var dashboard: SenseDashboardSnapshot?
    @State private var status: SenseStatusSnapshot?
    @State private var monitorOptions: [SenseMonitorOption] = []
    @State private var lastTestResult: SenseConnectionTestResult?
    @State private var form = SenseConfigForm()
    @State private var selectedRange: SenseDashboardRange = .sixHours
    @State private var isLoading = true
    @State private var isRefreshing = false
    @State private var isTesting = false
    @State private var isSaving = false
    @State private var isSyncing = false
    @State private var errorMessage: String?
    @State private var infoMessage = ""

    private var isAdmin: Bool {
        session.currentUser?.role == "admin"
    }

    private var activeIntegration: SenseIntegrationStatus? {
        status?.integration ?? dashboard?.integration
    }

    private var liveSnapshot: SenseDashboardLiveSnapshot? {
        dashboard?.live
    }

    private var activeDevices: [SenseDashboardDevice] {
        dashboard?.activeDevices ?? []
    }

    private var chartPoints: [SenseDashboardSnapshotPoint] {
        (dashboard?.recentSnapshots.points ?? []).filter { $0.date != nil }
    }

    private var maxDevicePower: Double {
        max(1, activeDevices.map(\.powerW).max() ?? 1)
    }

    private var topChartDevices: [SenseChartDeviceLine] {
        Array(activeDevices.filter { !$0.synthetic }.prefix(6).enumerated()).map { index, device in
            SenseChartDeviceLine(
                id: "\(device.senseDeviceId)-\(index)",
                senseDeviceId: device.senseDeviceId,
                name: device.name,
                color: senseDeviceLineColors[index % senseDeviceLineColors.count]
            )
        }
    }

    private var peakSnapshot: SenseDashboardSnapshotPoint? {
        chartPoints.max { $0.powerW < $1.powerW }
    }

    private var selectedMonitorLabel: String {
        guard !form.monitorId.isEmpty else {
            return "Use current or first discovered monitor"
        }

        return monitorOptions.first(where: { $0.id == form.monitorId })?.name ?? form.monitorId
    }

    private var autoRefreshTaskKey: String {
        "\(selectedRange.rawValue)-\(dashboard?.integration.enabled == true)-\(scenePhase == .active)"
    }

    private var summaryCards: [SenseDisplayCard] {
        let live = liveSnapshot
        let solarSubtitle = dashboard?.monitor.solarConfigured == true
            ? "Solar production and current net household draw."
            : "Consumption-only monitor profile right now."

        return [
            SenseDisplayCard(
                id: "whole-home",
                title: "Whole Home",
                value: senseFormatPower(live?.powerW),
                detail: "Last realtime update \(senseFormatDateTime(dashboard?.health.lastRealtimeAt ?? live?.observedAt))",
                color: HBPalette.accentYellow
            ),
            SenseDisplayCard(
                id: "solar-net",
                title: "Solar / Net",
                value: "\(senseFormatPower(live?.solarW)) / \(senseFormatPower(live?.netW))",
                detail: solarSubtitle,
                color: HBPalette.accentGreen
            ),
            SenseDisplayCard(
                id: "active-loads",
                title: "Active Loads",
                value: "\((live?.activeDeviceCount ?? 0).formatted())",
                detail: activeDevices.first.map { "\($0.name) • \(senseFormatPower($0.powerW))" } ?? "Sense is not reporting active device loads yet.",
                color: HBPalette.accentBlue
            ),
            SenseDisplayCard(
                id: "always-on",
                title: "Always-On Floor",
                value: senseFormatPower(live?.alwaysOnW),
                detail: "Voltage \(senseFormatVoltage(live?.voltage ?? []))\(live?.frequencyHz == nil ? "" : " • \(live?.frequencyHz?.formatted(.number.precision(.fractionLength(0...2))) ?? "--") Hz")",
                color: HBPalette.accentOrange
            )
        ]
    }

    private var insightCards: [SenseDisplayCard] {
        let leadDevice = activeDevices.first
        let live = liveSnapshot
        let solarOffset: Double? = {
            guard let power = live?.powerW, power > 0 else { return nil }
            return min(100, max(0, ((live?.solarW ?? 0) / power) * 100))
        }()

        let alwaysOnShare: Double? = {
            guard let power = live?.powerW,
                  let alwaysOn = live?.alwaysOnW,
                  power > 0 else { return nil }
            return (alwaysOn / power) * 100
        }()

        return [
            SenseDisplayCard(
                id: "always-on-share",
                title: "Always-On Floor",
                value: senseFormatPower(live?.alwaysOnW),
                detail: alwaysOnShare == nil
                    ? "Baseline draw that tends to stay present all day."
                    : "\(senseFormatPercent(alwaysOnShare, digits: 0)) of current household draw",
                color: HBPalette.accentBlue
            ),
            SenseDisplayCard(
                id: "lead-load",
                title: "Lead Load",
                value: leadDevice?.name ?? "No active device",
                detail: leadDevice == nil
                    ? "Sense is not reporting active detected devices right now."
                    : "\(senseFormatPower(leadDevice?.powerW)) • \(senseFormatPercent(leadDevice?.sharePct, digits: 0)) of live load",
                color: HBPalette.accentOrange
            ),
            SenseDisplayCard(
                id: "solar-offset",
                title: "Solar Offset",
                value: senseFormatPercent(solarOffset, digits: 0),
                detail: dashboard?.monitor.solarConfigured == true
                    ? "\(senseFormatPower(live?.solarW)) currently offsetting whole-home demand"
                    : "This monitor is operating in consumption-only mode.",
                color: HBPalette.accentGreen
            ),
            SenseDisplayCard(
                id: "window-peak",
                title: "Window Peak",
                value: senseFormatPower(peakSnapshot?.powerW),
                detail: peakSnapshot?.observedAt == nil
                    ? "No recent peak is available in this dashboard window yet."
                    : "Highest draw in this \(selectedRange.title.lowercased()) window at \(senseFormatDateTime(peakSnapshot?.observedAt))",
                color: HBPalette.accentRed
            )
        ]
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                heroPanel

                if let errorMessage {
                    InlineErrorView(message: errorMessage) {
                        Task { await loadContent(showLoading: true) }
                    }
                }

                if !infoMessage.isEmpty {
                    HBPanel {
                        Text(infoMessage)
                            .font(.system(size: 13, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                if isAdmin {
                    adminSetupPanel
                }

                if isLoading && dashboard == nil {
                    LoadingView(title: "Loading Sense energy dashboard...")
                } else if let dashboard {
                    if dashboard.integration.enabled {
                        summaryGrid
                        visualizationPanels
                        insightGrid
                        reportingPanels
                    } else {
                        configurationPrompt(using: dashboard)
                    }
                } else {
                    EmptyStateView(
                        title: "Sense Energy is unavailable",
                        subtitle: "HomeBrain could not load the Sense dashboard right now."
                    )
                }
            }
            .padding(16)
            .padding(.bottom, 8)
        }
        .scrollIndicators(.hidden)
        .refreshable {
            await loadContent(showLoading: false)
        }
        .task {
            await loadContent(showLoading: true)
        }
        .task(id: autoRefreshTaskKey) {
            await runAutoRefreshLoop()
        }
    }

    private var heroPanel: some View {
        HBDeckSurface {
            VStack(alignment: .leading, spacing: 18) {
                HStack(alignment: .top, spacing: 14) {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Power Intelligence")
                            .font(.system(size: 11, weight: .bold, design: .rounded))
                            .textCase(.uppercase)
                            .tracking(2.4)
                            .foregroundStyle(HBPalette.textMuted)

                        Text("Sense Energy")
                            .font(.system(size: 30, weight: .bold, design: .rounded))
                            .foregroundStyle(HBPalette.textPrimary)

                        Text("Whole-home draw, per-device load bars, live utilization overlays, and report-grade energy windows now live together in the native iOS app.")
                            .font(.system(size: 14, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)

                        HStack(spacing: 8) {
                            HBBadge(
                                text: dashboard?.health.websocketConnected == true ? "Live Feed" : (dashboard?.health.isConnected == true ? "Polling" : "Standby"),
                                foreground: dashboard?.health.isConnected == true ? HBPalette.accentGreen : HBPalette.textPrimary,
                                background: dashboard?.health.isConnected == true ? HBPalette.accentGreen.opacity(0.16) : HBPalette.panelSoft,
                                stroke: dashboard?.health.isConnected == true ? HBPalette.accentGreen.opacity(0.7) : HBPalette.panelStrokeStrong
                            )
                            HBBadge(text: "\((liveSnapshot?.activeDeviceCount ?? 0).formatted()) active loads")
                            if dashboard?.monitor.solarConfigured == true {
                                HBBadge(text: "Solar aware")
                            }
                        }
                    }

                    Spacer(minLength: 0)

                    VStack(alignment: .trailing, spacing: 10) {
                        HStack(spacing: 8) {
                            ForEach(SenseDashboardRange.allCases) { option in
                                Button {
                                    selectedRange = option
                                    Task {
                                        do {
                                            try await loadDashboard(showLoading: false)
                                        } catch {
                                            errorMessage = error.localizedDescription
                                        }
                                    }
                                } label: {
                                    Text(option.title)
                                        .font(.system(size: 12, weight: .bold, design: .rounded))
                                        .frame(minWidth: 44)
                                }
                                .buttonStyle(.borderedProminent)
                                .tint(selectedRange == option ? HBPalette.accentBlue : HBPalette.accentSlate)
                            }
                        }

                        Button {
                            Task { await loadContent(showLoading: false) }
                        } label: {
                            Label(isRefreshing ? "Refreshing..." : "Refresh", systemImage: "arrow.clockwise")
                        }
                        .buttonStyle(HBSecondaryButtonStyle())

                        if isAdmin {
                            Button {
                                Task { await syncSense() }
                            } label: {
                                Label(isSyncing ? "Syncing..." : "Sync Sense", systemImage: "bolt.horizontal")
                            }
                            .buttonStyle(HBPrimaryButtonStyle())
                            .disabled(isSyncing)
                        }
                    }
                }

                HStack(spacing: 12) {
                    senseHeroFact(title: "Realtime", value: senseFormatDateTime(dashboard?.health.lastRealtimeAt ?? liveSnapshot?.observedAt))
                    senseHeroFact(title: "Trend Sync", value: senseFormatDateTime(dashboard?.health.lastTrendSyncAt))
                    senseHeroFact(title: "Monitor", value: dashboard?.monitor.name.isEmpty == false ? dashboard?.monitor.name ?? "Sense Monitor" : "Sense Monitor")
                    senseHeroFact(title: "Data Platform", value: "Report Ready")
                }
            }
            .padding(18)
        }
    }

    private var adminSetupPanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Sense Account Setup")
                            .font(.system(size: 20, weight: .bold, design: .rounded))
                            .foregroundStyle(HBPalette.textPrimary)

                        Text("Authenticate the Sense account, choose the monitor, and tune how HomeBrain keeps the realtime feed and report windows in sync.")
                            .font(.system(size: 13, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    Spacer(minLength: 0)

                    HBBadge(
                        text: status?.health.isConnected == true ? "Connected" : "Standby",
                        foreground: status?.health.isConnected == true ? HBPalette.accentGreen : HBPalette.textPrimary,
                        background: status?.health.isConnected == true ? HBPalette.accentGreen.opacity(0.16) : HBPalette.panelSoft,
                        stroke: status?.health.isConnected == true ? HBPalette.accentGreen.opacity(0.7) : HBPalette.panelStrokeStrong
                    )
                }

                LazyVGrid(columns: [GridItem(.adaptive(minimum: 190), spacing: 12)], spacing: 12) {
                    senseRuntimeTile(
                        title: "Live Draw",
                        value: senseFormatPower(status?.latestSnapshot?.powerW ?? liveSnapshot?.powerW),
                        detail: "Latest whole-home reading captured by HomeBrain.",
                        accent: HBPalette.accentYellow
                    )
                    senseRuntimeTile(
                        title: "Realtime Feed",
                        value: status?.health.websocketConnected == true ? "Live" : "Polling",
                        detail: "Last message \(senseFormatDateTime(status?.health.websocketLastMessageAt))",
                        accent: HBPalette.accentBlue
                    )
                    senseRuntimeTile(
                        title: "Trend Sync",
                        value: "\((status?.integration.trendSyncIntervalMinutes ?? 15).formatted()) min",
                        detail: "Last sync \(senseFormatDateTime(status?.health.lastTrendSyncAt))",
                        accent: HBPalette.accentGreen
                    )
                    senseRuntimeTile(
                        title: "Monitor",
                        value: activeIntegration?.monitorName.isEmpty == false ? activeIntegration?.monitorName ?? "Not selected" : "Not selected",
                        detail: activeIntegration?.solarConfigured == true ? "Solar-enabled monitor detected." : "Consumption-only profile right now.",
                        accent: HBPalette.accentOrange
                    )
                }

                LazyVGrid(columns: [GridItem(.adaptive(minimum: 220), spacing: 12)], spacing: 12) {
                    senseFieldGroup(title: "Sense Account Email") {
                        TextField("you@example.com", text: $form.email)
                            .textInputAutocapitalization(.never)
                            .disableAutocorrection(true)
                            .keyboardType(.emailAddress)
                            .hbPanelTextField()
                    }

                    senseFieldGroup(title: "Sense Password") {
                        SecureField("Enter Sense password", text: $form.password)
                            .textInputAutocapitalization(.never)
                            .disableAutocorrection(true)
                            .hbPanelTextField()
                        Text(activeIntegration?.passwordConfigured == true
                             ? "A password is already stored. Enter a new value only if you want to replace it."
                             : "HomeBrain uses the password to establish or recover the Sense session.")
                            .font(.system(size: 11, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textMuted)
                    }

                    senseFieldGroup(title: "MFA Code") {
                        TextField("Only needed when Sense requests MFA", text: $form.mfaCode)
                            .textInputAutocapitalization(.never)
                            .disableAutocorrection(true)
                            .hbPanelTextField()
                    }

                    senseFieldGroup(title: "HomeBrain Room") {
                        TextField("Electrical Panel", text: $form.room)
                            .hbPanelTextField()
                    }

                    senseFieldGroup(title: "Monitor") {
                        Menu {
                            Button("Use current or first discovered monitor") {
                                form.monitorId = ""
                            }

                            ForEach(monitorOptions) { monitor in
                                Button(monitor.name) {
                                    form.monitorId = monitor.id
                                }
                            }
                        } label: {
                            HStack {
                                Text(selectedMonitorLabel)
                                    .foregroundStyle(HBPalette.textPrimary)
                                    .lineLimit(1)
                                Spacer(minLength: 0)
                                Image(systemName: "chevron.up.chevron.down")
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundStyle(HBPalette.textMuted)
                            }
                            .hbPanelTextField()
                        }
                        .buttonStyle(.plain)
                    }

                    senseFieldGroup(title: "Poll Every (sec)") {
                        TextField("10", value: $form.pollIntervalSeconds, format: .number)
                            .keyboardType(.numberPad)
                            .hbPanelTextField()
                    }

                    senseFieldGroup(title: "Trend Sync (min)") {
                        TextField("15", value: $form.trendSyncIntervalMinutes, format: .number)
                            .keyboardType(.numberPad)
                            .hbPanelTextField()
                    }
                }

                HStack(spacing: 12) {
                    HBCardRow {
                        Toggle(isOn: $form.enabled) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Enable Sense Integration")
                                    .font(.system(size: 14, weight: .semibold, design: .rounded))
                                    .foregroundStyle(HBPalette.textPrimary)
                                Text("Persist monitor snapshots, trend windows, and device telemetry.")
                                    .font(.system(size: 12, weight: .medium, design: .rounded))
                                    .foregroundStyle(HBPalette.textSecondary)
                            }
                        }
                        .tint(HBPalette.accentBlue)
                    }

                    HBCardRow {
                        Toggle(isOn: $form.realtimeEnabled) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Realtime Websocket Feed")
                                    .font(.system(size: 14, weight: .semibold, design: .rounded))
                                    .foregroundStyle(HBPalette.textPrimary)
                                Text("Keep a live session open for near-real-time dashboard updates.")
                                    .font(.system(size: 12, weight: .medium, design: .rounded))
                                    .foregroundStyle(HBPalette.textSecondary)
                            }
                        }
                        .tint(HBPalette.accentBlue)
                    }
                }

                HStack(spacing: 10) {
                    Button {
                        Task { await testConnection() }
                    } label: {
                        Label(isTesting ? "Testing..." : "Test Sense Account", systemImage: "checkmark.seal")
                    }
                    .buttonStyle(HBSecondaryButtonStyle())
                    .disabled(isTesting)

                    Button {
                        Task { await saveConfiguration() }
                    } label: {
                        Label(isSaving ? "Saving..." : "Save Sense Config", systemImage: "square.and.arrow.down")
                    }
                    .buttonStyle(HBPrimaryButtonStyle())
                    .disabled(isSaving)

                    Button {
                        Task { await syncSense() }
                    } label: {
                        Label(isSyncing ? "Syncing..." : "Sync Sense Now", systemImage: "arrow.triangle.2.circlepath")
                    }
                    .buttonStyle(HBSecondaryButtonStyle())
                    .disabled(isSyncing)
                }

                if let lastTestResult {
                    HBCardRow {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text("Verified Monitor")
                                    .font(.system(size: 15, weight: .bold, design: .rounded))
                                    .foregroundStyle(HBPalette.textPrimary)
                                Spacer(minLength: 0)
                                HBBadge(
                                    text: lastTestResult.solarConfigured ? "Solar configured" : "Consumption only",
                                    foreground: lastTestResult.solarConfigured ? HBPalette.accentGreen : HBPalette.textPrimary,
                                    background: lastTestResult.solarConfigured ? HBPalette.accentGreen.opacity(0.16) : HBPalette.panelSoft,
                                    stroke: lastTestResult.solarConfigured ? HBPalette.accentGreen.opacity(0.7) : HBPalette.panelStrokeStrong
                                )
                            }

                            Text(lastTestResult.monitorName)
                                .font(.system(size: 18, weight: .bold, design: .rounded))
                                .foregroundStyle(HBPalette.textPrimary)

                            Text("\(lastTestResult.model) • \(lastTestResult.timezone.isEmpty ? "Timezone unavailable" : lastTestResult.timezone)")
                                .font(.system(size: 12, weight: .medium, design: .rounded))
                                .foregroundStyle(HBPalette.textSecondary)
                        }
                    }
                }

                HBCardRow {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 10) {
                            Image(systemName: status?.health.isConnected == true ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                                .foregroundStyle(status?.health.isConnected == true ? HBPalette.accentGreen : HBPalette.accentOrange)

                            Text(status?.health.isConnected == true
                                 ? "Sense is feeding HomeBrain live energy data."
                                 : "Sense is configured but not currently streaming data.")
                                .font(.system(size: 15, weight: .bold, design: .rounded))
                                .foregroundStyle(HBPalette.textPrimary)
                        }

                        VStack(alignment: .leading, spacing: 4) {
                            Text("Last auth: \(senseFormatDateTime(status?.health.lastAuthenticatedAt))")
                            Text("Last realtime: \(senseFormatDateTime(status?.health.lastRealtimeAt))")
                            Text("Last trend sync: \(senseFormatDateTime(status?.health.lastTrendSyncAt))")
                            Text("Reconnect count: \((status?.health.websocketReconnectCount ?? 0).formatted())")
                        }
                        .font(.system(size: 12, weight: .medium, design: .rounded))
                        .foregroundStyle(HBPalette.textSecondary)

                        if let error = status?.health.lastError, !error.isEmpty {
                            Text(error)
                                .font(.system(size: 12, weight: .medium, design: .rounded))
                                .foregroundStyle(HBPalette.accentOrange)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        }
    }

    private var summaryGrid: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 170), spacing: 12)], spacing: 12) {
            ForEach(summaryCards) { card in
                senseRuntimeTile(
                    title: card.title,
                    value: card.value,
                    detail: card.detail,
                    accent: card.color
                )
            }
        }
    }

    private var visualizationPanels: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .top, spacing: 12) {
                utilizationTimelinePanel
                realtimeDeviceLoadPanel
                    .frame(width: 360)
            }
            VStack(spacing: 12) {
                utilizationTimelinePanel
                realtimeDeviceLoadPanel
            }
        }
    }

    private var utilizationTimelinePanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Utilization Timeline")
                            .font(.system(size: 20, weight: .bold, design: .rounded))
                            .foregroundStyle(HBPalette.textPrimary)

                        Text("Whole-home draw with solar, baseline load, residual usage, and the heaviest active Sense devices on one chart.")
                            .font(.system(size: 13, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    Spacer(minLength: 0)

                    HBBadge(text: "\((dashboard?.recentSnapshots.rawPointCount ?? 0).formatted()) raw points")
                }

                if chartPoints.isEmpty {
                    EmptyStateView(
                        title: "No recent energy points",
                        subtitle: "Sense snapshots will appear here as HomeBrain ingests the realtime feed."
                    )
                } else {
                    Chart {
                        ForEach(chartPoints) { point in
                            if let date = point.date {
                                AreaMark(
                                    x: .value("Observed", date),
                                    y: .value("Whole Home", point.powerW)
                                )
                                .foregroundStyle(
                                    LinearGradient(
                                        colors: [Color.white.opacity(0.24), Color.white.opacity(0.03)],
                                        startPoint: .top,
                                        endPoint: .bottom
                                    )
                                )

                                LineMark(
                                    x: .value("Observed", date),
                                    y: .value("Whole Home", point.powerW)
                                )
                                .foregroundStyle(Color.white.opacity(0.92))
                                .lineStyle(StrokeStyle(lineWidth: 2.6, lineCap: .round, lineJoin: .round))
                                .interpolationMethod(.catmullRom)

                                LineMark(
                                    x: .value("Observed", date),
                                    y: .value("Solar", point.solarW)
                                )
                                .foregroundStyle(HBPalette.accentGreen)
                                .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                                .interpolationMethod(.catmullRom)

                                LineMark(
                                    x: .value("Observed", date),
                                    y: .value("Always On", point.alwaysOnW ?? 0)
                                )
                                .foregroundStyle(HBPalette.accentBlue)
                                .lineStyle(StrokeStyle(lineWidth: 1.8, lineCap: .round, dash: [5, 4]))
                                .interpolationMethod(.catmullRom)

                                LineMark(
                                    x: .value("Observed", date),
                                    y: .value("Other", point.otherW)
                                )
                                .foregroundStyle(HBPalette.accentOrange)
                                .lineStyle(StrokeStyle(lineWidth: 1.8, lineCap: .round, dash: [2, 4]))
                                .interpolationMethod(.catmullRom)
                            }
                        }

                        ForEach(topChartDevices) { device in
                            ForEach(chartPoints) { point in
                                if let date = point.date,
                                   let value = point.power(for: device.senseDeviceId) {
                                    LineMark(
                                        x: .value("Observed", date),
                                        y: .value(device.name, value)
                                    )
                                    .foregroundStyle(device.color)
                                    .lineStyle(StrokeStyle(lineWidth: 1.7, lineCap: .round, lineJoin: .round))
                                    .interpolationMethod(.catmullRom)
                                }
                            }
                        }

                        if let peakSnapshot,
                           let peakDate = peakSnapshot.date {
                            RuleMark(x: .value("Peak", peakDate))
                                .foregroundStyle(HBPalette.accentRed.opacity(0.55))
                                .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 4]))
                                .annotation(position: .top, alignment: .leading) {
                                    Text("Peak \(senseFormatPower(peakSnapshot.powerW))")
                                        .font(.system(size: 10, weight: .bold, design: .rounded))
                                        .foregroundStyle(HBPalette.textPrimary)
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 4)
                                        .background(HBGlassBackground(cornerRadius: 10, variant: .panelSoft))
                                }
                        }
                    }
                    .frame(height: 300)
                    .chartXAxis {
                        AxisMarks(values: .automatic(desiredCount: 5)) { value in
                            AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [2, 4]))
                                .foregroundStyle(HBPalette.divider.opacity(0.35))
                            AxisValueLabel {
                                if let date = value.as(Date.self) {
                                    Text(senseFormatChartTime(date))
                                        .font(.system(size: 10, weight: .medium, design: .rounded))
                                        .foregroundStyle(HBPalette.textMuted)
                                }
                            }
                        }
                    }
                    .chartYAxis {
                        AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { value in
                            AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [2, 4]))
                                .foregroundStyle(HBPalette.divider.opacity(0.28))
                            AxisValueLabel {
                                if let watts = value.as(Double.self) {
                                    Text(sensePowerAxisLabel(watts))
                                        .font(.system(size: 10, weight: .medium, design: .rounded))
                                        .foregroundStyle(HBPalette.textMuted)
                                }
                            }
                        }
                    }

                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            senseLegendChip(label: "Whole Home", color: Color.white)
                            senseLegendChip(label: "Solar", color: HBPalette.accentGreen)
                            senseLegendChip(label: "Always On", color: HBPalette.accentBlue)
                            senseLegendChip(label: "Other", color: HBPalette.accentOrange)
                            ForEach(topChartDevices) { device in
                                senseLegendChip(label: device.name, color: device.color)
                            }
                        }
                        .padding(.vertical, 2)
                    }

                    HBWeatherSyncCaption(value: dashboard?.health.lastRealtimeAt ?? liveSnapshot?.observedAt, label: "Last realtime")
                }
            }
        }
    }

    private var realtimeDeviceLoadPanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 16) {
                Text("Realtime Device Load")
                    .font(.system(size: 20, weight: .bold, design: .rounded))
                    .foregroundStyle(HBPalette.textPrimary)

                Text("Horizontal load bars shift from green toward red as a device becomes a larger current share of the household draw.")
                    .font(.system(size: 13, weight: .medium, design: .rounded))
                    .foregroundStyle(HBPalette.textMuted)
                    .fixedSize(horizontal: false, vertical: true)

                if activeDevices.isEmpty {
                    EmptyStateView(
                        title: "No active device loads",
                        subtitle: "Sense is not reporting active per-device draw right now."
                    )
                } else {
                    VStack(spacing: 10) {
                        ForEach(Array(activeDevices.prefix(12))) { device in
                            HBCardRow {
                                VStack(alignment: .leading, spacing: 10) {
                                    HStack(alignment: .top, spacing: 10) {
                                        VStack(alignment: .leading, spacing: 4) {
                                            Text(device.name)
                                                .font(.system(size: 15, weight: .bold, design: .rounded))
                                                .foregroundStyle(HBPalette.textPrimary)
                                                .lineLimit(1)

                                            Text("\(device.synthetic ? "Residual bucket" : "Sense-detected device") • \(senseFormatPercent(device.sharePct, digits: 0)) of live load")
                                                .font(.system(size: 12, weight: .medium, design: .rounded))
                                                .foregroundStyle(HBPalette.textSecondary)
                                        }

                                        Spacer(minLength: 0)

                                        VStack(alignment: .trailing, spacing: 4) {
                                            Text(senseFormatPower(device.powerW))
                                                .font(.system(size: 16, weight: .bold, design: .rounded))
                                                .foregroundStyle(HBPalette.textPrimary)

                                            Text(device.synthetic ? "Residual" : "Active")
                                                .font(.system(size: 10, weight: .bold, design: .rounded))
                                                .textCase(.uppercase)
                                                .tracking(1.6)
                                                .foregroundStyle(HBPalette.textMuted)
                                        }
                                    }

                                    GeometryReader { proxy in
                                        let ratio = max(0.04, min(1, device.powerW / maxDevicePower))
                                        let barColor = senseBarColor(ratio)
                                        ZStack(alignment: .leading) {
                                            Capsule()
                                                .fill(HBPalette.panelSoft.opacity(0.85))

                                            Capsule()
                                                .fill(
                                                    LinearGradient(
                                                        colors: [barColor, Color.white.opacity(0.92)],
                                                        startPoint: .leading,
                                                        endPoint: .trailing
                                                    )
                                                )
                                                .frame(width: max(18, proxy.size.width * ratio))
                                        }
                                    }
                                    .frame(height: 14)
                                }
                            }
                        }
                    }

                    if activeDevices.count > 12 {
                        Text("Showing the top 12 of \(activeDevices.count.formatted()) active loads.")
                            .font(.system(size: 12, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textMuted)
                    }
                }
            }
        }
    }

    private var insightGrid: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 170), spacing: 12)], spacing: 12) {
            ForEach(insightCards) { card in
                senseRuntimeTile(
                    title: card.title,
                    value: card.value,
                    detail: card.detail,
                    accent: card.color
                )
            }
        }
    }

    private var reportingPanels: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .top, spacing: 12) {
                energyWindowsPanel
                deviceLedgerPanel
            }
            VStack(spacing: 12) {
                energyWindowsPanel
                deviceLedgerPanel
            }
        }
    }

    private var energyWindowsPanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 16) {
                Text("Energy Windows")
                    .font(.system(size: 20, weight: .bold, design: .rounded))
                    .foregroundStyle(HBPalette.textPrimary)

                Text("Consumption and solar totals persisted by HomeBrain for reporting, charting, and long-range analysis.")
                    .font(.system(size: 13, weight: .medium, design: .rounded))
                    .foregroundStyle(HBPalette.textMuted)
                    .fixedSize(horizontal: false, vertical: true)

                LazyVGrid(columns: [GridItem(.adaptive(minimum: 170), spacing: 12)], spacing: 12) {
                    ForEach(SenseTrendScale.allCases) { scale in
                        let trend = dashboard?.trends[scale.rawValue]
                        senseRuntimeTile(
                            title: scale.title,
                            value: senseFormatEnergy(trend?.consumptionTotalKwh),
                            detail: "Production \(senseFormatEnergy(trend?.productionTotalKwh)) • Grid \(senseFormatEnergy(trend?.fromGridKwh)) • Solar \(senseFormatPercent(trend?.solarPoweredPct, digits: 0)) • Synced \(senseFormatDateTime(trend?.syncedAt))",
                            accent: scale == .day ? HBPalette.accentYellow : (scale == .week ? HBPalette.accentBlue : (scale == .month ? HBPalette.accentGreen : (scale == .year ? HBPalette.accentPurple : HBPalette.accentOrange)))
                        )
                    }
                }
            }
        }
    }

    private var deviceLedgerPanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 16) {
                Text("Device Energy Ledger")
                    .font(.system(size: 20, weight: .bold, design: .rounded))
                    .foregroundStyle(HBPalette.textPrimary)

                Text("Live device draw plus daily, weekly, monthly, yearly, and billing-cycle energy totals from the persisted Sense trend fabric.")
                    .font(.system(size: 13, weight: .medium, design: .rounded))
                    .foregroundStyle(HBPalette.textMuted)
                    .fixedSize(horizontal: false, vertical: true)

                if (dashboard?.deviceUsage ?? []).isEmpty {
                    EmptyStateView(
                        title: "No device ledger yet",
                        subtitle: "Per-device energy windows will appear here as Sense trend data arrives."
                    )
                } else {
                    ScrollView(.horizontal, showsIndicators: false) {
                        VStack(spacing: 0) {
                            HStack(spacing: 10) {
                                senseLedgerHeader("Device", width: 180, alignment: .leading)
                                senseLedgerHeader("Now", width: 86)
                                senseLedgerHeader("Day", width: 78)
                                senseLedgerHeader("Week", width: 78)
                                senseLedgerHeader("Month", width: 78)
                                senseLedgerHeader("Year", width: 78)
                                senseLedgerHeader("Cycle", width: 78)
                            }
                            .padding(.horizontal, 12)
                            .padding(.bottom, 8)

                            ForEach(Array((dashboard?.deviceUsage ?? []).prefix(18))) { device in
                                Divider()
                                    .overlay(HBPalette.divider.opacity(0.32))

                                HStack(spacing: 10) {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(device.name)
                                            .font(.system(size: 14, weight: .bold, design: .rounded))
                                            .foregroundStyle(HBPalette.textPrimary)
                                            .lineLimit(1)

                                        Text(device.room.isEmpty ? "Whole home energy deck" : device.room)
                                            .font(.system(size: 11, weight: .medium, design: .rounded))
                                            .foregroundStyle(HBPalette.textSecondary)
                                            .lineLimit(1)
                                    }
                                    .frame(width: 180, alignment: .leading)

                                    senseLedgerValue(senseFormatPower(device.currentPowerW), width: 86)
                                    senseLedgerValue(senseFormatEnergy(device.day?.energyKwh), width: 78)
                                    senseLedgerValue(senseFormatEnergy(device.week?.energyKwh), width: 78)
                                    senseLedgerValue(senseFormatEnergy(device.month?.energyKwh), width: 78)
                                    senseLedgerValue(senseFormatEnergy(device.year?.energyKwh), width: 78)
                                    senseLedgerValue(senseFormatEnergy(device.cycle?.energyKwh), width: 78)
                                }
                                .padding(.horizontal, 12)
                                .padding(.vertical, 12)
                            }
                        }
                    }
                }
            }
        }
    }

    private func configurationPrompt(using dashboard: SenseDashboardSnapshot) -> some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 14) {
                Text("Sense Energy is ready once the account is connected.")
                    .font(.system(size: 18, weight: .bold, design: .rounded))
                    .foregroundStyle(HBPalette.textPrimary)

                Text(isAdmin
                     ? "Use the Sense Account Setup panel above to authenticate the account, choose the monitor, and enable realtime ingestion. Once connected, the live energy deck and report windows will appear here."
                     : "An administrator needs to finish the Sense setup before live power telemetry, device-level load bars, and historical energy reporting become available in the iOS app.")
                    .font(.system(size: 13, weight: .medium, design: .rounded))
                    .foregroundStyle(HBPalette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)

                if !dashboard.health.lastError.isEmpty {
                    Text(dashboard.health.lastError)
                        .font(.system(size: 12, weight: .medium, design: .rounded))
                        .foregroundStyle(HBPalette.accentOrange)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func senseHeroFact(title: String, value: String) -> some View {
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
                .minimumScaleFactor(0.78)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(HBGlassBackground(cornerRadius: 16, variant: .panelSoft))
    }

    private func senseRuntimeTile(title: String, value: String, detail: String, accent: Color) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.system(size: 11, weight: .bold, design: .rounded))
                .textCase(.uppercase)
                .tracking(2)
                .foregroundStyle(HBPalette.textMuted)

            Text(value)
                .font(.system(size: 22, weight: .bold, design: .rounded))
                .foregroundStyle(HBPalette.textPrimary)
                .lineLimit(2)
                .minimumScaleFactor(0.7)

            Text(detail)
                .font(.system(size: 12, weight: .medium, design: .rounded))
                .foregroundStyle(HBPalette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

            Capsule()
                .fill(
                    LinearGradient(
                        colors: [accent.opacity(0.98), accent.opacity(0.24)],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                )
                .frame(width: 46, height: 4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(HBGlassBackground(cornerRadius: 18, variant: .panelSoft))
    }

    private func senseFieldGroup<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.system(size: 11, weight: .bold, design: .rounded))
                .textCase(.uppercase)
                .tracking(2)
                .foregroundStyle(HBPalette.textMuted)

            content()
        }
    }

    private func senseLegendChip(label: String, color: Color) -> some View {
        HStack(spacing: 8) {
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)

            Text(label)
                .font(.system(size: 11, weight: .semibold, design: .rounded))
                .foregroundStyle(HBPalette.textSecondary)
                .lineLimit(1)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(HBGlassBackground(cornerRadius: 16, variant: .panelSoft))
    }

    private func senseLedgerHeader(_ text: String, width: CGFloat, alignment: Alignment = .center) -> some View {
        Text(text)
            .font(.system(size: 10, weight: .bold, design: .rounded))
            .textCase(.uppercase)
            .tracking(1.8)
            .foregroundStyle(HBPalette.textMuted)
            .frame(width: width, alignment: alignment)
    }

    private func senseLedgerValue(_ value: String, width: CGFloat) -> some View {
        Text(value)
            .font(.system(size: 12, weight: .semibold, design: .rounded))
            .foregroundStyle(HBPalette.textPrimary)
            .frame(width: width)
            .lineLimit(1)
            .minimumScaleFactor(0.72)
    }

    private func loadContent(showLoading: Bool) async {
        if showLoading {
            isLoading = true
        } else {
            isRefreshing = true
        }

        defer {
            isLoading = false
            isRefreshing = false
        }

        do {
            try await loadDashboard(showLoading: false)

            if isAdmin {
                try await loadStatus()
            } else {
                status = nil
            }

            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func loadDashboard(showLoading: Bool) async throws {
        if showLoading {
            isLoading = true
        }

        defer {
            if showLoading {
                isLoading = false
            }
        }

        let response = try await session.apiClient.get(
            "/api/sense/dashboard",
            query: [URLQueryItem(name: "hours", value: "\(selectedRange.rawValue)")]
        )
        let object = JSON.object(response)
        dashboard = SenseDashboardSnapshot.from(object)
        errorMessage = nil
    }

    private func loadStatus() async throws {
        let response = try await session.apiClient.get("/api/sense/status")
        let object = JSON.object(response)
        let nextStatus = SenseStatusSnapshot.from(object)
        status = nextStatus
        monitorOptions = nextStatus.monitors
        form.apply(nextStatus.integration)
        errorMessage = nil
    }

    private func runAutoRefreshLoop() async {
        guard scenePhase == .active, dashboard?.integration.enabled == true else {
            return
        }

        while !Task.isCancelled {
            do {
                try await Task.sleep(nanoseconds: 10_000_000_000)
            } catch {
                return
            }

            guard !Task.isCancelled, scenePhase == .active, dashboard?.integration.enabled == true else {
                return
            }

            do {
                try await loadDashboard(showLoading: false)
            } catch {
                // Keep the last dashboard on screen during transient realtime refresh failures.
            }
        }
    }

    private func testConnection() async {
        isTesting = true
        defer { isTesting = false }

        do {
            var payload: [String: Any] = [
                "email": form.email
            ]

            if !senseIsMaskedSecret(form.password),
               !form.password.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                payload["password"] = form.password
            }
            if !form.monitorId.isEmpty {
                payload["monitorId"] = form.monitorId
            }
            if !form.mfaCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                payload["mfaCode"] = form.mfaCode
            }

            let response = try await session.apiClient.post("/api/sense/test", body: payload)
            let object = JSON.object(response)
            let result = SenseConnectionTestResult.from(object)
            lastTestResult = result
            monitorOptions = result.monitors

            if form.monitorId.isEmpty, let first = result.monitors.first {
                form.monitorId = first.id
            }

            infoMessage = result.monitorName.isEmpty
                ? "Sense account verified."
                : "Sense credentials verified for \(result.monitorName)."
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func saveConfiguration() async {
        isSaving = true
        defer { isSaving = false }

        do {
            var payload: [String: Any] = [
                "email": form.email,
                "enabled": form.enabled,
                "realtimeEnabled": form.realtimeEnabled,
                "room": form.room,
                "pollIntervalSeconds": max(5, form.pollIntervalSeconds),
                "trendSyncIntervalMinutes": max(5, form.trendSyncIntervalMinutes)
            ]

            if !senseIsMaskedSecret(form.password),
               !form.password.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                payload["password"] = form.password
            }
            if !form.monitorId.isEmpty {
                payload["monitorId"] = form.monitorId
            }
            if !form.mfaCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                payload["mfaCode"] = form.mfaCode
            }

            let response = try await session.apiClient.post("/api/sense/configure", body: payload)
            let object = JSON.object(response)
            let nextStatus = SenseStatusSnapshot.from(object)
            status = nextStatus
            monitorOptions = nextStatus.monitors
            form.apply(nextStatus.integration)
            infoMessage = JSON.string(object, "message", fallback: "Sense integration updated successfully.")
            errorMessage = nil
            try await loadDashboard(showLoading: false)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func syncSense() async {
        isSyncing = true
        defer { isSyncing = false }

        do {
            let response = try await session.apiClient.post("/api/sense/sync")
            let object = JSON.object(response)
            infoMessage = JSON.string(object, "message", fallback: "Sense realtime and trend data were refreshed.")
            errorMessage = nil
            await loadContent(showLoading: false)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
