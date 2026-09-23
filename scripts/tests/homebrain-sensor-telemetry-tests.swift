import Foundation

@main
struct HomeBrainSensorTelemetryTests {
    static func main() throws {
        var count = 0
        func check(_ name: String, _ condition: Bool) { precondition(condition, name); count += 1; print("PASS \(name)") }
        for profile in ["air-station", "presence", "climate"] {
            let rows = HomeBrainSensorTelemetry.rows(["profile": profile, "readings": ["temperature_f": 0]])
            check("\(profile) includes every expected measurement", rows.map(\.key) == HomeBrainSensorTelemetry.profiles[profile])
            check("\(profile) zero is real", rows.first { $0.key == "temperature_f" }?.value == "0 °F")
            check("\(profile) missing is unavailable", rows.first { $0.key == "humidity_pct" }?.available == false)
        }
        let payload = #"{"profile":"presence","readings":{"presence_present":false,"illuminance_lux":0},"power":{"usb_powered":false,"battery_pct":0},"diagnostics":{"dht11_available":false,"ld2410_available":true,"ip_address":"192.0.2.1"}}"#
        let data = try JSONSerialization.jsonObject(with: Data(payload.utf8)) as! [String: Any]
        let rows = Dictionary(uniqueKeysWithValues: HomeBrainSensorTelemetry.rows(data).map { ($0.key, $0) })
        check("boolean false is clear, not missing", rows["presence_present"]?.value == "Clear")
        check("numeric zero is not a boolean", rows["illuminance_lux"]?.value == "0 lux")
        check("module failure remains graphable", rows["dht11_available"]?.value == "Not reporting" && rows["dht11_available"]?.numeric == true)
        check("module success is explicit", rows["ld2410_available"]?.value == "Reporting")
        check("IP remains text, not a meaningless graph", rows["ip_address"]?.numeric == false)
        check("summary is profile-specific", HomeBrainSensorTelemetry.summary(data).contains("Presence: Clear"))
        print("\(count) sensor telemetry checks passed")
    }
}
