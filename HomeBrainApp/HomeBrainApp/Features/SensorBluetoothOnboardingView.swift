import SwiftUI

struct SensorBluetoothOnboardingView: View {
    @EnvironmentObject private var session: SessionStore
    @StateObject private var bluetooth = SensorBluetooth()
    @State private var networks: [SensorBluetooth.Network] = []
    @State private var ssid = ""
    @State private var password = ""
    @State private var name = ""
    @State private var room = ""
    @State private var profile = "auto"
    @State private var busy = false
    @State private var connected = false
    @State private var complete = false
    @State private var status = ""
    @State private var errorMessage: String?
    @State private var registration: [String: Any]?
    @State private var selectedDevice: SensorBluetooth.Nearby?
    @State private var selectedHardwareId = ""
    @State private var work: Task<Void, Never>?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Add HomeBrain Sensor", systemImage: "sensor.tag.radiowaves.forward.fill").font(.headline)
            Text("Discover your nearby sensor, choose its 2.4 GHz Wi-Fi and enter the password. HomeBrain handles registration.").font(.subheadline).foregroundStyle(.secondary)
            Text(status.isEmpty ? bluetooth.message : status).font(.caption)
            if let errorMessage { Text(errorMessage).font(.caption).foregroundStyle(.red) }
            if !complete {
                Button(connected ? "Reconnect / rescan" : "Find nearby sensor") {
                    bluetooth.disconnect(); connected = false; selectedDevice = nil; selectedHardwareId = ""
                    registration = nil; status = ""; errorMessage = nil
                    bluetooth.scan()
                }.buttonStyle(HBSecondaryButtonStyle()).disabled(busy)
            }
            if !connected && !complete {
                ForEach(bluetooth.nearby) { device in
                    Button {
                        work = Task { await connect(device) }
                    } label: { HStack { Text(device.name); Spacer(); Text("\(device.rssi) dBm").font(.caption) } }
                    .buttonStyle(HBSecondaryButtonStyle()).disabled(busy)
                }
            }
            if connected && !complete {
                if !networks.isEmpty {
                    Picker("Nearby Wi-Fi", selection: $ssid) {
                        Text("Choose a network").tag("")
                        ForEach(networks) { network in Text(network.ssid).tag(network.ssid) }
                    }.disabled(busy)
                }
                TextField("Wi-Fi network name", text: $ssid).textContentType(.none).textInputAutocapitalization(.never).autocorrectionDisabled().disabled(busy)
                SecureField("Wi-Fi password", text: $password).textContentType(.newPassword).disabled(busy)
                if !JSON.bool(bluetooth.identity, "configured") {
                    DisclosureGroup("Optional name, room and device type") {
                        TextField("Automatic sensor name", text: $name)
                        TextField("Room (can be assigned later)", text: $room)
                        Picker("Device type", selection: $profile) {
                            Text("Atmosphere").tag("air-station"); Text("Presence + Climate").tag("presence")
                            Text("Battery Climate").tag("climate"); Text("Auto detect").tag("auto")
                        }
                    }.disabled(busy)
                }
                Button { work = Task { await configure() } } label: {
                    HStack {
                        if busy { ProgressView() }
                        Text(busy ? "Connecting…" : bluetooth.isConnected ? "Connect sensor" : "Reconnect and connect sensor")
                    }.frame(maxWidth: .infinity)
                }.buttonStyle(HBPrimaryButtonStyle()).disabled(busy || ssid.isEmpty)
            }
            if complete { Label("Connected to HomeBrain", systemImage: "checkmark.circle.fill").foregroundStyle(.green) }
            Text("New sensors advertise for 10 minutes after power-on. To change Wi-Fi on a claimed device, send ‘setup’ through its USB console; registration is preserved.")
                .font(.caption2).foregroundStyle(.secondary)
        }
        .textFieldStyle(.roundedBorder)
        .onChange(of: bluetooth.isConnected) { _, isConnected in
            if !isConnected && connected && !complete && !busy {
                status = "Bluetooth disconnected. Connect sensor will reconnect before registration."
            }
        }
        .onDisappear { work?.cancel(); password = ""; registration = nil; bluetooth.disconnect() }
    }
    private func connect(_ device: SensorBluetooth.Nearby) async {
        busy = true; errorMessage = nil; registration = nil
        defer { busy = false }
        do {
            try await bluetooth.connect(device)
            selectedDevice = device
            selectedHardwareId = JSON.string(bluetooth.identity, "hardwareId")
            connected = true; profile = JSON.string(bluetooth.identity, "profile", fallback: "auto")
            status = "Connected by Bluetooth. Scanning Wi-Fi…"
            networks = try await bluetooth.scanNetworks()
            status = "Select Wi-Fi and connect. No addresses or setup codes to enter."
        } catch {
            connected = false; selectedDevice = nil; selectedHardwareId = ""
            errorMessage = error.localizedDescription
        }
    }
    private func ensureBluetoothConnection() async throws {
        guard let selectedDevice, !selectedHardwareId.isEmpty else {
            throw NSError(domain: "HomeBrain", code: 1, userInfo: [NSLocalizedDescriptionKey: "Find the sensor again to continue setup."])
        }
        if !bluetooth.isConnected {
            status = "Reconnecting to the sensor by Bluetooth…"
            do { try await bluetooth.connect(selectedDevice) }
            catch {
                if Task.isCancelled { throw error }
                throw NSError(domain: "HomeBrain", code: 1, userInfo: [NSLocalizedDescriptionKey: "Bluetooth connection was lost. Restart the sensor and tap Reconnect / rescan if it does not reconnect."])
            }
        }
        guard JSON.string(bluetooth.identity, "hardwareId") == selectedHardwareId else {
            bluetooth.disconnect()
            throw NSError(domain: "HomeBrain", code: 1, userInfo: [NSLocalizedDescriptionKey: "A different sensor connected. Find the intended sensor again."])
        }
    }
    private func configure() async {
        busy = true; errorMessage = nil
        defer { busy = false }
        do {
            try await ensureBluetoothConnection()
            status = "Preparing HomeBrain registration…"
            let result: [String: Any]
            if let registration { result = registration }
            else {
                result = JSON.object(try await session.apiClient.post("/api/sensor-nodes/onboard", body: [
                    "hardwareId": JSON.string(bluetooth.identity, "hardwareId"), "profile": profile, "name": name, "room": room
                ]))
                registration = result
            }
            let node = JSON.object(result["node"]), config = JSON.object(result["provisioning"])
            let nodeId = JSON.string(node, "id")
            if JSON.bool(result, "alreadyRegistered"), JSON.string(bluetooth.identity, "nodeId") != nodeId {
                throw NSError(domain: "HomeBrain", code: 1, userInfo: [NSLocalizedDescriptionKey: "This sensor was previously claimed. Recover its registration in Sensor Fleet before pairing again."])
            }
            try await ensureBluetoothConnection() // The link may have dropped during registration.
            let fields: [String: Any] = [
                "ssid": ssid, "password": password, "hubUrl": JSON.string(config, "hubUrl"),
                "nodeId": nodeId, "setupCode": JSON.string(config, "setupCode")
            ]
            do {
                try await sendConfiguration(fields)
            } catch {
                guard !bluetooth.isConnected else { throw error }
                status = "Bluetooth disconnected. Checking whether HomeBrain received setup…"
                let response = JSON.object(try await session.apiClient.get("/api/sensor-nodes/\(nodeId)"))
                if JSON.string(JSON.object(response["node"]), "status") != "online" {
                    try await ensureBluetoothConnection()
                    try await sendConfiguration(fields)
                }
            }
            password = ""; registration = nil; bluetooth.disconnect(); connected = false
            for _ in 0..<38 {
                try Task.checkCancellation()
                let response = JSON.object(try await session.apiClient.get("/api/sensor-nodes/\(nodeId)"))
                let active = JSON.object(response["node"])
                if JSON.string(active, "status") == "online", !JSON.string(active, "lastReadingAt").isEmpty,
                   JSON.string(active, "lastReadingAt") != JSON.string(node, "lastReadingAt") {
                    complete = true; status = "\(JSON.string(active, "name")) is online and reporting. Open Devices to view telemetry and module health."
                    return
                }
                try await Task.sleep(for: .seconds(2))
            }
            status = "Wi-Fi and HomeBrain are configured. The first sensor report is still pending; check Devices shortly."
        } catch { if !Task.isCancelled { errorMessage = error.localizedDescription } }
    }
    private func sendConfiguration(_ fields: [String: Any]) async throws {
        _ = try await bluetooth.command("configure", fields: fields) { state in
            status = state == "activating" ? "Wi-Fi connected. Verifying HomeBrain…" : state == "complete" ? "Connected. Waiting for the first report…" : "Connecting to Wi-Fi…"
        }
    }
}
