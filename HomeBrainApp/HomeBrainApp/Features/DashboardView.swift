import SwiftUI

struct DashboardView: View {
    @EnvironmentObject private var session: SessionStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    @State private var isLoading = true
    @State private var errorMessage: String?

    @State private var devices: [DeviceItem] = []
    @State private var scenes: [SceneItem] = []
    @State private var voiceDevices: [VoiceDeviceItem] = []
    @State private var securityStatus = "Unknown"
    @State private var securityZonesTotal = 0
    @State private var securityZonesActive = 0
    @State private var systemStatus = "Online"

    @State private var commandText = ""
    @State private var commandResponse = ""
    @State private var isSendingCommand = false

    private var isCompact: Bool { horizontalSizeClass == .compact }

    private var onlineDevices: Int {
        devices.filter { $0.status }.count
    }

    private var onlineVoiceDevices: Int {
        voiceDevices.filter { $0.status == "online" }.count
    }

    private var metricColumns: [GridItem] {
        [GridItem(.adaptive(minimum: isCompact ? 170 : 190), spacing: 12)]
    }

    private var featuredDevices: [DeviceItem] {
        Array(devices.prefix(isCompact ? 6 : 10))
    }

    private var quickScenes: [SceneItem] {
        Array(scenes.prefix(isCompact ? 3 : 5))
    }

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [HBPalette.pageTop.opacity(0.42), HBPalette.pageMid.opacity(0.34), HBPalette.pageBottom.opacity(0.38)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )

            Group {
                if isLoading {
                    LoadingView(title: "Loading dashboard...")
                        .padding()
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 16) {
                            if let errorMessage {
                                InlineErrorView(message: errorMessage) {
                                    Task { await loadDashboard() }
                                }
                            }

                            dashboardHeader

                            LazyVGrid(columns: metricColumns, spacing: 12) {
                                metricCard(
                                    title: "Active Devices",
                                    value: "\(onlineDevices)/\(devices.count)",
                                    subtitle: "Smart devices online",
                                    icon: "lightbulb.max",
                                    colors: [Color(red: 0.08, green: 0.14, blue: 0.36), Color(red: 0.05, green: 0.10, blue: 0.29)],
                                    accent: HBPalette.accentBlue
                                )
                                metricCard(
                                    title: "Voice Devices",
                                    value: "\(onlineVoiceDevices)/\(voiceDevices.count)",
                                    subtitle: "Voice hubs connected",
                                    icon: "mic",
                                    colors: [Color(red: 0.03, green: 0.25, blue: 0.16), Color(red: 0.02, green: 0.17, blue: 0.11)],
                                    accent: HBPalette.accentGreen
                                )
                                metricCard(
                                    title: "Scenes",
                                    value: "\(scenes.count)",
                                    subtitle: "Available scenes",
                                    icon: "play.triangle",
                                    colors: [Color(red: 0.20, green: 0.08, blue: 0.33), Color(red: 0.14, green: 0.06, blue: 0.25)],
                                    accent: Color(red: 0.73, green: 0.55, blue: 1.0)
                                )
                                metricCard(
                                    title: "System Status",
                                    value: systemStatus,
                                    subtitle: "All systems operational",
                                    icon: "waveform.path.ecg",
                                    colors: [Color(red: 0.31, green: 0.12, blue: 0.06), Color(red: 0.22, green: 0.08, blue: 0.04)],
                                    accent: HBPalette.accentOrange
                                )
                            }

                            if isCompact {
                                VStack(spacing: 12) {
                                    securityPanel
                                    quickScenePanel
                                }
                            } else {
                                HStack(alignment: .top, spacing: 12) {
                                    securityPanel
                                    quickScenePanel
                                }
                            }

                            if featuredDevices.isEmpty {
                                HBPanel {
                                    EmptyStateView(
                                        title: "No devices yet",
                                        subtitle: "Add devices in the Devices section to control them from the dashboard."
                                    )
                                }
                            } else {
                                ScrollView(.horizontal, showsIndicators: false) {
                                    HStack(spacing: 12) {
                                        ForEach(featuredDevices) { device in
                                            featuredDeviceCard(device)
                                        }
                                    }
                                    .padding(.vertical, 2)
                                }
                            }

                            voiceCommandPanel
                        }
                        .padding(.bottom, 10)
                    }
                    .scrollIndicators(.hidden)
                    .refreshable {
                        await loadDashboard()
                    }
                }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color.white.opacity(0.1), lineWidth: 1)
        )
        .task {
            await loadDashboard()
        }
    }

    private var dashboardHeader: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Welcome Home")
                    .font(.system(size: isCompact ? 38 : 48, weight: .bold, design: .rounded))
                    .foregroundStyle(
                        LinearGradient(
                            colors: [HBPalette.accentBlue, HBPalette.accentPurple],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                Text("Control your smart home with voice commands or touch")
                    .font(.system(size: 19, weight: .medium, design: .rounded))
                    .foregroundStyle(HBPalette.textSecondary)
            }

            Spacer(minLength: 0)

            Button {
                selectionHaptic()
            } label: {
                Label("Voice Commands", systemImage: "message")
                    .font(.system(size: 17, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(
                        LinearGradient(
                            colors: [HBPalette.accentGreen, HBPalette.accentBlue],
                            startPoint: .leading,
                            endPoint: .trailing
                        ),
                        in: RoundedRectangle(cornerRadius: 9, style: .continuous)
                    )
            }
            .buttonStyle(.plain)
        }
    }

    private func metricCard(
        title: String,
        value: String,
        subtitle: String,
        icon: String,
        colors: [Color],
        accent: Color
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title)
                    .font(.system(size: 16, weight: .semibold, design: .rounded))
                    .foregroundStyle(HBPalette.textPrimary)
                Spacer()
                Image(systemName: icon)
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(accent)
            }
            Text(value)
                .font(.system(size: 38, weight: .bold, design: .rounded))
                .foregroundStyle(accent)
                .lineLimit(1)
                .minimumScaleFactor(0.65)
            Text(subtitle)
                .font(.system(size: 15, weight: .medium, design: .rounded))
                .foregroundStyle(HBPalette.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(LinearGradient(colors: colors, startPoint: .topLeading, endPoint: .bottomTrailing))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(accent.opacity(0.55), lineWidth: 1)
        )
    }

    private var securityPanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Label("Security Alarm", systemImage: "shield")
                        .font(.system(size: 22, weight: .bold, design: .rounded))
                        .foregroundStyle(HBPalette.textPrimary)

                    Spacer()

                    Text(securityStatus.capitalized)
                        .font(.system(size: 15, weight: .bold, design: .rounded))
                        .foregroundStyle(Color.black.opacity(0.7))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(Color.white.opacity(0.85), in: Capsule())
                }

                HStack {
                    Text("Zones:")
                        .foregroundStyle(HBPalette.textSecondary)
                    Spacer()
                    Text("\(securityZonesActive)/\(securityZonesTotal) active")
                        .foregroundStyle(HBPalette.textPrimary)
                        .fontWeight(.semibold)
                }
                .font(.system(size: 16, weight: .medium, design: .rounded))

                HStack {
                    Text("Status:")
                        .foregroundStyle(HBPalette.textSecondary)
                    Spacer()
                    Text(systemStatus)
                        .foregroundStyle(HBPalette.accentGreen)
                        .fontWeight(.semibold)
                }
                .font(.system(size: 16, weight: .medium, design: .rounded))

                HStack(spacing: 10) {
                    Button {
                        Task { await armSecurity(stay: true) }
                    } label: {
                        Label("Arm Stay", systemImage: "house")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.black.opacity(0.65))

                    Button {
                        Task { await armSecurity(stay: false) }
                    } label: {
                        Label("Arm Away", systemImage: "car")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.black.opacity(0.65))
                }

                Button("Sync with SmartThings") {
                    Task { await syncSecurity() }
                }
                .buttonStyle(.plain)
                .font(.system(size: 14, weight: .semibold, design: .rounded))
                .foregroundStyle(HBPalette.textSecondary)
                .frame(maxWidth: .infinity)
                .padding(.top, 2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    private var quickScenePanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 12) {
                Label("Quick Scene Actions", systemImage: "play")
                    .font(.system(size: 22, weight: .bold, design: .rounded))
                    .foregroundStyle(HBPalette.textPrimary)

                if quickScenes.isEmpty {
                    VStack(spacing: 8) {
                        Image(systemName: "heart")
                            .foregroundStyle(HBPalette.textSecondary)
                        Text("No favorite scenes yet. Use the list below to pin your most-used automations.")
                            .font(.system(size: 15, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textSecondary)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 24)
                    .background(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .stroke(Color.white.opacity(0.18), style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                    )
                } else {
                    ForEach(quickScenes) { scene in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(scene.name)
                                    .font(.system(size: 18, weight: .semibold, design: .rounded))
                                    .foregroundStyle(HBPalette.textPrimary)
                                Text(scene.details)
                                    .font(.system(size: 14, weight: .medium, design: .rounded))
                                    .foregroundStyle(HBPalette.textSecondary)
                                    .lineLimit(1)
                            }

                            Spacer()

                            Button("Activate") {
                                Task { await activateScene(scene) }
                            }
                            .buttonStyle(.bordered)
                            .tint(HBPalette.accentBlue)
                        }
                        .padding(.vertical, 2)
                    }
                }

                Text("Say: \"Hey Anna, activate [scene name]\" to control with voice")
                    .font(.system(size: 14, weight: .medium, design: .rounded))
                    .foregroundStyle(HBPalette.textSecondary)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    private func featuredDeviceCard(_ device: DeviceItem) -> some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top) {
                    Image(systemName: iconForDevice(device.type))
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 34, height: 34)
                        .background(HBPalette.accentBlue.opacity(0.65), in: Circle())

                    Spacer()

                    Text(device.status ? "On" : "Off")
                        .font(.system(size: 13, weight: .bold, design: .rounded))
                        .foregroundStyle(device.status ? Color.black.opacity(0.7) : HBPalette.textPrimary)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(device.status ? Color.white.opacity(0.9) : Color.white.opacity(0.12), in: Capsule())
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text(device.name)
                        .font(.system(size: 22, weight: .bold, design: .rounded))
                        .foregroundStyle(HBPalette.textPrimary)
                        .lineLimit(2)
                    Text(device.room)
                        .font(.system(size: 15, weight: .medium, design: .rounded))
                        .foregroundStyle(HBPalette.textSecondary)
                }

                if let temperature = device.temperature {
                    HStack {
                        Text("Temperature")
                            .font(.system(size: 13, weight: .semibold, design: .rounded))
                            .foregroundStyle(HBPalette.textSecondary)
                        Spacer()
                        Text("\(Int(temperature))°F")
                            .font(.system(size: 18, weight: .bold, design: .rounded))
                            .foregroundStyle(HBPalette.textPrimary)
                    }
                }

                Button(device.status ? "Turn Off" : "Turn On") {
                    Task { await toggleDevice(device) }
                }
                .buttonStyle(.borderedProminent)
                .tint(device.status ? Color.red.opacity(0.9) : HBPalette.accentBlue)
                .frame(maxWidth: .infinity)

                Text("Say: \"Hey Anna, \(device.status ? "turn off" : "turn on") \(device.name)\"")
                    .font(.system(size: 13, weight: .medium, design: .rounded))
                    .foregroundStyle(HBPalette.textSecondary)
                    .lineLimit(2)
            }
        }
        .frame(width: isCompact ? 260 : 300)
    }

    private var voiceCommandPanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 12) {
                Label("Voice Command", systemImage: "waveform")
                    .font(.system(size: 22, weight: .bold, design: .rounded))
                    .foregroundStyle(HBPalette.textPrimary)

                TextField("Type a natural language command", text: $commandText)
                    .textFieldStyle(.plain)
                    .font(.system(size: 17, weight: .medium, design: .rounded))
                    .foregroundStyle(HBPalette.textPrimary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 12)
                    .background(Color.black.opacity(0.35), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .stroke(Color.white.opacity(0.16), lineWidth: 1)
                    )

                HStack(spacing: 10) {
                    Button {
                        Task { await sendVoiceCommand() }
                    } label: {
                        if isSendingCommand {
                            HStack(spacing: 8) {
                                ProgressView()
                                    .tint(.white)
                                Text("Sending...")
                            }
                            .frame(maxWidth: .infinity)
                        } else {
                            Text("Run Command")
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(HBPalette.accentGreen)
                    .disabled(commandText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSendingCommand)

                    Button("Refresh") {
                        Task { await loadDashboard() }
                    }
                    .buttonStyle(.bordered)
                    .tint(HBPalette.accentBlue)
                }

                if !commandResponse.isEmpty {
                    Text(commandResponse)
                        .font(.system(size: 15, weight: .medium, design: .rounded))
                        .foregroundStyle(HBPalette.textSecondary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.black.opacity(0.28), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
            }
        }
    }

    private func iconForDevice(_ type: String) -> String {
        switch type.lowercased() {
        case "light":
            return "lightbulb"
        case "thermostat":
            return "thermometer"
        case "lock":
            return "lock"
        case "garage":
            return "door.garage.closed"
        case "camera":
            return "camera"
        case "sensor":
            return "sensor.tag.radiowaves.forward"
        default:
            return "switch.2"
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
            let zoneObjects = JSON.array(statusObject["zones"]).map { JSON.object($0) }
            let activeZones = zoneObjects.filter { JSON.bool($0, "active") }.count
            let totalZones = zoneObjects.count

            devices = deviceList.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            scenes = sceneList.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            voiceDevices = voiceList.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            securityStatus = alarmState
            securityZonesActive = activeZones
            securityZonesTotal = totalZones
            systemStatus = alarmState.lowercased() == "error" ? "Degraded" : "Online"
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

    private func armSecurity(stay: Bool) async {
        do {
            let endpoint = stay ? "/api/security-alarm/sthm/arm-stay" : "/api/security-alarm/sthm/arm-away"
            _ = try await session.apiClient.post(endpoint, body: [:])
            await loadDashboard()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func syncSecurity() async {
        do {
            _ = try await session.apiClient.post("/api/security-alarm/sync-state", body: [:])
            await loadDashboard()
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
            commandResponse = JSON.string(
                object,
                "responseText",
                fallback: JSON.string(object, "message", fallback: "Command processed.")
            )
            commandText = ""
        } catch {
            commandResponse = "Error: \(error.localizedDescription)"
        }
    }

    private func selectionHaptic() {
        #if os(iOS)
        let generator = UIImpactFeedbackGenerator(style: .light)
        generator.impactOccurred()
        #endif
    }
}
