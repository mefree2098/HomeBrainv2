import Charts
import Combine
import CoreLocation
import SwiftUI

private let tempestConfiguredSecretPlaceholder = "••••••••••••••••"
private let weatherChartHistoryLimit = 240
private let weatherChartRangeOptions = [
    WeatherChartRangeOption(hours: 6, label: "6 hours", shortLabel: "6h"),
    WeatherChartRangeOption(hours: 12, label: "12 hours", shortLabel: "12h"),
    WeatherChartRangeOption(hours: 24, label: "24 hours", shortLabel: "24h"),
    WeatherChartRangeOption(hours: 48, label: "48 hours", shortLabel: "48h"),
    WeatherChartRangeOption(hours: 72, label: "72 hours", shortLabel: "72h"),
    WeatherChartRangeOption(hours: 24 * 7, label: "7 days", shortLabel: "7d"),
    WeatherChartRangeOption(hours: 24 * 14, label: "14 days", shortLabel: "14d")
]
private let defaultWeatherChartRangeIndex = 3
private let maximumWeatherChartHours = 24 * 14

private struct WeatherChartRangeOption: Identifiable {
    let hours: Int
    let label: String
    let shortLabel: String

    var id: Int { hours }
}

private func weatherHexColor(_ value: UInt32, opacity: Double = 1) -> Color {
    Color(
        .sRGB,
        red: Double((value >> 16) & 0xFF) / 255,
        green: Double((value >> 8) & 0xFF) / 255,
        blue: Double(value & 0xFF) / 255,
        opacity: opacity
    )
}

private let forecastTemperatureChartColor = weatherHexColor(0x38BDF8)
private let forecastWindChartColor = weatherHexColor(0xA78BFA)
private let forecastPrecipitationChartColor = weatherHexColor(0x22C55E)
private let atmosphericTemperatureChartColor = weatherHexColor(0x22D3EE)
private let atmosphericFeelsLikeChartColor = weatherHexColor(0xA855F7)
private let atmosphericDewPointChartColor = weatherHexColor(0x34D399)
private let windAverageChartColor = weatherHexColor(0x38BDF8)
private let windGustChartColor = weatherHexColor(0xFB7185)
private let windRapidChartColor = weatherHexColor(0xFACC15)
private let indoorTemperatureChartColor = weatherHexColor(0x10B981)
private let indoorHumidityChartColor = weatherHexColor(0x38BDF8)
private let indoorPM25ChartColor = weatherHexColor(0xA78BFA)
private let indoorAQIChartColor = weatherHexColor(0xF59E0B)
private let environmentalPressureChartColor = weatherHexColor(0x10B981)
private let environmentalRainRateChartColor = weatherHexColor(0x60A5FA)
private let environmentalSolarChartColor = weatherHexColor(0xF59E0B)

private func weatherOptionalDouble(_ value: Any?) -> Double? {
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

private func weatherOptionalInt(_ value: Any?) -> Int? {
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

private func weatherStringArray(_ value: Any?) -> [String] {
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

private func weatherIntArray(_ value: Any?) -> [Int] {
    if let ints = value as? [Int] {
        return ints
    }
    if let array = value as? [Any] {
        return array.compactMap { item in
            weatherOptionalInt(item)
        }
    }
    return []
}

private func weatherIsMaskedSecret(_ value: String) -> Bool {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return false }
    if trimmed.allSatisfy({ $0 == "*" || $0 == "•" }) {
        return true
    }
    return false
}

private func celsiusToFahrenheit(_ value: Double?) -> Double? {
    guard let value else { return nil }
    return (value * 9 / 5) + 32
}

private func metersPerSecondToMph(_ value: Double?) -> Double? {
    guard let value else { return nil }
    return value * 2.2369362921
}

private func millimetersToInches(_ value: Double?) -> Double? {
    guard let value else { return nil }
    return value / 25.4
}

private func millibarToInHg(_ value: Double?) -> Double? {
    guard let value else { return nil }
    return value * 0.0295299831
}

private func formatTemperature(_ value: Double?) -> String {
    guard let value else { return "--" }
    return "\(Int(value.rounded()))°"
}

private func formatPercent(_ value: Double?) -> String {
    guard let value else { return "--" }
    return "\(Int(value.rounded()))%"
}

private func formatWind(_ value: Double?) -> String {
    guard let value else { return "--" }
    return "\(Int(value.rounded())) mph"
}

private func formatRain(_ value: Double?) -> String {
    guard let value else { return "--" }
    return String(format: "%.2f in", value)
}

private func formatPressure(_ value: Double?) -> String {
    guard let value else { return "--" }
    return String(format: "%.2f inHg", value)
}

private func formatSolar(_ value: Double?) -> String {
    guard let value else { return "--" }
    return "\(Int(value.rounded())) W/m²"
}

private func formatUV(_ value: Double?) -> String {
    guard let value else { return "--" }
    return String(format: "%.1f", value)
}

private func formatAQI(_ value: Double?) -> String {
    guard let value else { return "--" }
    return String(Int(value.rounded()))
}

private func formatPM25(_ value: Double?) -> String {
    guard let value else { return "--" }
    return String(format: "%.1f ug/m³", value)
}

private func deriveRainRateFromLastMinute(_ value: Double?) -> Double? {
    guard let value else { return nil }
    return (value * 60 * 100).rounded() / 100
}

private func formatTimestamp(_ value: String?) -> String {
    guard let value, let date = JSON.date(from: value) else {
        return "Unknown"
    }
    return DateFormatter.localizedString(from: date, dateStyle: .medium, timeStyle: .short)
}

private func formatTimeOnly(_ value: String?) -> String {
    guard let value, let date = JSON.date(from: value) else {
        return "--"
    }
    return DateFormatter.localizedString(from: date, dateStyle: .none, timeStyle: .short)
}

private func formatChartTime(_ date: Date) -> String {
    date.formatted(.dateTime.hour(.defaultDigits(amPM: .abbreviated)))
}

private func formatWeatherChartTimestamp(_ date: Date?, hours: Int) -> String {
    guard let date else {
        return "--"
    }
    return DateFormatter.localizedString(
        from: date,
        dateStyle: hours > 72 ? .short : .none,
        timeStyle: .short
    )
}

private func downsampleWeatherChartData<Entry>(_ entries: [Entry], limit: Int = weatherChartHistoryLimit) -> [Entry] {
    guard entries.count > limit, limit > 1 else {
        return entries
    }

    return (0..<limit).map { index in
        let sourceIndex = Int((Double(index) * Double(entries.count - 1) / Double(limit - 1)).rounded())
        return entries[sourceIndex]
    }
}

private func weatherChartHistory<Entry>(
    _ entries: [Entry],
    hours: Int,
    timestamp: (Entry) -> Date?
) -> [Entry] {
    let cutoff = Date().addingTimeInterval(-Double(hours) * 60 * 60)
    let filtered = entries.filter { entry in
        guard let date = timestamp(entry) else {
            return false
        }
        return date >= cutoff
    }
    return downsampleWeatherChartData(filtered)
}

private func compassDirection(_ degrees: Double?) -> String {
    guard let degrees else { return "--" }
    let directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
    let index = Int((degrees / 45).rounded()) % directions.count
    return directions[index]
}

private func weatherSymbolName(icon: String, isDay: Bool) -> String {
    switch icon {
    case "sunny":
        return isDay ? "sun.max.fill" : "moon.stars.fill"
    case "partly-cloudy":
        return isDay ? "cloud.sun.fill" : "cloud.moon.fill"
    case "fog":
        return "cloud.fog.fill"
    case "drizzle", "rain":
        return "cloud.rain.fill"
    case "sleet", "snow":
        return "cloud.snow.fill"
    case "storm":
        return "cloud.bolt.rain.fill"
    default:
        return "cloud.fill"
    }
}

private struct WeatherHourlySnapshot: Identifiable {
    let time: String
    let date: Date?
    let temperatureF: Double?
    let precipitationChance: Double?
    let windSpeedMph: Double?
    let condition: String
    let icon: String

    var id: String { time }
    static func from(_ object: [String: Any]) -> WeatherHourlySnapshot {
        let time = JSON.string(object, "time")
        return WeatherHourlySnapshot(
            time: time,
            date: JSON.date(from: time),
            temperatureF: weatherOptionalDouble(object["temperatureF"]),
            precipitationChance: weatherOptionalDouble(object["precipitationChance"]),
            windSpeedMph: weatherOptionalDouble(object["windSpeedMph"]),
            condition: JSON.string(object, "condition", fallback: "Unknown"),
            icon: JSON.string(object, "icon", fallback: "cloudy")
        )
    }
}

private struct WeatherChartPoint: Identifiable {
    let id: String
    let index: Int
    let value: Double
}

private struct WeatherChartSegment: Identifiable {
    let id: String
    let points: [WeatherChartPoint]
}

private struct WeatherWindChartSample {
    let observedDate: Date?
    let averageMph: Double?
    let gustMph: Double?
    let rapidMph: Double?
}

private struct WeatherChartLegendItem {
    let label: String
    let color: Color
}

private struct WeatherChartLegend: View {
    let items: [WeatherChartLegendItem]

    var body: some View {
        LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 104), spacing: 12)],
            alignment: .leading,
            spacing: 8
        ) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                HStack(spacing: 7) {
                    RoundedRectangle(cornerRadius: 2, style: .continuous)
                        .fill(item.color)
                        .frame(width: 10, height: 10)
                    Text(item.label)
                        .font(HBTypography.body(size: 12, weight: .semibold))
                        .foregroundStyle(HBPalette.textSecondary)
                        .lineLimit(1)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(item.label) series")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Chart key")
    }
}

private struct WeatherChartRangeSlider: View {
    @Binding var selectedIndex: Int

    private var selectedOption: WeatherChartRangeOption {
        weatherChartRangeOptions[min(max(selectedIndex, 0), weatherChartRangeOptions.count - 1)]
    }

    var body: some View {
        VStack(spacing: 8) {
            HStack {
                Text("Time scale")
                    .font(HBTypography.body(size: 12, weight: .semibold))
                    .foregroundStyle(HBPalette.textPrimary)
                Spacer()
                Text(selectedOption.label)
                    .font(HBTypography.body(size: 12, weight: .medium))
                    .foregroundStyle(HBPalette.textMuted)
                    .monospacedDigit()
            }

            Slider(
                value: Binding(
                    get: { Double(selectedIndex) },
                    set: { selectedIndex = Int($0.rounded()) }
                ),
                in: 0...Double(weatherChartRangeOptions.count - 1),
                step: 1
            )
            .tint(HBPalette.heroCore)
            .accessibilityLabel("Chart time scale")
            .accessibilityValue(selectedOption.label)

            HStack {
                Text(weatherChartRangeOptions.first?.shortLabel ?? "")
                Spacer()
                Text(weatherChartRangeOptions.last?.shortLabel ?? "")
            }
            .font(HBTypography.body(size: 10, weight: .medium))
            .foregroundStyle(HBPalette.textMuted)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(HBGlassBackground(cornerRadius: 14, variant: .panelSoft))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(HBPalette.panelStroke.opacity(0.55), lineWidth: 1)
        )
    }
}

private func buildWeatherChartSegments<Entry>(
    from entries: [Entry],
    value: (Entry) -> Double?
) -> [WeatherChartSegment] {
    var segments: [WeatherChartSegment] = []
    var currentPoints: [WeatherChartPoint] = []
    var segmentIndex = 0

    func flushCurrentSegment() {
        guard currentPoints.count > 1 else {
            currentPoints.removeAll(keepingCapacity: true)
            return
        }

        segments.append(
            WeatherChartSegment(
                id: "segment-\(segmentIndex)",
                points: currentPoints
            )
        )
        segmentIndex += 1
        currentPoints.removeAll(keepingCapacity: true)
    }

    for (index, entry) in entries.enumerated() {
        guard let entryValue = value(entry) else {
            flushCurrentSegment()
            continue
        }

        currentPoints.append(
            WeatherChartPoint(
                id: "point-\(segmentIndex)-\(index)",
                index: index,
                value: entryValue
            )
        )
    }

    flushCurrentSegment()
    return segments
}

private func buildWeatherChartPoints<Entry>(
    from entries: [Entry],
    value: (Entry) -> Double?
) -> [WeatherChartPoint] {
    entries.enumerated().compactMap { index, entry in
        guard let entryValue = value(entry) else {
            return nil
        }

        return WeatherChartPoint(
            id: "point-\(index)",
            index: index,
            value: entryValue
        )
    }
}

private func weatherChartAxisValues(count: Int, desiredCount: Int = 6) -> [Int] {
    guard count > 0 else { return [] }
    guard count > desiredCount else { return Array(0..<count) }

    let step = Double(count - 1) / Double(max(desiredCount - 1, 1))
    var values = Set<Int>()

    for position in 0..<desiredCount {
        values.insert(Int((Double(position) * step).rounded()))
    }

    values.insert(0)
    values.insert(count - 1)
    return values.sorted()
}

private struct TempestStationMetricsSnapshot {
    let temperatureF: Double?
    let feelsLikeF: Double?
    let dewPointF: Double?
    let humidityPct: Double?
    let windLullMph: Double?
    let windAvgMph: Double?
    let windGustMph: Double?
    let windRapidMph: Double?
    let windDirectionDeg: Double?
    let pressureMb: Double?
    let pressureInHg: Double?
    let pressureTrend: String
    let rainLastMinuteIn: Double?
    let rainTodayIn: Double?
    let rainRateInPerHr: Double?
    let illuminanceLux: Double?
    let uvIndex: Double?
    let solarRadiationWm2: Double?
    let lightningAvgDistanceKm: Double?
    let lightningAvgDistanceMiles: Double?
    let lightningCount: Double?
    let batteryVolts: Double?

    static func from(_ object: [String: Any]) -> TempestStationMetricsSnapshot {
        TempestStationMetricsSnapshot(
            temperatureF: weatherOptionalDouble(object["temperatureF"]),
            feelsLikeF: weatherOptionalDouble(object["feelsLikeF"]),
            dewPointF: weatherOptionalDouble(object["dewPointF"]),
            humidityPct: weatherOptionalDouble(object["humidityPct"]),
            windLullMph: weatherOptionalDouble(object["windLullMph"]),
            windAvgMph: weatherOptionalDouble(object["windAvgMph"]),
            windGustMph: weatherOptionalDouble(object["windGustMph"]),
            windRapidMph: weatherOptionalDouble(object["windRapidMph"]),
            windDirectionDeg: weatherOptionalDouble(object["windDirectionDeg"]),
            pressureMb: weatherOptionalDouble(object["pressureMb"]),
            pressureInHg: weatherOptionalDouble(object["pressureInHg"]),
            pressureTrend: JSON.string(object, "pressureTrend", fallback: "steady"),
            rainLastMinuteIn: weatherOptionalDouble(object["rainLastMinuteIn"]),
            rainTodayIn: weatherOptionalDouble(object["rainTodayIn"]),
            rainRateInPerHr: weatherOptionalDouble(object["rainRateInPerHr"]),
            illuminanceLux: weatherOptionalDouble(object["illuminanceLux"]),
            uvIndex: weatherOptionalDouble(object["uvIndex"]),
            solarRadiationWm2: weatherOptionalDouble(object["solarRadiationWm2"]),
            lightningAvgDistanceKm: weatherOptionalDouble(object["lightningAvgDistanceKm"]),
            lightningAvgDistanceMiles: weatherOptionalDouble(object["lightningAvgDistanceMiles"]),
            lightningCount: weatherOptionalDouble(object["lightningCount"]),
            batteryVolts: weatherOptionalDouble(object["batteryVolts"])
        )
    }
}

private struct TempestStationStatusSnapshot {
    let sensorStatusFlags: [String]
    let firmwareRevision: String
    let hubFirmwareRevision: String
    let signalRssi: Double?
    let hubRssi: Double?
    let websocketConnected: Bool
    let udpListening: Bool

    static func from(_ object: [String: Any]) -> TempestStationStatusSnapshot {
        TempestStationStatusSnapshot(
            sensorStatusFlags: weatherStringArray(object["sensorStatusFlags"]),
            firmwareRevision: JSON.string(object, "firmwareRevision"),
            hubFirmwareRevision: JSON.string(object, "hubFirmwareRevision"),
            signalRssi: weatherOptionalDouble(object["signalRssi"]),
            hubRssi: weatherOptionalDouble(object["hubRssi"]),
            websocketConnected: JSON.bool(object, "websocketConnected"),
            udpListening: JSON.bool(object, "udpListening")
        )
    }
}

private struct TempestStationSnapshot: Identifiable {
    let id: String
    let stationId: Int?
    let name: String
    let room: String
    let model: String
    let brand: String
    let isOnline: Bool
    let observedAt: String?
    let lastEventAt: String?
    let latitude: Double?
    let longitude: Double?
    let timezone: String
    let metrics: TempestStationMetricsSnapshot
    let status: TempestStationStatusSnapshot

    static func from(_ object: [String: Any]) -> TempestStationSnapshot {
        let location = JSON.object(object["location"])
        return TempestStationSnapshot(
            id: JSON.optionalString(object, "id") ?? JSON.id(object),
            stationId: weatherOptionalInt(object["stationId"]),
            name: JSON.string(object, "name", fallback: "Tempest Station"),
            room: JSON.string(object, "room", fallback: "Outside"),
            model: JSON.string(object, "model", fallback: "Tempest"),
            brand: JSON.string(object, "brand", fallback: "WeatherFlow"),
            isOnline: JSON.bool(object, "isOnline", fallback: true),
            observedAt: JSON.optionalString(object, "observedAt"),
            lastEventAt: JSON.optionalString(object, "lastEventAt"),
            latitude: weatherOptionalDouble(location["latitude"]),
            longitude: weatherOptionalDouble(location["longitude"]),
            timezone: JSON.string(location, "timezone", fallback: TimeZone.current.identifier),
            metrics: TempestStationMetricsSnapshot.from(JSON.object(object["metrics"])),
            status: TempestStationStatusSnapshot.from(JSON.object(object["status"]))
        )
    }
}

private struct TempestObservationSnapshot: Identifiable {
    let stationId: Int?
    let deviceId: Int?
    let observationType: String
    let source: String
    let observedAt: String
    let observedDate: Date?
    let metrics: [String: Any]
    let derived: [String: Any]

    var id: String { "\(observationType)-\(observedAt)" }
    var date: Date? { observedDate }

    func metricDouble(_ key: String) -> Double? {
        weatherOptionalDouble(metrics[key])
    }

    func derivedDouble(_ key: String) -> Double? {
        weatherOptionalDouble(derived[key])
    }

    static func from(_ object: [String: Any]) -> TempestObservationSnapshot {
        let observedAt = JSON.string(object, "observedAt")
        return TempestObservationSnapshot(
            stationId: weatherOptionalInt(object["stationId"]),
            deviceId: weatherOptionalInt(object["deviceId"]),
            observationType: JSON.string(object, "observationType", fallback: "obs_st"),
            source: JSON.string(object, "source", fallback: "ws"),
            observedAt: observedAt,
            observedDate: JSON.date(from: observedAt),
            metrics: JSON.object(object["metrics"]),
            derived: JSON.object(object["derived"])
        )
    }
}

private struct TempestEventSnapshot: Identifiable {
    let stationId: Int?
    let deviceId: Int?
    let eventType: String
    let source: String
    let eventAt: String
    let payload: [String: Any]

    var id: String { "\(eventType)-\(eventAt)" }
    var date: Date? { JSON.date(from: eventAt) }

    func payloadDouble(_ key: String) -> Double? {
        weatherOptionalDouble(payload[key])
    }

    static func from(_ object: [String: Any]) -> TempestEventSnapshot {
        TempestEventSnapshot(
            stationId: weatherOptionalInt(object["stationId"]),
            deviceId: weatherOptionalInt(object["deviceId"]),
            eventType: JSON.string(object, "eventType"),
            source: JSON.string(object, "source", fallback: "ws"),
            eventAt: JSON.string(object, "eventAt"),
            payload: JSON.object(object["payload"])
        )
    }
}

private struct GoveeIndoorAirSnapshot: Identifiable, Equatable {
    let id: String
    let deviceName: String
    let room: String
    let observedAt: String?
    let observedDate: Date?
    let temperatureF: Double?
    let humidityPct: Double?
    let pm25UgM3: Double?
    let usAqi: Double?
    let co2Ppm: Double?
    let tvocPpb: Double?
    let qualityLabel: String
    let qualityAdvice: String
    let isOnline: Bool?

    static func from(_ object: [String: Any]) -> GoveeIndoorAirSnapshot? {
        guard !object.isEmpty else {
            return nil
        }

        let observedAt = JSON.optionalString(object, "observedAt")
        return GoveeIndoorAirSnapshot(
            id: JSON.string(object, "id", fallback: UUID().uuidString),
            deviceName: JSON.string(object, "deviceName", fallback: "Govee Indoor Air"),
            room: JSON.string(object, "room", fallback: "Inside"),
            observedAt: observedAt,
            observedDate: JSON.date(from: observedAt),
            temperatureF: weatherOptionalDouble(object["temperatureF"]),
            humidityPct: weatherOptionalDouble(object["humidityPct"]),
            pm25UgM3: weatherOptionalDouble(object["pm25UgM3"]),
            usAqi: weatherOptionalDouble(object["usAqi"]),
            co2Ppm: weatherOptionalDouble(object["co2Ppm"]),
            tvocPpb: weatherOptionalDouble(object["tvocPpb"]),
            qualityLabel: JSON.string(object, "qualityLabel", fallback: "Unknown"),
            qualityAdvice: JSON.string(object, "qualityAdvice", fallback: "Indoor readings are retained for Weather and Data Platform history."),
            isOnline: object["isOnline"] is NSNull ? nil : (object["isOnline"] as? Bool)
        )
    }
}

private struct WeatherForecastSnapshot {
    let fetchedAt: String
    let locationName: String
    let locationSource: DashboardWeatherLocationMode
    let timezone: String
    let currentTemperatureF: Double?
    let apparentTemperatureF: Double?
    let humidity: Double?
    let windSpeedMph: Double?
    let precipitationIn: Double?
    let isDay: Bool
    let condition: String
    let icon: String
    let highF: Double?
    let lowF: Double?
    let precipitationChance: Double?
    let sunrise: String?
    let sunset: String?
    let todayCondition: String
    let hourlyForecast: [WeatherHourlySnapshot]
    let tempestAvailable: Bool
    let tempestStation: TempestStationSnapshot?
    let indoorAir: GoveeIndoorAirSnapshot?

    var headlineTemperatureF: Double? {
        tempestStation?.metrics.temperatureF ?? currentTemperatureF
    }

    var headlineFeelsLikeF: Double? {
        tempestStation?.metrics.feelsLikeF ?? apparentTemperatureF
    }

    static func from(_ object: [String: Any]) -> WeatherForecastSnapshot? {
        let location = JSON.object(object["location"])
        let current = JSON.object(object["current"])
        let today = JSON.object(object["today"])
        guard !location.isEmpty, !current.isEmpty, !today.isEmpty else {
            return nil
        }

        let tempest = JSON.object(object["tempest"])
        let stationObject = JSON.object(tempest["station"])
        let indoorAir = JSON.object(object["indoorAir"])

        return WeatherForecastSnapshot(
            fetchedAt: JSON.string(object, "fetchedAt"),
            locationName: JSON.string(location, "name", fallback: "Saved location"),
            locationSource: DashboardWeatherLocationMode(rawValue: JSON.string(location, "source")) ?? .saved,
            timezone: JSON.string(location, "timezone", fallback: TimeZone.current.identifier),
            currentTemperatureF: weatherOptionalDouble(current["temperatureF"]),
            apparentTemperatureF: weatherOptionalDouble(current["apparentTemperatureF"]),
            humidity: weatherOptionalDouble(current["humidity"]),
            windSpeedMph: weatherOptionalDouble(current["windSpeedMph"]),
            precipitationIn: weatherOptionalDouble(current["precipitationIn"]),
            isDay: JSON.bool(current, "isDay", fallback: true),
            condition: JSON.string(current, "condition", fallback: "Unknown"),
            icon: JSON.string(current, "icon", fallback: "cloudy"),
            highF: weatherOptionalDouble(today["highF"]),
            lowF: weatherOptionalDouble(today["lowF"]),
            precipitationChance: weatherOptionalDouble(today["precipitationChance"]),
            sunrise: JSON.optionalString(today, "sunrise"),
            sunset: JSON.optionalString(today, "sunset"),
            todayCondition: JSON.string(today, "condition", fallback: "Unknown"),
            hourlyForecast: JSON.array(object["hourlyForecast"]).map { WeatherHourlySnapshot.from($0) },
            tempestAvailable: JSON.bool(tempest, "available") && !stationObject.isEmpty,
            tempestStation: stationObject.isEmpty ? nil : TempestStationSnapshot.from(stationObject),
            indoorAir: JSON.bool(indoorAir, "available") ? GoveeIndoorAirSnapshot.from(JSON.object(indoorAir["monitor"])) : nil
        )
    }
}

private struct WeatherDashboardSnapshot {
    let fetchedAt: String
    let forecast: WeatherForecastSnapshot
    let hourlyForecast: [WeatherHourlySnapshot]
    let tempestAvailable: Bool
    let station: TempestStationSnapshot?
    let observations: [TempestObservationSnapshot]
    let events: [TempestEventSnapshot]
    let indoorAir: GoveeIndoorAirSnapshot?
    let indoorAirSamples: [GoveeIndoorAirSnapshot]

    static func from(_ object: [String: Any]) -> WeatherDashboardSnapshot? {
        guard let forecast = WeatherForecastSnapshot.from(JSON.object(object["forecast"])) else {
            return nil
        }

        let tempest = JSON.object(object["tempest"])
        let stationObject = JSON.object(tempest["station"])
        let indoorAir = JSON.object(object["indoorAir"])
        let indoorAirMonitor = JSON.object(indoorAir["monitor"])

        return WeatherDashboardSnapshot(
            fetchedAt: JSON.string(object, "fetchedAt"),
            forecast: forecast,
            hourlyForecast: JSON.array(object["hourlyForecast"]).map { WeatherHourlySnapshot.from($0) },
            tempestAvailable: JSON.bool(tempest, "available") && !stationObject.isEmpty,
            station: stationObject.isEmpty ? nil : TempestStationSnapshot.from(stationObject),
            observations: JSON.array(tempest["observations"]).map { TempestObservationSnapshot.from($0) },
            events: JSON.array(tempest["events"]).map { TempestEventSnapshot.from($0) },
            indoorAir: indoorAirMonitor.isEmpty ? forecast.indoorAir : GoveeIndoorAirSnapshot.from(indoorAirMonitor),
            indoorAirSamples: JSON.array(indoorAir["samples"]).compactMap { GoveeIndoorAirSnapshot.from($0) }
        )
    }
}

private struct TempestIntegrationSnapshot {
    let token: String
    let tokenConfigured: Bool
    let tokenSource: String
    let enabled: Bool
    let websocketEnabled: Bool
    let udpEnabled: Bool
    let udpBindAddress: String
    let udpPort: Int
    let room: String
    let selectedStationId: Int?
    let selectedDeviceIds: [Int]
    let tempOffsetC: Double
    let humidityOffsetPct: Double
    let pressureOffsetMb: Double
    let windSpeedMultiplier: Double
    let rainMultiplier: Double
    let isConnected: Bool
    let lastDiscoveryAt: String?
    let lastSyncAt: String?
    let lastObservationAt: String?
    let lastError: String

    static func from(_ object: [String: Any]) -> TempestIntegrationSnapshot {
        let calibration = JSON.object(object["calibration"])
        return TempestIntegrationSnapshot(
            token: JSON.string(object, "token"),
            tokenConfigured: JSON.bool(object, "tokenConfigured") || !JSON.string(object, "token").isEmpty,
            tokenSource: JSON.string(object, "tokenSource", fallback: "none"),
            enabled: JSON.bool(object, "enabled"),
            websocketEnabled: JSON.bool(object, "websocketEnabled", fallback: true),
            udpEnabled: JSON.bool(object, "udpEnabled"),
            udpBindAddress: JSON.string(object, "udpBindAddress", fallback: "0.0.0.0"),
            udpPort: JSON.int(object, "udpPort", fallback: 50222),
            room: JSON.string(object, "room", fallback: "Outside"),
            selectedStationId: weatherOptionalInt(object["selectedStationId"]),
            selectedDeviceIds: weatherIntArray(object["selectedDeviceIds"]),
            tempOffsetC: weatherOptionalDouble(calibration["tempOffsetC"]) ?? 0,
            humidityOffsetPct: weatherOptionalDouble(calibration["humidityOffsetPct"]) ?? 0,
            pressureOffsetMb: weatherOptionalDouble(calibration["pressureOffsetMb"]) ?? 0,
            windSpeedMultiplier: weatherOptionalDouble(calibration["windSpeedMultiplier"]) ?? 1,
            rainMultiplier: weatherOptionalDouble(calibration["rainMultiplier"]) ?? 1,
            isConnected: JSON.bool(object, "isConnected"),
            lastDiscoveryAt: JSON.optionalString(object, "lastDiscoveryAt"),
            lastSyncAt: JSON.optionalString(object, "lastSyncAt"),
            lastObservationAt: JSON.optionalString(object, "lastObservationAt"),
            lastError: JSON.string(object, "lastError")
        )
    }
}

private struct TempestHealthSnapshot {
    let isConnected: Bool
    let websocketConnected: Bool
    let websocketLastConnectedAt: String?
    let websocketLastMessageAt: String?
    let websocketReconnectCount: Int
    let udpListening: Bool
    let udpLastMessageAt: String?
    let lastDiscoveryAt: String?
    let lastObservationAt: String?
    let lastError: String

    static func from(_ object: [String: Any]) -> TempestHealthSnapshot {
        TempestHealthSnapshot(
            isConnected: JSON.bool(object, "isConnected"),
            websocketConnected: JSON.bool(object, "websocketConnected"),
            websocketLastConnectedAt: JSON.optionalString(object, "websocketLastConnectedAt"),
            websocketLastMessageAt: JSON.optionalString(object, "websocketLastMessageAt"),
            websocketReconnectCount: JSON.int(object, "websocketReconnectCount"),
            udpListening: JSON.bool(object, "udpListening"),
            udpLastMessageAt: JSON.optionalString(object, "udpLastMessageAt"),
            lastDiscoveryAt: JSON.optionalString(object, "lastDiscoveryAt"),
            lastObservationAt: JSON.optionalString(object, "lastObservationAt"),
            lastError: JSON.string(object, "lastError")
        )
    }
}

private struct TempestStatusSnapshot {
    let integration: TempestIntegrationSnapshot
    let health: TempestHealthSnapshot
    let selectedStation: TempestStationSnapshot?
    let stations: [TempestStationSnapshot]

    static func from(_ object: [String: Any]) -> TempestStatusSnapshot? {
        let integration = JSON.object(object["integration"])
        let health = JSON.object(object["health"])
        guard !integration.isEmpty, !health.isEmpty else {
            return nil
        }

        let selectedStationObject = JSON.object(object["selectedStation"])
        return TempestStatusSnapshot(
            integration: TempestIntegrationSnapshot.from(integration),
            health: TempestHealthSnapshot.from(health),
            selectedStation: selectedStationObject.isEmpty ? nil : TempestStationSnapshot.from(selectedStationObject),
            stations: JSON.array(object["stations"]).map { TempestStationSnapshot.from($0) }
        )
    }
}

private struct TempestStationChoice: Identifiable {
    let stationId: Int
    let name: String
    let detail: String

    var id: Int { stationId }

    static func fromStatusStation(_ station: TempestStationSnapshot) -> TempestStationChoice? {
        guard let stationId = station.stationId else { return nil }
        return TempestStationChoice(
            stationId: stationId,
            name: station.name,
            detail: "\(station.room) • \(station.model)"
        )
    }

    static func fromDiscovery(_ object: [String: Any]) -> TempestStationChoice? {
        let stationId = JSON.int(object, "stationId")
        guard stationId > 0 else { return nil }
        let devices = JSON.array(object["devices"])
        return TempestStationChoice(
            stationId: stationId,
            name: JSON.string(object, "name", fallback: "Tempest Station"),
            detail: "\(max(devices.count, 1)) devices"
        )
    }
}

private struct TempestConfigForm {
    var token = ""
    var enabled = false
    var websocketEnabled = true
    var udpEnabled = false
    var udpBindAddress = "0.0.0.0"
    var udpPort = "50222"
    var room = "Outside"
    var selectedStationId: Int?
    var selectedDeviceIds: [Int] = []
    var tempOffsetC = "0"
    var humidityOffsetPct = "0"
    var pressureOffsetMb = "0"
    var windSpeedMultiplier = "1"
    var rainMultiplier = "1"

    mutating func hydrate(from status: TempestStatusSnapshot) {
        token = status.integration.tokenConfigured || weatherIsMaskedSecret(status.integration.token)
            ? tempestConfiguredSecretPlaceholder
            : status.integration.token
        enabled = status.integration.enabled
        websocketEnabled = status.integration.websocketEnabled
        udpEnabled = status.integration.udpEnabled
        udpBindAddress = status.integration.udpBindAddress
        udpPort = String(status.integration.udpPort)
        room = status.integration.room
        selectedStationId = status.integration.selectedStationId
        selectedDeviceIds = status.integration.selectedDeviceIds
        tempOffsetC = String(format: "%.2f", status.integration.tempOffsetC)
        humidityOffsetPct = String(format: "%.2f", status.integration.humidityOffsetPct)
        pressureOffsetMb = String(format: "%.2f", status.integration.pressureOffsetMb)
        windSpeedMultiplier = String(format: "%.2f", status.integration.windSpeedMultiplier)
        rainMultiplier = String(format: "%.2f", status.integration.rainMultiplier)
    }

    func payload() -> [String: Any] {
        var result: [String: Any] = [
            "enabled": enabled,
            "websocketEnabled": websocketEnabled,
            "udpEnabled": udpEnabled,
            "udpBindAddress": udpBindAddress.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "0.0.0.0" : udpBindAddress.trimmingCharacters(in: .whitespacesAndNewlines),
            "udpPort": Int(udpPort.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 50222,
            "room": room.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Outside" : room.trimmingCharacters(in: .whitespacesAndNewlines),
            "selectedStationId": selectedStationId ?? NSNull(),
            "selectedDeviceIds": selectedDeviceIds,
            "calibration": [
                "tempOffsetC": Double(tempOffsetC.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0,
                "humidityOffsetPct": Double(humidityOffsetPct.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0,
                "pressureOffsetMb": (Double(pressureOffsetMb.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0) as Any,
                "windSpeedMultiplier": Double(windSpeedMultiplier.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 1,
                "rainMultiplier": Double(rainMultiplier.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 1
            ]
        ]

        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedToken.isEmpty && !weatherIsMaskedSecret(trimmedToken) {
            result["token"] = trimmedToken
        }

        return result
    }
}

private struct GoveeDeviceChoice: Identifiable {
    let sku: String
    let device: String
    let name: String
    let type: String
    let isAirQualityDevice: Bool
    let ip: String
    let port: Int

    var id: String { "\(sku)::\(device)" }
    var detail: String {
        let local = ip.isEmpty ? "" : " • LAN \(ip)"
        return "\(sku)\(isAirQualityDevice ? " • sensor" : "")\(local)"
    }

    static func from(_ object: [String: Any]) -> GoveeDeviceChoice? {
        let sku = JSON.string(object, "sku")
        let device = JSON.string(object, "device")
        guard !sku.isEmpty, !device.isEmpty else { return nil }
        return GoveeDeviceChoice(
            sku: sku,
            device: device,
            name: JSON.string(object, "deviceName", fallback: "Govee Indoor Air"),
            type: JSON.string(object, "type"),
            isAirQualityDevice: JSON.bool(object, "isAirQualityDevice"),
            ip: JSON.string(object, "ip"),
            port: JSON.int(object, "port", fallback: 4003)
        )
    }
}

private struct GoveeIntegrationSnapshot {
    let apiKey: String
    let apiKeyConfigured: Bool
    let apiKeySource: String
    let connectionMode: String
    let enabled: Bool
    let room: String
    let selectedDevice: String
    let selectedSku: String
    let selectedDeviceName: String
    let selectedDeviceType: String
    let pollIntervalMs: Int
    let tempOffsetF: Double
    let humidityOffsetPct: Double
    let pm25OffsetUgM3: Double
    let localDeviceIp: String
    let localDevicePort: Int
    let lastLocalError: String
    let lastSampleSource: String
    let lastError: String

    static func from(_ object: [String: Any]) -> GoveeIntegrationSnapshot {
        GoveeIntegrationSnapshot(
            apiKey: JSON.string(object, "apiKey"),
            apiKeyConfigured: JSON.bool(object, "apiKeyConfigured"),
            apiKeySource: JSON.string(object, "apiKeySource", fallback: "none"),
            connectionMode: JSON.string(object, "connectionMode", fallback: "auto"),
            enabled: JSON.bool(object, "enabled"),
            room: JSON.string(object, "room", fallback: "Inside"),
            selectedDevice: JSON.string(object, "selectedDevice"),
            selectedSku: JSON.string(object, "selectedSku"),
            selectedDeviceName: JSON.string(object, "selectedDeviceName"),
            selectedDeviceType: JSON.string(object, "selectedDeviceType"),
            pollIntervalMs: JSON.int(object, "pollIntervalMs", fallback: 60_000),
            tempOffsetF: weatherOptionalDouble(object["tempOffsetF"]) ?? 0,
            humidityOffsetPct: weatherOptionalDouble(object["humidityOffsetPct"]) ?? 0,
            pm25OffsetUgM3: weatherOptionalDouble(object["pm25OffsetUgM3"]) ?? 0,
            localDeviceIp: JSON.string(object, "localDeviceIp"),
            localDevicePort: JSON.int(object, "localDevicePort", fallback: 4003),
            lastLocalError: JSON.string(object, "lastLocalError"),
            lastSampleSource: JSON.string(object, "lastSampleSource"),
            lastError: JSON.string(object, "lastError")
        )
    }
}

private struct GoveeStatusSnapshot {
    let integration: GoveeIntegrationSnapshot
    let selectedDevice: GoveeDeviceChoice?
    let devices: [GoveeDeviceChoice]
    let latestSample: GoveeIndoorAirSnapshot?
    let isConnected: Bool
    let lastSampleAt: String?
    let lastSyncAt: String?
    let lastError: String
    let lastLocalError: String
    let lastSampleSource: String

    static func from(_ object: [String: Any]) -> GoveeStatusSnapshot? {
        let integration = JSON.object(object["integration"])
        let health = JSON.object(object["health"])
        guard !integration.isEmpty, !health.isEmpty else {
            return nil
        }

        let selectedDeviceObject = JSON.object(object["selectedDevice"])
        let latestSampleObject = JSON.object(object["latestSample"])
        return GoveeStatusSnapshot(
            integration: GoveeIntegrationSnapshot.from(integration),
            selectedDevice: selectedDeviceObject.isEmpty ? nil : GoveeDeviceChoice.from(selectedDeviceObject),
            devices: mergeGoveeDevices(
                JSON.array(object["devices"]).compactMap { GoveeDeviceChoice.from($0) },
                JSON.array(object["localDevices"]).compactMap { GoveeDeviceChoice.from($0) }
            ),
            latestSample: latestSampleObject.isEmpty ? nil : GoveeIndoorAirSnapshot.from(latestSampleObject),
            isConnected: JSON.bool(health, "isConnected"),
            lastSampleAt: JSON.optionalString(health, "lastSampleAt"),
            lastSyncAt: JSON.optionalString(health, "lastSyncAt"),
            lastError: JSON.string(health, "lastError"),
            lastLocalError: JSON.string(health, "lastLocalError"),
            lastSampleSource: JSON.string(health, "lastSampleSource")
        )
    }
}

private func mergeGoveeDevices(_ groups: [GoveeDeviceChoice]...) -> [GoveeDeviceChoice] {
    var ordered: [GoveeDeviceChoice] = []
    var seen = Set<String>()
    for device in groups.flatMap({ $0 }) {
        guard !seen.contains(device.id) else { continue }
        ordered.append(device)
        seen.insert(device.id)
    }
    return ordered
}

private struct GoveeConfigForm {
    var apiKey = ""
    var connectionMode = "auto"
    var enabled = false
    var room = "Inside"
    var selectedDevice = ""
    var selectedSku = ""
    var selectedDeviceName = ""
    var selectedDeviceType = ""
    var pollIntervalSeconds = "60"
    var tempOffsetF = "0"
    var humidityOffsetPct = "0"
    var pm25OffsetUgM3 = "0"
    var localDeviceIp = ""
    var localDevicePort = "4003"

    mutating func hydrate(from status: GoveeStatusSnapshot) {
        apiKey = status.integration.apiKeyConfigured || weatherIsMaskedSecret(status.integration.apiKey)
            ? tempestConfiguredSecretPlaceholder
            : status.integration.apiKey
        connectionMode = status.integration.connectionMode.isEmpty ? "auto" : status.integration.connectionMode
        enabled = status.integration.enabled
        room = status.integration.room
        selectedDevice = status.integration.selectedDevice
        selectedSku = status.integration.selectedSku
        selectedDeviceName = status.integration.selectedDeviceName
        selectedDeviceType = status.integration.selectedDeviceType
        pollIntervalSeconds = String(max(60, status.integration.pollIntervalMs / 1000))
        tempOffsetF = String(format: "%.2f", status.integration.tempOffsetF)
        humidityOffsetPct = String(format: "%.2f", status.integration.humidityOffsetPct)
        pm25OffsetUgM3 = String(format: "%.2f", status.integration.pm25OffsetUgM3)
        localDeviceIp = status.integration.localDeviceIp
        localDevicePort = String(status.integration.localDevicePort)
    }

    mutating func select(_ device: GoveeDeviceChoice?) {
        guard let device else {
            selectedDevice = ""
            selectedSku = ""
            selectedDeviceName = ""
            selectedDeviceType = ""
            return
        }
        selectedDevice = device.device
        selectedSku = device.sku
        selectedDeviceName = device.name
        selectedDeviceType = device.type
        if !device.ip.isEmpty {
            localDeviceIp = device.ip
            localDevicePort = String(device.port)
        }
    }

    func payload() -> [String: Any] {
        var result: [String: Any] = [
            "connectionMode": ["auto", "cloud", "local"].contains(connectionMode) ? connectionMode : "auto",
            "enabled": enabled,
            "room": room.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Inside" : room.trimmingCharacters(in: .whitespacesAndNewlines),
            "pollIntervalMs": max(60, Int(pollIntervalSeconds.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 60) * 1000,
            "tempOffsetF": Double(tempOffsetF.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0,
            "humidityOffsetPct": Double(humidityOffsetPct.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0,
            "pm25OffsetUgM3": Double(pm25OffsetUgM3.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0,
            "localDeviceIp": localDeviceIp.trimmingCharacters(in: .whitespacesAndNewlines),
            "localDevicePort": max(1, min(65535, Int(localDevicePort.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 4003))
        ]

        if selectedDevice.isEmpty || selectedSku.isEmpty {
            result["autoSelect"] = true
        } else {
            result["selectedDevice"] = selectedDevice
            result["selectedSku"] = selectedSku
            result["selectedDeviceName"] = selectedDeviceName
            result["selectedDeviceType"] = selectedDeviceType
        }

        let trimmedKey = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedKey.isEmpty && !weatherIsMaskedSecret(trimmedKey) {
            result["apiKey"] = trimmedKey
        }

        return result
    }
}

@MainActor
private final class WeatherLocationManager: NSObject, ObservableObject, CLLocationManagerDelegate {
    @Published private(set) var coordinate: CLLocationCoordinate2D?
    @Published private(set) var errorMessage: String?
    @Published private(set) var isRequesting = false

    private let manager = CLLocationManager()

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyKilometer
    }

    func requestLocation() {
        errorMessage = nil
        isRequesting = true
        handleAuthorizationStatus(manager.authorizationStatus)
    }

    private func handleAuthorizationStatus(_ status: CLAuthorizationStatus) {
        switch status {
        case .authorizedAlways, .authorizedWhenInUse:
            manager.requestLocation()
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .denied, .restricted:
            isRequesting = false
            errorMessage = "Allow location access in Settings to use auto-detected weather."
        @unknown default:
            isRequesting = false
            errorMessage = "Location permission is unavailable."
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard isRequesting else { return }
        handleAuthorizationStatus(manager.authorizationStatus)
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        coordinate = locations.last?.coordinate
        errorMessage = nil
        isRequesting = false
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        isRequesting = false
        if let error = error as? CLError {
            switch error.code {
            case .denied:
                errorMessage = "Allow location access in Settings to use auto-detected weather."
            case .locationUnknown:
                errorMessage = "HomeBrain couldn't determine the current location yet. Try again in a moment."
            default:
                errorMessage = error.localizedDescription
            }
        } else {
            errorMessage = error.localizedDescription
        }
    }
}

private struct WeatherTelemetryCardItem: Identifiable {
    let title: String
    let value: String
    let detail: String
    let accent: Color
    let gradient: [Color]

    var id: String { title }
}

private struct WeatherTelemetryTile: View {
    let title: String
    let value: String
    let detail: String
    let accent: Color
    let gradient: [Color]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(HBTypography.display(size: 11, weight: .bold))
                .textCase(.uppercase)
                .tracking(2.2)
                .foregroundStyle(HBPalette.textMuted)

            Text(value)
                .font(HBTypography.display(size: 28, weight: .bold))
                .foregroundStyle(HBPalette.textPrimary)
                .minimumScaleFactor(0.7)
                .lineLimit(1)

            Text(detail)
                .font(HBTypography.body(size: 13, weight: .medium))
                .foregroundStyle(HBPalette.textSecondary)
                .lineLimit(2)

            Capsule()
                .fill(
                    LinearGradient(
                        colors: [accent, accent.opacity(0.18)],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                )
                .frame(width: 50, height: 4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background {
            ZStack {
                HBGlassBackground(cornerRadius: 22, variant: .panelSoft)
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(LinearGradient(colors: gradient, startPoint: .topLeading, endPoint: .bottomTrailing))
                    .opacity(0.92)
            }
        }
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(accent.opacity(0.30), lineWidth: 1)
        )
    }
}

struct WeatherView: View {
    @EnvironmentObject private var session: SessionStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    @StateObject private var locationManager = WeatherLocationManager()

    @State private var weatherLocationModeRaw = DashboardWeatherLocationMode.saved.rawValue
    @State private var weatherLocationQuery = ""

    @State private var dashboard: WeatherDashboardSnapshot?
    @State private var tempestStatus: TempestStatusSnapshot?
    @State private var tempestForm = TempestConfigForm()
    @State private var discoveredStations: [TempestStationChoice] = []
    @State private var goveeStatus: GoveeStatusSnapshot?
    @State private var goveeForm = GoveeConfigForm()
    @State private var discoveredGoveeDevices: [GoveeDeviceChoice] = []

    @State private var isLoading = true
    @State private var isRefreshing = false
    @State private var isLoadingTempest = false
    @State private var isTestingTempest = false
    @State private var isSavingTempest = false
    @State private var isSyncingTempest = false
    @State private var isLoadingGovee = false
    @State private var isTestingGovee = false
    @State private var isDiscoveringLocalGovee = false
    @State private var isTestingLocalGovee = false
    @State private var isSavingGovee = false
    @State private var isSyncingGovee = false

    @State private var errorMessage: String?
    @State private var infoMessage = ""
    @State private var adminErrorMessage: String?
    @State private var adminInfoMessage = ""
    @State private var forecastRangeIndex = defaultWeatherChartRangeIndex
    @State private var indoorAirRangeIndex = defaultWeatherChartRangeIndex
    @State private var atmosphericRangeIndex = defaultWeatherChartRangeIndex
    @State private var windRangeIndex = defaultWeatherChartRangeIndex
    @State private var environmentalRangeIndex = defaultWeatherChartRangeIndex

    private var isAdmin: Bool {
        session.currentUser?.role == "admin"
    }

    private var weatherLocationMode: DashboardWeatherLocationMode {
        DashboardWeatherLocationMode(rawValue: weatherLocationModeRaw) ?? .saved
    }

    private var weatherLocationModeBinding: Binding<DashboardWeatherLocationMode> {
        Binding(
            get: { weatherLocationMode },
            set: { weatherLocationModeRaw = $0.rawValue }
        )
    }

    private var usesCompactWeatherLayout: Bool {
        horizontalSizeClass == .compact
    }

    private var stationChoices: [TempestStationChoice] {
        if !discoveredStations.isEmpty {
            return discoveredStations
        }
        return tempestStatus?.stations.compactMap { TempestStationChoice.fromStatusStation($0) } ?? []
    }

    private var selectedStationPickerValue: Binding<String> {
        Binding(
            get: { tempestForm.selectedStationId.map(String.init) ?? "__auto__" },
            set: { newValue in
                tempestForm.selectedStationId = newValue == "__auto__" ? nil : Int(newValue)
            }
        )
    }

    private var goveeDeviceChoices: [GoveeDeviceChoice] {
        if !discoveredGoveeDevices.isEmpty {
            return discoveredGoveeDevices
        }
        return goveeStatus?.devices ?? []
    }

    private var selectedGoveePickerValue: Binding<String> {
        Binding(
            get: {
                guard !goveeForm.selectedSku.isEmpty, !goveeForm.selectedDevice.isEmpty else {
                    return "__auto__"
                }
                return "\(goveeForm.selectedSku)::\(goveeForm.selectedDevice)"
            },
            set: { newValue in
                if newValue == "__auto__" {
                    goveeForm.select(nil)
                    return
                }
                goveeForm.select(goveeDeviceChoices.first(where: { $0.id == newValue }))
            }
        )
    }

    private var autoLocationKey: String {
        guard let coordinate = locationManager.coordinate else {
            return "none"
        }
        return String(format: "%.4f:%.4f", coordinate.latitude, coordinate.longitude)
    }

    private var activeForecast: WeatherForecastSnapshot? {
        dashboard?.forecast
    }

    private var activeStation: TempestStationSnapshot? {
        dashboard?.station ?? activeForecast?.tempestStation
    }

    private var activeIndoorAir: GoveeIndoorAirSnapshot? {
        dashboard?.indoorAir ?? activeForecast?.indoorAir
    }

    private func chartRangeOption(at index: Int) -> WeatherChartRangeOption {
        weatherChartRangeOptions[min(max(index, 0), weatherChartRangeOptions.count - 1)]
    }

    private var forecastTrendData: [WeatherHourlySnapshot] {
        let entries = Array(
            (dashboard?.hourlyForecast ?? activeForecast?.hourlyForecast ?? [])
                .prefix(chartRangeOption(at: forecastRangeIndex).hours)
        )
        return downsampleWeatherChartData(entries)
    }

    private var forecastAxisLabels: [String] {
        forecastTrendData.map { formatWeatherChartTimestamp($0.date, hours: chartRangeOption(at: forecastRangeIndex).hours) }
    }

    private var forecastTemperaturePoints: [WeatherChartPoint] {
        buildWeatherChartPoints(
            from: forecastTrendData,
            value: { $0.temperatureF }
        )
    }

    private var forecastWindPoints: [WeatherChartPoint] {
        buildWeatherChartPoints(
            from: forecastTrendData,
            value: { $0.windSpeedMph }
        )
    }

    private var forecastPrecipitationPoints: [WeatherChartPoint] {
        buildWeatherChartPoints(
            from: forecastTrendData,
            value: { $0.precipitationChance }
        )
    }

    private var indoorAirTrendData: [GoveeIndoorAirSnapshot] {
        weatherChartHistory(
            dashboard?.indoorAirSamples ?? [],
            hours: chartRangeOption(at: indoorAirRangeIndex).hours,
            timestamp: { $0.observedDate }
        )
    }

    private var indoorAirAxisLabels: [String] {
        indoorAirTrendData.map { formatWeatherChartTimestamp($0.observedDate, hours: chartRangeOption(at: indoorAirRangeIndex).hours) }
    }

    private var indoorTemperatureSegments: [WeatherChartSegment] {
        buildWeatherChartSegments(
            from: indoorAirTrendData,
            value: { $0.temperatureF }
        )
    }

    private var indoorHumiditySegments: [WeatherChartSegment] {
        buildWeatherChartSegments(
            from: indoorAirTrendData,
            value: { $0.humidityPct }
        )
    }

    private var indoorPM25Segments: [WeatherChartSegment] {
        buildWeatherChartSegments(
            from: indoorAirTrendData,
            value: { $0.pm25UgM3 }
        )
    }

    private var indoorAQISegments: [WeatherChartSegment] {
        buildWeatherChartSegments(
            from: indoorAirTrendData,
            value: { $0.usAqi }
        )
    }

    private var atmosphericTrendData: [TempestObservationSnapshot] {
        weatherChartHistory(
            (dashboard?.observations ?? []).filter { $0.observationType != "rapid_wind" },
            hours: chartRangeOption(at: atmosphericRangeIndex).hours,
            timestamp: { $0.observedDate }
        )
    }

    private var atmosphericAxisLabels: [String] {
        atmosphericTrendData.map { formatWeatherChartTimestamp($0.observedDate, hours: chartRangeOption(at: atmosphericRangeIndex).hours) }
    }

    private var environmentalTrendData: [TempestObservationSnapshot] {
        weatherChartHistory(
            (dashboard?.observations ?? []).filter { $0.observationType != "rapid_wind" },
            hours: chartRangeOption(at: environmentalRangeIndex).hours,
            timestamp: { $0.observedDate }
        )
    }

    private var environmentalAxisLabels: [String] {
        environmentalTrendData.map { formatWeatherChartTimestamp($0.observedDate, hours: chartRangeOption(at: environmentalRangeIndex).hours) }
    }

    private var windTrendData: [WeatherWindChartSample] {
        let observations = dashboard?.observations ?? []
        let hours = chartRangeOption(at: windRangeIndex).hours
        let standard = weatherChartHistory(
            observations.filter { $0.observationType != "rapid_wind" },
            hours: hours,
            timestamp: { $0.observedDate }
        )
        let rapid = weatherChartHistory(
            observations.filter { $0.observationType == "rapid_wind" },
            hours: hours,
            timestamp: { $0.observedDate }
        )
        let base = standard.isEmpty ? rapid : standard
        let rapidTimed: [(date: Date, observation: TempestObservationSnapshot)] = rapid.compactMap { observation in
            guard let date = observation.observedDate else { return nil }
            return (date: date, observation: observation)
        }
        var rapidIndex = 0

        return base.map { entry in
            var closestRapid: TempestObservationSnapshot?
            if let entryDate = entry.observedDate, !rapidTimed.isEmpty {
                while rapidIndex + 1 < rapidTimed.count {
                    let currentDistance = abs(rapidTimed[rapidIndex].date.timeIntervalSince(entryDate))
                    let nextDistance = abs(rapidTimed[rapidIndex + 1].date.timeIntervalSince(entryDate))
                    guard nextDistance <= currentDistance else {
                        break
                    }
                    rapidIndex += 1
                }
                closestRapid = rapidTimed[rapidIndex].observation
            }
            return WeatherWindChartSample(
                observedDate: entry.observedDate,
                averageMph: metersPerSecondToMph(entry.metricDouble("wind_avg_mps")),
                gustMph: metersPerSecondToMph(entry.metricDouble("wind_gust_mps")),
                rapidMph: metersPerSecondToMph(closestRapid?.metricDouble("wind_rapid_mps"))
            )
        }
    }

    private var windAxisLabels: [String] {
        windTrendData.map { formatWeatherChartTimestamp($0.observedDate, hours: chartRangeOption(at: windRangeIndex).hours) }
    }

    private var atmosphericTemperatureSegments: [WeatherChartSegment] {
        buildWeatherChartSegments(
            from: atmosphericTrendData,
            value: { celsiusToFahrenheit($0.metricDouble("temp_c")) }
        )
    }

    private var atmosphericFeelsLikeSegments: [WeatherChartSegment] {
        buildWeatherChartSegments(
            from: atmosphericTrendData,
            value: { celsiusToFahrenheit($0.derivedDouble("feels_like_c")) }
        )
    }

    private var atmosphericDewPointSegments: [WeatherChartSegment] {
        buildWeatherChartSegments(
            from: atmosphericTrendData,
            value: { celsiusToFahrenheit($0.derivedDouble("dew_point_c")) }
        )
    }

    private var environmentalPressureSegments: [WeatherChartSegment] {
        buildWeatherChartSegments(
            from: environmentalTrendData,
            value: { millibarToInHg($0.metricDouble("pressure_mb")) }
        )
    }

    private var environmentalRainRatePoints: [WeatherChartPoint] {
        buildWeatherChartPoints(
            from: environmentalTrendData,
            value: { millimetersToInches($0.derivedDouble("rain_rate_mm_per_hr")) }
        )
    }

    private var environmentalSolarSegments: [WeatherChartSegment] {
        buildWeatherChartSegments(
            from: environmentalTrendData,
            value: { $0.metricDouble("solar_radiation_wm2") }
        )
    }

    private var windAverageSegments: [WeatherChartSegment] {
        buildWeatherChartSegments(
            from: windTrendData,
            value: { $0.averageMph }
        )
    }

    private var windGustSegments: [WeatherChartSegment] {
        buildWeatherChartSegments(
            from: windTrendData,
            value: { $0.gustMph }
        )
    }

    private var windRapidSegments: [WeatherChartSegment] {
        buildWeatherChartSegments(
            from: windTrendData,
            value: { $0.rapidMph }
        )
    }

    private var recentEvents: [TempestEventSnapshot] {
        Array((dashboard?.events ?? []).prefix(8))
    }

    @ViewBuilder
    private func weatherSplitPanels<Leading: View, Trailing: View>(
        @ViewBuilder leading: () -> Leading,
        @ViewBuilder trailing: () -> Trailing
    ) -> some View {
        let layout = usesCompactWeatherLayout
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 14))
            : AnyLayout(HStackLayout(alignment: .top, spacing: 14))

        layout {
            leading()
                .frame(maxWidth: .infinity, alignment: .topLeading)
            trailing()
                .frame(maxWidth: .infinity, alignment: .topLeading)
        }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                if isLoading && dashboard == nil {
                    LoadingView(title: "Loading weather systems...")
                } else {
                    HBSectionHeader(
                        title: "Weather Command Deck",
                        subtitle: "Forecast-first by default, with optional Tempest telemetry, charts, and station operations.",
                        eyebrow: "Atmospheric Systems",
                        buttonTitle: isRefreshing ? "Refreshing..." : "Refresh",
                        buttonIcon: isRefreshing ? "arrow.triangle.2.circlepath.circle.fill" : "arrow.clockwise",
                        buttonAction: {
                            Task { await refreshAll(silent: false, includeTempestStatus: isAdmin, forceTempestSync: true, forceIndoorAirSync: true) }
                        }
                    )

                    if let errorMessage, dashboard == nil {
                        InlineErrorView(message: errorMessage) {
                            Task { await refreshAll(silent: false, includeTempestStatus: isAdmin, forceTempestSync: true, forceIndoorAirSync: true) }
                        }
                    }

                    if !infoMessage.isEmpty {
                        HBPanel {
                            Text(infoMessage)
                                .font(HBTypography.body(size: 14, weight: .medium))
                                .foregroundStyle(HBPalette.textSecondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }

                    locationControlsPanel

                    if let dashboard {
                        weatherHero(for: dashboard)
                        weatherTelemetryGrid(for: dashboard)
                        weatherSensorAndForecastPanels(for: dashboard)
                        indoorAirHistoryPanel
                        weatherHistoricalPanels(for: dashboard)
                        weatherEnvironmentalPanel
                        weatherEventsPanel
                    } else if weatherLocationMode == .auto && locationManager.isRequesting {
                        EmptyStateView(
                            title: "Finding current location",
                            subtitle: "HomeBrain is requesting this device's location so the weather dashboard can auto-target the forecast."
                        )
                    } else {
                        EmptyStateView(
                            title: "Weather unavailable",
                            subtitle: locationUnavailableMessage
                        )
                    }

                    if isAdmin {
                        tempestAdminPanel
                        goveeAdminPanel
                    }
                }
            }
            .padding()
        }
        .refreshable {
            await refreshAll(silent: false, includeTempestStatus: isAdmin, forceTempestSync: true, forceIndoorAirSync: true)
        }
        .task {
            loadLocationPreferences()
            await refreshAll(silent: false, includeTempestStatus: isAdmin)
        }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                guard !Task.isCancelled else { break }
                await loadWeatherDashboard(silent: true)
            }
        }
        .onChange(of: weatherLocationModeRaw) { _, _ in
            persistLocationPreferences()
            Task { await loadWeatherDashboard(silent: dashboard != nil) }
        }
        .onChange(of: weatherLocationQuery) { _, _ in
            persistLocationPreferences()
        }
        .onChange(of: autoLocationKey) { _, _ in
            guard weatherLocationMode == .auto else { return }
            Task { await loadWeatherDashboard(silent: dashboard != nil) }
        }
    }

    private func loadLocationPreferences() {
        guard let activeInstanceID = session.activeInstanceID else { return }
        let defaults = UserDefaults.standard
        let modeKey = "homebrain.ios.weather.location-mode.\(activeInstanceID)"
        let queryKey = "homebrain.ios.weather.location-query.\(activeInstanceID)"

        if let storedMode = defaults.string(forKey: modeKey) {
            weatherLocationModeRaw = storedMode
            weatherLocationQuery = defaults.string(forKey: queryKey) ?? ""
            return
        }

        let legacyMigrationKey = "homebrain.ios.weather.location-preferences.migrated"
        if !defaults.bool(forKey: legacyMigrationKey) {
            weatherLocationModeRaw = defaults.string(forKey: "homebrain.ios.weather.location-mode")
                ?? DashboardWeatherLocationMode.saved.rawValue
            weatherLocationQuery = defaults.string(forKey: "homebrain.ios.weather.location-query") ?? ""
            defaults.set(true, forKey: legacyMigrationKey)
        }
        persistLocationPreferences()
    }

    private func persistLocationPreferences() {
        guard let activeInstanceID = session.activeInstanceID else { return }
        let defaults = UserDefaults.standard
        defaults.set(weatherLocationModeRaw, forKey: "homebrain.ios.weather.location-mode.\(activeInstanceID)")
        defaults.set(weatherLocationQuery, forKey: "homebrain.ios.weather.location-query.\(activeInstanceID)")
    }

    private var locationUnavailableMessage: String {
        if weatherLocationMode == .auto {
            return locationManager.errorMessage ?? "Allow location access or switch to a saved/custom address."
        }
        if weatherLocationMode == .custom {
            return errorMessage ?? "Enter a valid address and refresh the weather deck."
        }
        return errorMessage ?? "Add a saved address in Settings or choose a custom location."
    }

    private var locationControlsPanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .center) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Targeting")
                            .font(HBTypography.display(size: 11, weight: .bold))
                            .textCase(.uppercase)
                            .tracking(2.4)
                            .foregroundStyle(HBPalette.textMuted)
                        Text("Choose where the deck points the forecast engine.")
                            .font(HBTypography.body(size: 15, weight: .medium))
                            .foregroundStyle(HBPalette.textSecondary)
                    }

                    Spacer()

                    HBBadge(text: weatherLocationMode.title)
                }

                Picker("Location Source", selection: weatherLocationModeBinding) {
                    ForEach(DashboardWeatherLocationMode.allCases) { mode in
                        Text(mode.title).tag(mode)
                    }
                }
                .pickerStyle(.segmented)

                if weatherLocationMode == .custom {
                    TextField("City, State or full address", text: $weatherLocationQuery)
                        .textInputAutocapitalization(.words)
                        .disableAutocorrection(false)
                        .submitLabel(.search)
                        .hbPanelTextField()
                        .onSubmit {
                            Task { await loadWeatherDashboard(silent: false, forceTempestSync: true, forceIndoorAirSync: true) }
                        }
                }

                Group {
                    if usesCompactWeatherLayout && weatherLocationMode == .auto {
                        VStack(spacing: 10) {
                            Button {
                                Task { await loadWeatherDashboard(silent: false, forceTempestSync: true, forceIndoorAirSync: true) }
                            } label: {
                                Label(isRefreshing ? "Refreshing..." : "Refresh Deck", systemImage: "arrow.clockwise")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(HBPrimaryButtonStyle(compact: true))

                            Button {
                                locationManager.requestLocation()
                            } label: {
                                Label("Use Device Location", systemImage: "location")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(HBSecondaryButtonStyle(compact: true))
                        }
                    } else {
                        HStack(spacing: 10) {
                            Button {
                                Task { await loadWeatherDashboard(silent: false, forceTempestSync: true, forceIndoorAirSync: true) }
                            } label: {
                                Label(isRefreshing ? "Refreshing..." : "Refresh Deck", systemImage: "arrow.clockwise")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(HBPrimaryButtonStyle(compact: true))

                            if weatherLocationMode == .auto {
                                Button {
                                    locationManager.requestLocation()
                                } label: {
                                    Label("Use Device Location", systemImage: "location")
                                        .frame(maxWidth: .infinity)
                                }
                                .buttonStyle(HBSecondaryButtonStyle(compact: true))
                            }
                        }
                    }
                }
            }
        }
    }

    private func weatherHero(for dashboard: WeatherDashboardSnapshot) -> some View {
        let forecast = dashboard.forecast
        let station = dashboard.station ?? forecast.tempestStation
        let indoorAir = dashboard.indoorAir ?? forecast.indoorAir
        let headlineTemperature = forecast.headlineTemperatureF
        let headlineFeelsLike = forecast.headlineFeelsLikeF
        let stationLive = dashboard.tempestAvailable && station != nil
        let lastSyncedAt = weatherMostRecentTimestamp(
            station?.observedAt,
            station?.lastEventAt,
            indoorAir?.observedAt,
            dashboard.fetchedAt.isEmpty ? nil : dashboard.fetchedAt,
            forecast.fetchedAt.isEmpty ? nil : forecast.fetchedAt
        )

        return HBDeckSurface(cornerRadius: 30) {
            Group {
                if usesCompactWeatherLayout {
                    VStack(alignment: .leading, spacing: 18) {
                        HStack(alignment: .top, spacing: 14) {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Weather Command Deck")
                                    .font(HBTypography.display(size: 11, weight: .bold))
                                    .textCase(.uppercase)
                                    .tracking(3.0)
                                    .foregroundStyle(HBPalette.textMuted)

                                Text(formatTemperature(headlineTemperature))
                                    .font(HBTypography.display(size: 52, weight: .bold))
                                    .foregroundStyle(HBPalette.textPrimary)
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.72)

                                Text("Feels like \(formatTemperature(headlineFeelsLike))")
                                    .font(HBTypography.body(size: 16, weight: .semibold))
                                    .foregroundStyle(HBPalette.textSecondary)
                            }

                            Spacer(minLength: 12)

                            Image(systemName: weatherSymbolName(icon: forecast.icon, isDay: forecast.isDay))
                                .font(.system(size: 34, weight: .semibold))
                                .foregroundStyle(
                                    LinearGradient(
                                        colors: [HBPalette.accentBlue, HBPalette.accentPurple],
                                        startPoint: .topLeading,
                                        endPoint: .bottomTrailing
                                    )
                                )
                                .frame(width: 72, height: 72)
                                .background(HBGlassBackground(cornerRadius: 22, variant: .panelSoft))
                        }

                        Text(stationLive
                             ? "Live station telemetry is driving the now-cast layer while Open-Meteo supplies the broader forecast envelope."
                             : "Forecast mode is active. Connect a Tempest station to unlock local telemetry, historical charts, and event feeds.")
                            .font(HBTypography.body(size: 14, weight: .medium))
                            .foregroundStyle(HBPalette.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)

                        VStack(alignment: .leading, spacing: 8) {
                            HBBadge(
                                text: stationLive ? "Tempest fused with forecast" : "Forecast mode",
                                foreground: HBPalette.textPrimary,
                                background: HBPalette.panelSoft.opacity(0.96),
                                stroke: HBPalette.panelStrokeStrong
                            )
                            if let indoorAir {
                                HBBadge(
                                    text: "Inside \(indoorAir.qualityLabel)",
                                    foreground: HBPalette.textPrimary,
                                    background: HBPalette.accentGreen.opacity(0.18),
                                    stroke: HBPalette.accentGreen.opacity(0.45)
                                )
                            }

                            VStack(alignment: .leading, spacing: 12) {
                                VStack(alignment: .leading, spacing: 6) {
                                    Label(forecast.locationName, systemImage: "mappin.and.ellipse")
                                        .font(HBTypography.body(size: 13, weight: .medium))
                                        .foregroundStyle(HBPalette.textSecondary)
                                        .lineLimit(2)

                                    Text(forecast.condition)
                                        .font(HBTypography.body(size: 13, weight: .semibold))
                                        .foregroundStyle(HBPalette.textPrimary)
                                }

                                HStack(spacing: 8) {
                                    if let station {
                                        HBTempestBatteryBadge(volts: station.metrics.batteryVolts)
                                    }
                                    HBBadge(text: stationLive ? "Live Telemetry" : "Forecast Only")
                                }

                                if let trend = station?.metrics.pressureTrend, stationLive {
                                    HBBadge(
                                        text: trend,
                                        foreground: HBPalette.textPrimary,
                                        background: HBPalette.panel.opacity(0.94),
                                        stroke: HBPalette.panelStroke
                                    )
                                }

                                HBWeatherSyncCaption(value: lastSyncedAt)
                            }
                        }
                    }
                } else {
                    VStack(alignment: .leading, spacing: 22) {
                        HStack(alignment: .top, spacing: 16) {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Weather Command Deck")
                                    .font(HBTypography.display(size: 11, weight: .bold))
                                    .textCase(.uppercase)
                                    .tracking(3.0)
                                    .foregroundStyle(HBPalette.textMuted)

                                HStack(alignment: .firstTextBaseline, spacing: 12) {
                                    Text(formatTemperature(headlineTemperature))
                                        .font(HBTypography.display(size: 58, weight: .bold))
                                        .foregroundStyle(HBPalette.textPrimary)

                                    VStack(alignment: .leading, spacing: 6) {
                                        HBBadge(
                                            text: stationLive ? "Tempest fused with forecast" : "Forecast mode",
                                            foreground: HBPalette.textPrimary,
                                            background: HBPalette.panelSoft.opacity(0.96),
                                            stroke: HBPalette.panelStrokeStrong
                                        )
                                        if let indoorAir {
                                            HBBadge(
                                                text: "Inside \(indoorAir.qualityLabel)",
                                                foreground: HBPalette.textPrimary,
                                                background: HBPalette.accentGreen.opacity(0.18),
                                                stroke: HBPalette.accentGreen.opacity(0.45)
                                            )
                                        }
                                        Text("Feels like \(formatTemperature(headlineFeelsLike))")
                                            .font(HBTypography.body(size: 15, weight: .semibold))
                                            .foregroundStyle(HBPalette.textSecondary)
                                    }
                                }

                                Text(stationLive
                                     ? "Live station telemetry is driving the now-cast layer while Open-Meteo supplies the broader forecast envelope."
                                     : "Forecast mode is active. Connect a Tempest station to unlock local telemetry, historical charts, and event feeds.")
                                    .font(HBTypography.body(size: 15, weight: .medium))
                                    .foregroundStyle(HBPalette.textSecondary)
                                    .fixedSize(horizontal: false, vertical: true)

                                HStack(spacing: 12) {
                                    Label(forecast.locationName, systemImage: "mappin.and.ellipse")
                                        .font(HBTypography.body(size: 13, weight: .medium))
                                        .foregroundStyle(HBPalette.textSecondary)
                                        .lineLimit(2)
                                    Text(forecast.condition)
                                        .font(HBTypography.body(size: 13, weight: .semibold))
                                        .foregroundStyle(HBPalette.textPrimary)
                                }
                            }

                            Spacer(minLength: 12)

                            VStack(alignment: .trailing, spacing: 10) {
                                Image(systemName: weatherSymbolName(icon: forecast.icon, isDay: forecast.isDay))
                                    .font(.system(size: 42, weight: .semibold))
                                    .foregroundStyle(
                                        LinearGradient(
                                            colors: [HBPalette.accentBlue, HBPalette.accentPurple],
                                            startPoint: .topLeading,
                                            endPoint: .bottomTrailing
                                        )
                                    )
                                    .frame(width: 82, height: 82)
                                    .background(HBGlassBackground(cornerRadius: 24, variant: .panelSoft))

                                HStack(spacing: 8) {
                                    if let station {
                                        HBTempestBatteryBadge(volts: station.metrics.batteryVolts)
                                    }
                                    HBBadge(text: stationLive ? "Live Telemetry" : "Forecast Only")
                                    if let trend = station?.metrics.pressureTrend, stationLive {
                                        HBBadge(
                                            text: trend,
                                            foreground: HBPalette.textPrimary,
                                            background: HBPalette.panel.opacity(0.94),
                                            stroke: HBPalette.panelStroke
                                        )
                                    }
                                }

                                HBWeatherSyncCaption(value: lastSyncedAt)
                            }
                        }
                    }
                }
            }
            .padding(22)
        }
    }

    private func weatherTelemetryGrid(for dashboard: WeatherDashboardSnapshot) -> some View {
        let forecast = dashboard.forecast
        let station = dashboard.station ?? forecast.tempestStation
        let indoorAir = dashboard.indoorAir ?? forecast.indoorAir
        let liveRainRate = station?.metrics.rainRateInPerHr ?? deriveRainRateFromLastMinute(station?.metrics.rainLastMinuteIn)
        let livePrecipitationNow = station?.metrics.rainLastMinuteIn ?? forecast.precipitationIn
        let liveRainDetected = (liveRainRate ?? 0) > 0 || (livePrecipitationNow ?? 0) > 0

        var items: [WeatherTelemetryCardItem] = [
            WeatherTelemetryCardItem(
                title: "Local Forecast",
                value: "\(formatTemperature(forecast.highF)) / \(formatTemperature(forecast.lowF))",
                detail: "\(forecast.todayCondition) • Forecast rain chance \(formatPercent(forecast.precipitationChance))\(liveRainDetected ? " • Tempest says raining now" : "")",
                accent: HBPalette.accentBlue,
                gradient: [HBPalette.heroCore.opacity(0.8), HBPalette.panelSoft.opacity(0.16)]
            ),
            WeatherTelemetryCardItem(
                title: "Wind Field",
                value: formatWind(station?.metrics.windAvgMph ?? forecast.windSpeedMph),
                detail: station != nil ? "Gusts \(formatWind(station?.metrics.windGustMph)) from \(compassDirection(station?.metrics.windDirectionDeg))" : "Forecast wind speed",
                accent: HBPalette.accentPurple,
                gradient: [HBPalette.heroAccent.opacity(0.8), HBPalette.panelSoft.opacity(0.14)]
            ),
            WeatherTelemetryCardItem(
                title: "Pressure Core",
                value: formatPressure(station?.metrics.pressureInHg),
                detail: station != nil ? station?.metrics.pressureTrend.capitalized ?? "steady" : "Tempest required for local pressure",
                accent: HBPalette.accentGreen,
                gradient: [HBPalette.accentGreen.opacity(0.24), HBPalette.panelSoft.opacity(0.14)]
            ),
            WeatherTelemetryCardItem(
                title: "Hydrology",
                value: formatRain(station?.metrics.rainTodayIn),
                detail: station != nil ? "Rate \(formatRain(liveRainRate))/hr" : "Forecast-only users still get rain probability",
                accent: HBPalette.accentOrange,
                gradient: [HBPalette.accentOrange.opacity(0.24), HBPalette.panelSoft.opacity(0.14)]
            )
        ]

        if let indoorAir {
            items.insert(
                WeatherTelemetryCardItem(
                    title: "Indoor Air",
                    value: formatTemperature(indoorAir.temperatureF),
                    detail: "\(formatPercent(indoorAir.humidityPct)) RH • PM2.5 \(formatPM25(indoorAir.pm25UgM3)) • \(indoorAir.qualityLabel)",
                    accent: HBPalette.accentGreen,
                    gradient: [HBPalette.accentGreen.opacity(0.24), HBPalette.panelSoft.opacity(0.14)]
                ),
                at: min(1, items.count)
            )
        }

        return LazyVGrid(
            columns: [GridItem(.adaptive(minimum: usesCompactWeatherLayout ? 150 : 220), spacing: 12)],
            spacing: 12
        ) {
            ForEach(items) { item in
                WeatherTelemetryTile(
                    title: item.title,
                    value: item.value,
                    detail: item.detail,
                    accent: item.accent,
                    gradient: item.gradient
                )
            }
        }
    }

    private func weatherSensorAndForecastPanels(for dashboard: WeatherDashboardSnapshot) -> some View {
        let station = dashboard.station ?? dashboard.forecast.tempestStation
        let indoorAir = dashboard.indoorAir ?? dashboard.forecast.indoorAir

        return weatherSplitPanels {
            HBPanel {
                VStack(alignment: .leading, spacing: 14) {
                    chartHeader(
                        title: "Forecast Flightpath",
                        subtitle: "Next \(chartRangeOption(at: forecastRangeIndex).label) of temperature, wind, and precipitation probability."
                    )
                    WeatherChartRangeSlider(selectedIndex: $forecastRangeIndex)

                    if forecastTrendData.isEmpty {
                        EmptyStateView(
                            title: "Forecast history unavailable",
                            subtitle: "HomeBrain did not receive an hourly forecast payload for this location."
                        )
                    } else {
                        Chart {
                            ForEach(forecastTemperaturePoints) { point in
                                LineMark(
                                    x: .value("Sample", point.index),
                                    y: .value("Temperature", point.value),
                                    series: .value("Series", "forecast-temperature")
                                )
                                .interpolationMethod(.monotone)
                                .lineStyle(StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
                                .foregroundStyle(forecastTemperatureChartColor)
                            }

                            ForEach(forecastWindPoints) { point in
                                LineMark(
                                    x: .value("Sample", point.index),
                                    y: .value("Wind", point.value),
                                    series: .value("Series", "forecast-wind")
                                )
                                .interpolationMethod(.monotone)
                                .lineStyle(StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round))
                                .foregroundStyle(forecastWindChartColor)
                            }

                            ForEach(forecastPrecipitationPoints) { point in
                                LineMark(
                                    x: .value("Sample", point.index),
                                    y: .value("Precip", point.value),
                                    series: .value("Series", "forecast-precipitation")
                                )
                                .interpolationMethod(.monotone)
                                .lineStyle(StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round))
                                .foregroundStyle(forecastPrecipitationChartColor)
                            }
                        }
                        .frame(height: 280)
                        .chartXScale(domain: 0...max(forecastAxisLabels.count - 1, 0))
                        .chartXAxis {
                            AxisMarks(values: weatherChartAxisValues(count: forecastAxisLabels.count)) { value in
                                if let index = value.as(Int.self), forecastAxisLabels.indices.contains(index) {
                                    AxisValueLabel(forecastAxisLabels[index])
                                        .foregroundStyle(HBPalette.textMuted)
                                }
                            }
                        }
                        .chartYAxis {
                            AxisMarks(position: .leading) {
                                AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [4, 4]))
                                    .foregroundStyle(HBPalette.panelStroke.opacity(0.35))
                                AxisValueLabel()
                                    .foregroundStyle(HBPalette.textMuted)
                            }
                        }
                        WeatherChartLegend(items: [
                            WeatherChartLegendItem(label: "Temp", color: forecastTemperatureChartColor),
                            WeatherChartLegendItem(label: "Wind", color: forecastWindChartColor),
                            WeatherChartLegendItem(label: "Precip", color: forecastPrecipitationChartColor)
                        ])
                    }
                }
            }
        } trailing: {
            HBPanel {
                VStack(alignment: .leading, spacing: 14) {
                    chartHeader(
                        title: "Sensor State",
                        subtitle: station != nil ? "Live telemetry feed from \(station?.name ?? "Tempest")." : "No Tempest station is currently configured."
                    )

                    LazyVGrid(
                        columns: usesCompactWeatherLayout
                            ? [GridItem(.flexible())]
                            : [GridItem(.flexible()), GridItem(.flexible())],
                        spacing: 10
                    ) {
                        if let indoorAir {
                            MetricCard(
                                title: "Indoor Temp",
                                value: formatTemperature(indoorAir.temperatureF),
                                subtitle: "\(indoorAir.room) • \(indoorAir.qualityLabel)",
                                tint: HBPalette.accentGreen
                            )
                            MetricCard(
                                title: "Indoor RH",
                                value: formatPercent(indoorAir.humidityPct),
                                subtitle: "PM2.5 \(formatPM25(indoorAir.pm25UgM3))",
                                tint: HBPalette.accentBlue
                            )
                        }
                        MetricCard(
                            title: "Humidity",
                            value: formatPercent(station?.metrics.humidityPct ?? dashboard.forecast.humidity),
                            subtitle: "Dew point \(formatTemperature(station?.metrics.dewPointF))",
                            tint: HBPalette.accentBlue
                        )
                        MetricCard(
                            title: "Solar",
                            value: formatSolar(station?.metrics.solarRadiationWm2),
                            subtitle: "UV \(formatUV(station?.metrics.uvIndex))",
                            tint: HBPalette.accentOrange
                        )
                        MetricCard(
                            title: "Signal Path",
                            value: station?.status.websocketConnected == true ? "WS Live" : (station != nil ? "Snapshot" : "--"),
                            subtitle: "RSSI \(station?.status.signalRssi.map { "\(Int($0.rounded())) dBm" } ?? "--")",
                            tint: HBPalette.accentGreen
                        )
                        MetricCard(
                            title: "Lightning",
                            value: station?.metrics.lightningCount.map { String(Int($0.rounded())) } ?? "0",
                            subtitle: "Avg \(station?.metrics.lightningAvgDistanceMiles.map { String(format: "%.1f mi", $0) } ?? "--")",
                            tint: HBPalette.accentPurple
                        )
                    }

                    if station == nil && isAdmin {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Tempest is optional. Forecast mode already works for everyone, but admins can connect a station here to unlock local telemetry, historical charts, and event feeds.")
                                .font(HBTypography.body(size: 14, weight: .medium))
                                .foregroundStyle(HBPalette.textSecondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(HBGlassBackground(cornerRadius: 18, variant: .panelSoft))
                        .overlay(
                            RoundedRectangle(cornerRadius: 18, style: .continuous)
                                .stroke(HBPalette.panelStrokeStrong.opacity(0.55), lineWidth: 1)
                        )
                    }
                }
            }
        }
        .frame(maxWidth: .infinity)
    }

    private var indoorAirHistoryPanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 14) {
                chartHeader(
                    title: "Indoor Air History",
                    subtitle: "Last \(chartRangeOption(at: indoorAirRangeIndex).label) of temperature, humidity, PM2.5, and derived indoor AQI."
                )
                WeatherChartRangeSlider(selectedIndex: $indoorAirRangeIndex)

                if indoorAirTrendData.isEmpty {
                    EmptyStateView(
                        title: "No indoor air history",
                        subtitle: "Connect and sync the Govee monitor to populate indoor climate and air-quality charts."
                    )
                } else {
                    Chart {
                        ForEach(indoorTemperatureSegments) { segment in
                            ForEach(segment.points) { point in
                                LineMark(
                                    x: .value("Sample", point.index),
                                    y: .value("Indoor Temp", point.value),
                                    series: .value("Series", "indoor-temperature-\(segment.id)")
                                )
                                .interpolationMethod(.monotone)
                                .lineStyle(StrokeStyle(lineWidth: 2.6, lineCap: .round, lineJoin: .round))
                                .foregroundStyle(indoorTemperatureChartColor)
                            }
                        }

                        ForEach(indoorHumiditySegments) { segment in
                            ForEach(segment.points) { point in
                                LineMark(
                                    x: .value("Sample", point.index),
                                    y: .value("Indoor RH", point.value),
                                    series: .value("Series", "indoor-humidity-\(segment.id)")
                                )
                                .interpolationMethod(.monotone)
                                .lineStyle(StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round))
                                .foregroundStyle(indoorHumidityChartColor)
                            }
                        }

                        ForEach(indoorPM25Segments) { segment in
                            ForEach(segment.points) { point in
                                LineMark(
                                    x: .value("Sample", point.index),
                                    y: .value("PM2.5", point.value),
                                    series: .value("Series", "indoor-pm25-\(segment.id)")
                                )
                                .interpolationMethod(.monotone)
                                .lineStyle(StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round))
                                .foregroundStyle(indoorPM25ChartColor)
                            }
                        }

                        ForEach(indoorAQISegments) { segment in
                            ForEach(segment.points) { point in
                                LineMark(
                                    x: .value("Sample", point.index),
                                    y: .value("AQI", point.value),
                                    series: .value("Series", "indoor-aqi-\(segment.id)")
                                )
                                .interpolationMethod(.monotone)
                                .lineStyle(StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round))
                                .foregroundStyle(indoorAQIChartColor)
                            }
                        }
                    }
                    .frame(height: 260)
                    .chartXScale(domain: 0...max(indoorAirAxisLabels.count - 1, 0))
                    .chartXAxis {
                        AxisMarks(values: weatherChartAxisValues(count: indoorAirAxisLabels.count)) { value in
                            if let index = value.as(Int.self), indoorAirAxisLabels.indices.contains(index) {
                                AxisValueLabel(indoorAirAxisLabels[index])
                                    .foregroundStyle(HBPalette.textMuted)
                            }
                        }
                    }
                    .chartYAxis {
                        AxisMarks(position: .leading) {
                            AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [4, 4]))
                                .foregroundStyle(HBPalette.panelStroke.opacity(0.35))
                            AxisValueLabel()
                                .foregroundStyle(HBPalette.textMuted)
                        }
                    }
                    WeatherChartLegend(items: [
                        WeatherChartLegendItem(label: "Temp", color: indoorTemperatureChartColor),
                        WeatherChartLegendItem(label: "Humidity", color: indoorHumidityChartColor),
                        WeatherChartLegendItem(label: "PM2.5", color: indoorPM25ChartColor),
                        WeatherChartLegendItem(label: "AQI", color: indoorAQIChartColor)
                    ])
                }
            }
        }
    }

    private func weatherHistoricalPanels(for dashboard: WeatherDashboardSnapshot) -> some View {
        weatherSplitPanels {
            HBPanel {
                VStack(alignment: .leading, spacing: 14) {
                    chartHeader(
                        title: "Atmospheric Curve",
                        subtitle: "Last \(chartRangeOption(at: atmosphericRangeIndex).label) of temperature, feels-like, and dew point."
                    )
                    WeatherChartRangeSlider(selectedIndex: $atmosphericRangeIndex)

                    if atmosphericTrendData.isEmpty {
                        EmptyStateView(
                            title: "No Tempest history",
                            subtitle: "Connect a Tempest station to populate live atmospheric charts."
                        )
                    } else {
                        Chart {
                            ForEach(atmosphericTemperatureSegments) { segment in
                                ForEach(segment.points) { point in
                                    AreaMark(
                                        x: .value("Sample", point.index),
                                        y: .value("Temperature", point.value),
                                        series: .value("Series", "atmospheric-temperature-\(segment.id)")
                                    )
                                        .interpolationMethod(.monotone)
                                        .foregroundStyle(
                                            LinearGradient(
                                                colors: [
                                                    atmosphericTemperatureChartColor.opacity(0.36),
                                                    atmosphericTemperatureChartColor.opacity(0.04)
                                                ],
                                                startPoint: .top,
                                                endPoint: .bottom
                                            )
                                        )
                                    LineMark(
                                        x: .value("Sample", point.index),
                                        y: .value("Temperature", point.value),
                                        series: .value("Series", "atmospheric-temperature-\(segment.id)")
                                    )
                                        .interpolationMethod(.monotone)
                                        .foregroundStyle(atmosphericTemperatureChartColor)
                                        .lineStyle(StrokeStyle(lineWidth: 2.6, lineCap: .round, lineJoin: .round))
                                }
                            }

                            ForEach(atmosphericFeelsLikeSegments) { segment in
                                ForEach(segment.points) { point in
                                    LineMark(
                                        x: .value("Sample", point.index),
                                        y: .value("Feels Like", point.value),
                                        series: .value("Series", "atmospheric-feels-like-\(segment.id)")
                                    )
                                        .interpolationMethod(.monotone)
                                        .foregroundStyle(atmosphericFeelsLikeChartColor)
                                        .lineStyle(StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round))
                                }
                            }

                            ForEach(atmosphericDewPointSegments) { segment in
                                ForEach(segment.points) { point in
                                    LineMark(
                                        x: .value("Sample", point.index),
                                        y: .value("Dew Point", point.value),
                                        series: .value("Series", "atmospheric-dew-point-\(segment.id)")
                                    )
                                        .interpolationMethod(.monotone)
                                        .foregroundStyle(atmosphericDewPointChartColor)
                                        .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                                }
                            }
                        }
                        .frame(height: 300)
                        .chartXScale(domain: 0...max(atmosphericAxisLabels.count - 1, 0))
                        .chartXAxis {
                            AxisMarks(values: weatherChartAxisValues(count: atmosphericAxisLabels.count)) { value in
                                if let index = value.as(Int.self), atmosphericAxisLabels.indices.contains(index) {
                                    AxisValueLabel(atmosphericAxisLabels[index])
                                        .foregroundStyle(HBPalette.textMuted)
                                }
                            }
                        }
                        .chartYAxis {
                            AxisMarks(position: .leading) {
                                AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [4, 4]))
                                    .foregroundStyle(HBPalette.panelStroke.opacity(0.35))
                                AxisValueLabel()
                                    .foregroundStyle(HBPalette.textMuted)
                            }
                        }
                        WeatherChartLegend(items: [
                            WeatherChartLegendItem(label: "Temperature", color: atmosphericTemperatureChartColor),
                            WeatherChartLegendItem(label: "Feels Like", color: atmosphericFeelsLikeChartColor),
                            WeatherChartLegendItem(label: "Dew Point", color: atmosphericDewPointChartColor)
                        ])
                    }
                }
            }
        } trailing: {
            HBPanel {
                VStack(alignment: .leading, spacing: 14) {
                    chartHeader(
                        title: "Wind Vector Matrix",
                        subtitle: "Last \(chartRangeOption(at: windRangeIndex).label) of average, gust, and rapid wind samples."
                    )
                    WeatherChartRangeSlider(selectedIndex: $windRangeIndex)

                    if windTrendData.isEmpty {
                        EmptyStateView(
                            title: "No wind telemetry",
                            subtitle: "Wind history appears here once Tempest observations are available."
                        )
                    } else {
                        Chart {
                            ForEach(windAverageSegments) { segment in
                                ForEach(segment.points) { point in
                                    LineMark(
                                        x: .value("Sample", point.index),
                                        y: .value("Average", point.value),
                                        series: .value("Series", "wind-average-\(segment.id)")
                                    )
                                        .interpolationMethod(.monotone)
                                        .foregroundStyle(windAverageChartColor)
                                        .lineStyle(StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round))
                                }
                            }

                            ForEach(windGustSegments) { segment in
                                ForEach(segment.points) { point in
                                    LineMark(
                                        x: .value("Sample", point.index),
                                        y: .value("Gust", point.value),
                                        series: .value("Series", "wind-gust-\(segment.id)")
                                    )
                                        .interpolationMethod(.monotone)
                                        .foregroundStyle(windGustChartColor)
                                        .lineStyle(StrokeStyle(lineWidth: 2.3, lineCap: .round, lineJoin: .round))
                                }
                            }

                            ForEach(windRapidSegments) { segment in
                                ForEach(segment.points) { point in
                                    LineMark(
                                        x: .value("Sample", point.index),
                                        y: .value("Rapid", point.value),
                                        series: .value("Series", "wind-rapid-\(segment.id)")
                                    )
                                        .interpolationMethod(.monotone)
                                        .foregroundStyle(windRapidChartColor)
                                        .lineStyle(StrokeStyle(lineWidth: 1.8, lineCap: .round, lineJoin: .round))
                                }
                            }
                        }
                        .frame(height: 300)
                        .chartXScale(domain: 0...max(windAxisLabels.count - 1, 0))
                        .chartXAxis {
                            AxisMarks(values: weatherChartAxisValues(count: windAxisLabels.count)) { value in
                                if let index = value.as(Int.self), windAxisLabels.indices.contains(index) {
                                    AxisValueLabel(windAxisLabels[index])
                                        .foregroundStyle(HBPalette.textMuted)
                                }
                            }
                        }
                        .chartYAxis {
                            AxisMarks(position: .leading) {
                                AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [4, 4]))
                                    .foregroundStyle(HBPalette.panelStroke.opacity(0.35))
                                AxisValueLabel()
                                    .foregroundStyle(HBPalette.textMuted)
                            }
                        }
                        WeatherChartLegend(items: [
                            WeatherChartLegendItem(label: "Average", color: windAverageChartColor),
                            WeatherChartLegendItem(label: "Gust", color: windGustChartColor),
                            WeatherChartLegendItem(label: "Rapid", color: windRapidChartColor)
                        ])
                    }
                }
            }
        }
        .frame(maxWidth: .infinity)
    }

    private var weatherEnvironmentalPanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 14) {
                chartHeader(
                    title: "Pressure, Rain, and Solar",
                    subtitle: "Local environmental energy profile across the last \(chartRangeOption(at: environmentalRangeIndex).label)."
                )
                WeatherChartRangeSlider(selectedIndex: $environmentalRangeIndex)

                if environmentalTrendData.isEmpty {
                    EmptyStateView(
                        title: "No environmental telemetry",
                        subtitle: "Pressure, rainfall, and solar history appear here once Tempest observations are available."
                    )
                } else {
                    Chart {
                        ForEach(environmentalRainRatePoints) { point in
                            BarMark(
                                x: .value("Sample", point.index),
                                y: .value("Rain Rate", point.value)
                            )
                            .foregroundStyle(environmentalRainRateChartColor)
                        }

                        ForEach(environmentalPressureSegments) { segment in
                            ForEach(segment.points) { point in
                                LineMark(
                                    x: .value("Sample", point.index),
                                    y: .value("Pressure", point.value),
                                    series: .value("Series", "environmental-pressure-\(segment.id)")
                                )
                                .interpolationMethod(.monotone)
                                .foregroundStyle(environmentalPressureChartColor)
                                .lineStyle(StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round))
                            }
                        }

                        ForEach(environmentalSolarSegments) { segment in
                            ForEach(segment.points) { point in
                                LineMark(
                                    x: .value("Sample", point.index),
                                    y: .value("Solar", point.value),
                                    series: .value("Series", "environmental-solar-\(segment.id)")
                                )
                                .interpolationMethod(.monotone)
                                .foregroundStyle(environmentalSolarChartColor)
                                .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                            }
                        }
                    }
                    .frame(height: 320)
                    .chartXScale(domain: 0...max(environmentalAxisLabels.count - 1, 0))
                    .chartXAxis {
                        AxisMarks(values: weatherChartAxisValues(count: environmentalAxisLabels.count)) { value in
                            if let index = value.as(Int.self), environmentalAxisLabels.indices.contains(index) {
                                AxisValueLabel(environmentalAxisLabels[index])
                                    .foregroundStyle(HBPalette.textMuted)
                            }
                        }
                    }
                    .chartYAxis {
                        AxisMarks(position: .leading) {
                            AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [4, 4]))
                                .foregroundStyle(HBPalette.panelStroke.opacity(0.35))
                            AxisValueLabel()
                                .foregroundStyle(HBPalette.textMuted)
                        }
                    }
                    WeatherChartLegend(items: [
                        WeatherChartLegendItem(label: "Pressure", color: environmentalPressureChartColor),
                        WeatherChartLegendItem(label: "Rain Rate", color: environmentalRainRateChartColor),
                        WeatherChartLegendItem(label: "Solar", color: environmentalSolarChartColor)
                    ])
                }
            }
        }
    }

    private var weatherEventsPanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 14) {
                chartHeader(
                    title: "Event Feed",
                    subtitle: "Discrete lightning and rain-start events from the Tempest station."
                )

                if recentEvents.isEmpty {
                    EmptyStateView(
                        title: "No Tempest events recorded",
                        subtitle: "Lightning strikes and precipitation start events will appear here when the station reports them."
                    )
                } else {
                    VStack(spacing: 10) {
                        ForEach(recentEvents) { event in
                            HStack(alignment: .top, spacing: 12) {
                                Image(systemName: event.eventType == "lightning_strike" ? "bolt.fill" : "cloud.rain.fill")
                                    .font(.system(size: 16, weight: .bold))
                                    .foregroundStyle(event.eventType == "lightning_strike" ? HBPalette.accentPurple : HBPalette.accentBlue)
                                    .frame(width: 28, height: 28)
                                    .background(HBGlassBackground(cornerRadius: 12, variant: .panelSoft))

                                VStack(alignment: .leading, spacing: 4) {
                                    Text(event.eventType == "lightning_strike" ? "Lightning strike" : "Rain started")
                                        .font(HBTypography.body(size: 15, weight: .semibold))
                                        .foregroundStyle(HBPalette.textPrimary)

                                    if event.eventType == "lightning_strike" {
                                        Text("Distance \(event.payloadDouble("distanceMiles").map { String(format: "%.1f mi", $0) } ?? "--") • Energy \(event.payloadDouble("energy").map { String(Int($0.rounded())) } ?? "--")")
                                            .font(HBTypography.body(size: 13, weight: .medium))
                                            .foregroundStyle(HBPalette.textSecondary)
                                    } else {
                                        Text("Precipitation onset captured by the station event stream.")
                                            .font(HBTypography.body(size: 13, weight: .medium))
                                            .foregroundStyle(HBPalette.textSecondary)
                                    }
                                }

                                Spacer()

                                Text(formatTimestamp(event.eventAt))
                                    .font(HBTypography.body(size: 12, weight: .medium))
                                    .foregroundStyle(HBPalette.textMuted)
                                    .multilineTextAlignment(.trailing)
                            }
                            .padding(14)
                            .background(HBGlassBackground(cornerRadius: 18, variant: .panelSoft))
                        }
                    }
                }
            }
        }
    }

    private var tempestAdminPanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 14) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Tempest Weather Station")
                            .font(HBTypography.display(size: 22, weight: .bold))
                            .foregroundStyle(HBPalette.textPrimary)
                        Text("Personal Access Token setup, discovery, live feed health, and calibration.")
                            .font(HBTypography.body(size: 14, weight: .medium))
                            .foregroundStyle(HBPalette.textSecondary)
                    }

                    Spacer()

                    HBBadge(text: tempestStatus?.health.isConnected == true ? "Connected" : "Forecast Only")
                }

                if isLoadingTempest && tempestStatus == nil {
                    LoadingView(title: "Loading Tempest integration...")
                } else {
                    if let adminErrorMessage, !adminErrorMessage.isEmpty {
                        InlineErrorView(message: adminErrorMessage) {
                            Task { await loadTempestStatus() }
                        }
                    }

                    if !adminInfoMessage.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(adminInfoMessage)
                                .font(HBTypography.body(size: 14, weight: .medium))
                                .foregroundStyle(HBPalette.textSecondary)
                        }
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(HBGlassBackground(cornerRadius: 18, variant: .panelSoft))
                    }

                    weatherSplitPanels {
                        VStack(alignment: .leading, spacing: 12) {
                            SecureField("Paste Tempest token", text: $tempestForm.token)
                                .textInputAutocapitalization(.never)
                                .disableAutocorrection(true)
                                .hbPanelTextField()

                            if tempestStatus?.integration.tokenConfigured == true {
                                Text(tempestStatus?.integration.tokenSource == "environment"
                                    ? "A Tempest token is active from runtime environment settings. Enter a new value and save if you want HomeBrain to persist it in the database."
                                    : "A Tempest token is already configured. Enter a new value only if you want to replace it.")
                                    .font(HBTypography.body(size: 12, weight: .medium))
                                    .foregroundStyle(HBPalette.textSecondary)
                            }

                            Group {
                                if usesCompactWeatherLayout {
                                    VStack(spacing: 10) {
                                        TextField("Room label", text: $tempestForm.room)
                                            .hbPanelTextField()
                                        TextField("UDP bind address", text: $tempestForm.udpBindAddress)
                                            .textInputAutocapitalization(.never)
                                            .disableAutocorrection(true)
                                            .hbPanelTextField()
                                    }
                                } else {
                                    HStack(spacing: 10) {
                                        TextField("Room label", text: $tempestForm.room)
                                            .hbPanelTextField()
                                        TextField("UDP bind address", text: $tempestForm.udpBindAddress)
                                            .textInputAutocapitalization(.never)
                                            .disableAutocorrection(true)
                                            .hbPanelTextField()
                                    }
                                }
                            }

                            Picker("Preferred Station", selection: selectedStationPickerValue) {
                                Text("Auto-select first station").tag("__auto__")
                                ForEach(stationChoices) { station in
                                    Text("\(station.name) • \(station.detail)").tag(String(station.stationId))
                                }
                            }
                            .pickerStyle(.menu)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                            .background(HBPalette.fieldFill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 16, style: .continuous)
                                    .stroke(HBPalette.fieldStroke, lineWidth: 1)
                            )

                            LazyVGrid(columns: [GridItem(.adaptive(minimum: usesCompactWeatherLayout ? 140 : 170), spacing: 10)], spacing: 10) {
                                tempestToggleChip(title: "Enable", subtitle: "Active", isOn: $tempestForm.enabled)
                                tempestToggleChip(title: "WebSocket", subtitle: "Live stream", isOn: $tempestForm.websocketEnabled)
                                tempestToggleChip(title: "UDP", subtitle: "LAN fallback", isOn: $tempestForm.udpEnabled)

                                VStack(alignment: .leading, spacing: 6) {
                                    Text("Listener Port")
                                        .font(HBTypography.display(size: 11, weight: .bold))
                                        .textCase(.uppercase)
                                        .tracking(2)
                                        .foregroundStyle(HBPalette.textMuted)
                                    TextField("50222", text: $tempestForm.udpPort)
                                        .keyboardType(.numberPad)
                                        .hbPanelTextField()
                                }
                                .padding(14)
                                .frame(maxWidth: .infinity, minHeight: 92, alignment: .leading)
                                .background(HBGlassBackground(cornerRadius: 18, variant: .panelSoft))
                            }

                            LazyVGrid(columns: [GridItem(.adaptive(minimum: usesCompactWeatherLayout ? 150 : 180), spacing: 10)], spacing: 10) {
                                calibrationField(title: "Temp Offset (C)", text: $tempestForm.tempOffsetC)
                                calibrationField(title: "Humidity Offset (%)", text: $tempestForm.humidityOffsetPct)
                                calibrationField(title: "Pressure Offset (mb)", text: $tempestForm.pressureOffsetMb)
                                calibrationField(title: "Wind Multiplier", text: $tempestForm.windSpeedMultiplier)
                                calibrationField(title: "Rain Multiplier", text: $tempestForm.rainMultiplier)
                            }
                        }
                    } trailing: {
                        VStack(alignment: .leading, spacing: 10) {
                            MetricCard(
                                title: "Realtime",
                                value: tempestStatus?.health.websocketConnected == true ? "WS Live" : "Standby",
                                subtitle: "Last message \(formatTimestamp(tempestStatus?.health.websocketLastMessageAt))",
                                tint: HBPalette.accentBlue
                            )
                            MetricCard(
                                title: "Sync Status",
                                value: tempestStatus?.health.lastDiscoveryAt.map(formatTimestamp) ?? "Not synced",
                                subtitle: "Last observation \(formatTimestamp(tempestStatus?.health.lastObservationAt))",
                                tint: HBPalette.accentGreen
                            )
                            MetricCard(
                                title: "Selected Station",
                                value: tempestStatus?.selectedStation?.name ?? "No station",
                                subtitle: tempestStatus?.selectedStation.map { "\($0.room) • \($0.model)" } ?? "Run a token test or sync to discover stations.",
                                tint: HBPalette.accentPurple
                            )

                            if let lastError = tempestStatus?.health.lastError, !lastError.isEmpty {
                                VStack(alignment: .leading, spacing: 8) {
                                    Text("Last Error")
                                        .font(HBTypography.display(size: 11, weight: .bold))
                                        .textCase(.uppercase)
                                        .tracking(2)
                                        .foregroundStyle(HBPalette.accentOrange)
                                    Text(lastError)
                                        .font(HBTypography.body(size: 13, weight: .medium))
                                        .foregroundStyle(HBPalette.textSecondary)
                                }
                                .padding(14)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(HBGlassBackground(cornerRadius: 18, variant: .panelSoft))
                            }
                        }
                    }

                    Group {
                        if usesCompactWeatherLayout {
                            VStack(spacing: 10) {
                                Button {
                                    Task { await handleTestToken() }
                                } label: {
                                    Label(isTestingTempest ? "Testing..." : "Test Token", systemImage: "testtube.2")
                                        .frame(maxWidth: .infinity)
                                }
                                .buttonStyle(HBSecondaryButtonStyle(compact: true))
                                .disabled(isTestingTempest)

                                Button {
                                    Task { await handleSyncTempest() }
                                } label: {
                                    Label(isSyncingTempest ? "Syncing..." : "Sync Now", systemImage: "arrow.triangle.2.circlepath")
                                        .frame(maxWidth: .infinity)
                                }
                                .buttonStyle(HBSecondaryButtonStyle(compact: true))
                                .disabled(isSyncingTempest)

                                Button {
                                    Task { await handleSaveTempest() }
                                } label: {
                                    Label(isSavingTempest ? "Saving..." : "Save Tempest Config", systemImage: "square.and.arrow.down")
                                        .frame(maxWidth: .infinity)
                                }
                                .buttonStyle(HBPrimaryButtonStyle(compact: true))
                                .disabled(isSavingTempest)
                            }
                        } else {
                            HStack(spacing: 10) {
                                Button {
                                    Task { await handleTestToken() }
                                } label: {
                                    Label(isTestingTempest ? "Testing..." : "Test Token", systemImage: "testtube.2")
                                        .frame(maxWidth: .infinity)
                                }
                                .buttonStyle(HBSecondaryButtonStyle(compact: true))
                                .disabled(isTestingTempest)

                                Button {
                                    Task { await handleSyncTempest() }
                                } label: {
                                    Label(isSyncingTempest ? "Syncing..." : "Sync Now", systemImage: "arrow.triangle.2.circlepath")
                                        .frame(maxWidth: .infinity)
                                }
                                .buttonStyle(HBSecondaryButtonStyle(compact: true))
                                .disabled(isSyncingTempest)

                                Button {
                                    Task { await handleSaveTempest() }
                                } label: {
                                    Label(isSavingTempest ? "Saving..." : "Save Tempest Config", systemImage: "square.and.arrow.down")
                                        .frame(maxWidth: .infinity)
                                }
                                .buttonStyle(HBPrimaryButtonStyle(compact: true))
                                .disabled(isSavingTempest)
                            }
                        }
                    }

                    Text("Forecast mode remains available for everyone. Tempest adds local truth, history, and event telemetry without replacing the existing weather experience.")
                        .font(HBTypography.body(size: 12, weight: .medium))
                        .foregroundStyle(HBPalette.textMuted)
                }
            }
        }
    }

    private var goveeAdminPanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 14) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Govee Indoor Air")
                            .font(HBTypography.display(size: 22, weight: .bold))
                            .foregroundStyle(HBPalette.textPrimary)
                        Text("API key setup, H5106 discovery, indoor comfort readings, and retained telemetry.")
                            .font(HBTypography.body(size: 14, weight: .medium))
                            .foregroundStyle(HBPalette.textSecondary)
                    }

                    Spacer()

                    HBBadge(text: goveeStatus?.isConnected == true ? "Connected" : "Not Connected")
                }

                if isLoadingGovee && goveeStatus == nil {
                    LoadingView(title: "Loading Govee indoor air...")
                } else {
                    weatherSplitPanels {
                        VStack(alignment: .leading, spacing: 12) {
                            SecureField("Paste Govee API key", text: $goveeForm.apiKey)
                                .textInputAutocapitalization(.never)
                                .disableAutocorrection(true)
                                .hbPanelTextField()

                            if goveeStatus?.integration.apiKeyConfigured == true {
                                Text(goveeStatus?.integration.apiKeySource == "environment"
                                     ? "A Govee key is active from runtime environment settings. Enter a new value and save if you want HomeBrain to persist it in the database."
                                     : "A Govee key is already configured. Enter a new value only if you want to replace it.")
                                    .font(HBTypography.body(size: 12, weight: .medium))
                                    .foregroundStyle(HBPalette.textSecondary)
                            }

                            Picker("Connection", selection: $goveeForm.connectionMode) {
                                Text("Auto: local first").tag("auto")
                                Text("Local LAN only").tag("local")
                                Text("Cloud API only").tag("cloud")
                            }
                            .pickerStyle(.segmented)

                            if usesCompactWeatherLayout {
                                VStack(spacing: 10) {
                                    TextField("Room label", text: $goveeForm.room)
                                        .hbPanelTextField()
                                    TextField("Poll interval seconds", text: $goveeForm.pollIntervalSeconds)
                                        .keyboardType(.numberPad)
                                        .hbPanelTextField()
                                    TextField("Local device IP", text: $goveeForm.localDeviceIp)
                                        .textInputAutocapitalization(.never)
                                        .disableAutocorrection(true)
                                        .hbPanelTextField()
                                    TextField("LAN port", text: $goveeForm.localDevicePort)
                                        .keyboardType(.numberPad)
                                        .hbPanelTextField()
                                }
                            } else {
                                HStack(spacing: 10) {
                                    TextField("Room label", text: $goveeForm.room)
                                        .hbPanelTextField()
                                    TextField("Poll interval seconds", text: $goveeForm.pollIntervalSeconds)
                                        .keyboardType(.numberPad)
                                        .hbPanelTextField()
                                    TextField("Local device IP", text: $goveeForm.localDeviceIp)
                                        .textInputAutocapitalization(.never)
                                        .disableAutocorrection(true)
                                        .hbPanelTextField()
                                    TextField("LAN port", text: $goveeForm.localDevicePort)
                                        .keyboardType(.numberPad)
                                        .hbPanelTextField()
                                }
                            }

                            Picker("Preferred Monitor", selection: selectedGoveePickerValue) {
                                Text("Auto-select indoor monitor").tag("__auto__")
                                ForEach(goveeDeviceChoices) { device in
                                    Text("\(device.name) • \(device.detail)").tag(device.id)
                                }
                            }
                            .pickerStyle(.menu)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                            .background(HBPalette.fieldFill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 16, style: .continuous)
                                    .stroke(HBPalette.fieldStroke, lineWidth: 1)
                            )

                            LazyVGrid(columns: [GridItem(.adaptive(minimum: usesCompactWeatherLayout ? 150 : 180), spacing: 10)], spacing: 10) {
                                tempestToggleChip(title: "Enable", subtitle: "Poll indoor air", isOn: $goveeForm.enabled)
                                calibrationField(title: "Temp Offset (F)", text: $goveeForm.tempOffsetF)
                                calibrationField(title: "Humidity Offset (%)", text: $goveeForm.humidityOffsetPct)
                                calibrationField(title: "PM2.5 Offset", text: $goveeForm.pm25OffsetUgM3)
                            }
                        }
                    } trailing: {
                        VStack(alignment: .leading, spacing: 10) {
                            MetricCard(
                                title: "Indoor Temp",
                                value: formatTemperature(goveeStatus?.latestSample?.temperatureF),
                                subtitle: "\(goveeStatus?.latestSample?.room ?? goveeForm.room) • \(goveeStatus?.latestSample?.qualityLabel ?? "No sample")",
                                tint: HBPalette.accentGreen
                            )
                            MetricCard(
                                title: "Indoor Air",
                                value: formatPM25(goveeStatus?.latestSample?.pm25UgM3),
                                subtitle: "AQI \(formatAQI(goveeStatus?.latestSample?.usAqi)) • RH \(formatPercent(goveeStatus?.latestSample?.humidityPct))",
                                tint: HBPalette.accentBlue
                            )
                            MetricCard(
                                title: "Sync Status",
                                value: goveeStatus?.lastSampleAt.map(formatTimestamp) ?? "Not synced",
                                subtitle: (goveeStatus?.lastSampleSource == "local_lan" ? "Local LAN" : "Cloud/API") + " • \(formatTimestamp(goveeStatus?.lastSyncAt))",
                                tint: HBPalette.accentPurple
                            )

                            if let localError = goveeStatus?.lastLocalError, !localError.isEmpty {
                                Text(localError)
                                    .font(HBTypography.body(size: 13, weight: .medium))
                                    .foregroundStyle(HBPalette.accentOrange)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .padding(14)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(HBGlassBackground(cornerRadius: 18, variant: .panelSoft))
                            }

                            if let lastError = goveeStatus?.lastError, !lastError.isEmpty {
                                Text(lastError)
                                    .font(HBTypography.body(size: 13, weight: .medium))
                                    .foregroundStyle(HBPalette.accentOrange)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .padding(14)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(HBGlassBackground(cornerRadius: 18, variant: .panelSoft))
                            }
                        }
                    }

                    if usesCompactWeatherLayout {
                        VStack(spacing: 10) {
                            goveeAdminButtons(stacked: true)
                        }
                    } else {
                        goveeAdminButtons(stacked: false)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func goveeAdminButtons(stacked: Bool) -> some View {
        let layout = stacked
            ? AnyLayout(VStackLayout(spacing: 10))
            : AnyLayout(HStackLayout(spacing: 10))

        layout {
            Button {
                Task { await handleTestGovee() }
            } label: {
                Label(isTestingGovee ? "Testing..." : "Test API Key", systemImage: "testtube.2")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(HBSecondaryButtonStyle(compact: true))
            .disabled(isTestingGovee)

            Button {
                Task { await handleDiscoverLocalGovee() }
            } label: {
                Label(isDiscoveringLocalGovee ? "Discovering..." : "Discover Local", systemImage: "wifi")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(HBSecondaryButtonStyle(compact: true))
            .disabled(isDiscoveringLocalGovee)

            Button {
                Task { await handleTestLocalGovee() }
            } label: {
                Label(isTestingLocalGovee ? "Testing LAN..." : "Test Local", systemImage: "antenna.radiowaves.left.and.right")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(HBSecondaryButtonStyle(compact: true))
            .disabled(isTestingLocalGovee)

            Button {
                Task { await handleSyncGovee() }
            } label: {
                Label(isSyncingGovee ? "Syncing..." : "Sync Now", systemImage: "arrow.triangle.2.circlepath")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(HBSecondaryButtonStyle(compact: true))
            .disabled(isSyncingGovee)

            Button {
                Task { await handleSaveGovee() }
            } label: {
                Label(isSavingGovee ? "Saving..." : "Save Govee Config", systemImage: "square.and.arrow.down")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(HBPrimaryButtonStyle(compact: true))
            .disabled(isSavingGovee)
        }
    }

    private func chartHeader(title: String, subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(HBTypography.display(size: 20, weight: .bold))
                .foregroundStyle(HBPalette.textPrimary)
            Text(subtitle)
                .font(HBTypography.body(size: 14, weight: .medium))
                .foregroundStyle(HBPalette.textSecondary)
        }
    }

    private func tempestToggleChip(title: String, subtitle: String, isOn: Binding<Bool>) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(title)
                        .font(HBTypography.display(size: 11, weight: .bold))
                        .textCase(.uppercase)
                        .tracking(2)
                        .foregroundStyle(HBPalette.textMuted)

                    Text(subtitle)
                        .font(HBTypography.body(size: 14, weight: .semibold))
                        .foregroundStyle(HBPalette.textPrimary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 8)

                Toggle("", isOn: isOn)
                    .labelsHidden()
                    .tint(HBPalette.heroCore)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 92, alignment: .leading)
        .background(HBGlassBackground(cornerRadius: 18, variant: .panelSoft))
    }

    private func calibrationField(title: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(HBTypography.display(size: 11, weight: .bold))
                .textCase(.uppercase)
                .tracking(2)
                .foregroundStyle(HBPalette.textMuted)
            TextField(title, text: text)
                .keyboardType(.decimalPad)
                .hbPanelTextField()
        }
    }

    private func refreshAll(
        silent: Bool,
        includeTempestStatus: Bool,
        forceTempestSync: Bool = false,
        forceIndoorAirSync: Bool = false,
        refreshIndoorAir: Bool = true
    ) async {
        await loadWeatherDashboard(
            silent: silent,
            forceTempestSync: forceTempestSync,
            forceIndoorAirSync: forceIndoorAirSync,
            refreshIndoorAir: refreshIndoorAir
        )
        if includeTempestStatus {
            await loadTempestStatus()
            await loadGoveeStatus()
        }
    }

    private func loadWeatherDashboard(
        silent: Bool,
        forceTempestSync: Bool = false,
        forceIndoorAirSync: Bool = false,
        refreshIndoorAir: Bool = true
    ) async {
        if silent {
            isRefreshing = true
        } else if dashboard == nil {
            isLoading = true
        }

        defer {
            isLoading = false
            isRefreshing = false
        }

        errorMessage = nil

        guard var query = resolvedWeatherQuery() else {
            return
        }

        if forceTempestSync {
            query.append(URLQueryItem(name: "forceTempestSync", value: "true"))
        }
        if forceIndoorAirSync {
            query.append(URLQueryItem(name: "forceIndoorAirSync", value: "true"))
        }
        if refreshIndoorAir {
            query.append(URLQueryItem(name: "refreshIndoorAir", value: "true"))
        }

        do {
            let response = try await session.apiClient.get("/api/weather/dashboard", query: query)
            let root = JSON.object(response)
            let payload = JSON.object(root["dashboard"])
            guard let nextDashboard = WeatherDashboardSnapshot.from(payload) else {
                throw APIError.parsingFailed
            }
            dashboard = nextDashboard
        } catch {
            errorMessage = error.localizedDescription
            if !silent {
                dashboard = nil
            }
        }
    }

    private func resolvedWeatherQuery() -> [URLQueryItem]? {
        var query: [URLQueryItem] = [
            URLQueryItem(name: "tempestHistoryHours", value: String(maximumWeatherChartHours)),
            URLQueryItem(name: "indoorAirHistoryHours", value: String(maximumWeatherChartHours)),
            URLQueryItem(name: "historyPointLimit", value: String(weatherChartHistoryLimit)),
            URLQueryItem(name: "compact", value: "true")
        ]

        switch weatherLocationMode {
        case .saved:
            break
        case .custom:
            let trimmed = weatherLocationQuery.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else {
                errorMessage = "Enter a custom address or switch to the saved location."
                return nil
            }
            query.append(URLQueryItem(name: "address", value: trimmed))
        case .auto:
            guard let coordinate = locationManager.coordinate else {
                if let message = locationManager.errorMessage {
                    errorMessage = message
                } else {
                    errorMessage = "Tap Use Device Location to load weather for your approximate location."
                }
                return nil
            }
            let approximateLatitude = (coordinate.latitude * 100).rounded() / 100
            let approximateLongitude = (coordinate.longitude * 100).rounded() / 100
            query.append(URLQueryItem(name: "latitude", value: String(approximateLatitude)))
            query.append(URLQueryItem(name: "longitude", value: String(approximateLongitude)))
            query.append(URLQueryItem(name: "label", value: "Current location"))
        }

        return query
    }

    private func loadTempestStatus() async {
        guard isAdmin else { return }

        if tempestStatus == nil {
            isLoadingTempest = true
        }

        defer { isLoadingTempest = false }

        do {
            let response = try await session.apiClient.get("/api/tempest/status")
            let root = JSON.object(response)
            guard let status = TempestStatusSnapshot.from(root) else {
                throw APIError.parsingFailed
            }
            tempestStatus = status
            tempestForm.hydrate(from: status)
            if discoveredStations.isEmpty {
                discoveredStations = status.stations.compactMap { TempestStationChoice.fromStatusStation($0) }
            }
            adminErrorMessage = nil
        } catch {
            adminErrorMessage = error.localizedDescription
        }
    }

    private func handleTestToken() async {
        guard isAdmin else { return }
        isTestingTempest = true
        defer { isTestingTempest = false }

        do {
            let trimmedToken = tempestForm.token.trimmingCharacters(in: .whitespacesAndNewlines)
            let body: [String: Any]
            if trimmedToken.isEmpty || weatherIsMaskedSecret(trimmedToken) {
                body = [:]
            } else {
                body = ["token": trimmedToken]
            }

            let response = try await session.apiClient.post("/api/tempest/test", body: body)
            let root = JSON.object(response)
            discoveredStations = JSON.array(root["stations"]).compactMap { TempestStationChoice.fromDiscovery($0) }
            adminInfoMessage = "Tempest token verified. Found \(discoveredStations.count) station\(discoveredStations.count == 1 ? "" : "s")."
            adminErrorMessage = nil
        } catch {
            adminErrorMessage = error.localizedDescription
        }
    }

    private func handleSaveTempest() async {
        guard isAdmin else { return }
        isSavingTempest = true
        defer { isSavingTempest = false }

        do {
            let response = try await session.apiClient.post("/api/tempest/configure", body: tempestForm.payload())
            let root = JSON.object(response)
            guard let status = TempestStatusSnapshot.from(root) else {
                throw APIError.parsingFailed
            }
            tempestStatus = status
            tempestForm.hydrate(from: status)
            discoveredStations = status.stations.compactMap { TempestStationChoice.fromStatusStation($0) }
            adminInfoMessage = JSON.string(root, "message", fallback: "Tempest integration updated successfully.")
            adminErrorMessage = nil
            await loadWeatherDashboard(silent: true)
        } catch {
            adminErrorMessage = error.localizedDescription
        }
    }

    private func handleSyncTempest() async {
        guard isAdmin else { return }
        isSyncingTempest = true
        defer { isSyncingTempest = false }

        do {
            let response = try await session.apiClient.post("/api/tempest/sync")
            let root = JSON.object(response)
            adminInfoMessage = JSON.string(root, "message", fallback: "Tempest stations and live feeds were refreshed.")
            adminErrorMessage = nil
            await loadTempestStatus()
            await loadWeatherDashboard(silent: true)
        } catch {
            adminErrorMessage = error.localizedDescription
        }
    }

    private func loadGoveeStatus() async {
        guard isAdmin else { return }

        if goveeStatus == nil {
            isLoadingGovee = true
        }

        defer { isLoadingGovee = false }

        do {
            let response = try await session.apiClient.get("/api/govee-air-quality/status")
            let root = JSON.object(response)
            guard let status = GoveeStatusSnapshot.from(root) else {
                throw APIError.parsingFailed
            }
            goveeStatus = status
            goveeForm.hydrate(from: status)
            if discoveredGoveeDevices.isEmpty {
                discoveredGoveeDevices = status.devices
            }
            adminErrorMessage = nil
        } catch {
            adminErrorMessage = error.localizedDescription
        }
    }

    private func handleTestGovee() async {
        guard isAdmin else { return }
        isTestingGovee = true
        defer { isTestingGovee = false }

        do {
            let trimmedKey = goveeForm.apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
            let body: [String: Any]
            if trimmedKey.isEmpty || weatherIsMaskedSecret(trimmedKey) {
                body = [:]
            } else {
                body = ["apiKey": trimmedKey]
            }

            let response = try await session.apiClient.post("/api/govee-air-quality/test", body: body)
            let root = JSON.object(response)
            let discovered = JSON.array(root["airQualityDevices"]).compactMap { GoveeDeviceChoice.from($0) }
            let allDevices = JSON.array(root["devices"]).compactMap { GoveeDeviceChoice.from($0) }
            discoveredGoveeDevices = discovered.isEmpty ? allDevices : discovered
            if goveeForm.selectedDevice.isEmpty {
                goveeForm.select(discoveredGoveeDevices.first)
            }
            adminInfoMessage = JSON.string(root, "message", fallback: "Govee API key verified.")
            adminErrorMessage = nil
        } catch {
            adminErrorMessage = error.localizedDescription
        }
    }

    private func handleDiscoverLocalGovee() async {
        guard isAdmin else { return }
        isDiscoveringLocalGovee = true
        defer { isDiscoveringLocalGovee = false }

        do {
            let response = try await session.apiClient.post("/api/govee-air-quality/local/discover", body: ["timeoutMs": 3500])
            let root = JSON.object(response)
            let devices = JSON.array(root["devices"]).compactMap { GoveeDeviceChoice.from($0) }
            discoveredGoveeDevices = mergeGoveeDevices(discoveredGoveeDevices, devices)
            if let preferred = devices.first(where: { $0.isAirQualityDevice }) ?? devices.first {
                goveeForm.select(preferred)
            }
            adminInfoMessage = JSON.string(root, "message", fallback: devices.isEmpty ? "No local Govee LAN devices responded." : "Local Govee devices discovered.")
            adminErrorMessage = nil
        } catch {
            adminErrorMessage = error.localizedDescription
        }
    }

    private func handleTestLocalGovee() async {
        guard isAdmin else { return }
        isTestingLocalGovee = true
        defer { isTestingLocalGovee = false }

        do {
            let body: [String: Any] = [
                "localDeviceIp": goveeForm.localDeviceIp.trimmingCharacters(in: .whitespacesAndNewlines),
                "localDevicePort": Int(goveeForm.localDevicePort.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 4003,
                "discover": goveeForm.localDeviceIp.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ]
            let response = try await session.apiClient.post("/api/govee-air-quality/local/test", body: body)
            let root = JSON.object(response)
            let devices = JSON.array(root["devices"]).compactMap { GoveeDeviceChoice.from($0) }
            discoveredGoveeDevices = mergeGoveeDevices(discoveredGoveeDevices, devices)
            let selected = JSON.object(root["selectedDevice"])
            if let selectedDevice = GoveeDeviceChoice.from(selected) {
                discoveredGoveeDevices = mergeGoveeDevices(discoveredGoveeDevices, [selectedDevice])
                goveeForm.select(selectedDevice)
            }
            let message = JSON.string(root, "message", fallback: "Local Govee LAN test finished.")
            if JSON.bool(root, "success") {
                adminInfoMessage = message
                adminErrorMessage = nil
            } else {
                adminErrorMessage = message
            }
        } catch {
            adminErrorMessage = error.localizedDescription
        }
    }

    private func handleSaveGovee() async {
        guard isAdmin else { return }
        isSavingGovee = true
        defer { isSavingGovee = false }

        do {
            let response = try await session.apiClient.post("/api/govee-air-quality/configure", body: goveeForm.payload())
            let root = JSON.object(response)
            guard let status = GoveeStatusSnapshot.from(root) else {
                throw APIError.parsingFailed
            }
            goveeStatus = status
            goveeForm.hydrate(from: status)
            discoveredGoveeDevices = status.devices
            adminInfoMessage = JSON.string(root, "message", fallback: "Govee indoor air integration updated successfully.")
            adminErrorMessage = nil
            await loadWeatherDashboard(silent: true)
        } catch {
            adminErrorMessage = error.localizedDescription
        }
    }

    private func handleSyncGovee() async {
        guard isAdmin else { return }
        isSyncingGovee = true
        defer { isSyncingGovee = false }

        do {
            let response = try await session.apiClient.post("/api/govee-air-quality/sync")
            let root = JSON.object(response)
            adminInfoMessage = JSON.string(root, "message", fallback: "Govee indoor air readings were refreshed.")
            adminErrorMessage = nil
            await loadGoveeStatus()
            await loadWeatherDashboard(silent: true)
        } catch {
            adminErrorMessage = error.localizedDescription
        }
    }
}
