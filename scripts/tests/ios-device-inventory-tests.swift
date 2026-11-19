import Foundation

@main
struct IOSDeviceInventoryTests {
    static func main() {
        func device(_ id: String, _ name: String, on: Bool = false) -> DeviceItem {
            DeviceItem.from(["_id": id, "name": name, "status": on])
        }

        // The response to a create can race a stream event for the same device.
        var inventory = DeviceInventory([device("a", "Zebra"), device("b", "Beta"), device("a", "Alpha")])
        precondition(inventory.ordered.map(\.id) == ["a", "b"])
        precondition(inventory["a"]?.name == "Alpha")
        inventory.upsert([device("a", "Alpha", on: true), device("b", "Beta", on: true)])
        precondition(inventory.ordered.map(\.status) == [true, true])

        inventory.upsert([device("b", "Zebra"), device("c", "beta"), device("c", "Aardvark")])
        precondition(inventory.ordered.map(\.id) == ["c", "a", "b"])
        precondition(["b", "missing", "c"].compactMap { inventory[$0]?.name } == ["Zebra", "Aardvark"])
        inventory.remove(id: "a")
        inventory.remove(id: "missing")
        precondition(inventory["a"] == nil && inventory["b"]?.name == "Zebra")
        inventory.upsert([device("b", "Ant")])
        precondition(inventory.ordered.map(\.name) == ["Aardvark", "Ant"])
        inventory = DeviceInventory([device("b", "Ant")])
        precondition(inventory["c"] == nil && inventory.ordered.count == 1)
        print("PASS device snapshots, batch updates, ordering, widget lookup and removal")

        precondition(DeviceItem.normalizedHexColor("  #aB12Ef\n") == "#ab12ef")
        for invalid in ["#12345", "#1234567", "123456", "#12GG00", "#１２３４５６"] {
            precondition(DeviceItem.normalizedHexColor(invalid) == nil)
        }
        precondition(DeviceItem.from(["color": NSNull()]).color == "#ffffff")
        print("PASS device color parsing and fallback")

        let seconds = JSON.date(from: "2026-11-19T12:30:40Z")!
        let milliseconds = JSON.date(from: "2026-11-19T12:30:40.123Z")!
        precondition(abs(milliseconds.timeIntervalSince(seconds) - 0.123) < 0.000001)
        precondition(JSON.date(from: "2026-11-19T05:30:40-07:00") == seconds)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        let local = calendar.date(from: DateComponents(year: 2026, month: 11, day: 19, hour: 12, minute: 30))!
        for timestamp in ["2026-11-19T12:30", "2026-11-19 12:30", "2026-11-19T12:30:00", "2026-11-19 12:30:00"] {
            precondition(JSON.date(from: timestamp) == local)
        }
        precondition(JSON.date(from: seconds) == seconds && JSON.date(from: "invalid") == nil)
        print("PASS fractional, offset and legacy local timestamps")
    }
}
