import Foundation
import Combine
@preconcurrency import CoreBluetooth

@MainActor
final class SensorBluetooth: NSObject, ObservableObject, @preconcurrency CBCentralManagerDelegate, @preconcurrency CBPeripheralDelegate {
    static let service = CBUUID(string: "9c2f0001-7d1b-4a2f-9d3b-0f91e6a3b805")
    static let infoID = CBUUID(string: "9c2f0002-7d1b-4a2f-9d3b-0f91e6a3b805")
    static let commandID = CBUUID(string: "9c2f0003-7d1b-4a2f-9d3b-0f91e6a3b805")
    static let responseID = CBUUID(string: "9c2f0004-7d1b-4a2f-9d3b-0f91e6a3b805")
    struct Nearby: Identifiable { let peripheral: CBPeripheral; let name: String; let rssi: Int; var id: UUID { peripheral.identifier } }
    struct Network: Identifiable { let ssid: String; let rssi: Int; let secure: Bool; var id: String { ssid } }
    @Published var nearby: [Nearby] = []
    @Published var message = "Choose Find nearby sensor to start Bluetooth discovery."
    @Published var identity: [String: Any] = [:]
    @Published private(set) var isConnected = false
    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var characteristics: [CBUUID: CBCharacteristic] = [:]
    private var connection: CheckedContinuation<Void, Error>?
    private var reader: CheckedContinuation<Data, Error>?
    private var writer: CheckedContinuation<Void, Error>?
    private var operationTimeout: Task<Void, Never>?
    private var discoveryTimeout: Task<Void, Never>?
    private var wantsScan = false
    private var sequence = 0

    func scan() {
        nearby = []; wantsScan = true
        message = "Looking for HomeBrain sensors…"
        if central == nil { central = CBCentralManager(delegate: self, queue: .main) }
        else { centralManagerDidUpdateState(central) }
    }
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn:
            guard wantsScan else { return }
            central.scanForPeripherals(withServices: [Self.service], options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
            discoveryTimeout?.cancel()
            discoveryTimeout = Task { [weak self] in
                try? await Task.sleep(for: .seconds(20))
                guard !Task.isCancelled, let self else { return }
                self.central.stopScan(); self.wantsScan = false
                self.message = self.nearby.isEmpty ? "No sensor found. Power on an unclaimed device or open its local USB setup window, then retry." : "Choose your nearby sensor."
            }
        case .unauthorized: message = "Allow Bluetooth for HomeBrain in iPhone Settings → Privacy & Security → Bluetooth."
        case .poweredOff: message = "Turn on Bluetooth in iPhone Settings."
        case .unsupported: message = "Bluetooth is not supported on this device."
        default: message = "Waiting for Bluetooth…"
        }
    }
    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        guard !nearby.contains(where: { $0.id == peripheral.identifier }) else { return }
        nearby.append(Nearby(peripheral: peripheral, name: advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? peripheral.name ?? "HomeBrain Sensor", rssi: RSSI.intValue))
        nearby.sort { $0.rssi > $1.rssi }
    }
    func connect(_ device: Nearby) async throws {
        disconnect()
        central.stopScan(); discoveryTimeout?.cancel(); wantsScan = false
        peripheral = device.peripheral; device.peripheral.delegate = self
        do {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                connection = continuation; armTimeout()
                central.connect(device.peripheral)
            }
            identity = try await readObject(Self.infoID)
            guard JSON.int(identity, "protocol") == 1,
                  JSON.string(identity, "hardwareId").range(of: "^XIAO-C6-[A-Fa-f0-9]{12}$", options: .regularExpression) != nil else {
                throw failure("Unsupported sensor firmware.")
            }
            _ = try await readObject(Self.responseID) // Encrypted read triggers native pairing before credentials.
            isConnected = true
        } catch {
            disconnect()
            throw error
        }
    }
    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        peripheral.discoverServices([Self.service])
    }
    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        failPending(error ?? failure("Could not connect to the sensor."))
        if self.peripheral?.identifier == peripheral.identifier {
            self.peripheral = nil; characteristics = [:]; isConnected = false
        }
    }
    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        guard self.peripheral?.identifier == peripheral.identifier else { return }
        failPending(error ?? failure("Sensor disconnected. Reconnect to retry setup."))
        self.peripheral = nil; characteristics = [:]; isConnected = false
    }
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        if let error { failPending(error); return }
        guard let service = peripheral.services?.first(where: { $0.uuid == Self.service }) else { failPending(failure("Sensor setup service is missing.")); return }
        peripheral.discoverCharacteristics([Self.infoID, Self.commandID, Self.responseID], for: service)
    }
    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        if let error { failPending(error); return }
        for characteristic in service.characteristics ?? [] { characteristics[characteristic.uuid] = characteristic }
        guard [Self.infoID, Self.commandID, Self.responseID].allSatisfy({ characteristics[$0] != nil }) else { failPending(failure("Sensor setup is incomplete. Update its firmware.")); return }
        operationTimeout?.cancel(); let pending = connection; connection = nil; pending?.resume()
    }
    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        operationTimeout?.cancel(); let pending = reader; reader = nil
        if let error { pending?.resume(throwing: error) }
        else if let data = characteristic.value { pending?.resume(returning: data) }
        else { pending?.resume(throwing: failure("Empty sensor response.")) }
    }
    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        operationTimeout?.cancel(); let pending = writer; writer = nil
        if let error { pending?.resume(throwing: error) } else { pending?.resume() }
    }
    private func readObject(_ id: CBUUID) async throws -> [String: Any] {
        guard let peripheral, let characteristic = characteristics[id] else { throw failure("Reconnect to the sensor.") }
        let data: Data = try await withCheckedThrowingContinuation { continuation in
            reader = continuation; armTimeout(); peripheral.readValue(for: characteristic)
        }
        guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw failure("Invalid sensor response.") }
        return value
    }
    private func write(_ data: Data) async throws {
        guard let peripheral, let characteristic = characteristics[Self.commandID] else { throw failure("Reconnect to the sensor.") }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            writer = continuation; armTimeout(); peripheral.writeValue(data, for: characteristic, type: .withResponse)
        }
    }
    func command(_ operation: String, fields: [String: Any] = [:], onState: ((String) -> Void)? = nil) async throws -> [String: Any] {
        sequence += 1; let id = sequence
        var payload = fields; payload["id"] = id; payload["op"] = operation
        var data = try JSONSerialization.data(withJSONObject: payload); data.append(10)
        guard data.count <= 1537 else { throw failure("Setup request is too long.") }
        for offset in stride(from: 0, to: data.count, by: 20) {
            try Task.checkCancellation()
            try await write(data.subdata(in: offset..<min(offset + 20, data.count)))
        }
        data.resetBytes(in: 0..<data.count)
        let deadline = Date().addingTimeInterval(90)
        while Date() < deadline {
            try Task.checkCancellation()
            let response = try await readObject(Self.responseID)
            if JSON.int(response, "id") == id {
                let state = JSON.string(response, "state")
                if state == "error" { throw failure(JSON.string(response, "error", fallback: "Sensor setup failed.")) }
                onState?(state)
                if ["complete", "scanned", "networks", "cancelled"].contains(state) { return response }
            }
            try await Task.sleep(for: .milliseconds(250))
        }
        throw failure("Setup timed out. Reconnect and try again.")
    }
    func scanNetworks() async throws -> [Network] {
        _ = try await command("scan")
        var networks: [String: Network] = [:]
        var offset = 0
        for _ in 0..<100 {
            let page = try await command("networks", fields: ["offset": offset])
            for item in JSON.array(page["networks"]) {
                let network = Network(ssid: JSON.string(item, "ssid"), rssi: JSON.int(item, "rssi"), secure: JSON.bool(item, "secure"))
                if !network.ssid.isEmpty, network.rssi > (networks[network.ssid]?.rssi ?? -200) { networks[network.ssid] = network }
            }
            let next = JSON.int(page, "next", fallback: -1)
            if next < 0 { break }
            guard next > offset else { throw failure("Invalid network scan response.") }
            offset = next
        }
        return networks.values.sorted { $0.rssi > $1.rssi }
    }
    func disconnect() {
        discoveryTimeout?.cancel(); wantsScan = false; central?.stopScan()
        failPending(failure("Bluetooth setup closed."))
        if let peripheral { central?.cancelPeripheralConnection(peripheral) }
        peripheral = nil; characteristics = [:]; isConnected = false
    }
    private func armTimeout() {
        operationTimeout?.cancel()
        operationTimeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(20))
            guard !Task.isCancelled else { return }
            self?.failPending(self?.failure("Bluetooth operation timed out. Reconnect to retry.") ?? CancellationError())
        }
    }
    private func failPending(_ error: Error) {
        operationTimeout?.cancel()
        let c = connection, r = reader, w = writer
        connection = nil; reader = nil; writer = nil
        c?.resume(throwing: error); r?.resume(throwing: error); w?.resume(throwing: error)
    }
    private func failure(_ text: String) -> NSError { NSError(domain: "HomeBrain.SensorBluetooth", code: 1, userInfo: [NSLocalizedDescriptionKey: text]) }
}
