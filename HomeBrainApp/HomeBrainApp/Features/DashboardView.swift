import SwiftUI

struct DashboardView: View {
    let previewMode: Bool

    @EnvironmentObject private var session: SessionStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass

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
    @State private var contentWidth: CGFloat = UIScreen.main.bounds.width

    private var isCompact: Bool { horizontalSizeClass == .compact }
    private var isCompactHeight: Bool { verticalSizeClass == .compact }
    private var useLandscapeCompactLayout: Bool { isCompact && isCompactHeight }
    private var usesHeroSplitLayout: Bool { useLandscapeCompactLayout || contentWidth >= 860 }
    private var supportsTwoColumnCards: Bool { useLandscapeCompactLayout || contentWidth >= 820 }

    private var onlineDevices: Int {
        devices.filter { $0.status }.count
    }

    private var onlineVoiceDevices: Int {
        voiceDevices.filter { $0.status == "online" }.count
    }

    private var metricColumns: [GridItem] {
        if useLandscapeCompactLayout {
            return Array(repeating: GridItem(.flexible(), spacing: 10), count: 4)
        }
        if contentWidth >= 1060 {
            return Array(repeating: GridItem(.flexible(), spacing: 12), count: 4)
        }
        if contentWidth >= 620 {
            return [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]
        }
        return [GridItem(.flexible(), spacing: 12)]
    }

    private var featuredHalfColumns: [GridItem] {
        if contentWidth >= 720 {
            return [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]
        }
        return [GridItem(.flexible(), spacing: 12)]
    }

    private var commandSuggestionColumns: [GridItem] {
        if contentWidth >= 720 {
            return [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]
        }
        return [GridItem(.flexible(), spacing: 8)]
    }

    private var featuredDevices: [DeviceItem] {
        devices
            .filter { favoriteDeviceIds.contains($0.id) }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    private var featuredFullWidthDevices: [DeviceItem] {
        featuredDevices.filter { $0.type == "thermostat" }
    }

    private var featuredHalfWidthDevices: [DeviceItem] {
        featuredDevices.filter { $0.type != "thermostat" }
    }

    private var quickScenes: [SceneItem] {
        Array(scenes.prefix(useLandscapeCompactLayout ? 4 : (isCompact ? 3 : 5)))
    }

    private var commandSuggestions: [String] {
        [
            "Turn on the patio lights at sunset",
            "Set the upstairs thermostat to 70",
            "Run movie night in the living room",
            "Create a bedtime shutdown workflow"
        ]
    }

    private var heroBadgeTexts: [String] {
        var badges = [
            "\(scenes.count) scenes ready",
            "\(onlineVoiceDevices) voice hubs online"
        ]

        if favoritesProfileId != nil {
            badges.append("Favorites tuned")
        }

        return badges
    }

    init(previewMode: Bool = false) {
        self.previewMode = previewMode
    }

    var body: some View {
        GeometryReader { proxy in
            Group {
                if isLoading {
                    LoadingView(title: "Loading dashboard...")
                        .padding(useLandscapeCompactLayout ? 10 : 16)
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: useLandscapeCompactLayout ? 12 : 16) {
                            if let errorMessage {
                                InlineErrorView(message: errorMessage) {
                                    Task { await loadDashboard() }
                                }
                            }

                            dashboardHeader

                            LazyVGrid(columns: metricColumns, spacing: 12) {
                                metricCard(
                                    title: "Live Devices",
                                    value: "\(onlineDevices)/\(devices.count)",
                                    subtitle: "Realtime endpoints responding",
                                    icon: "lightbulb.max",
                                    colors: [HBPalette.accentBlue.opacity(0.24), HBPalette.accentPurple.opacity(0.14)],
                                    accent: HBPalette.accentBlue
                                )
                                metricCard(
                                    title: "Voice Mesh",
                                    value: "\(onlineVoiceDevices)/\(voiceDevices.count)",
                                    subtitle: "Wake hubs currently connected",
                                    icon: "mic",
                                    colors: [HBPalette.accentGreen.opacity(0.22), HBPalette.accentBlue.opacity(0.12)],
                                    accent: HBPalette.accentGreen
                                )
                                metricCard(
                                    title: "Scene Library",
                                    value: "\(scenes.count)",
                                    subtitle: "Pinned atmospheres available",
                                    icon: "play.fill",
                                    colors: [HBPalette.accentPurple.opacity(0.24), HBPalette.panelSoft.opacity(0.18)],
                                    accent: HBPalette.accentPurple
                                )
                                metricCard(
                                    title: "Automation Signal",
                                    value: systemStatus,
                                    subtitle: "Residence mesh health",
                                    icon: "waveform.path.ecg",
                                    colors: [HBPalette.accentOrange.opacity(0.22), HBPalette.panelSoft.opacity(0.16)],
                                    accent: HBPalette.accentOrange
                                )
                            }

                            if supportsTwoColumnCards {
                                HStack(alignment: .top, spacing: 12) {
                                    securityPanel
                                    quickScenePanel
                                }
                            } else {
                                VStack(spacing: 12) {
                                    securityPanel
                                    quickScenePanel
                                }
                            }

                            VStack(alignment: .leading, spacing: 12) {
                                HBSectionHeader(
                                    title: "Favorite Devices",
                                    subtitle: favoritesProfileId == nil
                                        ? "Activate a user profile to pin favorite controls."
                                        : "Profile-tuned shortcuts for your most-used devices.",
                                    eyebrow: "Priority Controls"
                                )

                                if featuredDevices.isEmpty {
                                    EmptyStateView(
                                        title: "No favorite devices yet",
                                        subtitle: favoritesProfileId == nil
                                            ? "Create or activate a user profile, then favorite devices to pin them here."
                                            : "Favorite your go-to devices from the Devices screen to pin them here."
                                    )
                                } else {
                                    VStack(alignment: .leading, spacing: 12) {
                                        ForEach(featuredFullWidthDevices) { device in
                                            featuredDeviceCard(device)
                                                .frame(maxWidth: .infinity, alignment: .leading)
                                        }

                                        if !featuredHalfWidthDevices.isEmpty {
                                            LazyVGrid(columns: featuredHalfColumns, spacing: 12) {
                                                ForEach(featuredHalfWidthDevices) { device in
                                                    featuredDeviceCard(device)
                                                        .frame(maxWidth: .infinity, alignment: .leading)
                                                }
                                            }
                                        }
                                    }
                                }
                            }

                            voiceCommandPanel
                        }
                        .padding(useLandscapeCompactLayout ? 10 : 16)
                        .padding(.bottom, 12)
                    }
                    .scrollIndicators(.hidden)
                    .refreshable {
                        await loadDashboard()
                    }
                }
            }
            .onAppear {
                contentWidth = proxy.size.width
            }
            .onChange(of: proxy.size.width) { _, newWidth in
                contentWidth = newWidth
            }
        }
        .task {
            await loadDashboard()
        }
    }

    private var dashboardHeader: some View {
        HBPanel {
            Group {
                if usesHeroSplitLayout {
                    HStack(alignment: .top, spacing: 18) {
                        dashboardHeroCopy
                        dashboardHeroCommandSurface
                            .frame(maxWidth: 360, alignment: .trailing)
                    }
                } else {
                    VStack(alignment: .leading, spacing: 16) {
                        dashboardHeroCopy
                        dashboardHeroCommandSurface
                    }
                }
            }
        }
    }

    private var dashboardHeroCopy: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Residence Control Nexus")
                .font(.system(size: 11, weight: .bold, design: .rounded))
                .textCase(.uppercase)
                .tracking(3.0)
                .foregroundStyle(HBPalette.textMuted)

            Text("Welcome home. Every room, routine, and wake-word path is online.")
                .font(
                    .system(
                        size: useLandscapeCompactLayout ? 28 : (contentWidth < 760 ? 38 : (contentWidth < 960 ? 42 : 48)),
                        weight: .bold,
                        design: .rounded
                    )
                )
                .foregroundStyle(
                    LinearGradient(
                        colors: [HBPalette.accentBlue, HBPalette.accentPurple, HBPalette.textPrimary],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                )

            Text("Control the home as one responsive system with cinematic visibility across devices, scenes, voice hubs, and automations.")
                .font(.system(size: useLandscapeCompactLayout ? 14 : 18, weight: .medium, design: .rounded))
                .foregroundStyle(HBPalette.textSecondary)

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    ForEach(heroBadgeTexts, id: \.self) { badge in
                        HBBadge(text: badge)
                    }
                }

                VStack(alignment: .leading, spacing: 8) {
                    ForEach(heroBadgeTexts, id: \.self) { badge in
                        HBBadge(text: badge)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var dashboardHeroCommandSurface: some View {
        HBCardRow {
            VStack(alignment: .leading, spacing: 12) {
                Text("Natural Language Interface")
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .textCase(.uppercase)
                    .tracking(2.6)
                    .foregroundStyle(HBPalette.textMuted)

                Text("Speak the next move")
                    .font(.system(size: useLandscapeCompactLayout ? 22 : (contentWidth < 760 ? 24 : 28), weight: .bold, design: .rounded))
                    .foregroundStyle(HBPalette.textPrimary)

                Text("Trigger a scene, dim a room, or compose a workflow from a single command surface.")
                    .font(.system(size: 15, weight: .medium, design: .rounded))
                    .foregroundStyle(HBPalette.textSecondary)

                LazyVGrid(columns: commandSuggestionColumns, spacing: 8) {
                    ForEach(commandSuggestions, id: \.self) { suggestion in
                        Text(suggestion)
                            .font(.system(size: 13, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textSecondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 10)
                            .background(HBGlassBackground(cornerRadius: 16, variant: .panelSoft))
                    }
                }

                Button {
                    selectionHaptic()
                } label: {
                    Label("Open Voice Console", systemImage: "waveform")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(HBPrimaryButtonStyle())
            }
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
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(title)
                        .font(.system(size: 11, weight: .bold, design: .rounded))
                        .textCase(.uppercase)
                        .tracking(2.2)
                        .foregroundStyle(HBPalette.textMuted)

                    Text(value)
                        .font(.system(size: useLandscapeCompactLayout ? 28 : 34, weight: .bold, design: .rounded))
                        .foregroundStyle(HBPalette.textPrimary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.65)
                }

                Spacer(minLength: 10)

                Image(systemName: icon)
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(accent)
                    .frame(width: 38, height: 38)
                    .background(HBGlassBackground(cornerRadius: 14, variant: .panelSoft))
            }

            Text(subtitle)
                .font(.system(size: useLandscapeCompactLayout ? 13 : 15, weight: .medium, design: .rounded))
                .foregroundStyle(HBPalette.textSecondary)

            Capsule()
                .fill(
                    LinearGradient(
                        colors: [accent, accent.opacity(0.18)],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                )
                .frame(width: 52, height: 4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .background {
            ZStack {
                HBGlassBackground(cornerRadius: 22, variant: .panelSoft)
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(LinearGradient(colors: colors, startPoint: .topLeading, endPoint: .bottomTrailing))
                    .opacity(0.92)
            }
        }
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(accent.opacity(0.32), lineWidth: 1)
        )
    }

    private var securityPanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Security Envelope")
                            .font(.system(size: 11, weight: .bold, design: .rounded))
                            .textCase(.uppercase)
                            .tracking(2.6)
                            .foregroundStyle(HBPalette.textMuted)

                        Label("Security Alarm", systemImage: "shield")
                            .font(.system(size: useLandscapeCompactLayout ? 18 : 22, weight: .bold, design: .rounded))
                            .foregroundStyle(HBPalette.textPrimary)
                    }

                    Spacer()

                    HBBadge(
                        text: securityStatus.capitalized,
                        foreground: HBPalette.textPrimary,
                        background: HBPalette.panelSoft.opacity(0.95),
                        stroke: HBPalette.panelStrokeStrong
                    )
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
                    .buttonStyle(HBSecondaryButtonStyle())

                    Button {
                        Task { await armSecurity(stay: false) }
                    } label: {
                        Label("Arm Away", systemImage: "car")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(HBSecondaryButtonStyle())
                }

                Button("Sync with SmartThings") {
                    Task { await syncSecurity() }
                }
                .buttonStyle(HBGhostButtonStyle())
                .frame(maxWidth: .infinity)
                .padding(.top, 2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    private var quickScenePanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Scene Launchpad")
                        .font(.system(size: 11, weight: .bold, design: .rounded))
                        .textCase(.uppercase)
                        .tracking(2.6)
                        .foregroundStyle(HBPalette.textMuted)

                    Label("Quick Scene Actions", systemImage: "play")
                        .font(.system(size: useLandscapeCompactLayout ? 18 : 22, weight: .bold, design: .rounded))
                        .foregroundStyle(HBPalette.textPrimary)
                }

                if quickScenes.isEmpty {
                    EmptyStateView(
                        title: "No favorite scenes yet",
                        subtitle: "Pin your most-used automations and they will appear here for instant launch."
                    )
                } else {
                    ForEach(quickScenes) { scene in
                        HBCardRow {
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
                                .buttonStyle(HBSecondaryButtonStyle(compact: true))
                            }
                        }
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
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: iconForDevice(device.type))
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(Color.white)
                        .frame(width: 38, height: 38)
                        .background(
                            LinearGradient(
                                colors: statusEnabled
                                    ? [HBPalette.accentGreen, HBPalette.accentBlue]
                                    : [HBPalette.accentSlate, HBPalette.panelSoft],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            ),
                            in: Circle()
                        )

                    VStack(alignment: .leading, spacing: 6) {
                        Text(device.name)
                            .font(.system(size: useLandscapeCompactLayout ? 20 : 22, weight: .bold, design: .rounded))
                            .foregroundStyle(HBPalette.textPrimary)
                            .lineLimit(2)
                        Text(device.room)
                            .font(.system(size: useLandscapeCompactLayout ? 13 : 15, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textSecondary)
                    }

                    Spacer(minLength: 0)

                    favoriteButton(for: device)
                }

                HStack(spacing: 8) {
                    HBBadge(
                        text: statusText,
                        foreground: statusEnabled ? HBPalette.textPrimary : HBPalette.textSecondary,
                        background: statusEnabled ? HBPalette.accentBlue.opacity(0.22) : HBPalette.panelSoft.opacity(0.88),
                        stroke: statusEnabled ? HBPalette.accentBlue : HBPalette.panelStrokeStrong
                    )

                    if let temperature = device.temperature, !isThermostat {
                        HBBadge(
                            text: "\(Int(temperature))°F",
                            foreground: HBPalette.textPrimary,
                            background: HBPalette.panelSoft.opacity(0.88),
                            stroke: HBPalette.panelStrokeStrong
                        )
                    }
                }

                if isThermostat {
                    featuredThermostatControls(for: device)
                } else {
                    if device.status {
                        Button(device.status ? "Turn Off" : "Turn On") {
                            Task { await toggleDevice(device) }
                        }
                        .buttonStyle(HBSecondaryButtonStyle())
                        .frame(maxWidth: .infinity)
                        .disabled(pendingControlDeviceIds.contains(device.id))
                    } else {
                        Button(device.status ? "Turn Off" : "Turn On") {
                            Task { await toggleDevice(device) }
                        }
                        .buttonStyle(HBPrimaryButtonStyle())
                        .frame(maxWidth: .infinity)
                        .disabled(pendingControlDeviceIds.contains(device.id))
                    }

                    Text("Say: \"Hey Anna, \(device.status ? "turn off" : "turn on") \(device.name)\"")
                        .font(.system(size: 13, weight: .medium, design: .rounded))
                        .foregroundStyle(HBPalette.textSecondary)
                        .lineLimit(2)
                }
            }
        }
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
                    .frame(width: 30, height: 30)
            } else {
                Image(systemName: isFavorite ? "heart.fill" : "heart")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(isFavorite ? Color.red.opacity(0.95) : HBPalette.textSecondary)
                    .frame(width: 30, height: 30)
                    .contentShape(Rectangle())
            }
        }
        .background(HBGlassBackground(cornerRadius: 14, variant: .panelSoft))
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
            if isOff {
                Button {
                    let nextMode = isOff ? onMode : "off"
                    Task { await handleDeviceControl(deviceId: device.id, action: "set_mode", value: nextMode) }
                } label: {
                    Label(isOff ? "Turn On" : "Turn Off", systemImage: isOff ? "power.circle.fill" : "power.circle")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(HBPrimaryButtonStyle())
                .disabled(pending)
            } else {
                Button {
                    let nextMode = isOff ? onMode : "off"
                    Task { await handleDeviceControl(deviceId: device.id, action: "set_mode", value: nextMode) }
                } label: {
                    Label(isOff ? "Turn On" : "Turn Off", systemImage: isOff ? "power.circle.fill" : "power.circle")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(HBSecondaryButtonStyle())
                .disabled(pending)
            }

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
                        .font(.system(size: useLandscapeCompactLayout ? 40 : 48, weight: .bold, design: .rounded))
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
                        .font(.system(size: useLandscapeCompactLayout ? 30 : 36, weight: .bold, design: .rounded))
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
            .tint(HBPalette.accentBlue)
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
        .padding(14)
        .background(HBGlassBackground(cornerRadius: 18, variant: .panelSoft))
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
        .foregroundStyle(active ? Color.white : HBPalette.textPrimary)
        .frame(maxWidth: .infinity)
        .padding(.vertical, useLandscapeCompactLayout ? 9 : 11)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(
                    active
                    ? LinearGradient(
                        colors: [HBPalette.accentBlue, HBPalette.accentPurple],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                    : LinearGradient(
                        colors: [HBPalette.panelSoft.opacity(0.92), HBPalette.panel.opacity(0.74)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(active ? HBPalette.accentBlue.opacity(0.18) : HBPalette.panelStroke.opacity(0.4), lineWidth: 1)
        )
        .disabled(pending)
    }

    private var voiceCommandPanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Voice Command Surface")
                        .font(.system(size: 11, weight: .bold, design: .rounded))
                        .textCase(.uppercase)
                        .tracking(2.6)
                        .foregroundStyle(HBPalette.textMuted)

                    Text("Launch a natural-language control pass")
                        .font(.system(size: useLandscapeCompactLayout ? 20 : 26, weight: .bold, design: .rounded))
                        .foregroundStyle(HBPalette.textPrimary)
                }

                Text("Type or speak a request and HomeBrain interprets the intent, confidence, and execution path.")
                    .font(.system(size: 15, weight: .medium, design: .rounded))
                    .foregroundStyle(HBPalette.textSecondary)

                TextField("Type a natural language command", text: $commandText)
                    .hbPanelTextField()

                HStack(spacing: 10) {
                    Button {
                        Task { await sendVoiceCommand() }
                    } label: {
                        if isSendingCommand {
                            HStack(spacing: 8) {
                                ProgressView()
                                    .tint(HBPalette.textPrimary)
                                Text("Sending...")
                            }
                            .frame(maxWidth: .infinity)
                        } else {
                            Label("Run Command", systemImage: "waveform")
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .buttonStyle(HBPrimaryButtonStyle())
                    .disabled(commandText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSendingCommand)

                    Button("Refresh") {
                        Task { await loadDashboard() }
                    }
                    .buttonStyle(HBSecondaryButtonStyle())
                }

                if !commandResponse.isEmpty {
                    Text(commandResponse)
                        .font(.system(size: 15, weight: .medium, design: .rounded))
                        .foregroundStyle(HBPalette.textSecondary)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(HBGlassBackground(cornerRadius: 18, variant: .panelSoft))
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
        if previewMode {
            errorMessage = nil
            devices = UIPreviewData.devices.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            scenes = UIPreviewData.scenes.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            voiceDevices = UIPreviewData.voiceDevices
            securityStatus = "Disarmed"
            securityZonesActive = 0
            securityZonesTotal = 9
            systemStatus = "Online"
            favoritesProfileId = UIPreviewData.favoriteProfileId
            favoriteDeviceIds = UIPreviewData.favoriteDeviceIds
            isLoading = false
            return
        }

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

        if previewMode {
            applyControlLocally(deviceId: deviceId, action: action, value: value)
            if action == "set_temperature" {
                thermostatTemperatureDrafts.removeValue(forKey: deviceId)
            }
            return
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
        if previewMode {
            if favoriteDeviceIds.contains(device.id) {
                favoriteDeviceIds.remove(device.id)
            } else {
                favoriteDeviceIds.insert(device.id)
            }
            favoritesProfileId = UIPreviewData.favoriteProfileId
            return
        }

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
        if previewMode {
            for index in scenes.indices {
                scenes[index].active = scenes[index].id == scene.id
            }
            return
        }

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
        if previewMode {
            securityStatus = stay ? "Armed Stay" : "Armed Away"
            systemStatus = "Online"
            return
        }

        do {
            let endpoint = stay ? "/api/security-alarm/sthm/arm-stay" : "/api/security-alarm/sthm/arm-away"
            _ = try await session.apiClient.post(endpoint, body: [:])
            await loadDashboard()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func syncSecurity() async {
        if previewMode {
            systemStatus = "Online"
            return
        }

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

        if previewMode {
            commandResponse = "Preview mode executed: \(trimmed). Residence mesh accepted the request and staged the cinematic control path."
            commandText = ""
            return
        }

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
