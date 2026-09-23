import Foundation

nonisolated struct HomeBrainSensorTelemetryRow: Identifiable {
    let key: String
    let label: String
    let value: String
    let section: String
    let numeric: Bool
    let available: Bool
    var id: String { key }
}

nonisolated enum HomeBrainSensorTelemetry {
    static let labels: [String: (String, String)] = [
        "temperature_c": ("Temperature", "°C"), "temperature_f": ("Temperature", "°F"), "humidity_pct": ("Humidity", "%"),
        "dew_point_c": ("Dew point", "°C"), "dew_point_f": ("Dew point", "°F"), "absolute_humidity_gm3": ("Absolute humidity", "g/m³"),
        "pressure_hpa": ("Pressure", "hPa"), "gas_resistance_ohms": ("Gas resistance", "Ω"),
        "air_quality_score": ("Air quality score (estimate)", "/100"), "voc_trend_index": ("VOC trend (relative)", ""),
        "comfort_score": ("Comfort score (estimate)", "/100"), "mold_risk_score": ("Mold risk score (estimate)", "/100"),
        "co2_ppm": ("CO₂", "ppm"), "pm1_0_ugm3": ("PM1.0", "µg/m³"), "pm2_5_ugm3": ("PM2.5", "µg/m³"), "pm10_ugm3": ("PM10", "µg/m³"),
        "illuminance_lux": ("Light", "lux"), "presence_present": ("Presence", ""), "moving_distance_cm": ("Moving target distance", "cm"),
        "stationary_distance_cm": ("Stationary target distance", "cm"), "moving_energy_pct": ("Moving target energy", "%"),
        "stationary_energy_pct": ("Stationary target energy", "%"), "battery_volts": ("Battery voltage", "V"), "battery_pct": ("Battery", "%"),
        "usb_powered": ("USB powered", ""), "signal_rssi_dbm": ("Wi-Fi signal", "dBm"), "uptime_ms": ("Uptime", "ms"),
        "wake_count": ("Wake count", ""), "free_heap_bytes": ("Free memory", "bytes"), "ip_address": ("Local IP", ""),
        "temperature_source": ("Temperature source", ""), "bme680_available": ("BME680", ""), "scd41_available": ("SCD41", ""),
        "veml7700_available": ("VEML7700", ""), "pms5003_available": ("PMS5003", ""), "ld2410_available": ("LD2410", ""), "dht11_available": ("DHT11", "")
    ]
    static let climate = ["temperature_f", "temperature_c", "humidity_pct", "dew_point_c", "absolute_humidity_gm3", "comfort_score", "mold_risk_score"]
    static let profiles: [String: [String]] = [
        "air-station": climate + ["co2_ppm", "pm1_0_ugm3", "pm2_5_ugm3", "pm10_ugm3", "illuminance_lux", "pressure_hpa", "gas_resistance_ohms", "voc_trend_index", "air_quality_score"],
        "presence": climate + ["illuminance_lux", "presence_present", "moving_distance_cm", "stationary_distance_cm", "moving_energy_pct", "stationary_energy_pct"],
        "climate": climate
    ]

    static func rows(_ sensor: [String: Any]) -> [HomeBrainSensorTelemetryRow] {
        let profile = sensor["profile"] as? String ?? "auto"
        return [("Measurements", "readings"), ("Power", "power"), ("Diagnostics", "diagnostics")].flatMap { section, field in
            let values = sensor[field] as? [String: Any] ?? [:]
            let expected = field == "readings" ? profiles[profile] ?? [] : []
            let keys = expected + values.keys.sorted().filter { !expected.contains($0) }
            return keys.map { key in
                let raw = values[key]
                let (label, unit) = labels[key] ?? (key.replacingOccurrences(of: "_", with: " "), "")
                var formatted = "Unavailable"
                var numeric = false
                var available = false
                if let value = raw as? NSNumber {
                    if CFGetTypeID(value) == CFBooleanGetTypeID() {
                        formatted = key.hasSuffix("_available") ? (value.boolValue ? "Reporting" : "Not reporting")
                            : key == "presence_present" ? (value.boolValue ? "Present" : "Clear") : (value.boolValue ? "Yes" : "No")
                        numeric = true; available = true
                    } else if value.doubleValue.isFinite {
                        formatted = value.doubleValue.formatted(.number.precision(.fractionLength(0...(key == "battery_volts" ? 3 : 2)))) + (unit.isEmpty ? "" : " \(unit)")
                        numeric = true; available = true
                    }
                } else if let value = raw as? String {
                    formatted = value; available = true
                }
                return HomeBrainSensorTelemetryRow(key: key, label: label, value: formatted, section: section, numeric: numeric, available: available)
            }
        }
    }

    static func summary(_ sensor: [String: Any]) -> String {
        let profile = sensor["profile"] as? String ?? ""
        let keys = profile == "presence" ? ["presence_present", "temperature_f", "humidity_pct", "illuminance_lux"]
            : profile == "climate" ? ["temperature_f", "humidity_pct", "battery_pct"] : ["co2_ppm", "pm2_5_ugm3", "humidity_pct", "illuminance_lux"]
        let all = rows(sensor)
        return keys.compactMap { key in all.first { $0.key == key && $0.available } }.map { "\($0.label): \($0.value)" }.joined(separator: " · ")
    }
}
