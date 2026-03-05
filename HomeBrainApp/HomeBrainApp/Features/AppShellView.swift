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

        var chromeLabel: String {
            switch self {
            case .dashboard: return "Residence Overview"
            case .devices: return "Device Matrix"
            case .scenes: return "Scene Sequencer"
            case .workflows: return "Workflow Studio"
            case .automations: return "Automation Grid"
            case .voiceDevices: return "Voice Nexus"
            case .userProfiles: return "Identity Profiles"
            case .settings: return "System Configuration"
            case .operations: return "Operations Center"
            case .platformDeploy: return "Deployment Bay"
            case .ollama: return "LLM Core"
            case .whisper: return "Whisper Matrix"
            case .ssl: return "Certificate Vault"
            }
        }

        var chromeKicker: String {
            switch self {
            case .dashboard: return "Live Command Deck"
            case .devices: return "Hardware Orchestration"
            case .scenes: return "Atmosphere Control"
            case .workflows: return "Behavior Programming"
            case .automations: return "Scheduled Intelligence"
            case .voiceDevices: return "Wake Mesh"
            case .userProfiles: return "Identity Layer"
            case .settings: return "Control Core"
            case .operations: return "Telemetry"
            case .platformDeploy: return "Rollout Status"
            case .ollama: return "Inference Systems"
            case .whisper: return "Speech Intelligence"
            case .ssl: return "Trust Fabric"
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
    private var topBarHeight: CGFloat { isCompactHeight ? 72 : (isCompact ? 86 : 102) }
    private var shellPadding: CGFloat { isCompactHeight ? 10 : (isCompact ? 14 : 18) }
    private var chromeButtonSide: CGFloat { isCompactHeight ? 38 : 42 }
    private var isSidebarCollapsed: Bool { isCompact ? isCompactSidebarCollapsed : isRegularSidebarCollapsed }
    private var sidebarWidth: CGFloat { isSidebarCollapsed ? (isCompact ? 88 : 94) : 280 }
    private var currentSection: AppSection { selection ?? visibleSections.first ?? .dashboard }

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
        HStack(spacing: shellPadding) {
            sidebar
                .frame(width: sidebarWidth)
            detailStack
        }
        .padding(.horizontal, shellPadding)
        .padding(.bottom, shellPadding)
        .animation(.easeInOut(duration: 0.25), value: sidebarWidth)
    }

    private var compactShell: some View {
        ZStack(alignment: .leading) {
            detailStack

            if isCompactSidebarVisible {
                HBPalette.pageBottom.opacity(isSidebarCollapsed ? 0.12 : 0.20)
                    .onTapGesture {
                        withAnimation(.easeInOut(duration: 0.25)) {
                            isCompactSidebarVisible = false
                        }
                    }
                    .transition(.opacity)

                sidebar
                    .frame(width: sidebarWidth)
                    .padding(.leading, shellPadding)
                    .padding(.bottom, shellPadding)
                    .transition(.move(edge: .leading).combined(with: .opacity))
            }
        }
        .padding(.bottom, shellPadding)
        .animation(.easeInOut(duration: 0.25), value: isCompactSidebarVisible)
        .animation(.easeInOut(duration: 0.25), value: sidebarWidth)
    }

    private var topBar: some View {
        ZStack {
            HBGlassBackground(cornerRadius: isCompactHeight ? 24 : 30, variant: .chrome)

            Group {
                if isCompact {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: isCompactHeight ? 8 : 10) {
                            compactMenuButton
                            chromeBrandCluster(compact: true)
                            chromeSectionCluster(compact: true)
                            HBBadge(text: "\(activeDevicesSummary) active")
                            resourceUtilizationStrip
                            voiceToggleButton(compact: true)
                            HBThemeToggleMenu()
                            chromeIconButton(systemImage: "gearshape") {
                                selection = .settings
                            }
                            chromeIconButton(systemImage: "rectangle.portrait.and.arrow.right") {
                                session.logout()
                            }
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, isCompactHeight ? 8 : 10)
                    }
                } else {
                    HStack(spacing: 12) {
                        chromeBrandCluster(compact: false)
                        chromeSectionCluster(compact: false)
                        HBBadge(text: "\(activeDevicesSummary) devices active")
                        resourceUtilizationStrip

                        Spacer(minLength: 8)

                        voiceToggleButton(compact: false)
                        HBThemeToggleMenu()
                        chromeIconButton(systemImage: "gearshape") {
                            selection = .settings
                        }
                        chromeIconButton(systemImage: "rectangle.portrait.and.arrow.right") {
                            session.logout()
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, isCompactHeight ? 8 : 10)
                }
            }
        }
        .frame(height: topBarHeight - (isCompactHeight ? 12 : 16))
        .padding(.horizontal, shellPadding)
    }

    private func chromeBrandCluster(compact: Bool) -> some View {
        HStack(spacing: compact ? 10 : 12) {
            Image("HomeBrainBrandIcon")
                .resizable()
                .scaledToFit()
                .frame(width: compact ? 26 : 34, height: compact ? 26 : 34)
                .padding(compact ? 8 : 10)
                .background(HBGlassBackground(cornerRadius: 16, variant: .panelSoft))

            VStack(alignment: .leading, spacing: 3) {
                Text("HomeBrain OS")
                    .font(.system(size: 10, weight: .bold, design: .rounded))
                    .textCase(.uppercase)
                    .tracking(2.8)
                    .foregroundStyle(HBPalette.textMuted)
                Text("Cinematic Command Deck")
                    .font(.system(size: compact ? 16 : 20, weight: .bold, design: .rounded))
                    .foregroundStyle(HBPalette.textPrimary)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, compact ? 12 : 14)
        .padding(.vertical, compact ? 8 : 10)
        .background(HBGlassBackground(cornerRadius: 22, variant: .panel))
    }

    private func chromeSectionCluster(compact: Bool) -> some View {
        HStack(spacing: compact ? 8 : 10) {
            Circle()
                .fill(HBPalette.accentGreen)
                .frame(width: compact ? 10 : 12, height: compact ? 10 : 12)

            VStack(alignment: .leading, spacing: 3) {
                Text(currentSection.chromeKicker)
                    .font(.system(size: 10, weight: .bold, design: .rounded))
                    .textCase(.uppercase)
                    .tracking(2.8)
                    .foregroundStyle(HBPalette.textMuted)

                Text(currentSection.chromeLabel)
                    .font(.system(size: compact ? 15 : 18, weight: .bold, design: .rounded))
                    .foregroundStyle(HBPalette.textPrimary)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, compact ? 12 : 16)
        .padding(.vertical, compact ? 8 : 10)
        .background(HBGlassBackground(cornerRadius: 22, variant: .panel))
    }

    private func voiceToggleButton(compact: Bool) -> some View {
        Button {
            Task { await voiceAssistant.toggle() }
        } label: {
            if compact {
                Label(
                    voiceAssistant.isEnabled
                    ? (voiceAssistant.isProcessing ? "Processing" : "Voice On")
                    : "Voice Off",
                    systemImage: voiceAssistant.isEnabled ? "mic.fill" : "mic.slash"
                )
                .labelStyle(.iconOnly)
                .font(.system(size: 14, weight: .semibold, design: .rounded))
            } else {
                Label(
                    voiceAssistant.isEnabled
                    ? (voiceAssistant.isProcessing ? "Processing" : "Voice On")
                    : "Voice Off",
                    systemImage: voiceAssistant.isEnabled ? "mic.fill" : "mic.slash"
                )
                .labelStyle(.titleAndIcon)
                .font(.system(size: 15, weight: .semibold, design: .rounded))
            }
        }
        .buttonStyle(HBSecondaryButtonStyle(compact: compact))
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
        HStack(spacing: compact ? 8 : 10) {
            ForEach(metrics) { metric in
                resourceMetricChip(metric, compact: compact)
            }

            HStack(spacing: 5) {
                Circle()
                    .fill(Color.green.opacity((resourceStripLoading || resourceStripRefreshing) ? 0.6 : 0.95))
                    .frame(width: compact ? 5 : 6, height: compact ? 5 : 6)
                if !compact {
                    Text("Live")
                        .font(.system(size: 10, weight: .semibold, design: .rounded))
                        .foregroundStyle(HBPalette.textSecondary)
                }
            }
            .padding(.horizontal, compact ? 4 : 6)
        }
        .padding(.horizontal, compact ? 6 : 8)
        .padding(.vertical, compact ? 5 : 6)
        .background(HBGlassBackground(cornerRadius: 18, variant: .panel))
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
                        .fill(HBPalette.panelStroke.opacity(0.55))

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
        .frame(width: compact ? 50 : 60)
        .padding(.horizontal, compact ? 5 : 6)
        .padding(.vertical, compact ? 4 : 5)
        .background(HBGlassBackground(cornerRadius: 14, variant: .panelSoft))
    }

    private func chromeIconButton(systemImage: String, action: @escaping () -> Void = {}) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(HBPalette.textPrimary)
                .frame(width: chromeButtonSide, height: chromeButtonSide)
                .background(HBGlassBackground(cornerRadius: 14, variant: .panelSoft))
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
                .foregroundStyle(HBPalette.textPrimary)
                .frame(width: chromeButtonSide, height: chromeButtonSide)
                .background(HBGlassBackground(cornerRadius: 14, variant: .panel))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isCompactSidebarVisible ? "Close main menu" : "Open main menu")
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                if !isSidebarCollapsed {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Nav Core")
                            .font(.system(size: 11, weight: .bold, design: .rounded))
                            .foregroundStyle(HBPalette.textMuted)
                            .textCase(.uppercase)
                            .tracking(2.8)
                        Text("Residence Systems")
                            .font(.system(size: 18, weight: .bold, design: .rounded))
                            .foregroundStyle(HBPalette.textPrimary)
                    }
                }

                Spacer(minLength: 0)

                Button {
                    toggleSidebarCollapsed()
                } label: {
                    Image(systemName: isSidebarCollapsed ? "chevron.right" : "chevron.left")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(HBPalette.textPrimary)
                        .frame(width: 38, height: 38)
                        .background(HBGlassBackground(cornerRadius: 14, variant: .panelSoft))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(isSidebarCollapsed ? "Expand main menu" : "Collapse main menu")
            }

            Rectangle()
                .fill(HBPalette.divider.opacity(0.7))
                .frame(height: 1)

            ScrollView(showsIndicators: false) {
                LazyVStack(spacing: 10) {
                    ForEach(visibleSections) { section in
                        sidebarButton(for: section)
                    }
                }
                .padding(.vertical, 2)
            }

            if isSidebarCollapsed {
                HBPanel {
                    VStack(spacing: 8) {
                        Circle()
                            .fill(voiceAssistant.isEnabled ? HBPalette.accentGreen : HBPalette.accentSlate)
                            .frame(width: 10, height: 10)

                        Image(systemName: voiceAssistant.isEnabled ? "mic.fill" : "mic.slash")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(voiceAssistant.isEnabled ? HBPalette.accentBlue : HBPalette.textSecondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 4)
                }
            } else {
                HBPanel {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 8) {
                            Circle()
                                .fill(voiceAssistant.isEnabled ? HBPalette.accentGreen : HBPalette.accentSlate)
                                .frame(width: 12, height: 12)

                            Text("Wake Mesh")
                                .font(.system(size: 11, weight: .bold, design: .rounded))
                                .textCase(.uppercase)
                                .tracking(2.6)
                                .foregroundStyle(HBPalette.textMuted)
                        }

                        Text(voiceAssistant.isEnabled ? "Voice Commands Armed" : "Voice Commands Offline")
                            .font(.system(size: 18, weight: .bold, design: .rounded))
                            .foregroundStyle(HBPalette.textPrimary)

                        Text(voiceAssistant.statusText)
                            .font(.system(size: 14, weight: .medium, design: .rounded))
                            .foregroundStyle(voiceAssistant.errorMessage == nil ? HBPalette.textSecondary : HBPalette.accentRed)
                            .lineLimit(3)

                        if let pending = voiceAssistant.pendingWakeWord {
                            HBBadge(
                                text: "Wake word: \(pending)",
                                foreground: HBPalette.textPrimary,
                                background: HBPalette.panelSoft.opacity(0.95),
                                stroke: HBPalette.panelStrokeStrong
                            )
                        } else {
                            Text("Wake words: \(voiceAssistant.wakeWordsSummary)")
                                .font(.system(size: 12, weight: .medium, design: .rounded))
                                .foregroundStyle(HBPalette.textSecondary)
                                .lineLimit(2)
                        }

                        if let response = voiceAssistant.lastResponse, !response.isEmpty {
                            Text(response)
                                .font(.system(size: 12, weight: .regular, design: .rounded))
                                .foregroundStyle(HBPalette.textSecondary)
                                .lineLimit(2)
                        }
                    }
                }
            }
        }
        .padding(isSidebarCollapsed ? 12 : 16)
        .frame(width: sidebarWidth)
        .background(HBGlassBackground(cornerRadius: 30, variant: .panelStrong))
    }

    private func sidebarButton(for section: AppSection) -> some View {
        let isSelected = selection == section

        return Button {
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
                    .foregroundStyle(isSelected ? Color.white : HBPalette.accentBlue)
                    .frame(width: 22, height: 22)
                    .padding(10)
                    .background(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .fill(isSelected ? Color.white.opacity(0.16) : HBPalette.panelSoft.opacity(0.72))
                    )

                if !isSidebarCollapsed {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(section.title)
                            .font(.system(size: 15, weight: .semibold, design: .rounded))
                            .foregroundStyle(isSelected ? Color.white : HBPalette.textPrimary)
                            .lineLimit(1)
                        Text(section.chromeKicker)
                            .font(.system(size: 10, weight: .bold, design: .rounded))
                            .foregroundStyle(isSelected ? Color.white.opacity(0.72) : HBPalette.textMuted)
                            .textCase(.uppercase)
                            .tracking(1.6)
                            .lineLimit(1)
                    }

                    Spacer(minLength: 0)

                    if isSelected {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(Color.white.opacity(0.78))
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: isSidebarCollapsed ? .center : .leading)
            .padding(.horizontal, isSidebarCollapsed ? 0 : 10)
            .padding(.vertical, 8)
            .background {
                if isSelected {
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [HBPalette.accentBlue.opacity(0.98), HBPalette.accentPurple.opacity(0.92)],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                } else {
                    HBGlassBackground(cornerRadius: 20, variant: .panelSoft)
                }
            }
            .overlay(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(isSelected ? HBPalette.panelStrokeStrong.opacity(0.25) : HBPalette.panelStroke.opacity(0.38), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(section.title)
    }

    private var detailStack: some View {
        NavigationStack {
            HBDeckSurface(cornerRadius: 32) {
                VStack(spacing: 0) {
                    detailContent
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                }
                .padding(shellPadding)
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
