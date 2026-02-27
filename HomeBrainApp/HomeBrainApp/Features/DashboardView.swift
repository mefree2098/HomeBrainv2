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
    @State private var favoriteDeviceIds: Set<String> = []
    @State private var favoritesProfileId: String?
    @State private var pendingFavoriteDeviceIds: Set<String> = []
    @State private var thermostatTemperatureDrafts: [String: Double] = [:]
    @State private var pendingControlDeviceIds: Set<String> = []

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
        [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]
    }

    private var featuredDeviceColumns: [GridItem] {
        if isCompact {
            return [GridItem(.flexible(), spacing: 12)]
        }
        return [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]
    }

    private var featuredDevices: [DeviceItem] {
        devices
            .filter { favoriteDeviceIds.contains($0.id) }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
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
                                    icon: "play.fill",
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
                                        title: "No favorite devices yet",
                                        subtitle: favoritesProfileId == nil
                                            ? "Create or activate a user profile, then favorite devices to pin them to dashboard."
                                            : "Favorite your go-to devices from the Devices screen to pin them here."
                                    )
                                }
                            } else {
                                LazyVGrid(columns: featuredDeviceColumns, spacing: 12) {
                                    ForEach(featuredDevices) { device in
                                        featuredDeviceCard(device)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                            .gridCellColumns(featuredGridSpan(for: device))
                                    }
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
        return HBPanel {
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
        let isThermostat = device.type == "thermostat"
        let mode = thermostatMode(for: device)
        let statusText = isThermostat ? mode.uppercased() : (device.status ? "On" : "Off")
        let statusEnabled = isThermostat ? mode != "off" : device.status

        return HBPanel {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top) {
                    Image(systemName: iconForDevice(device.type))
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 34, height: 34)
                        .background(HBPalette.accentBlue.opacity(0.65), in: Circle())

                    Spacer()

                    HStack(spacing: 8) {
                        favoriteButton(for: device)

                        Text(statusText)
                            .font(.system(size: 13, weight: .bold, design: .rounded))
                            .foregroundStyle(statusEnabled ? Color.black.opacity(0.7) : HBPalette.textPrimary)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 4)
                            .background(statusEnabled ? Color.white.opacity(0.9) : Color.white.opacity(0.12), in: Capsule())
                    }
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

                if isThermostat {
                    featuredThermostatControls(for: device)
                } else {
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
                    .disabled(pendingControlDeviceIds.contains(device.id))

                    Text("Say: \"Hey Anna, \(device.status ? "turn off" : "turn on") \(device.name)\"")
                        .font(.system(size: 13, weight: .medium, design: .rounded))
                        .foregroundStyle(HBPalette.textSecondary)
                        .lineLimit(2)
                }
            }
        }
    }

    private func featuredGridSpan(for device: DeviceItem) -> Int {
        (!isCompact && device.type == "thermostat") ? 2 : 1
    }

    private func favoriteButton(for device: DeviceItem) -> some View {
        let isFavorite = favoriteDeviceIds.contains(device.id)
        let isPending = pendingFavoriteDeviceIds.contains(device.id)

        return Button {
            Task { await toggleDeviceFavorite(device) }
        } label: {
            if isPending {
                ProgressView()
                    .controlSize(.small)
                    .frame(width: 22, height: 22)
                    .padding(4)
            } else {
                Image(systemName: isFavorite ? "heart.fill" : "heart")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(isFavorite ? Color.red.opacity(0.95) : HBPalette.textSecondary)
                    .frame(width: 22, height: 22)
                    .padding(4)
                    .contentShape(Rectangle())
            }
        }
        .buttonStyle(.plain)
        .disabled(isPending)
        .accessibilityLabel(isFavorite ? "Remove \(device.name) from favorites" : "Add \(device.name) to favorites")
    }

    private func featuredThermostatControls(for device: DeviceItem) -> some View {
        let pending = pendingControlDeviceIds.contains(device.id)
        let mode = thermostatMode(for: device)
        let onMode = thermostatOnMode(for: device)
        let targetTemp = Int(currentThermostatSetpoint(for: device).rounded())
        let currentTemp = device.temperature.map { Int($0.rounded()) }
        let isOff = mode == "off"

        return VStack(alignment: .leading, spacing: 12) {
            Button {
                let nextMode = isOff ? onMode : "off"
                Task { await handleDeviceControl(deviceId: device.id, action: "set_mode", value: nextMode) }
            } label: {
                Label(isOff ? "Turn On" : "Turn Off", systemImage: isOff ? "power.circle.fill" : "power.circle")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(isOff ? Color.black.opacity(0.68) : Color.white.opacity(0.88))
            .foregroundStyle(isOff ? Color.white : Color.black.opacity(0.82))
            .disabled(pending)

            thermostatSetpointPanel(
                device: device,
                mode: mode,
                targetTemp: targetTemp,
                currentTemp: currentTemp,
                pending: pending
            )

            Text("Say: \"Hey Anna, set \(device.name) to \(targetTemp) degrees\"")
                .font(.system(size: 13, weight: .medium, design: .rounded))
                .foregroundStyle(HBPalette.textSecondary)
                .lineLimit(2)
        }
    }

    private func thermostatSetpointPanel(
        device: DeviceItem,
        mode: String,
        targetTemp: Int,
        currentTemp: Int?,
        pending: Bool
    ) -> some View {
        VStack(spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("SETPOINT")
                        .font(.system(size: 12, weight: .semibold, design: .rounded))
                        .tracking(1.2)
                        .foregroundStyle(HBPalette.textSecondary)
                    Text("\(targetTemp)°F")
                        .font(.system(size: 48, weight: .bold, design: .rounded))
                        .foregroundStyle(HBPalette.textPrimary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }

                Spacer(minLength: 12)

                VStack(alignment: .trailing, spacing: 2) {
                    Text("CURRENT")
                        .font(.system(size: 12, weight: .semibold, design: .rounded))
                        .tracking(1.2)
                        .foregroundStyle(HBPalette.textSecondary)
                    Text(currentTemp.map { "\($0)°F" } ?? "--")
                        .font(.system(size: 36, weight: .bold, design: .rounded))
                        .foregroundStyle(HBPalette.textPrimary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.85)
                }
            }

            Slider(
                value: Binding(
                    get: { currentThermostatSetpoint(for: device) },
                    set: { thermostatTemperatureDrafts[device.id] = clampThermostatTemperature($0) }
                ),
                in: 55...90,
                step: 1,
                onEditingChanged: { editing in
                    guard !editing else { return }
                    let next = Int(currentThermostatSetpoint(for: device).rounded())
                    Task { await handleDeviceControl(deviceId: device.id, action: "set_temperature", value: next) }
                }
            )
            .tint(Color.white.opacity(0.95))
            .disabled(pending)

            HStack(spacing: 8) {
                ForEach(["auto", "cool", "heat", "off"], id: \.self) { thermostatMode in
                    thermostatModeChip(
                        device: device,
                        mode: thermostatMode,
                        activeMode: mode,
                        pending: pending
                    )
                }
            }
        }
        .padding(12)
        .background(Color(red: 0.09, green: 0.15, blue: 0.37).opacity(0.66), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(HBPalette.accentBlue.opacity(0.5), lineWidth: 1)
        )
    }

    private func thermostatModeChip(
        device: DeviceItem,
        mode: String,
        activeMode: String,
        pending: Bool
    ) -> some View {
        let active = activeMode == mode

        return Button(mode.uppercased()) {
            Task { await handleDeviceControl(deviceId: device.id, action: "set_mode", value: mode) }
        }
        .buttonStyle(.plain)
        .font(.system(size: 14, weight: .bold, design: .rounded))
        .foregroundStyle(active ? Color.black.opacity(0.86) : HBPalette.textPrimary)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 11)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(active ? Color.white.opacity(0.9) : Color.black.opacity(0.62))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(active ? Color.clear : Color.white.opacity(0.14), lineWidth: 1)
        )
        .disabled(pending)
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
            async let profilesTask = session.apiClient.get("/api/profiles")

            let devicesResponse = try await devicesTask
            let scenesResponse = try await scenesTask
            let voiceResponse = try await voiceTask
            let securityResponse = try await securityTask
            let favoritesContext = (try? await profilesTask).map(FavoritesSupport.deviceContext(fromProfilesPayload:)) ?? .empty

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
            applyFavoriteContext(favoritesContext)
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    private func toggleDevice(_ device: DeviceItem) async {
        await handleDeviceControl(
            deviceId: device.id,
            action: device.status ? "turn_off" : "turn_on"
        )
    }

    private func handleDeviceControl(deviceId: String, action: String, value: Any? = nil) async {
        pendingControlDeviceIds.insert(deviceId)
        defer {
            pendingControlDeviceIds.remove(deviceId)
        }

        do {
            var payload: [String: Any] = [
                "deviceId": deviceId,
                "action": action
            ]
            if let value {
                payload["value"] = value
            }

            let response = try await session.apiClient.post("/api/devices/control", body: payload)
            let root = JSON.object(response)
            let data = JSON.object(root["data"])
            let updatedObject = JSON.object(data["device"])

            if !updatedObject.isEmpty {
                let updated = DeviceItem.from(updatedObject)
                upsertDevice(updated)
            } else {
                applyControlLocally(deviceId: deviceId, action: action, value: value)
            }

            if action == "set_temperature" {
                thermostatTemperatureDrafts.removeValue(forKey: deviceId)
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func applyControlLocally(deviceId: String, action: String, value: Any?) {
        guard let index = devices.firstIndex(where: { $0.id == deviceId }) else {
            return
        }

        var updated = devices[index]

        switch action {
        case "turn_on":
            updated.status = true

        case "turn_off":
            updated.status = false

        case "set_temperature":
            if let target = numberValue(from: value) {
                updated.targetTemperature = clampThermostatTemperature(target)
                updated.status = true
            }

        case "set_mode":
            if let mode = normalizeThermostatMode(value) {
                updated.status = mode != "off"
                updated.properties["hvacMode"] = mode
                updated.properties["smartThingsThermostatMode"] = mode
                if mode != "off" {
                    updated.properties["smartThingsLastActiveThermostatMode"] = mode
                }
            }

        default:
            break
        }

        devices[index] = updated
    }

    private func upsertDevice(_ updated: DeviceItem) {
        if let index = devices.firstIndex(where: { $0.id == updated.id }) {
            devices[index] = updated
        } else {
            devices.append(updated)
        }
        devices.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    private func numberValue(from value: Any?) -> Double? {
        if let value = value as? Double { return value }
        if let value = value as? Int { return Double(value) }
        if let value = value as? NSNumber { return value.doubleValue }
        if let value = value as? String, let parsed = Double(value) { return parsed }
        return nil
    }

    private func normalizeThermostatMode(_ value: Any?) -> String? {
        guard let value else { return nil }
        let raw = String(describing: value)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: " ", with: "")
            .replacingOccurrences(of: "_", with: "")
            .replacingOccurrences(of: "-", with: "")

        switch raw {
        case "auto":
            return "auto"
        case "cool":
            return "cool"
        case "heat", "auxheatonly", "emergencyheat":
            return "heat"
        case "off":
            return "off"
        default:
            return nil
        }
    }

    private func thermostatMode(for device: DeviceItem) -> String {
        let candidates: [Any?] = [
            device.properties["smartThingsThermostatMode"],
            device.properties["ecobeeHvacMode"],
            device.properties["hvacMode"]
        ]

        for candidate in candidates {
            if let normalized = normalizeThermostatMode(candidate) {
                return normalized
            }
        }

        return "auto"
    }

    private func thermostatOnMode(for device: DeviceItem) -> String {
        let mode = thermostatMode(for: device)
        if mode != "off" {
            return mode
        }

        if let fallback = normalizeThermostatMode(
            device.properties["smartThingsLastActiveThermostatMode"]
                ?? device.properties["ecobeeLastActiveHvacMode"]
        ) {
            return fallback
        }

        return "auto"
    }

    private func thermostatTargetTemperature(for device: DeviceItem) -> Int {
        if let target = device.targetTemperature {
            return Int(clampThermostatTemperature(target))
        }
        if let current = device.temperature {
            return Int(clampThermostatTemperature(current))
        }
        return 68
    }

    private func clampThermostatTemperature(_ value: Double) -> Double {
        let clamped = min(90, max(55, value))
        return clamped.rounded()
    }

    private func currentThermostatSetpoint(for device: DeviceItem) -> Double {
        if let draft = thermostatTemperatureDrafts[device.id] {
            return clampThermostatTemperature(draft)
        }
        return Double(thermostatTargetTemperature(for: device))
    }

    private func applyFavoriteContext(_ context: FavoriteDeviceContext) {
        favoritesProfileId = context.profileId
        favoriteDeviceIds = context.favoriteDeviceIds
    }

    private func applyFavoriteContext(
        fromToggleResponse response: Any,
        fallbackProfileId: String,
        toggledDeviceId: String,
        shouldFavorite: Bool
    ) {
        let root = JSON.object(response)
        let data = JSON.object(root["data"])
        let payloadProfile = JSON.object(data["profile"])
        let rootProfile = JSON.object(root["profile"])

        if !payloadProfile.isEmpty {
            let context = FavoritesSupport.deviceContext(fromProfileObject: payloadProfile)
            favoritesProfileId = context.profileId ?? fallbackProfileId
            favoriteDeviceIds = context.favoriteDeviceIds
            return
        }

        if !rootProfile.isEmpty {
            let context = FavoritesSupport.deviceContext(fromProfileObject: rootProfile)
            favoritesProfileId = context.profileId ?? fallbackProfileId
            favoriteDeviceIds = context.favoriteDeviceIds
            return
        }

        favoritesProfileId = fallbackProfileId
        if shouldFavorite {
            favoriteDeviceIds.insert(toggledDeviceId)
        } else {
            favoriteDeviceIds.remove(toggledDeviceId)
        }
    }

    private func toggleDeviceFavorite(_ device: DeviceItem) async {
        guard let profileId = favoritesProfileId, !profileId.isEmpty else {
            errorMessage = "Create or activate a user profile to manage favorite devices."
            return
        }

        if pendingFavoriteDeviceIds.contains(device.id) {
            return
        }

        let shouldFavorite = !favoriteDeviceIds.contains(device.id)
        pendingFavoriteDeviceIds.insert(device.id)

        defer {
            pendingFavoriteDeviceIds.remove(device.id)
        }

        do {
            if shouldFavorite {
                let response = try await session.apiClient.post(
                    "/api/profiles/\(profileId)/favorites/devices",
                    body: ["deviceId": device.id]
                )
                applyFavoriteContext(
                    fromToggleResponse: response,
                    fallbackProfileId: profileId,
                    toggledDeviceId: device.id,
                    shouldFavorite: shouldFavorite
                )
            } else {
                let response = try await session.apiClient.delete(
                    "/api/profiles/\(profileId)/favorites/devices/\(device.id)"
                )
                applyFavoriteContext(
                    fromToggleResponse: response,
                    fallbackProfileId: profileId,
                    toggledDeviceId: device.id,
                    shouldFavorite: shouldFavorite
                )
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
