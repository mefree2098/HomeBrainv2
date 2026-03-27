import SwiftUI

struct VoiceDevicesView: View {
    @EnvironmentObject private var session: SessionStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    @State private var voiceDevices: [VoiceDeviceItem] = []
    @State private var voiceStatus: [String: Any] = [:]
    @State private var updateStats: [String: Any] = [:]
    @State private var packageInfo: [String: Any] = [:]
    @State private var fleetSummary: [String: Any] = [:]

    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var infoMessage = ""

    @State private var commandText = ""
    @State private var commandResponse = ""
    @State private var ttsText = "HomeBrain test from iOS."

    @State private var showRegisterSheet = false
    @State private var registerName = ""
    @State private var registerRoom = ""
    @State private var registerType = "speaker"

    private let statusOptions = ["online", "offline", "error", "updating"]
    private let registerTypes = ["hub", "speaker", "display", "mobile", "microphone"]

    private var usesCompactLayout: Bool {
        horizontalSizeClass == .compact
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                if isLoading {
                    LoadingView(title: "Loading voice devices...")
                } else {
                    HBSectionHeader(
                        title: "Voice Devices",
                        subtitle: "Manage room listeners and fleet updates",
                        buttonTitle: "Register",
                        buttonIcon: "plus"
                    ) {
                        showRegisterSheet = true
                    }

                    if let errorMessage {
                        InlineErrorView(message: errorMessage) {
                            Task { await loadVoiceData() }
                        }
                    }

                    if !infoMessage.isEmpty {
                        HBPanel {
                            Text(infoMessage)
                                .font(.subheadline)
                                .foregroundStyle(HBPalette.textSecondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }

                    statusCards
                    voiceCommandPanel
                    remoteUpdatePanel

                    if voiceDevices.isEmpty {
                        EmptyStateView(title: "No voice devices", subtitle: "Register a remote listener from this page.")
                    } else {
                        ForEach(voiceDevices) { device in
                            HBCardRow {
                                deviceRow(device)
                            }
                        }
                    }
                }
            }
        }
        .scrollIndicators(.hidden)
        .groupBoxStyle(HBPanelGroupBoxStyle())
        .padding()
        .sheet(isPresented: $showRegisterSheet) {
            registerSheet
        }
        .refreshable {
            await loadVoiceData()
        }
        .task {
            await loadVoiceData()
        }
    }

    private var statusCards: some View {
        let total = JSON.int(voiceStatus, "totalDevices", fallback: voiceDevices.count)
        let active = JSON.int(voiceStatus, "activeDevices", fallback: voiceDevices.filter { $0.status == "online" }.count)
        let connected = JSON.bool(voiceStatus, "connected", fallback: active > 0)

        return LazyVGrid(
            columns: [GridItem(.adaptive(minimum: usesCompactLayout ? 110 : 150), spacing: 12, alignment: .leading)],
            alignment: .leading,
            spacing: 12
        ) {
            MetricCard(title: "Voice Devices", value: "\(active)/\(max(total, 1))", subtitle: "Online", tint: .green)
            MetricCard(title: "Transport", value: connected ? "Connected" : "Disconnected", subtitle: "Hub to listeners", tint: .orange)
            MetricCard(title: "Outdated", value: "\(JSON.int(updateStats, "outdated"))", subtitle: "Needs update", tint: .purple)
        }
    }

    private var voiceCommandPanel: some View {
        GroupBox("Voice Command Test") {
            VStack(alignment: .leading, spacing: 10) {
                TextField("Type a command", text: $commandText)
                    .textFieldStyle(.roundedBorder)

                Button("Send Command") {
                    Task { await sendVoiceCommand() }
                }
                .frame(maxWidth: usesCompactLayout ? .infinity : nil, alignment: .leading)
                .buttonStyle(HBPrimaryButtonStyle(compact: true))
                .disabled(commandText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                if !commandResponse.isEmpty {
                    Text(commandResponse)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.top, 4)
        }
    }

    private var remoteUpdatePanel: some View {
        GroupBox("Remote Fleet Updates") {
            VStack(alignment: .leading, spacing: 10) {
                Text("Current package: \(JSON.string(packageInfo, "version", fallback: "N/A"))")
                    .font(.subheadline)
                    .foregroundStyle(HBPalette.textPrimary)
                Text("Up-to-date: \(JSON.int(updateStats, "upToDate")) · Outdated: \(JSON.int(updateStats, "outdated"))")
                    .font(.caption)
                    .foregroundStyle(HBPalette.textSecondary)
                Text("Fleet latest: \(JSON.string(fleetSummary, "latestVersion", fallback: "Unknown"))")
                    .font(.caption)
                    .foregroundStyle(HBPalette.textSecondary)

                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: usesCompactLayout ? 128 : 156), spacing: 10, alignment: .leading)],
                    alignment: .leading,
                    spacing: 10
                ) {
                    Button("Generate Package") {
                        Task { await generatePackage() }
                    }
                    .frame(maxWidth: .infinity)
                    .buttonStyle(HBSecondaryButtonStyle(compact: true))

                    Button("Update Outdated") {
                        Task { await updateAllOutdatedDevices() }
                    }
                    .frame(maxWidth: .infinity)
                    .buttonStyle(HBPrimaryButtonStyle(compact: true))

                    Button("Refresh") {
                        Task { await loadVoiceData() }
                    }
                    .frame(maxWidth: .infinity)
                    .buttonStyle(HBSecondaryButtonStyle(compact: true))
                }
            }
            .padding(.top, 4)
        }
    }

    private func deviceRow(_ device: VoiceDeviceItem) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if usesCompactLayout {
                VStack(alignment: .leading, spacing: 10) {
                    deviceIdentity(device)
                    statusMenu(for: device)
                }
            } else {
                HStack(alignment: .top) {
                    deviceIdentity(device)

                    Spacer()

                    statusMenu(for: device)
                }
            }

            TextField("TTS text", text: $ttsText)
                .hbPanelTextField()

            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: usesCompactLayout ? 120 : 136), spacing: 10, alignment: .leading)],
                alignment: .leading,
                spacing: 10
            ) {
                Button("Test") {
                    Task { await testDevice(device) }
                }
                .frame(maxWidth: .infinity)
                .buttonStyle(HBSecondaryButtonStyle(compact: true))

                Button("Push Config") {
                    Task { await pushConfig(device) }
                }
                .frame(maxWidth: .infinity)
                .buttonStyle(HBSecondaryButtonStyle(compact: true))

                Button("Ping TTS") {
                    Task { await pingTTS(device) }
                }
                .frame(maxWidth: .infinity)
                .buttonStyle(HBSecondaryButtonStyle(compact: true))
            }
        }
    }

    private func deviceIdentity(_ device: VoiceDeviceItem) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(device.name)
                .font(.system(size: 20, weight: .bold, design: .rounded))
                .foregroundStyle(HBPalette.textPrimary)
            Text("\(device.room) · \(device.deviceType)")
                .font(.caption)
                .foregroundStyle(HBPalette.textSecondary)
            Text("Firmware: \(device.firmwareVersion)")
                .font(.caption2)
                .foregroundStyle(HBPalette.textSecondary)
        }
    }

    private func statusMenu(for device: VoiceDeviceItem) -> some View {
        Menu {
            ForEach(statusOptions, id: \.self) { option in
                Button(option.capitalized) {
                    Task { await updateStatus(device, status: option) }
                }
            }
        } label: {
            Text(device.status.capitalized)
                .font(.caption)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Color.secondary.opacity(0.15))
                .clipShape(Capsule())
        }
    }

    private var registerSheet: some View {
        NavigationStack {
            Form {
                TextField("Device name", text: $registerName)
                TextField("Room", text: $registerRoom)

                Picker("Device type", selection: $registerType) {
                    ForEach(registerTypes, id: \.self) { type in
                        Text(type.capitalized).tag(type)
                    }
                }
            }
            .hbFormStyle()
            .navigationTitle("Register Voice Device")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { showRegisterSheet = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Register") {
                        Task { await registerDevice() }
                    }
                    .disabled(registerName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || registerRoom.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private func loadVoiceData() async {
        isLoading = true
        errorMessage = nil

        do {
            async let statusTask = session.apiClient.get("/api/voice/status")
            async let devicesTask = session.apiClient.get("/api/voice/devices")

            let statusResponse = try await statusTask
            let devicesResponse = try await devicesTask

            voiceStatus = JSON.object(statusResponse)
            let devicesObject = JSON.object(devicesResponse)
            voiceDevices = JSON.array(devicesObject["devices"]).map(VoiceDeviceItem.from)
                .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }

            if let statsResponse = try? await session.apiClient.get("/api/remote-updates/statistics") {
                updateStats = JSON.object(statsResponse)
            }

            if let packageResponse = try? await session.apiClient.get("/api/remote-updates/package-info") {
                packageInfo = JSON.object(packageResponse)
            }

            if let fleetResponse = try? await session.apiClient.get("/api/remote-updates/fleet-status") {
                fleetSummary = JSON.object(fleetResponse)
            }
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    private func sendVoiceCommand() async {
        do {
            let payload: [String: Any] = [
                "commandText": commandText,
                "wakeWord": "ios"
            ]
            let response = try await session.apiClient.post("/api/voice/commands/interpret", body: payload)
            let object = JSON.object(response)
            commandResponse = JSON.string(object, "responseText", fallback: JSON.string(object, "message", fallback: "Command sent."))
            commandText = ""
        } catch {
            commandResponse = "Error: \(error.localizedDescription)"
        }
    }

    private func testDevice(_ device: VoiceDeviceItem) async {
        do {
            let response = try await session.apiClient.post("/api/voice/test", body: ["deviceId": device.id])
            let object = JSON.object(response)
            infoMessage = JSON.string(object, "message", fallback: "Test completed for \(device.name).")
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func updateStatus(_ device: VoiceDeviceItem, status: String) async {
        do {
            let payload: [String: Any] = ["status": status]
            let response = try await session.apiClient.put("/api/voice/devices/\(device.id)/status", body: payload)
            let object = JSON.object(response)
            let updated = VoiceDeviceItem.from(JSON.object(object["device"]))
            if let index = voiceDevices.firstIndex(where: { $0.id == updated.id }) {
                voiceDevices[index] = updated
            }
            infoMessage = "Updated \(device.name) to \(status)."
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func pushConfig(_ device: VoiceDeviceItem) async {
        do {
            let response = try await session.apiClient.post("/api/voice/devices/\(device.id)/push-config", body: [:])
            let object = JSON.object(response)
            infoMessage = JSON.string(object, "message", fallback: "Config pushed to \(device.name).")
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func pingTTS(_ device: VoiceDeviceItem) async {
        do {
            let response = try await session.apiClient.post("/api/voice/devices/\(device.id)/ping-tts", body: ["text": ttsText])
            let object = JSON.object(response)
            infoMessage = JSON.string(object, "message", fallback: "TTS ping sent to \(device.name).")
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func registerDevice() async {
        do {
            let payload: [String: Any] = [
                "name": registerName,
                "room": registerRoom,
                "deviceType": registerType
            ]
            let response = try await session.apiClient.post("/api/remote-devices/register", body: payload)
            let object = JSON.object(response)
            let message = JSON.string(object, "message", fallback: "Device registered.")
            infoMessage = message

            registerName = ""
            registerRoom = ""
            registerType = "speaker"
            showRegisterSheet = false

            await loadVoiceData()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func generatePackage() async {
        do {
            let response = try await session.apiClient.post("/api/remote-updates/generate-package", body: ["force": false])
            let object = JSON.object(response)
            infoMessage = JSON.string(object, "message", fallback: "Update package generated.")
            await loadVoiceData()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func updateAllOutdatedDevices() async {
        do {
            let payload: [String: Any] = ["onlyOutdated": true, "force": false]
            let response = try await session.apiClient.post("/api/remote-updates/initiate-all", body: payload)
            let object = JSON.object(response)
            infoMessage = JSON.string(object, "message", fallback: "Update request sent to fleet.")
            await loadVoiceData()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
