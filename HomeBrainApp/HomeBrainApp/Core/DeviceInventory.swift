import Foundation

nonisolated struct DeviceInventory {
    private(set) var ordered: [DeviceItem] = []
    private var indexByID: [String: Int] = [:]

    init(_ snapshot: [DeviceItem] = []) {
        upsert(snapshot)
    }

    subscript(id: String) -> DeviceItem? {
        indexByID[id].map { ordered[$0] }
    }

    mutating func upsert(_ updates: [DeviceItem]) {
        var needsSort = false
        for device in updates {
            if let index = indexByID[device.id] {
                if ordered[index].name != device.name { needsSort = true }
                ordered[index] = device
            } else {
                indexByID[device.id] = ordered.count
                ordered.append(device)
                needsSort = true
            }
        }
        if needsSort {
            ordered.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            updatePositions(startingAt: 0)
        }
    }

    mutating func remove(id: String) {
        guard let index = indexByID.removeValue(forKey: id) else { return }
        ordered.remove(at: index)
        updatePositions(startingAt: index)
    }

    private mutating func updatePositions(startingAt start: Int) {
        for index in start..<ordered.count {
            indexByID[ordered[index].id] = index
        }
    }
}
