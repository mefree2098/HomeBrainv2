import SwiftUI

struct AppShellView: View {
    private struct ResourceStripMetric: Identifiable {
        enum Key: String {
            case cpu
            case gpu
            case ram
            case disk
        }

        let key: Key
        let shortLabel: String
        let icon: String
        let percent: Double
        let available: Bool

        var id: String { key.rawValue }
    }

    enum AppSection: String, CaseIterable, Identifiable {
        case dashboard
        case devices
        case scenes
        case workflows
        case automations
        case voiceDevices
        case userProfiles
        case ollama
        case whisper
        case platformDeploy
        case operations
        case settings
        case ssl

        var id: String { rawValue }

        var title: String {
            switch self {
            case .dashboard: return "Dashboard"
            case .devices: return "Devices"
            case .scenes: return "Scenes"
            case .automations: return "Automations"
            case .workflows: return "Workflows"
            case .voiceDevices: return "Voice Devices"
            case .userProfiles: return "User Profiles"
            case .settings: return "Settings"
            case .operations: return "Operations"
            case .platformDeploy: return "Platform Deploy"
            case .ollama: return "Ollama / LLM"
            case .whisper: return "Whisper STT"
            case .ssl: return "SSL Certificates"
            }
        }

        var icon: String {
            switch self {
            case .dashboard: return "house"
            case .devices: return "lightbulb"
            case .scenes: return "sparkles"
            case .automations: return "bolt"
            case .workflows: return "point.3.connected.trianglepath.dotted"
            case .voiceDevices: return "mic"
            case .userProfiles: return "person.2"
            case .settings: return "gearshape"
            case .operations: return "waveform.path.ecg"
            case .platformDeploy: return "arrow.up.forward.app"
            case .ollama: return "brain"
            case .whisper: return "cpu"
            case .ssl: return "lock.shield"
            }
        }

        var adminOnly: Bool {
            switch self {
            case .operations, .platformDeploy, .ssl:
                return true
            default:
                return false
            }
        }
    }

    @EnvironmentObject private var session: SessionStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    @State private var selection: AppSection? = .dashboard
    @AppStorage("homebrain.ios.main-menu-collapsed.regular") private var isRegularSidebarCollapsed = false
    @AppStorage("homebrain.ios.main-menu-collapsed.compact") private var isCompactSidebarCollapsed = true
    @State private var isCompactSidebarVisible = false
    @State private var activeDevicesSummary = "--/--"
    @StateObject private var voiceAssistant = VoiceAssistantManager()
    @State private var resourceStripMetrics: [ResourceStripMetric] = defaultResourceStripMetrics()
    @State private var resourceStripLoading = true
    @State private var resourceStripRefreshing = false

    private var isCompact: Bool { horizontalSizeClass == .compact }
    private var isCompactHeight: Bool { verticalSizeClass == .compact }
    private var topBarHeight: CGFloat { isCompactHeight ? 52 : (isCompact ? 56 : 72) }
    private var shellPadding: CGFloat { isCompactHeight ? 8 : (isCompact ? 12 : 16) }
    private var chromeButtonSide: CGFloat { isCompactHeight ? 32 : 36 }
    private var isSidebarCollapsed: Bool { isCompact ? isCompactSidebarCollapsed : isRegularSidebarCollapsed }
    private var sidebarWidth: CGFloat { isSidebarCollapsed ? (isCompact ? 76 : 82) : 245 }

    private var visibleSections: [AppSection] {
        AppSection.allCases.filter { !($0.adminOnly && session.currentUser?.role != "admin") }
    }

    private func setSidebarCollapsed(_ collapsed: Bool) {
        if isCompact {
            isCompactSidebarCollapsed = collapsed
        } else {
            isRegularSidebarCollapsed = collapsed
        }
    }

    private func toggleSidebarCollapsed() {
        withAnimation(.easeInOut(duration: 0.25)) {
            setSidebarCollapsed(!isSidebarCollapsed)
        }
    }

    var body: some View {
        GeometryReader { proxy in
            let topInset = proxy.safeAreaInsets.top

            ZStack(alignment: .top) {
                HBPageBackground()
                    .ignoresSafeArea()

                Group {
                    if isCompact {
                        compactShell
                    } else {
                        regularShell
                    }
                }
                .padding(.top, topInset + topBarHeight)

                topBar
                    .padding(.top, topInset)
                    .frame(height: topBarHeight + topInset, alignment: .bottom)
                    .frame(maxWidth: .infinity, alignment: .bottom)
                    .zIndex(2)
            }
        }
        .ignoresSafeArea(edges: .top)
        .tint(HBPalette.accentBlue)
        .preferredColorScheme(.dark)
        .onAppear {
            syncSelectionWithVisibleSections()
            voiceAssistant.bind(sessionStore: session)
            isCompactSidebarVisible = !isCompact
        }
        .onChange(of: horizontalSizeClass) { _, sizeClass in
            withAnimation(.easeInOut(duration: 0.25)) {
                isCompactSidebarVisible = sizeClass != .compact
            }
        }
        .onChange(of: session.currentUser?.role) { _, _ in
            syncSelectionWithVisibleSections()
        }
        .onChange(of: session.isAuthenticated) { _, isAuthenticated in
            if !isAuthenticated {
                voiceAssistant.stop()
            } else {
                voiceAssistant.bind(sessionStore: session)
            }
        }
        .task(id: session.currentUser?.id ?? "guest") {
            await refreshHeaderSummary()
        }
        .task(id: session.isAuthenticated) {
            if session.isAuthenticated {
                await runResourceStripLoop()
            } else {
                resourceStripMetrics = Self.defaultResourceStripMetrics()
                resourceStripLoading = false
                resourceStripRefreshing = false
            }
        }
    }

    private var regularShell: some View {
        HStack(spacing: 0) {
            sidebar
                .frame(width: sidebarWidth)
            detailStack
        }
        .animation(.easeInOut(duration: 0.25), value: sidebarWidth)
    }

    private var compactShell: some View {
        ZStack(alignment: .leading) {
            detailStack

            if isCompactSidebarVisible {
                Color.black.opacity(isSidebarCollapsed ? 0.30 : 0.42)
                    .onTapGesture {
                        withAnimation(.easeInOut(duration: 0.25)) {
                            isCompactSidebarVisible = false
                        }
                    }
                    .transition(.opacity)

                sidebar
                    .frame(width: sidebarWidth)
                    .shadow(color: Color.black.opacity(0.35), radius: 20, x: 8, y: 0)
                    .transition(.move(edge: .leading).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.25), value: isCompactSidebarVisible)
        .animation(.easeInOut(duration: 0.25), value: sidebarWidth)
    }

    private var topBar: some View {
        HStack(spacing: isCompactHeight ? 8 : 10) {
            if isCompact {
                compactMenuButton
            }

            HStack(spacing: 8) {
                Image("HomeBrainBrandIcon")
                    .resizable()
                    .scaledToFit()
                    .frame(width: isCompactHeight ? 22 : (isCompact ? 24 : 30), height: isCompactHeight ? 22 : (isCompact ? 24 : 30))
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))

                Text("Home Brain")
                    .font(
                        .system(
                            size: isCompactHeight ? 16 : (isCompact ? 18 : 32),
                            weight: .bold,
                            design: .rounded
                        )
                    )
                    .foregroundStyle(
                        LinearGradient(
                            colors: [HBPalette.accentBlue, HBPalette.accentPurple],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .layoutPriority(1)

            Text(isCompact ? activeDevicesSummary : "\(activeDevicesSummary) devices active")
                .font(.system(size: isCompactHeight ? 12 : 14, weight: .semibold, design: .rounded))
                .foregroundStyle(Color.black.opacity(0.85))
                .padding(.horizontal, isCompactHeight ? 10 : 12)
                .padding(.vertical, isCompactHeight ? 5 : 6)
                .background(Color.white.opacity(0.92), in: Capsule())
                .lineLimit(1)
                .layoutPriority(1)

            resourceUtilizationStrip
                .layoutPriority(2)

            Spacer(minLength: 8)

            Button {
                Task { await voiceAssistant.toggle() }
            } label: {
                Group {
                    if isCompact {
                        Label("", systemImage: voiceAssistant.isEnabled ? "mic.fill" : "mic.slash")
                            .labelStyle(.iconOnly)
                    } else {
                        Label(
                            voiceAssistant.isEnabled
                            ? (voiceAssistant.isProcessing ? "Processing..." : "Voice On")
                            : "Voice Off",
                            systemImage: voiceAssistant.isEnabled ? "mic.fill" : "mic.slash"
                        )
                            .labelStyle(.titleAndIcon)
                    }
                }
                .font(.system(size: isCompactHeight ? 13 : 15, weight: .semibold, design: .rounded))
                .foregroundStyle(HBPalette.textPrimary)
                .padding(.horizontal, isCompactHeight ? 9 : (isCompact ? 10 : 14))
                .padding(.vertical, isCompactHeight ? 7 : 8)
                .background(Color.black.opacity(0.65), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            .buttonStyle(.plain)

            if !isCompact {
                chromeIconButton(systemImage: "sun.max")
                chromeIconButton(systemImage: "gearshape") {
                    selection = .settings
                }
            }

            chromeIconButton(systemImage: "rectangle.portrait.and.arrow.right") {
                session.logout()
            }
        }
        .padding(.horizontal, isCompact ? 12 : 16)
        .padding(.vertical, isCompactHeight ? 8 : 12)
        .background(HBPalette.chrome.opacity(0.98))
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color.white.opacity(0.08))
                .frame(height: 1)
        }
    }

    private var resourceUtilizationStrip: some View {
        let noGPU = resourceStripMetrics.filter { $0.key != .gpu }
        let minimal = resourceStripMetrics.filter { $0.key == .cpu || $0.key == .ram }

        return Group {
            if isCompact {
                resourceUtilizationStripContent(metrics: minimal, compact: true)
                    .frame(maxWidth: 150)
            } else {
                ViewThatFits(in: .horizontal) {
                    resourceUtilizationStripContent(metrics: resourceStripMetrics)
                    resourceUtilizationStripContent(metrics: noGPU)
                    resourceUtilizationStripContent(metrics: minimal)
                }
            }
        }
    }

    private func resourceUtilizationStripContent(metrics: [ResourceStripMetric], compact: Bool = false) -> some View {
        HStack(spacing: 6) {
            ForEach(metrics) { metric in
                resourceMetricChip(metric, compact: compact)
            }

            HStack(spacing: 4) {
                Circle()
                    .fill(Color.green.opacity((resourceStripLoading || resourceStripRefreshing) ? 0.6 : 0.95))
                    .frame(width: compact ? 5 : 6, height: compact ? 5 : 6)
                if !compact {
                    Text("Live")
                        .font(.system(size: 10, weight: .semibold, design: .rounded))
                        .foregroundStyle(HBPalette.textSecondary)
                }
            }
            .padding(.horizontal, 3)
        }
        .padding(.horizontal, compact ? 4 : 6)
        .padding(.vertical, compact ? 4 : 5)
        .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color.white.opacity(0.12), lineWidth: 1)
        )
    }

    private func resourceMetricChip(_ metric: ResourceStripMetric, compact: Bool = false) -> some View {
        let barColors = resourceBarGradient(for: metric.percent)
        let percentLabel = metric.available ? "\(Int(metric.percent.rounded()))%" : "N/A"

        return VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 2) {
                Text(metric.shortLabel)
                    .font(.system(size: compact ? 8 : 9, weight: .bold, design: .rounded))
                    .foregroundStyle(HBPalette.textSecondary)

                Spacer(minLength: 2)

                Image(systemName: metric.icon)
                    .font(.system(size: compact ? 8 : 9, weight: .bold))
                    .foregroundStyle(HBPalette.textSecondary)
            }

            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 3, style: .continuous)
                        .fill(Color.white.opacity(0.18))

                    RoundedRectangle(cornerRadius: 3, style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: barColors,
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                        .frame(
                            width: geometry.size.width * CGFloat(metric.available ? metric.percent / 100 : 0)
                        )
                }
            }
            .frame(height: 5)

            HStack {
                Spacer(minLength: 0)
                Text(percentLabel)
                    .font(.system(size: compact ? 9 : 10, weight: .bold, design: .rounded))
                    .foregroundStyle(metric.available ? resourceValueColor(for: metric.percent) : HBPalette.textSecondary)
            }
        }
        .frame(width: compact ? 50 : 58)
        .padding(.horizontal, compact ? 4 : 5)
        .padding(.vertical, compact ? 3 : 4)
        .background(Color.black.opacity(0.25), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
    }

    private func chromeIconButton(systemImage: String, action: @escaping () -> Void = {}) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(HBPalette.textSecondary)
                .frame(width: chromeButtonSide, height: chromeButtonSide)
                .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private var compactMenuButton: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.25)) {
                isCompactSidebarVisible.toggle()
            }
        } label: {
            Image(systemName: isCompactSidebarVisible ? "xmark" : "line.3.horizontal")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(HBPalette.textSecondary)
                .frame(width: chromeButtonSide, height: chromeButtonSide)
                .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isCompactSidebarVisible ? "Close main menu" : "Open main menu")
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                if !isSidebarCollapsed {
                    Text("Main Menu")
                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                        .foregroundStyle(HBPalette.textSecondary)
                        .textCase(.uppercase)
                        .tracking(0.7)
                    Spacer()
                }

                Button {
                    toggleSidebarCollapsed()
                } label: {
                    Image(systemName: isSidebarCollapsed ? "chevron.right" : "chevron.left")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(HBPalette.textSecondary)
                        .frame(width: 30, height: 30)
                        .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(isSidebarCollapsed ? "Expand main menu" : "Collapse main menu")
            }
            .padding(.horizontal, isSidebarCollapsed ? 0 : 4)
            .padding(.top, isCompactHeight ? 4 : 6)

            ForEach(visibleSections) { section in
                Button {
                    selection = section
                    if isCompact {
                        withAnimation(.easeInOut(duration: 0.25)) {
                            isCompactSidebarVisible = false
                        }
                    }
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: section.icon)
                            .font(.system(size: 15, weight: .semibold))
                            .frame(width: 18, height: 18)

                        if !isSidebarCollapsed {
                            Text(section.title)
                                .font(.system(size: 22, weight: .semibold, design: .rounded))
                        }

                        if !isSidebarCollapsed {
                            Spacer()

                            if selection == section {
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 12, weight: .bold))
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: isSidebarCollapsed ? .center : .leading)
                    .foregroundStyle(selection == section ? HBPalette.textPrimary : HBPalette.textSecondary)
                    .padding(.horizontal, isSidebarCollapsed ? 0 : 14)
                    .padding(.vertical, 12)
                    .background(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .fill(
                                selection == section
                                ? LinearGradient(
                                    colors: [HBPalette.accentBlue.opacity(0.95), HBPalette.accentPurple.opacity(0.95)],
                                    startPoint: .leading,
                                    endPoint: .trailing
                                )
                                : LinearGradient(
                                    colors: [Color.white.opacity(0.03), Color.white.opacity(0.0)],
                                    startPoint: .top,
                                    endPoint: .bottom
                                )
                            )
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .stroke(selection == section ? Color.clear : Color.white.opacity(0.08), lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
                .accessibilityLabel(section.title)
            }

            Spacer()

            if isSidebarCollapsed {
                HBPanel {
                    HStack {
                        Spacer(minLength: 0)
                        Image(systemName: voiceAssistant.isEnabled ? "mic.fill" : "mic.slash")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(voiceAssistant.isEnabled ? HBPalette.accentBlue : HBPalette.textSecondary)
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 2)
                }
            } else {
                HBPanel {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(voiceAssistant.isEnabled ? "Voice Commands Active" : "Voice Commands Off")
                            .font(.system(size: 13, weight: .semibold, design: .rounded))
                            .foregroundStyle(HBPalette.textPrimary)
                        Text(voiceAssistant.statusText)
                            .font(.system(size: 12, weight: .regular, design: .rounded))
                            .foregroundStyle(voiceAssistant.errorMessage == nil ? HBPalette.textSecondary : Color.red.opacity(0.9))
                            .lineLimit(2)
                        if let pending = voiceAssistant.pendingWakeWord {
                            Text("Wake word detected: \"\(pending)\"")
                                .font(.system(size: 11, weight: .medium, design: .rounded))
                                .foregroundStyle(HBPalette.accentBlue)
                        } else {
                            Text("Wake words: \(voiceAssistant.wakeWordsSummary)")
                                .font(.system(size: 11, weight: .medium, design: .rounded))
                                .foregroundStyle(HBPalette.textSecondary)
                                .lineLimit(2)
                        }
                        if let response = voiceAssistant.lastResponse, !response.isEmpty {
                            Text(response)
                                .font(.system(size: 11, weight: .regular, design: .rounded))
                                .foregroundStyle(HBPalette.textSecondary)
                                .lineLimit(2)
                        }
                    }
                }
            }
        }
        .padding(.horizontal, isSidebarCollapsed ? 8 : 10)
        .padding(.vertical, 12)
        .frame(width: sidebarWidth)
        .background(
            LinearGradient(
                colors: [HBPalette.sidebar.opacity(0.98), HBPalette.chrome.opacity(0.96)],
                startPoint: .top,
                endPoint: .bottom
            )
        )
        .overlay(alignment: .trailing) {
            Rectangle()
                .fill(Color.white.opacity(0.08))
                .frame(width: 1)
        }
    }

    private var detailStack: some View {
        NavigationStack {
            detailContent
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .padding(shellPadding)
        }
        .toolbar(.hidden, for: .navigationBar)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(
            LinearGradient(
                colors: [HBPalette.pageTop.opacity(0.72), HBPalette.pageMid.opacity(0.62), HBPalette.pageBottom.opacity(0.55)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        )
        .overlay(alignment: .top) {
            Rectangle()
                .fill(Color.white.opacity(0.07))
                .frame(height: 1)
        }
    }

    @ViewBuilder
    private var detailContent: some View {
        if let current = selection ?? visibleSections.first {
            sectionView(current)
                .id(current)
        } else {
            EmptyStateView(
                title: "Select a section",
                subtitle: "Use the left sidebar to open a HomeBrain module."
            )
        }
    }

    @ViewBuilder
    private func sectionView(_ section: AppSection) -> some View {
        switch section {
        case .dashboard:
            DashboardView()
        case .devices:
            DevicesView()
        case .scenes:
            ScenesView()
        case .automations:
            AutomationsView()
        case .workflows:
            WorkflowsView()
        case .voiceDevices:
            VoiceDevicesView()
        case .userProfiles:
            UserProfilesView()
        case .settings:
            SettingsView()
        case .operations:
            OperationsView()
        case .platformDeploy:
            PlatformDeployView()
        case .ollama:
            OllamaView()
        case .whisper:
            WhisperView()
        case .ssl:
            SSLView()
        }
    }

    private func syncSelectionWithVisibleSections() {
        if let current = selection, visibleSections.contains(current) {
            return
        }
        selection = visibleSections.first
    }

    private func refreshHeaderSummary() async {
        do {
            let response = try await session.apiClient.get("/api/devices")
            let root = JSON.object(response)
            let data = JSON.object(root["data"])
            let devices = JSON.array(data["devices"]).map(DeviceItem.from)
            let active = devices.filter { $0.status }.count
            activeDevicesSummary = "\(active)/\(devices.count)"
        } catch {
            activeDevicesSummary = "--/--"
        }
    }

    private func runResourceStripLoop() async {
        await refreshResourceStrip(initialLoad: true)

        while !Task.isCancelled && session.isAuthenticated {
            try? await Task.sleep(nanoseconds: 12_000_000_000)
            guard !Task.isCancelled && session.isAuthenticated else {
                break
            }
            await refreshResourceStrip(initialLoad: false)
        }
    }

    private func refreshResourceStrip(initialLoad: Bool) async {
        if initialLoad {
            resourceStripLoading = true
        } else {
            resourceStripRefreshing = true
        }

        defer {
            resourceStripLoading = false
            resourceStripRefreshing = false
        }

        do {
            let response = try await session.apiClient.get("/api/resources/utilization")
            applyResourceSnapshot(response)
        } catch {
            // Keep last known values visible if refresh fails.
        }
    }

    private func applyResourceSnapshot(_ payload: Any) {
        let root = JSON.object(payload)
        let cpu = JSON.object(root["cpu"])
        let gpu = JSON.object(root["gpu"])
        let memory = JSON.object(root["memory"])
        let disk = JSON.object(root["disk"])

        let cpuPercent = normalizedResourcePercent(JSON.double(cpu, "usagePercent"))
        let gpuAvailable = JSON.bool(gpu, "available")
        let gpuPercent = normalizedResourcePercent(JSON.double(gpu, "usagePercent"))
        let memoryPercent = normalizedResourcePercent(JSON.double(memory, "usagePercent"))
        let diskPercent = normalizedResourcePercent(JSON.double(disk, "usagePercent"))

        resourceStripMetrics = [
            ResourceStripMetric(key: .cpu, shortLabel: "CPU", icon: "cpu", percent: cpuPercent, available: true),
            ResourceStripMetric(key: .gpu, shortLabel: "GPU", icon: "dial.medium", percent: gpuPercent, available: gpuAvailable),
            ResourceStripMetric(key: .ram, shortLabel: "RAM", icon: "memorychip", percent: memoryPercent, available: true),
            ResourceStripMetric(key: .disk, shortLabel: "DSK", icon: "externaldrive", percent: diskPercent, available: true)
        ]
    }

    private func normalizedResourcePercent(_ value: Double) -> Double {
        min(100, max(0, value))
    }

    private func resourceValueColor(for percent: Double) -> Color {
        if percent >= 90 {
            return Color.red.opacity(0.92)
        }
        if percent >= 70 {
            return HBPalette.accentOrange
        }
        return HBPalette.accentGreen
    }

    private func resourceBarGradient(for percent: Double) -> [Color] {
        if percent >= 90 {
            return [Color.red.opacity(0.9), Color.orange.opacity(0.9)]
        }
        if percent >= 70 {
            return [HBPalette.accentOrange.opacity(0.95), Color.yellow.opacity(0.9)]
        }
        return [HBPalette.accentGreen.opacity(0.95), HBPalette.accentBlue.opacity(0.9)]
    }

    private static func defaultResourceStripMetrics() -> [ResourceStripMetric] {
        [
            ResourceStripMetric(key: .cpu, shortLabel: "CPU", icon: "cpu", percent: 0, available: true),
            ResourceStripMetric(key: .gpu, shortLabel: "GPU", icon: "dial.medium", percent: 0, available: false),
            ResourceStripMetric(key: .ram, shortLabel: "RAM", icon: "memorychip", percent: 0, available: true),
            ResourceStripMetric(key: .disk, shortLabel: "DSK", icon: "externaldrive", percent: 0, available: true)
        ]
    }
}
