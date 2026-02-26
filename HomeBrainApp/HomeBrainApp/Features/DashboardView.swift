import SwiftUI

struct DashboardView: View {
    @EnvironmentObject private var session: SessionStore

    @State private var isLoading = true
    @State private var errorMessage: String?

    @State private var devices: [DeviceItem] = []
    @State private var scenes: [SceneItem] = []
    @State private var voiceDevices: [VoiceDeviceItem] = []
    @State private var securityStatus = "Unknown"

    @State private var commandText = ""
    @State private var commandResponse = ""
    @State private var isSendingCommand = false

    private var onlineDevices: Int {
        devices.filter { $0.status }.count
    }

    private var onlineVoiceDevices: Int {
        voiceDevices.filter { $0.status == "online" }.count
    }

    var body: some View {
        Group {
            if isLoading {
                LoadingView(title: "Loading dashboard...")
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        if let errorMessage {
                            InlineErrorView(message: errorMessage) {
                                Task { await loadDashboard() }
                            }
                        }

                        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                            MetricCard(
                                title: "Devices Online",
                                value: "\(onlineDevices)/\(devices.count)",
                                subtitle: "Smart home devices",
                                tint: .blue
                            )
                            MetricCard(
                                title: "Voice Devices",
                                value: "\(onlineVoiceDevices)/\(voiceDevices.count)",
                                subtitle: "Room listeners",
                                tint: .green
                            )
                            MetricCard(
                                title: "Scenes",
                                value: "\(scenes.count)",
                                subtitle: "Saved presets",
                                tint: .purple
                            )
                            MetricCard(
                                title: "Security",
                                value: securityStatus,
                                subtitle: "Alarm state",
                                tint: .orange
                            )
                        }

                        GroupBox("Quick Device Controls") {
                            VStack(spacing: 10) {
                                if devices.isEmpty {
                                    EmptyStateView(title: "No devices", subtitle: "Add devices from the Devices section.")
                                } else {
                                    ForEach(Array(devices.prefix(6))) { device in
                                        HStack {
                                            VStack(alignment: .leading) {
                                                Text(device.name)
                                                    .font(.headline)
                                                Text("\(device.room) · \(device.type)")
                                                    .font(.caption)
                                                    .foregroundStyle(.secondary)
                                            }

                                            Spacer()

                                            Button(device.status ? "Turn Off" : "Turn On") {
                                                Task { await toggleDevice(device) }
                                            }
                                            .buttonStyle(.borderedProminent)
                                            .tint(device.status ? .red : .green)
                                        }
                                        .padding(.vertical, 2)
                                    }
                                }
                            }
                            .padding(.top, 4)
                        }

                        GroupBox("Quick Scene Activation") {
                            VStack(spacing: 10) {
                                if scenes.isEmpty {
                                    EmptyStateView(title: "No scenes", subtitle: "Create scenes in the Scenes section.")
                                } else {
                                    ForEach(Array(scenes.prefix(6))) { scene in
                                        HStack {
                                            VStack(alignment: .leading) {
                                                Text(scene.name)
                                                    .font(.headline)
                                                Text(scene.details)
                                                    .font(.caption)
                                                    .foregroundStyle(.secondary)
                                                    .lineLimit(1)
                                            }

                                            Spacer()

                                            Button("Activate") {
                                                Task { await activateScene(scene) }
                                            }
                                            .buttonStyle(.bordered)
                                        }
                                        .padding(.vertical, 2)
                                    }
                                }
                            }
                            .padding(.top, 4)
                        }

                        GroupBox("Voice Command") {
                            VStack(alignment: .leading, spacing: 10) {
                                TextField("Type a natural language command", text: $commandText)
                                    .textFieldStyle(.roundedBorder)

                                Button {
                                    Task { await sendVoiceCommand() }
                                } label: {
                                    if isSendingCommand {
                                        HStack {
                                            ProgressView()
                                            Text("Sending...")
                                        }
                                    } else {
                                        Text("Run Command")
                                    }
                                }
                                .buttonStyle(.borderedProminent)
                                .disabled(commandText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSendingCommand)

                                if !commandResponse.isEmpty {
                                    Text(commandResponse)
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                        .padding(.top, 4)
                                }
                            }
                            .padding(.top, 4)
                        }
                    }
                    .padding()
                }
                .refreshable {
                    await loadDashboard()
                }
            }
        }
        .task {
            await loadDashboard()
        }
    }

    private func loadDashboard() async {
        isLoading = true
        errorMessage = nil

        do {
            async let devicesTask = session.apiClient.get("/api/devices")
            async let scenesTask = session.apiClient.get("/api/scenes")
            async let voiceTask = session.apiClient.get("/api/voice/devices")
            async let securityTask = session.apiClient.get("/api/security-alarm/status")

            let devicesResponse = try await devicesTask
            let scenesResponse = try await scenesTask
            let voiceResponse = try await voiceTask
            let securityResponse = try await securityTask

            let devicesObject = JSON.object(devicesResponse)
            let devicesData = JSON.object(devicesObject["data"])
            let deviceList = JSON.array(devicesData["devices"]).map(DeviceItem.from)

            let sceneObject = JSON.object(scenesResponse)
            let sceneList = JSON.array(sceneObject["scenes"]).map(SceneItem.from)

            let voiceObject = JSON.object(voiceResponse)
            let voiceList = JSON.array(voiceObject["devices"]).map(VoiceDeviceItem.from)

            let securityObject = JSON.object(securityResponse)
            let statusObject = JSON.object(securityObject["status"])
            let alarmState = JSON.string(statusObject, "alarmState", fallback: "Unknown")

            devices = deviceList.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            scenes = sceneList.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            voiceDevices = voiceList.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            securityStatus = alarmState
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    private func toggleDevice(_ device: DeviceItem) async {
        do {
            let action = device.status ? "turn_off" : "turn_on"
            let payload: [String: Any] = [
                "deviceId": device.id,
                "action": action
            ]
            let response = try await session.apiClient.post("/api/devices/control", body: payload)
            let object = JSON.object(response)
            let data = JSON.object(object["data"])
            let updatedObject = JSON.object(data["device"])
            let updated = DeviceItem.from(updatedObject)

            if let index = devices.firstIndex(where: { $0.id == updated.id }) {
                devices[index] = updated
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func activateScene(_ scene: SceneItem) async {
        do {
            let payload: [String: Any] = ["sceneId": scene.id]
            _ = try await session.apiClient.post("/api/scenes/activate", body: payload)
            for index in scenes.indices {
                scenes[index].active = scenes[index].id == scene.id
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func sendVoiceCommand() async {
        let trimmed = commandText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        isSendingCommand = true
        defer { isSendingCommand = false }

        do {
            let payload: [String: Any] = [
                "commandText": trimmed,
                "wakeWord": "ios-app"
            ]
            let response = try await session.apiClient.post("/api/voice/commands/interpret", body: payload)
            let object = JSON.object(response)
            commandResponse = JSON.string(object, "responseText", fallback: JSON.string(object, "message", fallback: "Command processed."))
            commandText = ""
        } catch {
            commandResponse = "Error: \(error.localizedDescription)"
        }
    }
}
