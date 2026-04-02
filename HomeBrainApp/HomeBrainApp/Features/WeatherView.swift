import Charts
import Combine
import CoreLocation
import SwiftUI

private let tempestConfiguredSecretPlaceholder = "••••••••••••••••"

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
    let temperatureF: Double?
    let precipitationChance: Double?
    let windSpeedMph: Double?
    let condition: String
    let icon: String

    var id: String { time }
    var date: Date? { JSON.date(from: time) }

    static func from(_ object: [String: Any]) -> WeatherHourlySnapshot {
        WeatherHourlySnapshot(
            time: JSON.string(object, "time"),
            temperatureF: weatherOptionalDouble(object["temperatureF"]),
            precipitationChance: weatherOptionalDouble(object["precipitationChance"]),
            windSpeedMph: weatherOptionalDouble(object["windSpeedMph"]),
            condition: JSON.string(object, "condition", fallback: "Unknown"),
            icon: JSON.string(object, "icon", fallback: "cloudy")
        )
    }
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
    let metrics: [String: Any]
    let derived: [String: Any]

    var id: String { "\(observationType)-\(observedAt)" }
    var date: Date? { JSON.date(from: observedAt) }

    func metricDouble(_ key: String) -> Double? {
        weatherOptionalDouble(metrics[key])
    }

    func derivedDouble(_ key: String) -> Double? {
        weatherOptionalDouble(derived[key])
    }

    static func from(_ object: [String: Any]) -> TempestObservationSnapshot {
        TempestObservationSnapshot(
            stationId: weatherOptionalInt(object["stationId"]),
            deviceId: weatherOptionalInt(object["deviceId"]),
            observationType: JSON.string(object, "observationType", fallback: "obs_st"),
            source: JSON.string(object, "source", fallback: "ws"),
            observedAt: JSON.string(object, "observedAt"),
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
            tempestStation: stationObject.isEmpty ? nil : TempestStationSnapshot.from(stationObject)
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

    static func from(_ object: [String: Any]) -> WeatherDashboardSnapshot? {
        guard let forecast = WeatherForecastSnapshot.from(JSON.object(object["forecast"])) else {
            return nil
        }

        let tempest = JSON.object(object["tempest"])
        let stationObject = JSON.object(tempest["station"])

        return WeatherDashboardSnapshot(
            fetchedAt: JSON.string(object, "fetchedAt"),
            forecast: forecast,
            hourlyForecast: JSON.array(object["hourlyForecast"]).map { WeatherHourlySnapshot.from($0) },
            tempestAvailable: JSON.bool(tempest, "available") && !stationObject.isEmpty,
            station: stationObject.isEmpty ? nil : TempestStationSnapshot.from(stationObject),
            observations: JSON.array(tempest["observations"]).map { TempestObservationSnapshot.from($0) },
            events: JSON.array(tempest["events"]).map { TempestEventSnapshot.from($0) }
        )
    }
}

private struct TempestIntegrationSnapshot {
    let token: String
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
        token = weatherIsMaskedSecret(status.integration.token)
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
        guard CLLocationManager.locationServicesEnabled() else {
            errorMessage = "Location services are disabled on this device."
            return
        }

        errorMessage = nil
        isRequesting = true

        switch manager.authorizationStatus {
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
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            manager.requestLocation()
        case .denied, .restricted:
            isRequesting = false
            errorMessage = "Allow location access in Settings to use auto-detected weather."
        case .notDetermined:
            break
        @unknown default:
            isRequesting = false
            errorMessage = "Location permission is unavailable."
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        coordinate = locations.last?.coordinate
        errorMessage = nil
        isRequesting = false
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        isRequesting = false
        errorMessage = error.localizedDescription
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
                .font(.system(size: 11, weight: .bold, design: .rounded))
                .textCase(.uppercase)
                .tracking(2.2)
                .foregroundStyle(HBPalette.textMuted)

            Text(value)
                .font(.system(size: 28, weight: .bold, design: .rounded))
                .foregroundStyle(HBPalette.textPrimary)
                .minimumScaleFactor(0.7)
                .lineLimit(1)

            Text(detail)
                .font(.system(size: 13, weight: .medium, design: .rounded))
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

    @AppStorage("homebrain.ios.weather.location-mode") private var weatherLocationModeRaw = DashboardWeatherLocationMode.saved.rawValue
    @AppStorage("homebrain.ios.weather.location-query") private var weatherLocationQuery = ""

    @State private var dashboard: WeatherDashboardSnapshot?
    @State private var tempestStatus: TempestStatusSnapshot?
    @State private var tempestForm = TempestConfigForm()
    @State private var discoveredStations: [TempestStationChoice] = []

    @State private var isLoading = true
    @State private var isRefreshing = false
    @State private var isLoadingTempest = false
    @State private var isTestingTempest = false
    @State private var isSavingTempest = false
    @State private var isSyncingTempest = false

    @State private var errorMessage: String?
    @State private var infoMessage = ""
    @State private var adminErrorMessage: String?
    @State private var adminInfoMessage = ""

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

    private var forecastTrendData: [WeatherHourlySnapshot] {
        Array((dashboard?.hourlyForecast ?? activeForecast?.hourlyForecast ?? []).prefix(18))
    }

    private var atmosphericTrendData: [TempestObservationSnapshot] {
        dashboard?.observations
            .filter { $0.observationType != "rapid_wind" }
            .suffix(72)
            .map { $0 } ?? []
    }

    private var windTrendData: [TempestObservationSnapshot] {
        dashboard?.observations.suffix(72).map { $0 } ?? []
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
                            Task { await refreshAll(silent: false, includeTempestStatus: isAdmin) }
                        }
                    )

                    if let errorMessage, dashboard == nil {
                        InlineErrorView(message: errorMessage) {
                            Task { await refreshAll(silent: false, includeTempestStatus: isAdmin) }
                        }
                    }

                    if !infoMessage.isEmpty {
                        HBPanel {
                            Text(infoMessage)
                                .font(.system(size: 14, weight: .medium, design: .rounded))
                                .foregroundStyle(HBPalette.textSecondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }

                    locationControlsPanel

                    if let dashboard {
                        weatherHero(for: dashboard)
                        weatherTelemetryGrid(for: dashboard)
                        weatherSensorAndForecastPanels(for: dashboard)
                        weatherHistoricalPanels(for: dashboard)
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
                    }
                }
            }
            .padding()
        }
        .refreshable {
            await refreshAll(silent: false, includeTempestStatus: isAdmin)
        }
        .task {
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
            if weatherLocationMode == .auto {
                locationManager.requestLocation()
            }
            Task { await loadWeatherDashboard(silent: dashboard != nil) }
        }
        .onChange(of: autoLocationKey) { _, _ in
            guard weatherLocationMode == .auto else { return }
            Task { await loadWeatherDashboard(silent: dashboard != nil) }
        }
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
                            .font(.system(size: 11, weight: .bold, design: .rounded))
                            .textCase(.uppercase)
                            .tracking(2.4)
                            .foregroundStyle(HBPalette.textMuted)
                        Text("Choose where the deck points the forecast engine.")
                            .font(.system(size: 15, weight: .medium, design: .rounded))
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
                            Task { await loadWeatherDashboard(silent: false) }
                        }
                }

                Group {
                    if usesCompactWeatherLayout && weatherLocationMode == .auto {
                        VStack(spacing: 10) {
                            Button {
                                Task { await loadWeatherDashboard(silent: false) }
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
                                Task { await loadWeatherDashboard(silent: false) }
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
        let headlineTemperature = forecast.headlineTemperatureF
        let headlineFeelsLike = forecast.headlineFeelsLikeF
        let stationLive = dashboard.tempestAvailable && station != nil
        let lastSyncedAt = station?.observedAt ?? forecast.fetchedAt

        return HBDeckSurface(cornerRadius: 30) {
            Group {
                if usesCompactWeatherLayout {
                    VStack(alignment: .leading, spacing: 18) {
                        HStack(alignment: .top, spacing: 14) {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Weather Command Deck")
                                    .font(.system(size: 11, weight: .bold, design: .rounded))
                                    .textCase(.uppercase)
                                    .tracking(3.0)
                                    .foregroundStyle(HBPalette.textMuted)

                                Text(formatTemperature(headlineTemperature))
                                    .font(.system(size: 52, weight: .bold, design: .rounded))
                                    .foregroundStyle(HBPalette.textPrimary)
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.72)

                                Text("Feels like \(formatTemperature(headlineFeelsLike))")
                                    .font(.system(size: 16, weight: .semibold, design: .rounded))
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
                            .font(.system(size: 14, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)

                        VStack(alignment: .leading, spacing: 8) {
                            HBBadge(
                                text: stationLive ? "Tempest fused with forecast" : "Forecast mode",
                                foreground: HBPalette.textPrimary,
                                background: HBPalette.panelSoft.opacity(0.96),
                                stroke: HBPalette.panelStrokeStrong
                            )

                            HStack(alignment: .top, spacing: 12) {
                                VStack(alignment: .leading, spacing: 6) {
                                    Label(forecast.locationName, systemImage: "mappin.and.ellipse")
                                        .font(.system(size: 13, weight: .medium, design: .rounded))
                                        .foregroundStyle(HBPalette.textSecondary)
                                        .lineLimit(2)

                                    Text(forecast.condition)
                                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                                        .foregroundStyle(HBPalette.textPrimary)
                                }

                                Spacer(minLength: 12)

                                VStack(alignment: .trailing, spacing: 6) {
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
                } else {
                    VStack(alignment: .leading, spacing: 22) {
                        HStack(alignment: .top, spacing: 16) {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Weather Command Deck")
                                    .font(.system(size: 11, weight: .bold, design: .rounded))
                                    .textCase(.uppercase)
                                    .tracking(3.0)
                                    .foregroundStyle(HBPalette.textMuted)

                                HStack(alignment: .firstTextBaseline, spacing: 12) {
                                    Text(formatTemperature(headlineTemperature))
                                        .font(.system(size: 58, weight: .bold, design: .rounded))
                                        .foregroundStyle(HBPalette.textPrimary)

                                    VStack(alignment: .leading, spacing: 6) {
                                        HBBadge(
                                            text: stationLive ? "Tempest fused with forecast" : "Forecast mode",
                                            foreground: HBPalette.textPrimary,
                                            background: HBPalette.panelSoft.opacity(0.96),
                                            stroke: HBPalette.panelStrokeStrong
                                        )
                                        Text("Feels like \(formatTemperature(headlineFeelsLike))")
                                            .font(.system(size: 15, weight: .semibold, design: .rounded))
                                            .foregroundStyle(HBPalette.textSecondary)
                                    }
                                }

                                Text(stationLive
                                     ? "Live station telemetry is driving the now-cast layer while Open-Meteo supplies the broader forecast envelope."
                                     : "Forecast mode is active. Connect a Tempest station to unlock local telemetry, historical charts, and event feeds.")
                                    .font(.system(size: 15, weight: .medium, design: .rounded))
                                    .foregroundStyle(HBPalette.textSecondary)
                                    .fixedSize(horizontal: false, vertical: true)

                                HStack(spacing: 12) {
                                    Label(forecast.locationName, systemImage: "mappin.and.ellipse")
                                        .font(.system(size: 13, weight: .medium, design: .rounded))
                                        .foregroundStyle(HBPalette.textSecondary)
                                        .lineLimit(2)
                                    Text(forecast.condition)
                                        .font(.system(size: 13, weight: .semibold, design: .rounded))
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

        let items: [WeatherTelemetryCardItem] = [
            WeatherTelemetryCardItem(
                title: "Local Forecast",
                value: "\(formatTemperature(forecast.highF)) / \(formatTemperature(forecast.lowF))",
                detail: "\(forecast.todayCondition) • Rain chance \(formatPercent(forecast.precipitationChance))",
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
                detail: station != nil ? "Rate \(formatRain(station?.metrics.rainRateInPerHr))/hr" : "Forecast-only users still get rain probability",
                accent: HBPalette.accentOrange,
                gradient: [HBPalette.accentOrange.opacity(0.24), HBPalette.panelSoft.opacity(0.14)]
            )
        ]

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

        return weatherSplitPanels {
            HBPanel {
                VStack(alignment: .leading, spacing: 14) {
                    chartHeader(
                        title: "Forecast Flightpath",
                        subtitle: "Next 18 hours of temperature, wind, and precipitation probability."
                    )

                    if forecastTrendData.isEmpty {
                        EmptyStateView(
                            title: "Forecast history unavailable",
                            subtitle: "HomeBrain did not receive an hourly forecast payload for this location."
                        )
                    } else {
                        Chart {
                            ForEach(forecastTrendData) { point in
                                if let date = point.date, let temperature = point.temperatureF {
                                    AreaMark(
                                        x: .value("Time", date),
                                        y: .value("Temperature", temperature)
                                    )
                                    .foregroundStyle(HBPalette.accentBlue.opacity(0.18))

                                    LineMark(
                                        x: .value("Time", date),
                                        y: .value("Temperature", temperature)
                                    )
                                    .interpolationMethod(.catmullRom)
                                    .lineStyle(StrokeStyle(lineWidth: 3))
                                    .foregroundStyle(HBPalette.accentBlue)
                                }
                            }

                            ForEach(forecastTrendData) { point in
                                if let date = point.date, let wind = point.windSpeedMph {
                                    LineMark(
                                        x: .value("Time", date),
                                        y: .value("Wind", wind)
                                    )
                                    .interpolationMethod(.catmullRom)
                                    .lineStyle(StrokeStyle(lineWidth: 2.2))
                                    .foregroundStyle(HBPalette.accentPurple)
                                }
                            }

                            ForEach(forecastTrendData) { point in
                                if let date = point.date, let precipitation = point.precipitationChance {
                                    BarMark(
                                        x: .value("Time", date),
                                        y: .value("Precip", precipitation)
                                    )
                                    .foregroundStyle(HBPalette.accentGreen.opacity(0.35))
                                }
                            }
                        }
                        .frame(height: 280)
                        .chartXAxis {
                            AxisMarks(values: .automatic(desiredCount: 6)) { _ in
                                AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [4, 4]))
                                    .foregroundStyle(HBPalette.panelStroke.opacity(0.45))
                                AxisTick()
                                    .foregroundStyle(HBPalette.panelStroke.opacity(0.6))
                                AxisValueLabel(format: .dateTime.hour(.defaultDigits(amPM: .abbreviated)))
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
                                .font(.system(size: 14, weight: .medium, design: .rounded))
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

    private func weatherHistoricalPanels(for dashboard: WeatherDashboardSnapshot) -> some View {
        weatherSplitPanels {
            HBPanel {
                VStack(alignment: .leading, spacing: 14) {
                    chartHeader(
                        title: "Atmospheric Curve",
                        subtitle: "Temperature, feels-like, and dew point from recent station history."
                    )

                    if atmosphericTrendData.isEmpty {
                        EmptyStateView(
                            title: "No Tempest history",
                            subtitle: "Connect a Tempest station to populate live atmospheric charts."
                        )
                    } else {
                        Chart {
                            ForEach(atmosphericTrendData) { point in
                                if let date = point.date, let tempF = celsiusToFahrenheit(point.metricDouble("temp_c")) {
                                    AreaMark(x: .value("Time", date), y: .value("Temperature", tempF))
                                        .foregroundStyle(HBPalette.accentBlue.opacity(0.18))
                                    LineMark(x: .value("Time", date), y: .value("Temperature", tempF))
                                        .foregroundStyle(HBPalette.accentBlue)
                                        .lineStyle(StrokeStyle(lineWidth: 2.6))
                                }
                            }

                            ForEach(atmosphericTrendData) { point in
                                if let date = point.date, let feelsLikeF = celsiusToFahrenheit(point.derivedDouble("feels_like_c")) {
                                    LineMark(x: .value("Time", date), y: .value("Feels Like", feelsLikeF))
                                        .foregroundStyle(HBPalette.accentPurple)
                                        .lineStyle(StrokeStyle(lineWidth: 2.2))
                                }
                            }

                            ForEach(atmosphericTrendData) { point in
                                if let date = point.date, let dewPointF = celsiusToFahrenheit(point.derivedDouble("dew_point_c")) {
                                    LineMark(x: .value("Time", date), y: .value("Dew Point", dewPointF))
                                        .foregroundStyle(HBPalette.accentGreen)
                                        .lineStyle(StrokeStyle(lineWidth: 2))
                                }
                            }
                        }
                        .frame(height: 300)
                        .chartXAxis {
                            AxisMarks(values: .automatic(desiredCount: 6)) { _ in
                                AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [4, 4]))
                                    .foregroundStyle(HBPalette.panelStroke.opacity(0.45))
                                AxisValueLabel(format: .dateTime.hour(.defaultDigits(amPM: .abbreviated)))
                            }
                        }
                    }
                }
            }
        } trailing: {
            HBPanel {
                VStack(alignment: .leading, spacing: 14) {
                    chartHeader(
                        title: "Wind Vector Matrix",
                        subtitle: "Average, gust, and rapid wind samples from the station feed."
                    )

                    if windTrendData.isEmpty {
                        EmptyStateView(
                            title: "No wind telemetry",
                            subtitle: "Wind history appears here once Tempest observations are available."
                        )
                    } else {
                        Chart {
                            ForEach(windTrendData) { point in
                                if let date = point.date, let avgMph = metersPerSecondToMph(point.metricDouble("wind_avg_mps")) {
                                    LineMark(x: .value("Time", date), y: .value("Average", avgMph))
                                        .foregroundStyle(HBPalette.accentBlue)
                                        .lineStyle(StrokeStyle(lineWidth: 2.5))
                                }
                            }

                            ForEach(windTrendData) { point in
                                if let date = point.date, let gustMph = metersPerSecondToMph(point.metricDouble("wind_gust_mps")) {
                                    LineMark(x: .value("Time", date), y: .value("Gust", gustMph))
                                        .foregroundStyle(HBPalette.accentRed)
                                        .lineStyle(StrokeStyle(lineWidth: 2.3))
                                }
                            }

                            ForEach(windTrendData) { point in
                                if let date = point.date, let rapidMph = metersPerSecondToMph(point.metricDouble("wind_rapid_mps")) {
                                    LineMark(x: .value("Time", date), y: .value("Rapid", rapidMph))
                                        .foregroundStyle(HBPalette.accentOrange)
                                        .lineStyle(StrokeStyle(lineWidth: 1.8))
                                }
                            }
                        }
                        .frame(height: 300)
                        .chartXAxis {
                            AxisMarks(values: .automatic(desiredCount: 6)) { _ in
                                AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [4, 4]))
                                    .foregroundStyle(HBPalette.panelStroke.opacity(0.45))
                                AxisValueLabel(format: .dateTime.hour(.defaultDigits(amPM: .abbreviated)))
                            }
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity)
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
                                        .font(.system(size: 15, weight: .semibold, design: .rounded))
                                        .foregroundStyle(HBPalette.textPrimary)

                                    if event.eventType == "lightning_strike" {
                                        Text("Distance \(event.payloadDouble("distanceMiles").map { String(format: "%.1f mi", $0) } ?? "--") • Energy \(event.payloadDouble("energy").map { String(Int($0.rounded())) } ?? "--")")
                                            .font(.system(size: 13, weight: .medium, design: .rounded))
                                            .foregroundStyle(HBPalette.textSecondary)
                                    } else {
                                        Text("Precipitation onset captured by the station event stream.")
                                            .font(.system(size: 13, weight: .medium, design: .rounded))
                                            .foregroundStyle(HBPalette.textSecondary)
                                    }
                                }

                                Spacer()

                                Text(formatTimestamp(event.eventAt))
                                    .font(.system(size: 12, weight: .medium, design: .rounded))
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
                            .font(.system(size: 22, weight: .bold, design: .rounded))
                            .foregroundStyle(HBPalette.textPrimary)
                        Text("Personal Access Token setup, discovery, live feed health, and calibration.")
                            .font(.system(size: 14, weight: .medium, design: .rounded))
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
                                .font(.system(size: 14, weight: .medium, design: .rounded))
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
                                        .font(.system(size: 11, weight: .bold, design: .rounded))
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
                                        .font(.system(size: 11, weight: .bold, design: .rounded))
                                        .textCase(.uppercase)
                                        .tracking(2)
                                        .foregroundStyle(HBPalette.accentOrange)
                                    Text(lastError)
                                        .font(.system(size: 13, weight: .medium, design: .rounded))
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
                        .font(.system(size: 12, weight: .medium, design: .rounded))
                        .foregroundStyle(HBPalette.textMuted)
                }
            }
        }
    }

    private func chartHeader(title: String, subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.system(size: 20, weight: .bold, design: .rounded))
                .foregroundStyle(HBPalette.textPrimary)
            Text(subtitle)
                .font(.system(size: 14, weight: .medium, design: .rounded))
                .foregroundStyle(HBPalette.textSecondary)
        }
    }

    private func tempestToggleChip(title: String, subtitle: String, isOn: Binding<Bool>) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(title)
                        .font(.system(size: 11, weight: .bold, design: .rounded))
                        .textCase(.uppercase)
                        .tracking(2)
                        .foregroundStyle(HBPalette.textMuted)

                    Text(subtitle)
                        .font(.system(size: 14, weight: .semibold, design: .rounded))
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
                .font(.system(size: 11, weight: .bold, design: .rounded))
                .textCase(.uppercase)
                .tracking(2)
                .foregroundStyle(HBPalette.textMuted)
            TextField(title, text: text)
                .keyboardType(.decimalPad)
                .hbPanelTextField()
        }
    }

    private func refreshAll(silent: Bool, includeTempestStatus: Bool) async {
        await loadWeatherDashboard(silent: silent)
        if includeTempestStatus {
            await loadTempestStatus()
        }
    }

    private func loadWeatherDashboard(silent: Bool) async {
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

        guard let query = resolvedWeatherQuery() else {
            return
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
            URLQueryItem(name: "tempestHistoryHours", value: "24")
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
                if locationManager.errorMessage == nil && !locationManager.isRequesting {
                    locationManager.requestLocation()
                } else if let message = locationManager.errorMessage {
                    errorMessage = message
                }
                return nil
            }
            query.append(URLQueryItem(name: "latitude", value: String(coordinate.latitude)))
            query.append(URLQueryItem(name: "longitude", value: String(coordinate.longitude)))
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
}
