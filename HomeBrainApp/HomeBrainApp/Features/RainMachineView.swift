import SwiftUI

private let rainMachineConfiguredSecretPlaceholder = "••••••••••••••••"
private let rainMachineMaxManualRunMinutes = 360

private func rainMachineOptionalDouble(_ value: Any?) -> Double? {
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

private func rainMachineOptionalInt(_ value: Any?) -> Int? {
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

private func rainMachineNumericMap(_ value: Any?) -> [String: Double] {
    let object = JSON.object(value)
    var result: [String: Double] = [:]
    object.forEach { key, rawValue in
        if let numeric = rainMachineOptionalDouble(rawValue) {
            result[key] = numeric
        }
    }
    return result
}

private func rainMachineBooleanMap(_ value: Any?) -> [String: Bool] {
    let object = JSON.object(value)
    var result: [String: Bool] = [:]

    object.forEach { key, rawValue in
        if let rawValue = rawValue as? Bool {
            result[key] = rawValue
            return
        }

        if let rawValue = rawValue as? NSNumber {
            result[key] = rawValue.boolValue
            return
        }

        if let rawValue = rawValue as? String {
            switch rawValue.lowercased() {
            case "true", "1", "yes", "on":
                result[key] = true
            case "false", "0", "no", "off":
                result[key] = false
            default:
                break
            }
        }
    }

    return result
}

private func rainMachineIntArray(_ value: Any?) -> [Int] {
    if let integers = value as? [Int] {
        return integers
    }

    if let array = value as? [Any] {
        return array.compactMap(rainMachineOptionalInt)
    }

    return []
}

private func rainMachineIsMaskedSecret(_ value: String) -> Bool {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return false }
    if trimmed.allSatisfy({ $0 == "*" || $0 == "•" }) {
        return true
    }
    return false
}

private func rainMachineDate(from value: String?) -> Date? {
    guard let value, !value.isEmpty else {
        return nil
    }

    if let parsed = JSON.date(from: value) {
        return parsed
    }

    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = .current
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter.date(from: value)
}

private func rainMachineFormatDateTime(_ value: String?) -> String {
    guard let date = rainMachineDate(from: value) else {
        return value?.isEmpty == false ? value ?? "Unknown" : "Never"
    }

    return DateFormatter.localizedString(from: date, dateStyle: .medium, timeStyle: .short)
}

private func rainMachineFormatDay(_ value: String?) -> String {
    guard let date = rainMachineDate(from: value) else {
        return value?.isEmpty == false ? value ?? "Unknown" : "Unknown"
    }

    return DateFormatter.localizedString(from: date, dateStyle: .medium, timeStyle: .none)
}

private func rainMachineFormatDuration(_ seconds: Int?) -> String {
    guard let seconds, seconds > 0 else {
        return "0m"
    }

    let hours = seconds / 3600
    let minutes = (seconds % 3600) / 60
    let remainingSeconds = seconds % 60

    if hours > 0 {
        return "\(hours)h \(minutes)m"
    }
    if minutes > 0 {
        return remainingSeconds > 0 ? "\(minutes)m \(remainingSeconds)s" : "\(minutes)m"
    }
    return "\(remainingSeconds)s"
}

private func rainMachineFormatPercent(_ value: Double?, digits: Int = 1) -> String {
    guard let value else { return "--" }
    return String(format: "%.\(digits)f%%", value)
}

private func rainMachineFormatHours(_ value: Double?) -> String {
    guard let value, value > 0 else { return "Off" }
    let digits = value >= 10 ? 0 : 1
    return String(format: "%.\(digits)f hr", value)
}

private func rainMachineHumanizeKey(_ value: String) -> String {
    let spaced = value
        .replacingOccurrences(of: "_", with: " ")
        .replacingOccurrences(
            of: "([a-z])([A-Z])",
            with: "$1 $2",
            options: .regularExpression
        )
    return spaced.capitalized
}

private struct RainMachineIntegrationStatus {
    let host: String
    let protocolValue: String
    let port: Int
    let password: String
    let passwordConfigured: Bool
    let enabled: Bool
    let room: String
    let pollIntervalMinutes: Int
    let defaultZoneDurationSeconds: Int
    let controllerId: String
    let controllerName: String
    let apiVersion: String
    let hardwareVersion: Double?
    let softwareVersion: String
    let isConnected: Bool
    let lastDiscoveredAt: String?
    let lastAuthenticatedAt: String?
    let lastConnectedAt: String?
    let lastSyncAt: String?
    let lastReportSyncAt: String?
    let lastError: String

    static func from(_ object: [String: Any]) -> RainMachineIntegrationStatus {
        RainMachineIntegrationStatus(
            host: JSON.string(object, "host"),
            protocolValue: JSON.string(object, "protocol", fallback: "https"),
            port: JSON.int(object, "port", fallback: 8080),
            password: JSON.string(object, "password"),
            passwordConfigured: JSON.bool(object, "passwordConfigured"),
            enabled: JSON.bool(object, "enabled"),
            room: JSON.string(object, "room", fallback: "Irrigation"),
            pollIntervalMinutes: JSON.int(object, "pollIntervalMinutes", fallback: 5),
            defaultZoneDurationSeconds: JSON.int(object, "defaultZoneDurationSeconds", fallback: 600),
            controllerId: JSON.string(object, "controllerId"),
            controllerName: JSON.string(object, "controllerName"),
            apiVersion: JSON.string(object, "apiVersion"),
            hardwareVersion: rainMachineOptionalDouble(object["hardwareVersion"]),
            softwareVersion: JSON.string(object, "softwareVersion"),
            isConnected: JSON.bool(object, "isConnected"),
            lastDiscoveredAt: JSON.optionalString(object, "lastDiscoveredAt"),
            lastAuthenticatedAt: JSON.optionalString(object, "lastAuthenticatedAt"),
            lastConnectedAt: JSON.optionalString(object, "lastConnectedAt"),
            lastSyncAt: JSON.optionalString(object, "lastSyncAt"),
            lastReportSyncAt: JSON.optionalString(object, "lastReportSyncAt"),
            lastError: JSON.string(object, "lastError")
        )
    }
}

private struct RainMachineHealthSnapshot {
    let isConnected: Bool
    let lastAuthenticatedAt: String?
    let lastConnectedAt: String?
    let lastSyncAt: String?
    let lastReportSyncAt: String?
    let lastError: String

    static func from(_ object: [String: Any]) -> RainMachineHealthSnapshot {
        RainMachineHealthSnapshot(
            isConnected: JSON.bool(object, "isConnected"),
            lastAuthenticatedAt: JSON.optionalString(object, "lastAuthenticatedAt"),
            lastConnectedAt: JSON.optionalString(object, "lastConnectedAt"),
            lastSyncAt: JSON.optionalString(object, "lastSyncAt"),
            lastReportSyncAt: JSON.optionalString(object, "lastReportSyncAt"),
            lastError: JSON.string(object, "lastError")
        )
    }
}

private struct RainMachineControllerSnapshot {
    let id: String
    let name: String
    let host: String
    let protocolValue: String
    let port: Int
    let apiVersion: String
    let hardwareVersion: Double?
    let softwareVersion: String
    let room: String
    let wifiIPAddress: String
    let wifiSSID: String
    let wifiMACAddress: String
    let ethernetIPAddress: String
    let cpuUsagePct: Double?
    let uptime: String

    static func from(_ object: [String: Any]) -> RainMachineControllerSnapshot {
        let network = JSON.object(object["network"])
        let wifi = JSON.object(network["wifi"])
        let ethernet = JSON.object(network["ethernet"])
        let diagnostics = JSON.object(object["diagnostics"])

        return RainMachineControllerSnapshot(
            id: JSON.string(object, "id"),
            name: JSON.string(object, "name", fallback: "RainMachine"),
            host: JSON.string(object, "host"),
            protocolValue: JSON.string(object, "protocol", fallback: "https"),
            port: JSON.int(object, "port", fallback: 8080),
            apiVersion: JSON.string(object, "apiVersion"),
            hardwareVersion: rainMachineOptionalDouble(object["hardwareVersion"]),
            softwareVersion: JSON.string(object, "softwareVersion"),
            room: JSON.string(object, "room", fallback: "Irrigation"),
            wifiIPAddress: JSON.string(wifi, "ipAddress"),
            wifiSSID: JSON.string(wifi, "ssid"),
            wifiMACAddress: JSON.string(wifi, "macAddress"),
            ethernetIPAddress: JSON.string(ethernet, "ipAddress"),
            cpuUsagePct: rainMachineOptionalDouble(diagnostics["cpuUsagePct"]),
            uptime: JSON.string(diagnostics, "uptime")
        )
    }
}

private struct RainMachineQueueEntry: Identifiable {
    let uid: Int?
    let name: String
    let stateLabel: String
    let remainingSeconds: Int
    let userDurationSeconds: Int
    let machineDurationSeconds: Int
    let cycle: Int
    let cycleCount: Int

    var id: String {
        "\(uid ?? -1)-\(name)-\(cycle)-\(cycleCount)"
    }

    static func from(_ object: [String: Any]) -> RainMachineQueueEntry {
        RainMachineQueueEntry(
            uid: rainMachineOptionalInt(object["uid"]),
            name: JSON.string(object, "name", fallback: "Zone"),
            stateLabel: JSON.string(object, "stateLabel", fallback: "idle"),
            remainingSeconds: JSON.int(object, "remainingSeconds"),
            userDurationSeconds: JSON.int(object, "userDurationSeconds"),
            machineDurationSeconds: JSON.int(object, "machineDurationSeconds"),
            cycle: JSON.int(object, "cycle"),
            cycleCount: JSON.int(object, "cycleCount")
        )
    }
}

private struct RainMachineRuntimeProgram: Identifiable {
    let uid: Int?
    let name: String
    let statusLabel: String
    let nextRun: String?

    var id: String {
        "\(uid ?? -1)-\(name)"
    }

    static func from(_ object: [String: Any]) -> RainMachineRuntimeProgram {
        RainMachineRuntimeProgram(
            uid: rainMachineOptionalInt(object["uid"]),
            name: JSON.string(object, "name", fallback: "Program"),
            statusLabel: JSON.string(object, "statusLabel", fallback: "idle"),
            nextRun: JSON.optionalString(object, "nextRun")
        )
    }
}

private struct RainMachineRuntimeSnapshot {
    let queue: [RainMachineQueueEntry]
    let activeZone: RainMachineQueueEntry?
    let activePrograms: [RainMachineRuntimeProgram]
    let queueLength: Int
    let activeZoneCount: Int
    let runningProgramCount: Int
    let activeRestrictionsCount: Int
    let rainDelayHours: Double
    let zoneCount: Int
    let programCount: Int

    static func from(_ object: [String: Any]) -> RainMachineRuntimeSnapshot {
        RainMachineRuntimeSnapshot(
            queue: JSON.array(object["queue"]).map(RainMachineQueueEntry.from),
            activeZone: JSON.object(object["activeZone"]).isEmpty ? nil : RainMachineQueueEntry.from(JSON.object(object["activeZone"])),
            activePrograms: JSON.array(object["activePrograms"]).map(RainMachineRuntimeProgram.from),
            queueLength: JSON.int(object, "queueLength"),
            activeZoneCount: JSON.int(object, "activeZoneCount"),
            runningProgramCount: JSON.int(object, "runningProgramCount"),
            activeRestrictionsCount: JSON.int(object, "activeRestrictionsCount"),
            rainDelayHours: JSON.double(object, "rainDelayHours"),
            zoneCount: JSON.int(object, "zoneCount"),
            programCount: JSON.int(object, "programCount")
        )
    }
}

private struct RainMachineZoneSummary: Identifiable {
    let uid: Int?
    let name: String
    let active: Bool
    let master: Bool
    let stateLabel: String
    let restriction: Bool
    let remainingSeconds: Int
    let nextRun: String?
    let nextRunProgramName: String

    var id: String {
        "\(uid ?? -1)-\(name)"
    }

    static func from(_ object: [String: Any]) -> RainMachineZoneSummary {
        RainMachineZoneSummary(
            uid: rainMachineOptionalInt(object["uid"]),
            name: JSON.string(object, "name", fallback: "Zone"),
            active: JSON.bool(object, "active", fallback: true),
            master: JSON.bool(object, "master"),
            stateLabel: JSON.string(object, "stateLabel", fallback: "idle"),
            restriction: JSON.bool(object, "restriction"),
            remainingSeconds: JSON.int(object, "remainingSeconds"),
            nextRun: JSON.optionalString(object, "nextRun"),
            nextRunProgramName: JSON.string(object, "nextRunProgramName")
        )
    }
}

private struct RainMachineProgramSummary: Identifiable {
    let uid: Int?
    let name: String
    let statusLabel: String
    let nextRun: String?
    let totalConfiguredDurationSeconds: Int
    let zoneIds: [Int]

    var id: String {
        "\(uid ?? -1)-\(name)"
    }

    static func from(_ object: [String: Any]) -> RainMachineProgramSummary {
        RainMachineProgramSummary(
            uid: rainMachineOptionalInt(object["uid"]),
            name: JSON.string(object, "name", fallback: "Program"),
            statusLabel: JSON.string(object, "statusLabel", fallback: "idle"),
            nextRun: JSON.optionalString(object, "nextRun"),
            totalConfiguredDurationSeconds: JSON.int(object, "totalConfiguredDurationSeconds"),
            zoneIds: rainMachineIntArray(object["zoneIds"])
        )
    }
}

private struct RainMachineRestrictionsSummary {
    let activeCount: Int
    let currentlyFlags: [String: Bool]
    let rainDelayHours: Double
    let rainDelayDays: Int

    var activeRestrictionLabels: [String] {
        currentlyFlags
            .filter { key, value in
                key != "activeCount" && value
            }
            .map { rainMachineHumanizeKey($0.key) }
            .sorted()
    }

    static func from(_ object: [String: Any]) -> RainMachineRestrictionsSummary {
        let currently = JSON.object(object["currently"])
        let rainDelay = JSON.object(object["rainDelay"])
        return RainMachineRestrictionsSummary(
            activeCount: JSON.int(currently, "activeCount"),
            currentlyFlags: rainMachineBooleanMap(currently),
            rainDelayHours: JSON.double(rainDelay, "hoursRemaining"),
            rainDelayDays: JSON.int(rainDelay, "daysRemaining")
        )
    }
}

private struct RainMachineDailyStatRecord: Identifiable {
    let controllerId: String
    let controllerName: String
    let day: String
    let dayDate: String
    let metrics: [String: Double]

    var id: String { day }

    static func from(_ object: [String: Any]) -> RainMachineDailyStatRecord {
        RainMachineDailyStatRecord(
            controllerId: JSON.string(object, "controllerId"),
            controllerName: JSON.string(object, "controllerName"),
            day: JSON.string(object, "day"),
            dayDate: JSON.string(object, "dayDate", fallback: JSON.string(object, "day")),
            metrics: rainMachineNumericMap(object["metrics"])
        )
    }
}

private struct RainMachineWateringDayRecord: Identifiable {
    let controllerId: String
    let controllerName: String
    let day: String
    let dayDate: String
    let simulated: Bool
    let summary: [String: Double]
    let programCount: Int

    var id: String { "\(day)-\(simulated ? "sim" : "actual")" }

    static func from(_ object: [String: Any]) -> RainMachineWateringDayRecord {
        RainMachineWateringDayRecord(
            controllerId: JSON.string(object, "controllerId"),
            controllerName: JSON.string(object, "controllerName"),
            day: JSON.string(object, "day"),
            dayDate: JSON.string(object, "dayDate", fallback: JSON.string(object, "day")),
            simulated: JSON.bool(object, "simulated"),
            summary: rainMachineNumericMap(object["summary"]),
            programCount: JSON.array(object["programs"]).count
        )
    }
}

private struct RainMachineTelemetrySources {
    let dailyStatsSourceKey: String
    let wateringLogSourceKey: String

    static func from(_ object: [String: Any]) -> RainMachineTelemetrySources? {
        let dailyStatsSourceKey = JSON.string(object, "dailyStatsSourceKey")
        let wateringLogSourceKey = JSON.string(object, "wateringLogSourceKey")
        guard !dailyStatsSourceKey.isEmpty || !wateringLogSourceKey.isEmpty else {
            return nil
        }

        return RainMachineTelemetrySources(
            dailyStatsSourceKey: dailyStatsSourceKey,
            wateringLogSourceKey: wateringLogSourceKey
        )
    }
}

private struct RainMachineDashboardSnapshot {
    let generatedAt: String
    let integration: RainMachineIntegrationStatus
    let health: RainMachineHealthSnapshot
    let controller: RainMachineControllerSnapshot?
    let runtime: RainMachineRuntimeSnapshot?
    let zones: [RainMachineZoneSummary]
    let programs: [RainMachineProgramSummary]
    let restrictions: RainMachineRestrictionsSummary?
    let dailyStats: [RainMachineDailyStatRecord]
    let wateringHistory: [RainMachineWateringDayRecord]
    let simulatedWateringHistory: [RainMachineWateringDayRecord]
    let telemetrySources: RainMachineTelemetrySources?

    static func from(_ object: [String: Any]) -> RainMachineDashboardSnapshot {
        let controllerObject = JSON.object(object["controller"])
        let runtimeObject = JSON.object(object["runtime"])
        let restrictionsObject = JSON.object(object["restrictions"])

        return RainMachineDashboardSnapshot(
            generatedAt: JSON.string(object, "generatedAt"),
            integration: RainMachineIntegrationStatus.from(JSON.object(object["integration"])),
            health: RainMachineHealthSnapshot.from(JSON.object(object["health"])),
            controller: controllerObject.isEmpty ? nil : RainMachineControllerSnapshot.from(controllerObject),
            runtime: runtimeObject.isEmpty ? nil : RainMachineRuntimeSnapshot.from(runtimeObject),
            zones: JSON.array(object["zones"]).map(RainMachineZoneSummary.from),
            programs: JSON.array(object["programs"]).map(RainMachineProgramSummary.from),
            restrictions: restrictionsObject.isEmpty ? nil : RainMachineRestrictionsSummary.from(restrictionsObject),
            dailyStats: JSON.array(object["dailyStats"]).map(RainMachineDailyStatRecord.from),
            wateringHistory: JSON.array(object["wateringHistory"]).map(RainMachineWateringDayRecord.from),
            simulatedWateringHistory: JSON.array(object["simulatedWateringHistory"]).map(RainMachineWateringDayRecord.from),
            telemetrySources: RainMachineTelemetrySources.from(JSON.object(object["telemetrySources"]))
        )
    }
}

private struct RainMachineStatusSnapshot {
    let integration: RainMachineIntegrationStatus
    let health: RainMachineHealthSnapshot
    let controller: RainMachineControllerSnapshot?
    let runtime: RainMachineRuntimeSnapshot?

    static func from(_ object: [String: Any]) -> RainMachineStatusSnapshot {
        let controllerObject = JSON.object(object["controller"])
        let runtimeObject = JSON.object(object["runtime"])
        return RainMachineStatusSnapshot(
            integration: RainMachineIntegrationStatus.from(JSON.object(object["integration"])),
            health: RainMachineHealthSnapshot.from(JSON.object(object["health"])),
            controller: controllerObject.isEmpty ? nil : RainMachineControllerSnapshot.from(controllerObject),
            runtime: runtimeObject.isEmpty ? nil : RainMachineRuntimeSnapshot.from(runtimeObject)
        )
    }
}

private struct RainMachineDiscoveryController: Identifiable {
    let name: String
    let host: String
    let protocolValue: String
    let port: Int
    let macAddress: String
    let configured: Bool
    let address: String

    var id: String {
        "\(host):\(port)"
    }

    static func from(_ object: [String: Any]) -> RainMachineDiscoveryController {
        RainMachineDiscoveryController(
            name: JSON.string(object, "name", fallback: "RainMachine"),
            host: JSON.string(object, "host"),
            protocolValue: JSON.string(object, "protocol", fallback: "https"),
            port: JSON.int(object, "port", fallback: 8080),
            macAddress: JSON.string(object, "macAddress"),
            configured: JSON.bool(object, "configured"),
            address: JSON.string(object, "address")
        )
    }
}

private struct RainMachineTestResult {
    let endpointHost: String
    let endpointProtocol: String
    let endpointPort: Int
    let controllerName: String
    let controllerId: String
    let apiVersion: String
    let hardwareVersion: Double?
    let softwareVersion: String
    let ipAddress: String
    let ssid: String
    let cpuUsagePct: Double?
    let uptime: String

    static func from(_ object: [String: Any]) -> RainMachineTestResult {
        let endpoint = JSON.object(object["endpoint"])
        let controller = JSON.object(object["controller"])
        return RainMachineTestResult(
            endpointHost: JSON.string(endpoint, "host"),
            endpointProtocol: JSON.string(endpoint, "protocol", fallback: "https"),
            endpointPort: JSON.int(endpoint, "port", fallback: 8080),
            controllerName: JSON.string(controller, "name", fallback: "RainMachine"),
            controllerId: JSON.string(controller, "controllerId"),
            apiVersion: JSON.string(controller, "apiVersion"),
            hardwareVersion: rainMachineOptionalDouble(controller["hardwareVersion"]),
            softwareVersion: JSON.string(controller, "softwareVersion"),
            ipAddress: JSON.string(controller, "ipAddress"),
            ssid: JSON.string(controller, "ssid"),
            cpuUsagePct: rainMachineOptionalDouble(controller["cpuUsagePct"]),
            uptime: JSON.string(controller, "uptime")
        )
    }
}

private struct RainMachineConfigForm {
    var host = ""
    var protocolValue = "https"
    var port = 8080
    var password = ""
    var enabled = false
    var room = "Irrigation"
    var pollIntervalMinutes = 5
    var defaultZoneDurationSeconds = 600

    mutating func apply(_ integration: RainMachineIntegrationStatus) {
        host = integration.host
        protocolValue = integration.protocolValue
        port = integration.port
        password = integration.passwordConfigured || rainMachineIsMaskedSecret(integration.password)
            ? rainMachineConfiguredSecretPlaceholder
            : integration.password
        enabled = integration.enabled
        room = integration.room.isEmpty ? "Irrigation" : integration.room
        pollIntervalMinutes = max(1, integration.pollIntervalMinutes)
        defaultZoneDurationSeconds = max(60, integration.defaultZoneDurationSeconds)
    }
}

private struct RainMachineSummaryCard: Identifiable {
    let label: String
    let value: String
    let detail: String

    var id: String { label }
}

private struct RainMachineWateringSummary {
    let scheduled: String
    let watered: String
    let saved: String
}

struct RainMachineView: View {
    @EnvironmentObject private var session: SessionStore

    @State private var dashboard: RainMachineDashboardSnapshot?
    @State private var status: RainMachineStatusSnapshot?
    @State private var discoveredControllers: [RainMachineDiscoveryController] = []
    @State private var lastTestResult: RainMachineTestResult?
    @State private var form = RainMachineConfigForm()
    @State private var isLoading = true
    @State private var isRefreshing = false
    @State private var isSyncing = false
    @State private var isDiscovering = false
    @State private var isTesting = false
    @State private var isSaving = false
    @State private var submittingKey: String?
    @State private var manualDurationMinutes: Int?
    @State private var hideInactiveZones = true
    @State private var errorMessage: String?
    @State private var infoMessage = ""

    private var isAdmin: Bool {
        session.currentUser?.role == "admin"
    }

    private var activeIntegration: RainMachineIntegrationStatus? {
        status?.integration ?? dashboard?.integration
    }

    private var activeHealth: RainMachineHealthSnapshot? {
        status?.health ?? dashboard?.health
    }

    private var activeController: RainMachineControllerSnapshot? {
        status?.controller ?? dashboard?.controller
    }

    private var activeRuntime: RainMachineRuntimeSnapshot? {
        status?.runtime ?? dashboard?.runtime
    }

    private var controllerReady: Bool {
        guard let dashboard else { return false }
        return dashboard.integration.enabled && dashboard.controller != nil
    }

    private var latestDailyStat: RainMachineDailyStatRecord? {
        dashboard?.dailyStats.first
    }

    private var recentWatering: [RainMachineWateringDayRecord] {
        Array((dashboard?.wateringHistory ?? []).prefix(7))
    }

    private var visibleZones: [RainMachineZoneSummary] {
        let zones = dashboard?.zones ?? []
        if hideInactiveZones {
            return zones.filter(\.active)
        }
        return zones
    }

    private var hiddenZoneCount: Int {
        max(0, (dashboard?.zones.count ?? 0) - visibleZones.count)
    }

    private var defaultManualDurationMinutes: Int {
        max(1, Int(round(Double(dashboard?.integration.defaultZoneDurationSeconds ?? 600) / 60)))
    }

    private var selectedManualDurationMinutes: Int {
        manualDurationMinutes ?? defaultManualDurationMinutes
    }

    private var summaryCards: [RainMachineSummaryCard] {
        let controller = activeController
        let runtime = dashboard?.runtime ?? activeRuntime
        let restrictions = dashboard?.restrictions
        let dailyStatsCount = dashboard?.dailyStats.count ?? 0
        let wateringDayCount = dashboard?.wateringHistory.count ?? 0

        return [
            RainMachineSummaryCard(
                label: "Controller",
                value: controller?.name.isEmpty == false ? controller?.name ?? "Not connected" : "Not connected",
                detail: controller?.wifiIPAddress.isEmpty == false
                    ? controller?.wifiIPAddress ?? "Configure the integration"
                    : (controller?.host.isEmpty == false ? controller?.host ?? "Configure the integration" : "Configure the integration")
            ),
            RainMachineSummaryCard(
                label: "Watering Queue",
                value: "\(runtime?.queueLength ?? 0)",
                detail: "\(runtime?.activeZoneCount ?? 0) active zone\((runtime?.activeZoneCount ?? 0) == 1 ? "" : "s")"
            ),
            RainMachineSummaryCard(
                label: "Rain Delay",
                value: rainMachineFormatHours(restrictions?.rainDelayHours),
                detail: "\(restrictions?.activeCount ?? 0) active restriction\((restrictions?.activeCount ?? 0) == 1 ? "" : "s")"
            ),
            RainMachineSummaryCard(
                label: "Reports",
                value: rainMachineFormatDateTime(activeHealth?.lastReportSyncAt),
                detail: "\(dailyStatsCount) daily stats • \(wateringDayCount) watering days"
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
                    LoadingView(title: "Loading RainMachine dashboard...")
                } else if let dashboard {
                    summaryGrid

                    if !controllerReady {
                        configurationPrompt(using: dashboard)
                    }

                    runtimeAndRestrictionsGrid
                    programsAndZonesGrid
                    reportsGrid
                } else {
                    EmptyStateView(
                        title: "RainMachine is unavailable",
                        subtitle: "HomeBrain could not load the irrigation dashboard right now."
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
    }

    private var heroPanel: some View {
        HBDeckSurface {
            VStack(alignment: .leading, spacing: 18) {
                HStack(alignment: .top, spacing: 14) {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Irrigation Control")
                            .font(.system(size: 11, weight: .bold, design: .rounded))
                            .textCase(.uppercase)
                            .tracking(2.4)
                            .foregroundStyle(HBPalette.textMuted)

                        Text("RainMachine")
                            .font(.system(size: 30, weight: .bold, design: .rounded))
                            .foregroundStyle(HBPalette.textPrimary)

                        Text("Live zone status, program controls, recent watering history, and controller-side reporting now travel together in the iOS app.")
                            .font(.system(size: 14, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)

                        HStack(spacing: 8) {
                            HBBadge(
                                text: activeHealth?.isConnected == true ? "Controller Online" : "Controller Offline",
                                foreground: activeHealth?.isConnected == true ? HBPalette.accentGreen : HBPalette.accentRed,
                                background: activeHealth?.isConnected == true ? HBPalette.accentGreen.opacity(0.16) : HBPalette.accentRed.opacity(0.16),
                                stroke: activeHealth?.isConnected == true ? HBPalette.accentGreen.opacity(0.7) : HBPalette.accentRed.opacity(0.7)
                            )
                            HBBadge(text: "\((dashboard?.runtime?.zoneCount) ?? (activeRuntime?.zoneCount ?? 0)) zones")
                            HBBadge(text: "\((dashboard?.runtime?.programCount) ?? (activeRuntime?.programCount ?? 0)) programs")
                        }
                    }

                    Spacer(minLength: 0)

                    VStack(alignment: .trailing, spacing: 10) {
                        Button {
                            Task { await loadContent(showLoading: false) }
                        } label: {
                            Label(isRefreshing ? "Refreshing..." : "Refresh", systemImage: "arrow.clockwise")
                        }
                        .buttonStyle(HBSecondaryButtonStyle())

                        if isAdmin {
                            Button {
                                Task { await syncRainMachine() }
                            } label: {
                                Label(isSyncing ? "Syncing..." : "Sync Controller", systemImage: "timer")
                            }
                            .buttonStyle(HBPrimaryButtonStyle())
                            .disabled(isSyncing)
                        }
                    }
                }

                if let health = activeHealth {
                    HStack(spacing: 12) {
                        rainMachineHeroFact(title: "Runtime Sync", value: rainMachineFormatDateTime(health.lastSyncAt))
                        rainMachineHeroFact(title: "Report Sync", value: rainMachineFormatDateTime(health.lastReportSyncAt))
                        rainMachineHeroFact(title: "Data Platform", value: dashboard?.telemetrySources == nil ? "Standby" : "Ready")
                    }
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
                        Text("Controller Setup")
                            .font(.system(size: 20, weight: .bold, design: .rounded))
                            .foregroundStyle(HBPalette.textPrimary)

                        Text("Discover the controller on your LAN, verify the password-authenticated local API, and save the polling configuration used by HomeBrain.")
                            .font(.system(size: 13, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    Spacer(minLength: 0)

                    HBBadge(
                        text: activeHealth?.isConnected == true ? "Connected" : "Standby",
                        foreground: activeHealth?.isConnected == true ? HBPalette.accentGreen : HBPalette.textPrimary,
                        background: activeHealth?.isConnected == true ? HBPalette.accentGreen.opacity(0.16) : HBPalette.panelSoft,
                        stroke: activeHealth?.isConnected == true ? HBPalette.accentGreen.opacity(0.7) : HBPalette.panelStrokeStrong
                    )
                }

                LazyVGrid(columns: [GridItem(.adaptive(minimum: 190), spacing: 12)], spacing: 12) {
                    rainMachineAdminTile(
                        title: "Controller",
                        value: activeController?.name.isEmpty == false ? activeController?.name ?? "Not discovered" : "Not discovered",
                        detail: activeController?.wifiIPAddress.isEmpty == false
                            ? activeController?.wifiIPAddress ?? "Run discovery or test connection."
                            : "Run discovery or test connection."
                    )
                    rainMachineAdminTile(
                        title: "Runtime",
                        value: (activeRuntime?.activeZoneCount ?? 0) > 0
                            ? "\(activeRuntime?.activeZoneCount ?? 0) active zone\((activeRuntime?.activeZoneCount ?? 0) == 1 ? "" : "s")"
                            : "Idle",
                        detail: "Queue \(activeRuntime?.queueLength ?? 0) • Programs \(activeRuntime?.programCount ?? 0)"
                    )
                    rainMachineAdminTile(
                        title: "Last Auth",
                        value: rainMachineFormatDateTime(activeHealth?.lastAuthenticatedAt),
                        detail: "Last connected \(rainMachineFormatDateTime(activeHealth?.lastConnectedAt))"
                    )
                    rainMachineAdminTile(
                        title: "Last Reports",
                        value: rainMachineFormatDateTime(activeHealth?.lastReportSyncAt),
                        detail: "Runtime sync \(rainMachineFormatDateTime(activeHealth?.lastSyncAt))"
                    )
                }

                VStack(alignment: .leading, spacing: 10) {
                    Text("Controller Host")
                        .font(.system(size: 11, weight: .bold, design: .rounded))
                        .textCase(.uppercase)
                        .tracking(2)
                        .foregroundStyle(HBPalette.textMuted)

                    TextField("192.168.1.50 or https://controller.local:8080", text: $form.host)
                        .textInputAutocapitalization(.never)
                        .disableAutocorrection(true)
                        .keyboardType(.URL)
                        .hbPanelTextField()

                    Text("Use the LAN IP or hostname for the RainMachine controller on your local network.")
                        .font(.system(size: 12, weight: .medium, design: .rounded))
                        .foregroundStyle(HBPalette.textMuted)
                }

                LazyVGrid(columns: [GridItem(.adaptive(minimum: 180), spacing: 12)], spacing: 12) {
                    rainMachineFieldGroup(title: "Protocol") {
                        Picker("Protocol", selection: $form.protocolValue) {
                            Text("HTTPS").tag("https")
                            Text("HTTP").tag("http")
                        }
                        .pickerStyle(.segmented)
                    }

                    rainMachineFieldGroup(title: "Port") {
                        TextField("Port", value: $form.port, format: .number)
                            .keyboardType(.numberPad)
                            .hbPanelTextField()
                    }

                    rainMachineFieldGroup(title: "Room Label") {
                        TextField("Irrigation", text: $form.room)
                            .hbPanelTextField()
                    }
                }

                LazyVGrid(columns: [GridItem(.adaptive(minimum: 180), spacing: 12)], spacing: 12) {
                    rainMachineFieldGroup(title: "Controller Password") {
                        SecureField("Enter RainMachine password", text: $form.password)
                            .textInputAutocapitalization(.never)
                            .disableAutocorrection(true)
                            .hbPanelTextField()
                    }

                    rainMachineFieldGroup(title: "Poll Interval (minutes)") {
                        TextField("5", value: $form.pollIntervalMinutes, format: .number)
                            .keyboardType(.numberPad)
                            .hbPanelTextField()
                    }

                    rainMachineFieldGroup(title: "Default Zone Run (seconds)") {
                        TextField("600", value: $form.defaultZoneDurationSeconds, format: .number)
                            .keyboardType(.numberPad)
                            .hbPanelTextField()
                    }
                }

                HBCardRow {
                    VStack(alignment: .leading, spacing: 12) {
                        Toggle(isOn: $form.enabled) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Enable Integration")
                                    .font(.system(size: 14, weight: .semibold, design: .rounded))
                                    .foregroundStyle(HBPalette.textPrimary)
                                Text("HomeBrain will poll the controller, surface irrigation controls, and retain report history in the data platform.")
                                    .font(.system(size: 12, weight: .medium, design: .rounded))
                                    .foregroundStyle(HBPalette.textSecondary)
                            }
                        }
                        .tint(HBPalette.accentBlue)

                        Text("Current target: \(form.protocolValue)://\(form.host.isEmpty ? "controller-host" : form.host):\(form.port)")
                            .font(.system(size: 12, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textMuted)
                    }
                }

                if let lastTestResult {
                    HBCardRow {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Last Verified Controller")
                                .font(.system(size: 11, weight: .bold, design: .rounded))
                                .textCase(.uppercase)
                                .tracking(2)
                                .foregroundStyle(HBPalette.textMuted)

                            Text(lastTestResult.controllerName)
                                .font(.system(size: 17, weight: .bold, design: .rounded))
                                .foregroundStyle(HBPalette.textPrimary)

                            Text("\(lastTestResult.endpointProtocol)://\(lastTestResult.endpointHost):\(lastTestResult.endpointPort) • API \(lastTestResult.apiVersion)")
                                .font(.system(size: 12, weight: .medium, design: .rounded))
                                .foregroundStyle(HBPalette.textSecondary)

                            if !lastTestResult.ipAddress.isEmpty || !lastTestResult.ssid.isEmpty {
                                Text([lastTestResult.ipAddress, lastTestResult.ssid].filter { !$0.isEmpty }.joined(separator: " • "))
                                    .font(.system(size: 12, weight: .medium, design: .rounded))
                                    .foregroundStyle(HBPalette.textMuted)
                            }
                        }
                    }
                }

                if !discoveredControllers.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Discovered Controllers")
                            .font(.system(size: 11, weight: .bold, design: .rounded))
                            .textCase(.uppercase)
                            .tracking(2)
                            .foregroundStyle(HBPalette.textMuted)

                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 12) {
                                ForEach(discoveredControllers) { controller in
                                    Button {
                                        form.host = controller.host
                                        form.protocolValue = controller.protocolValue
                                        form.port = controller.port
                                        infoMessage = "Selected \(controller.name) from discovery."
                                    } label: {
                                        VStack(alignment: .leading, spacing: 8) {
                                            HStack {
                                                Text(controller.name)
                                                    .font(.system(size: 14, weight: .bold, design: .rounded))
                                                    .foregroundStyle(HBPalette.textPrimary)
                                                Spacer(minLength: 0)
                                                HBBadge(
                                                    text: controller.configured ? "Configured" : "Setup Mode",
                                                    foreground: controller.configured ? HBPalette.accentGreen : HBPalette.accentOrange,
                                                    background: controller.configured ? HBPalette.accentGreen.opacity(0.16) : HBPalette.accentOrange.opacity(0.16),
                                                    stroke: controller.configured ? HBPalette.accentGreen.opacity(0.7) : HBPalette.accentOrange.opacity(0.7)
                                                )
                                            }

                                            Text("\(controller.host):\(controller.port)")
                                                .font(.system(size: 12, weight: .medium, design: .rounded))
                                                .foregroundStyle(HBPalette.textSecondary)

                                            if !controller.macAddress.isEmpty || !controller.address.isEmpty {
                                                Text([controller.macAddress, controller.address].filter { !$0.isEmpty }.joined(separator: " • "))
                                                    .font(.system(size: 11, weight: .medium, design: .rounded))
                                                    .foregroundStyle(HBPalette.textMuted)
                                            }
                                        }
                                        .frame(width: 250, alignment: .leading)
                                        .padding(14)
                                        .background(HBGlassBackground(cornerRadius: 18, variant: .panelSoft))
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                            .padding(.vertical, 2)
                        }
                    }
                }

                HStack(spacing: 10) {
                    Button {
                        Task { await discoverControllers() }
                    } label: {
                        Label(isDiscovering ? "Discovering..." : "Discover", systemImage: "magnifyingglass")
                    }
                    .buttonStyle(HBSecondaryButtonStyle(compact: true))
                    .disabled(isDiscovering)

                    Button {
                        Task { await testConnection() }
                    } label: {
                        Label(isTesting ? "Testing..." : "Test Connection", systemImage: "testtube.2")
                    }
                    .buttonStyle(HBSecondaryButtonStyle(compact: true))
                    .disabled(isTesting)

                    Button {
                        Task { await saveConfiguration() }
                    } label: {
                        Label(isSaving ? "Saving..." : "Save Configuration", systemImage: "square.and.arrow.down")
                    }
                    .buttonStyle(HBPrimaryButtonStyle(compact: true))
                    .disabled(isSaving)
                }

                if let health = activeHealth, !health.lastError.isEmpty {
                    HBCardRow {
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .font(.system(size: 15, weight: .bold))
                                .foregroundStyle(HBPalette.accentOrange)
                                .padding(.top, 2)

                            Text(health.lastError)
                                .font(.system(size: 13, weight: .medium, design: .rounded))
                                .foregroundStyle(HBPalette.textSecondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        }
    }

    private var summaryGrid: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 160), spacing: 12)], spacing: 12) {
            ForEach(summaryCards) { item in
                HBPanel {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(item.label)
                            .font(.system(size: 11, weight: .bold, design: .rounded))
                            .textCase(.uppercase)
                            .tracking(2)
                            .foregroundStyle(HBPalette.textMuted)

                        Text(item.value)
                            .font(.system(size: 22, weight: .bold, design: .rounded))
                            .foregroundStyle(HBPalette.textPrimary)

                        Text(item.detail)
                            .font(.system(size: 12, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }

    private func configurationPrompt(using dashboard: RainMachineDashboardSnapshot) -> some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 10) {
                Text("RainMachine is not configured yet.")
                    .font(.system(size: 20, weight: .bold, design: .rounded))
                    .foregroundStyle(HBPalette.textPrimary)

                Text(
                    isAdmin
                        ? "Complete the controller setup above, then come back here for zone controls, reports, and telemetry-backed watering history."
                        : "An administrator needs to finish the RainMachine setup before the live irrigation controls and reports become available here."
                )
                .font(.system(size: 13, weight: .medium, design: .rounded))
                .foregroundStyle(HBPalette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

                if !dashboard.integration.lastError.isEmpty {
                    Text(dashboard.integration.lastError)
                        .font(.system(size: 12, weight: .medium, design: .rounded))
                        .foregroundStyle(HBPalette.accentOrange)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private var runtimeAndRestrictionsGrid: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 300), spacing: 12)], spacing: 12) {
            runtimePanel
            restrictionsPanel
        }
    }

    private var programsAndZonesGrid: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 320), spacing: 12)], spacing: 12) {
            programsPanel
            zonesPanel
        }
    }

    private var reportsGrid: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 320), spacing: 12)], spacing: 12) {
            dailyStatsPanel
            wateringHistoryPanel
        }
    }

    private var runtimePanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Runtime Queue")
                            .font(.system(size: 20, weight: .bold, design: .rounded))
                            .foregroundStyle(HBPalette.textPrimary)

                        Text("Current queue depth, active zones, and controller-side irrigation runtime.")
                            .font(.system(size: 13, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textMuted)
                    }

                    Spacer(minLength: 0)

                    Button {
                        Task { await performDashboardMutation(actionKey: "stop-all", path: "/api/rainmachine/controller/stop-all") }
                    } label: {
                        Label(submittingKey == "stop-all" ? "Stopping..." : "Stop All", systemImage: "stop.fill")
                    }
                    .buttonStyle(HBDestructiveButtonStyle(compact: true))
                    .disabled(submittingKey == "stop-all" || (dashboard?.runtime?.queueLength ?? 0) == 0)
                }

                LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 12)], spacing: 12) {
                    rainMachineRuntimeTile(
                        title: "Active Zone",
                        value: dashboard?.runtime?.activeZone?.name ?? "None",
                        detail: dashboard?.runtime?.activeZone == nil
                            ? "No active watering"
                            : rainMachineFormatDuration(dashboard?.runtime?.activeZone?.remainingSeconds)
                    )
                    rainMachineRuntimeTile(
                        title: "Queue Length",
                        value: "\((dashboard?.runtime?.queueLength) ?? 0)",
                        detail: "\((dashboard?.runtime?.runningProgramCount) ?? 0) running programs"
                    )
                    rainMachineRuntimeTile(
                        title: "Last Sync",
                        value: rainMachineFormatDateTime(dashboard?.health.lastSyncAt),
                        detail: "Reports refreshed \(rainMachineFormatDateTime(dashboard?.health.lastReportSyncAt))"
                    )
                }

                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text("Queue Details")
                            .font(.system(size: 11, weight: .bold, design: .rounded))
                            .textCase(.uppercase)
                            .tracking(2)
                            .foregroundStyle(HBPalette.textMuted)
                        Spacer(minLength: 0)
                        HBBadge(text: "\((dashboard?.runtime?.queueLength) ?? 0) queued")
                    }

                    if (dashboard?.runtime?.queue ?? []).isEmpty {
                        Text("No queued watering right now.")
                            .font(.system(size: 13, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textSecondary)
                    } else {
                        VStack(spacing: 10) {
                            ForEach(dashboard?.runtime?.queue ?? []) { entry in
                                HBCardRow {
                                    HStack(alignment: .top, spacing: 12) {
                                        VStack(alignment: .leading, spacing: 6) {
                                            Text(entry.name)
                                                .font(.system(size: 15, weight: .bold, design: .rounded))
                                                .foregroundStyle(HBPalette.textPrimary)

                                            Text("\(entry.stateLabel.capitalized) • remaining \(rainMachineFormatDuration(entry.remainingSeconds))")
                                                .font(.system(size: 12, weight: .medium, design: .rounded))
                                                .foregroundStyle(HBPalette.textSecondary)
                                        }

                                        Spacer(minLength: 0)
                                        HBBadge(text: entry.stateLabel.capitalized)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private var restrictionsPanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 16) {
                Text("Restrictions")
                    .font(.system(size: 20, weight: .bold, design: .rounded))
                    .foregroundStyle(HBPalette.textPrimary)

                Text("Rain delay controls and any active watering restrictions reported by the controller.")
                    .font(.system(size: 13, weight: .medium, design: .rounded))
                    .foregroundStyle(HBPalette.textMuted)

                HBCardRow {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Rain Delay")
                            .font(.system(size: 11, weight: .bold, design: .rounded))
                            .textCase(.uppercase)
                            .tracking(2)
                            .foregroundStyle(HBPalette.textMuted)

                        Text(rainMachineFormatHours(dashboard?.restrictions?.rainDelayHours))
                            .font(.system(size: 22, weight: .bold, design: .rounded))
                            .foregroundStyle(HBPalette.textPrimary)

                        Text((dashboard?.restrictions?.currentlyFlags["rainDelay"] ?? false) ? "Rain delay is currently blocking watering." : "No rain delay is active.")
                            .font(.system(size: 12, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textSecondary)
                    }
                }

                HStack(spacing: 8) {
                    ForEach([0, 1, 2, 3], id: \.self) { days in
                        Button {
                            Task {
                                await performDashboardMutation(
                                    actionKey: "rain-delay-\(days)",
                                    path: "/api/rainmachine/restrictions/rain-delay",
                                    body: ["days": days]
                                )
                            }
                        } label: {
                            Text(days == 0 ? "Clear Delay" : "\(days) Day\(days == 1 ? "" : "s")")
                        }
                        .buttonStyle(days == 0 ? HBSecondaryButtonStyle(compact: true) : HBPrimaryButtonStyle(compact: true))
                        .disabled(submittingKey == "rain-delay-\(days)")
                    }
                }

                HBCardRow {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Active Restrictions")
                            .font(.system(size: 11, weight: .bold, design: .rounded))
                            .textCase(.uppercase)
                            .tracking(2)
                            .foregroundStyle(HBPalette.textMuted)

                        if (dashboard?.restrictions?.activeCount ?? 0) == 0 {
                            Text("No active restrictions.")
                                .font(.system(size: 13, weight: .medium, design: .rounded))
                                .foregroundStyle(HBPalette.textSecondary)
                        } else {
                            LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), spacing: 8)], spacing: 8) {
                                ForEach(dashboard?.restrictions?.activeRestrictionLabels ?? [], id: \.self) { label in
                                    HBBadge(text: label)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private var programsPanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Programs")
                            .font(.system(size: 20, weight: .bold, design: .rounded))
                            .foregroundStyle(HBPalette.textPrimary)

                        Text("Start or stop RainMachine programs without leaving the iOS app.")
                            .font(.system(size: 13, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textMuted)
                    }

                    Spacer(minLength: 0)
                    HBBadge(text: "\((dashboard?.programs.count) ?? 0)")
                }

                if (dashboard?.programs ?? []).isEmpty {
                    Text("No programs were returned by the controller.")
                        .font(.system(size: 13, weight: .medium, design: .rounded))
                        .foregroundStyle(HBPalette.textSecondary)
                } else {
                    VStack(spacing: 10) {
                        ForEach(dashboard?.programs ?? []) { program in
                            HBCardRow {
                                HStack(alignment: .top, spacing: 12) {
                                    VStack(alignment: .leading, spacing: 6) {
                                        HStack(spacing: 8) {
                                            Text(program.name)
                                                .font(.system(size: 15, weight: .bold, design: .rounded))
                                                .foregroundStyle(HBPalette.textPrimary)
                                            HBBadge(text: program.statusLabel.capitalized)
                                        }

                                        Text("Next run \(program.nextRun == nil ? "not scheduled" : rainMachineFormatDay(program.nextRun)) • \(program.zoneIds.count) zones • configured \(rainMachineFormatDuration(program.totalConfiguredDurationSeconds))")
                                            .font(.system(size: 12, weight: .medium, design: .rounded))
                                            .foregroundStyle(HBPalette.textSecondary)
                                    }

                                    Spacer(minLength: 0)

                                    if program.statusLabel == "running" || program.statusLabel == "pending" {
                                        Button {
                                            Task {
                                                await performDashboardMutation(
                                                    actionKey: "program-stop-\(program.id)",
                                                    path: "/api/rainmachine/programs/\(program.uid ?? 0)/stop"
                                                )
                                            }
                                        } label: {
                                            Label(submittingKey == "program-stop-\(program.id)" ? "Stopping..." : "Stop", systemImage: "stop.fill")
                                        }
                                        .buttonStyle(HBDestructiveButtonStyle(compact: true))
                                        .disabled(submittingKey == "program-stop-\(program.id)" || program.uid == nil)
                                    } else {
                                        Button {
                                            Task {
                                                await performDashboardMutation(
                                                    actionKey: "program-start-\(program.id)",
                                                    path: "/api/rainmachine/programs/\(program.uid ?? 0)/start"
                                                )
                                            }
                                        } label: {
                                            Label(submittingKey == "program-start-\(program.id)" ? "Starting..." : "Start", systemImage: "play.fill")
                                        }
                                        .buttonStyle(HBPrimaryButtonStyle(compact: true))
                                        .disabled(submittingKey == "program-start-\(program.id)" || program.uid == nil)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private var zonesPanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Zones")
                        .font(.system(size: 20, weight: .bold, design: .rounded))
                        .foregroundStyle(HBPalette.textPrimary)

                    Text("Live zone state with manual start and stop controls.")
                        .font(.system(size: 13, weight: .medium, design: .rounded))
                        .foregroundStyle(HBPalette.textMuted)
                }

                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .center, spacing: 10) {
                        rainMachineManualRunControl
                        rainMachineHideInactiveControl
                    }

                    VStack(alignment: .leading, spacing: 10) {
                        rainMachineManualRunControl

                        HStack {
                            Spacer(minLength: 0)
                            rainMachineHideInactiveControl
                        }
                    }
                }

                if (dashboard?.zones ?? []).isEmpty {
                    Text("No zones were returned by the controller.")
                        .font(.system(size: 13, weight: .medium, design: .rounded))
                        .foregroundStyle(HBPalette.textSecondary)
                } else if visibleZones.isEmpty {
                    HBCardRow {
                        Text("All \(hiddenZoneCount) inactive zone\(hiddenZoneCount == 1 ? "" : "s") are currently hidden. Turn off Hide Inactive to review them.")
                            .font(.system(size: 13, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } else {
                    VStack(spacing: 10) {
                        ForEach(visibleZones) { zone in
                            rainMachineZoneCard(zone)
                        }
                    }
                }

                if hideInactiveZones && hiddenZoneCount > 0 {
                    Text("\(hiddenZoneCount) inactive zone\(hiddenZoneCount == 1 ? "" : "s") hidden by default.")
                        .font(.system(size: 12, weight: .medium, design: .rounded))
                        .foregroundStyle(HBPalette.textMuted)
                }
            }
        }
    }

    private var dailyStatsPanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 16) {
                Text("Daily Stats")
                    .font(.system(size: 20, weight: .bold, design: .rounded))
                    .foregroundStyle(HBPalette.textPrimary)

                Text("Recent controller-side daily irrigation calculations stored in the data platform.")
                    .font(.system(size: 13, weight: .medium, design: .rounded))
                    .foregroundStyle(HBPalette.textMuted)

                LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 12)], spacing: 12) {
                    rainMachineRuntimeTile(
                        title: "Latest Day",
                        value: latestDailyStat == nil ? "None" : rainMachineFormatDay(latestDailyStat?.dayDate),
                        detail: latestDailyStat == nil
                            ? "No daily stats ingested yet."
                            : "\(Int(latestDailyStat?.metrics["program_count"] ?? 0)) programs • \(Int(latestDailyStat?.metrics["zone_count"] ?? 0)) zones"
                    )
                    rainMachineRuntimeTile(
                        title: "Scheduled",
                        value: rainMachineFormatDuration(Int(latestDailyStat?.metrics["scheduled_duration_sec"] ?? 0)),
                        detail: "Total scheduled watering time for the most recent day."
                    )
                    rainMachineRuntimeTile(
                        title: "Water Saved",
                        value: rainMachineFormatPercent(latestDailyStat?.metrics["water_saved_pct"]),
                        detail: "Difference between scheduled and computed irrigation."
                    )
                }

                if (dashboard?.dailyStats ?? []).isEmpty {
                    Text("Daily stats will appear here after the next report sync.")
                        .font(.system(size: 13, weight: .medium, design: .rounded))
                        .foregroundStyle(HBPalette.textSecondary)
                } else {
                    VStack(spacing: 10) {
                        ForEach(dashboard?.dailyStats ?? []) { stat in
                            HBCardRow {
                                VStack(alignment: .leading, spacing: 10) {
                                    HStack {
                                        Text(rainMachineFormatDay(stat.dayDate))
                                            .font(.system(size: 15, weight: .bold, design: .rounded))
                                            .foregroundStyle(HBPalette.textPrimary)
                                        Spacer(minLength: 0)
                                        HBBadge(text: "\(Int(stat.metrics["program_count"] ?? 0)) programs")
                                    }

                                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 100), spacing: 10)], spacing: 10) {
                                        rainMachineStatPill(title: "Scheduled", value: rainMachineFormatDuration(Int(stat.metrics["scheduled_duration_sec"] ?? 0)))
                                        rainMachineStatPill(title: "Machine", value: rainMachineFormatDuration(Int(stat.metrics["machine_duration_sec"] ?? 0)))
                                        rainMachineStatPill(title: "Saved", value: rainMachineFormatPercent(stat.metrics["water_saved_pct"]))
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private var wateringHistoryPanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 16) {
                Text("Watering History")
                    .font(.system(size: 20, weight: .bold, design: .rounded))
                    .foregroundStyle(HBPalette.textPrimary)

                Text("Recent watering outcomes persisted from the RainMachine watering log.")
                    .font(.system(size: 13, weight: .medium, design: .rounded))
                    .foregroundStyle(HBPalette.textMuted)

                LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 12)], spacing: 12) {
                    rainMachineRuntimeTile(
                        title: "Actual Runs",
                        value: "\((dashboard?.wateringHistory.count) ?? 0)",
                        detail: "Stored watering-day documents in this dashboard window."
                    )
                    rainMachineRuntimeTile(
                        title: "Simulated Runs",
                        value: "\((dashboard?.simulatedWateringHistory.count) ?? 0)",
                        detail: "Forecast or simulated watering-day projections."
                    )
                }

                if recentWatering.isEmpty {
                    Text("Watering history will appear here after report ingestion completes.")
                        .font(.system(size: 13, weight: .medium, design: .rounded))
                        .foregroundStyle(HBPalette.textSecondary)
                } else {
                    VStack(spacing: 10) {
                        ForEach(recentWatering) { day in
                            let summary = wateringSummary(for: day)

                            HBCardRow {
                                VStack(alignment: .leading, spacing: 10) {
                                    HStack(alignment: .top, spacing: 10) {
                                        VStack(alignment: .leading, spacing: 4) {
                                            Text(rainMachineFormatDay(day.dayDate))
                                                .font(.system(size: 15, weight: .bold, design: .rounded))
                                                .foregroundStyle(HBPalette.textPrimary)

                                            Text("\(day.programCount) programs • \(Int(day.summary["zone_count"] ?? 0)) zones • \(Int(day.summary["cycle_count"] ?? 0)) cycles")
                                                .font(.system(size: 12, weight: .medium, design: .rounded))
                                                .foregroundStyle(HBPalette.textSecondary)
                                        }

                                        Spacer(minLength: 0)

                                        HBBadge(
                                            text: day.simulated ? "Simulated" : "Actual",
                                            foreground: day.simulated ? HBPalette.accentOrange : HBPalette.accentGreen,
                                            background: day.simulated ? HBPalette.accentOrange.opacity(0.16) : HBPalette.accentGreen.opacity(0.16),
                                            stroke: day.simulated ? HBPalette.accentOrange.opacity(0.7) : HBPalette.accentGreen.opacity(0.7)
                                        )
                                    }

                                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 100), spacing: 10)], spacing: 10) {
                                        rainMachineStatPill(title: "Scheduled", value: summary.scheduled)
                                        rainMachineStatPill(title: "Watered", value: summary.watered)
                                        rainMachineStatPill(title: "Saved", value: summary.saved)
                                    }
                                }
                            }
                        }
                    }
                }

                if dashboard?.telemetrySources != nil {
                    HBCardRow {
                        Text("The RainMachine daily stats and watering log are also queryable in the shared data platform telemetry fabric. Open Data Platform from the sidebar to chart them alongside the rest of HomeBrain.")
                            .font(.system(size: 12, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }

    private func rainMachineZoneCard(_ zone: RainMachineZoneSummary) -> some View {
        let isRunning = zone.stateLabel == "running" || zone.stateLabel == "pending"
        let canStart = zone.uid != nil && zone.active && !zone.master

        return HBCardRow {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top, spacing: 10) {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 8) {
                            Text(zone.name)
                                .font(.system(size: 15, weight: .bold, design: .rounded))
                                .foregroundStyle(HBPalette.textPrimary)

                            if zone.master {
                                HBBadge(text: "Master Valve")
                            }
                            if !zone.active {
                                HBBadge(text: "Inactive")
                            }
                            if zone.restriction {
                                HBBadge(text: "Restricted")
                            }
                        }

                        Text("\(zone.stateLabel.capitalized) • remaining \(rainMachineFormatDuration(zone.remainingSeconds)) • next run \(zone.nextRun == nil ? "not scheduled" : "\(rainMachineFormatDay(zone.nextRun)) via \(zone.nextRunProgramName.isEmpty ? "program" : zone.nextRunProgramName)")")
                            .font(.system(size: 12, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textSecondary)
                    }

                    Spacer(minLength: 0)

                    if isRunning {
                        Button {
                            Task {
                                await performDashboardMutation(
                                    actionKey: "zone-stop-\(zone.id)",
                                    path: "/api/rainmachine/zones/\(zone.uid ?? 0)/stop"
                                )
                            }
                        } label: {
                            Label(submittingKey == "zone-stop-\(zone.id)" ? "Stopping..." : "Stop", systemImage: "stop.fill")
                        }
                        .buttonStyle(HBDestructiveButtonStyle(compact: true))
                        .disabled(submittingKey == "zone-stop-\(zone.id)" || zone.uid == nil)
                    } else {
                        Button {
                            Task {
                                await performDashboardMutation(
                                    actionKey: "zone-start-\(zone.id)",
                                    path: "/api/rainmachine/zones/\(zone.uid ?? 0)/start",
                                    body: ["durationSeconds": selectedManualDurationMinutes * 60]
                                )
                            }
                        } label: {
                            Label(submittingKey == "zone-start-\(zone.id)" ? "Starting..." : "Start", systemImage: "play.fill")
                        }
                        .buttonStyle(HBPrimaryButtonStyle(compact: true))
                        .disabled(submittingKey == "zone-start-\(zone.id)" || !canStart)
                    }
                }
            }
        }
    }

    private func rainMachineHeroFact(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.system(size: 10, weight: .bold, design: .rounded))
                .textCase(.uppercase)
                .tracking(1.8)
                .foregroundStyle(HBPalette.textMuted)
            Text(value)
                .font(.system(size: 13, weight: .semibold, design: .rounded))
                .foregroundStyle(HBPalette.textPrimary)
                .lineLimit(2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(HBGlassBackground(cornerRadius: 16, variant: .panelSoft))
    }

    private func rainMachineAdminTile(title: String, value: String, detail: String) -> some View {
        HBCardRow {
            VStack(alignment: .leading, spacing: 6) {
                Text(title)
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .textCase(.uppercase)
                    .tracking(2)
                    .foregroundStyle(HBPalette.textMuted)

                Text(value)
                    .font(.system(size: 17, weight: .bold, design: .rounded))
                    .foregroundStyle(HBPalette.textPrimary)
                    .lineLimit(2)

                Text(detail)
                    .font(.system(size: 12, weight: .medium, design: .rounded))
                    .foregroundStyle(HBPalette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func rainMachineFieldGroup<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.system(size: 11, weight: .bold, design: .rounded))
                .textCase(.uppercase)
                .tracking(2)
                .foregroundStyle(HBPalette.textMuted)
            content()
        }
    }

    private func rainMachineRuntimeTile(title: String, value: String, detail: String) -> some View {
        HBCardRow {
            VStack(alignment: .leading, spacing: 6) {
                Text(title)
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .textCase(.uppercase)
                    .tracking(2)
                    .foregroundStyle(HBPalette.textMuted)

                Text(value)
                    .font(.system(size: 20, weight: .bold, design: .rounded))
                    .foregroundStyle(HBPalette.textPrimary)
                    .lineLimit(2)

                Text(detail)
                    .font(.system(size: 12, weight: .medium, design: .rounded))
                    .foregroundStyle(HBPalette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func rainMachineStatPill(title: String, value: String) -> some View {
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

    private func wateringSummary(for day: RainMachineWateringDayRecord) -> RainMachineWateringSummary {
        RainMachineWateringSummary(
            scheduled: rainMachineFormatDuration(Int(day.summary["scheduled_duration_sec"] ?? 0)),
            watered: rainMachineFormatDuration(Int(day.summary["watered_duration_sec"] ?? 0)),
            saved: rainMachineFormatPercent(day.summary["water_saved_pct"])
        )
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
            let dashboardResponse = try await session.apiClient.get(
                "/api/rainmachine/dashboard",
                query: [
                    URLQueryItem(name: "dailyDays", value: "14"),
                    URLQueryItem(name: "wateringDays", value: "14")
                ]
            )
            let dashboardObject = JSON.object(dashboardResponse)
            let nextDashboard = RainMachineDashboardSnapshot.from(JSON.object(dashboardObject["dashboard"]))
            dashboard = nextDashboard
            if manualDurationMinutes == nil {
                manualDurationMinutes = max(1, Int(round(Double(nextDashboard.integration.defaultZoneDurationSeconds) / 60)))
            }

            if isAdmin {
                let statusResponse = try await session.apiClient.get("/api/rainmachine/status")
                let statusObject = JSON.object(statusResponse)
                let nextStatus = RainMachineStatusSnapshot.from(statusObject)
                status = nextStatus
                form.apply(nextStatus.integration)
            } else {
                status = nil
            }

            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func discoverControllers() async {
        isDiscovering = true
        defer { isDiscovering = false }

        do {
            let response = try await session.apiClient.post("/api/rainmachine/discover")
            let object = JSON.object(response)
            let controllers = JSON.array(object["controllers"]).map(RainMachineDiscoveryController.from)
            discoveredControllers = controllers

            if let first = controllers.first, form.host.isEmpty {
                form.host = first.host
                form.protocolValue = first.protocolValue
                form.port = first.port
            }

            infoMessage = "RainMachine discovery complete. Found \(controllers.count) controller\(controllers.count == 1 ? "" : "s") on your LAN."
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func testConnection() async {
        isTesting = true
        defer { isTesting = false }

        do {
            var payload: [String: Any] = [
                "host": form.host,
                "protocol": form.protocolValue,
                "port": max(1, form.port)
            ]
            if !rainMachineIsMaskedSecret(form.password) {
                payload["password"] = form.password
            }

            let response = try await session.apiClient.post("/api/rainmachine/test", body: payload)
            let object = JSON.object(response)
            let result = RainMachineTestResult.from(object)
            lastTestResult = result
            form.host = result.endpointHost
            form.protocolValue = result.endpointProtocol
            form.port = result.endpointPort
            infoMessage = "\(result.controllerName) is reachable at \(result.endpointHost):\(result.endpointPort)."
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
                "host": form.host,
                "protocol": form.protocolValue,
                "port": max(1, form.port),
                "enabled": form.enabled,
                "room": form.room,
                "pollIntervalMinutes": max(1, form.pollIntervalMinutes),
                "defaultZoneDurationSeconds": max(60, form.defaultZoneDurationSeconds)
            ]

            if !rainMachineIsMaskedSecret(form.password) {
                payload["password"] = form.password
            }

            let response = try await session.apiClient.post("/api/rainmachine/configure", body: payload)
            let object = JSON.object(response)
            let nextStatus = RainMachineStatusSnapshot.from(object)
            status = nextStatus
            form.apply(nextStatus.integration)
            infoMessage = JSON.string(object, "message", fallback: "RainMachine integration updated successfully.")
            errorMessage = nil
            await loadContent(showLoading: false)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func syncRainMachine() async {
        isSyncing = true
        defer { isSyncing = false }

        do {
            let response = try await session.apiClient.post("/api/rainmachine/sync")
            let object = JSON.object(response)
            infoMessage = JSON.string(object, "message", fallback: "RainMachine runtime and reports were refreshed.")
            errorMessage = nil
            await loadContent(showLoading: false)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func updateManualDurationMinutes(by delta: Int) {
        updateManualDurationMinutes(to: selectedManualDurationMinutes + delta)
    }

    private func updateManualDurationMinutes(to value: Int) {
        manualDurationMinutes = max(1, min(rainMachineMaxManualRunMinutes, value))
    }

    private func performDashboardMutation(actionKey: String, path: String, body: [String: Any]? = nil) async {
        submittingKey = actionKey
        defer { submittingKey = nil }

        do {
            let response = try await session.apiClient.post(path, body: body)
            let object = JSON.object(response)
            dashboard = RainMachineDashboardSnapshot.from(JSON.object(object["dashboard"]))
            infoMessage = JSON.string(object, "message", fallback: "RainMachine updated.")
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private var rainMachineManualRunControl: some View {
        HStack(spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: "clock")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(HBPalette.accentBlue)
                    .frame(width: 32, height: 32)
                    .background(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(HBPalette.accentBlue.opacity(0.12))
                    )

                VStack(alignment: .leading, spacing: 3) {
                    Text("Manual Run")
                        .font(.system(size: 10, weight: .bold, design: .rounded))
                        .textCase(.uppercase)
                        .tracking(1.8)
                        .foregroundStyle(HBPalette.textMuted)

                    Text("\(selectedManualDurationMinutes) min")
                        .font(.system(size: 20, weight: .bold, design: .rounded))
                        .foregroundStyle(HBPalette.textPrimary)
                }
            }

            Spacer(minLength: 0)

            HStack(spacing: 8) {
                rainMachineStepperButton(systemName: "minus") {
                    updateManualDurationMinutes(by: -5)
                }

                rainMachineStepperButton(systemName: "plus") {
                    updateManualDurationMinutes(by: 5)
                }
            }
        }
        .padding(12)
        .background(HBGlassBackground(cornerRadius: 18, variant: .panelSoft))
    }

    private var rainMachineHideInactiveControl: some View {
        HStack(spacing: 10) {
            Text("Hide Inactive")
                .font(.system(size: 14, weight: .semibold, design: .rounded))
                .foregroundStyle(HBPalette.textPrimary)

            Toggle("", isOn: $hideInactiveZones)
                .labelsHidden()
                .tint(HBPalette.accentBlue)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(HBGlassBackground(cornerRadius: 18, variant: .panelSoft))
    }

    private func rainMachineStepperButton(systemName: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(HBPalette.textPrimary)
                .frame(width: 36, height: 36)
                .background(HBGlassBackground(cornerRadius: 12, variant: .panel))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(HBPalette.panelStrokeStrong.opacity(0.72), lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
    }
}
