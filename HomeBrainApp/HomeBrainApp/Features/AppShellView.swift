import Combine
import SwiftUI

final class DashboardChromeState: ObservableObject {
    struct ViewSummary: Identifiable, Equatable {
        let id: String
        let name: String
        let widgetCount: Int
    }

    enum Command: Equatable {
        case toggleEditing
        case save
        case addWidget
        case createView
        case renameCurrentView
        case selectView(String)
    }

    @Published var currentViewName = "Dashboard"
    @Published var currentViewID = ""
    @Published var views: [ViewSummary] = []
    @Published var widgetCount = 0
    @Published var isEditing = false
    @Published var isDirty = false
    @Published var isSaving = false
    @Published var canEdit = false
    @Published private(set) var commandToken = UUID()

    private var pendingCommand: Command?

    func update(
        currentViewName: String,
        currentViewID: String,
        views: [ViewSummary],
        widgetCount: Int,
        isEditing: Bool,
        isDirty: Bool,
        isSaving: Bool,
        canEdit: Bool
    ) {
        self.currentViewName = currentViewName
        self.currentViewID = currentViewID
        self.views = views
        self.widgetCount = widgetCount
        self.isEditing = isEditing
        self.isDirty = isDirty
        self.isSaving = isSaving
        self.canEdit = canEdit
    }

    func send(_ command: Command) {
        pendingCommand = command
        commandToken = UUID()
    }

    func takePendingCommand() -> Command? {
        defer { pendingCommand = nil }
        return pendingCommand
    }

    func reset() {
        update(
            currentViewName: "Dashboard",
            currentViewID: "",
            views: [],
            widgetCount: 0,
            isEditing: false,
            isDirty: false,
            isSaving: false,
            canEdit: false
        )
    }
}

struct AppShellView: View {
    let previewMode: Bool

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
        case weather
        case views
        case devices
        case scenes
        case workflows
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
            case .weather: return "Weather"
            case .views: return "Views"
            case .devices: return "Devices"
            case .scenes: return "Scenes"
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
            case .weather: return "Weather Command Deck"
            case .views: return "Device Dashboards"
            case .devices: return "Device Matrix"
            case .scenes: return "Scene Sequencer"
            case .workflows: return "Workflow Studio"
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
            case .weather: return "Atmospheric Systems"
            case .views: return "Room Presets"
            case .devices: return "Hardware Orchestration"
            case .scenes: return "Atmosphere Control"
            case .workflows: return "Behavior Programming"
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
            case .weather: return "cloud.sun"
            case .views: return "rectangle.3.group"
            case .devices: return "lightbulb"
            case .scenes: return "sparkles"
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
    @EnvironmentObject private var uiPreview: UIPreviewStore
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
    @State private var previewVoiceEnabled = false
    @State private var containerWidth: CGFloat = 0
    @StateObject private var dashboardChrome = DashboardChromeState()
    @AppStorage("homebrain.ios.theme-mode") private var themeModeRaw = HBThemeMode.system.rawValue

    private var isCompact: Bool { horizontalSizeClass == .compact }
    private var isCompactHeight: Bool { verticalSizeClass == .compact }
    private var usesSidebarDrawer: Bool { isCompact || containerWidth < 980 }
    private var usesCondensedRegularTopBar: Bool { !usesSidebarDrawer && containerWidth < 1220 }
    private var usesPortraitPhoneTopBar: Bool { isCompact && !isCompactHeight }
    private var showsTopBarResourceStrip: Bool { !usesPortraitPhoneTopBar }
    private var topBarHeight: CGFloat {
        if isCompactHeight {
            return 60
        }
        if isCompact {
            return 78
        }
        return usesCondensedRegularTopBar || usesSidebarDrawer ? 82 : 86
    }
    private var shellPadding: CGFloat { isCompactHeight ? 8 : (isCompact ? 12 : 14) }
    private var chromeButtonSide: CGFloat { isCompactHeight ? 38 : 42 }
    private var compactTopBarClearance: CGFloat { 0 }
    private var topBarBottomSpacing: CGFloat {
        if isCompactHeight {
            return 6
        }
        if usesSidebarDrawer {
            return 10
        }
        return 12
    }
    private var isSidebarCollapsed: Bool { usesSidebarDrawer ? isCompactSidebarCollapsed : isRegularSidebarCollapsed }
    private var sidebarWidth: CGFloat {
        if usesSidebarDrawer {
            if isSidebarCollapsed {
                return isCompact ? 76 : 84
            }
            let maxWidth = max(232, containerWidth - (shellPadding * 2) - 18)
            let preferredWidth = isCompact ? min(max(containerWidth * 0.78, 248), 300) : 256
            return min(preferredWidth, maxWidth)
        }
        return isSidebarCollapsed ? 78 : 240
    }
    private var currentSection: AppSection { selection ?? visibleSections.first ?? .dashboard }
    private var voiceEnabled: Bool { previewMode ? previewVoiceEnabled : voiceAssistant.isEnabled }
    private var voiceProcessing: Bool { previewMode ? false : voiceAssistant.isProcessing }
    private var useCondensedChromeControls: Bool { usesSidebarDrawer || usesCondensedRegularTopBar }
    private var topBarStatusBadgeText: String? { nil }
    private var shellVoiceTitle: String {
        voiceEnabled ? "Voice Commands Armed" : "Voice Commands Offline"
    }
    private var shellVoiceDescription: String {
        if previewMode {
            return voiceEnabled
            ? "Say \"Hey Anna\" or \"Henry\" to orchestrate rooms, scenes, and workflows from a single command surface."
            : "Enable the wake mesh to arm hands-free room, scene, and workflow control."
        }
        return voiceAssistant.statusText
    }
    private var shellVoiceSupplementaryText: String {
        previewMode ? "Wake words: Hey Anna, Henry" : "Wake words: \(voiceAssistant.wakeWordsSummary)"
    }
    private var resourceStripCondensedMaxWidth: CGFloat {
        if isCompact {
            return 164
        }
        if usesSidebarDrawer {
            return containerWidth < 860 ? 304 : 320
        }
        return 310
    }
    private var showsDashboardChrome: Bool { currentSection == .dashboard }
    private var dashboardChromeStatusText: String {
        if dashboardChrome.isSaving {
            return "Saving layout..."
        }
        if dashboardChrome.isEditing {
            return dashboardChrome.isDirty ? "Unsaved changes" : "Edit mode"
        }
        return "\(dashboardChrome.widgetCount) widgets"
    }

    init(previewMode: Bool = false) {
        self.previewMode = previewMode
    }

    private var visibleSections: [AppSection] {
        if previewMode {
            return AppSection.allCases
        }
        return AppSection.allCases.filter { !($0.adminOnly && session.currentUser?.role != "admin") }
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
            ZStack(alignment: .top) {
                HBPageBackground()
                    .ignoresSafeArea()

                Group {
                    if usesSidebarDrawer {
                        compactShell
                    } else {
                        regularShell
                    }
                }
                .padding(.top, topBarHeight + topBarBottomSpacing + compactTopBarClearance)

                topBar
                    .padding(.top, compactTopBarClearance)
                    .frame(height: topBarHeight + compactTopBarClearance, alignment: .bottom)
                    .frame(maxWidth: .infinity, alignment: .bottom)
                    .zIndex(2)
            }
            .onAppear {
                syncNavigationPresentation(for: proxy.size.width)
            }
            .onChange(of: proxy.size.width) { _, newWidth in
                syncNavigationPresentation(for: newWidth)
            }
        }
        .tint(HBPalette.accentBlue)
        .onAppear {
            syncSelectionWithVisibleSections()
            if previewMode {
                selection = uiPreview.selectedSection
                activeDevicesSummary = "75/225"
                resourceStripMetrics = previewResourceStripMetrics()
                resourceStripLoading = false
                resourceStripRefreshing = false
                isRegularSidebarCollapsed = false
            } else {
                voiceAssistant.bind(sessionStore: session)
            }
            isCompactSidebarVisible = false
        }
        .onChange(of: selection) { _, newValue in
            if previewMode, let newValue {
                uiPreview.updateSection(newValue)
            }
            if newValue != .dashboard {
                dashboardChrome.reset()
            }
        }
        .onChange(of: horizontalSizeClass) { _, sizeClass in
            withAnimation(.easeInOut(duration: 0.25)) {
                isCompactSidebarVisible = sizeClass == .compact ? false : !usesSidebarDrawer
            }
        }
        .onChange(of: session.currentUser?.role) { _, _ in
            if !previewMode {
                syncSelectionWithVisibleSections()
            }
        }
        .onChange(of: session.isAuthenticated) { _, isAuthenticated in
            if !previewMode {
                if !isAuthenticated {
                    voiceAssistant.stop()
                } else {
                    voiceAssistant.bind(sessionStore: session)
                }
            }
        }
        .task(id: session.currentUser?.id ?? "guest") {
            if !previewMode {
                await refreshHeaderSummary()
            }
        }
        .task(id: session.isAuthenticated) {
            if previewMode {
                resourceStripMetrics = previewResourceStripMetrics()
                resourceStripLoading = false
                resourceStripRefreshing = false
            } else if session.isAuthenticated {
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
                .padding(.horizontal, shellPadding)

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
                    compactTopBarContent
                } else {
                    singleLineTopBarContent
                }
            }
        }
        .frame(height: topBarHeight - (isCompactHeight ? 12 : 14))
        .padding(.horizontal, shellPadding)
    }

    private var compactTopBarContent: some View {
        Group {
            if usesPortraitPhoneTopBar {
                portraitPhoneTopBarContent
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: isCompactHeight ? 8 : 10) {
                        compactMenuButton
                        chromeBrandCluster(compact: true)
                        if showsDashboardChrome {
                            dashboardViewMenu(compact: true)
                        }
                        if showsTopBarResourceStrip {
                            resourceUtilizationStrip
                        }
                        dashboardTopBarControls(compact: true)
                        voiceToggleButton(compact: true)
                        HBThemeToggleMenu()
                        chromeIconButton(systemImage: "gearshape") {
                            selection = .settings
                        }
                        chromeIconButton(systemImage: "rectangle.portrait.and.arrow.right") {
                            exitShell()
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, isCompactHeight ? 8 : 10)
                }
            }
        }
    }

    private var singleLineTopBarContent: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: useCondensedChromeControls ? 6 : 10) {
                if usesSidebarDrawer {
                    drawerToggleButton
                }

                chromeBrandCluster(compact: true)
                if showsDashboardChrome {
                    dashboardViewMenu(compact: false)
                }
                Spacer(minLength: 0)
                if showsTopBarResourceStrip {
                    resourceUtilizationStrip
                }
                dashboardTopBarControls(compact: useCondensedChromeControls)
                voiceToggleButton(compact: useCondensedChromeControls)
                HBThemeToggleMenu()
                chromeIconButton(systemImage: "gearshape") {
                    selection = .settings
                }
                chromeIconButton(systemImage: "rectangle.portrait.and.arrow.right") {
                    exitShell()
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)

            HStack(spacing: 8) {
                if usesSidebarDrawer {
                    drawerToggleButton
                }

                chromeBrandCluster(compact: true)
                if showsDashboardChrome {
                    dashboardViewMenu(compact: true)
                }
                Spacer(minLength: 0)
                if showsTopBarResourceStrip {
                    resourceUtilizationStrip
                }
                dashboardTopBarControls(compact: true)
                chromeOverflowMenu
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)

            HStack(spacing: 8) {
                if usesSidebarDrawer {
                    drawerToggleButton
                }

                chromeBrandCluster(compact: true, ultraCompact: true)
                Spacer(minLength: 0)
                if showsDashboardChrome {
                    dashboardViewMenu(compact: true, ultraCompact: true)
                }
                if showsDashboardChrome {
                    chromeIconButton(
                        systemImage: "square.grid.3x3",
                        isActive: dashboardChrome.isEditing,
                        isDisabled: !dashboardChrome.canEdit
                    ) {
                        dashboardChrome.send(.toggleEditing)
                    }
                }
                chromeOverflowMenu
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
        }
    }

    private var portraitPhoneTopBarContent: some View {
        HStack(spacing: 8) {
            compactMenuButton
            chromeBrandCluster(compact: true, ultraCompact: true)
            Spacer(minLength: 0)
            if showsDashboardChrome {
                chromeIconButton(
                    systemImage: "square.grid.3x3",
                    isActive: dashboardChrome.isEditing,
                    isDisabled: !dashboardChrome.canEdit
                ) {
                    dashboardChrome.send(.toggleEditing)
                }
            }
            chromeOverflowMenu
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private var drawerToggleButton: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.25)) {
                isCompactSidebarVisible.toggle()
            }
        } label: {
            if useCondensedChromeControls {
                Image(systemName: isCompactSidebarVisible ? "xmark" : "sidebar.left")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(HBPalette.textPrimary)
                    .frame(width: chromeButtonSide, height: chromeButtonSide)
            } else {
                Label(isCompactSidebarVisible ? "Close" : "Menu", systemImage: isCompactSidebarVisible ? "xmark" : "sidebar.left")
                    .font(.system(size: 14, weight: .semibold, design: .rounded))
                    .foregroundStyle(HBPalette.textPrimary)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .frame(minHeight: 38)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isCompactSidebarVisible ? "Close main menu" : "Open main menu")
    }

    private var chromeOverflowMenu: some View {
        Menu {
            if showsDashboardChrome {
                Menu {
                    ForEach(dashboardChrome.views) { view in
                        Button {
                            dashboardChrome.send(.selectView(view.id))
                        } label: {
                            if view.id == dashboardChrome.currentViewID {
                                Label("\(view.name) • \(view.widgetCount)", systemImage: "checkmark")
                            } else {
                                Text("\(view.name) • \(view.widgetCount)")
                            }
                        }
                    }
                } label: {
                    Label("Switch Dashboard", systemImage: "rectangle.3.group")
                }

                Button {
                    dashboardChrome.send(.toggleEditing)
                } label: {
                    Label(
                        dashboardChrome.isEditing ? "Exit Layout Editing" : "Edit Layout",
                        systemImage: dashboardChrome.isEditing ? "checkmark.circle" : "square.grid.3x3"
                    )
                }
                .disabled(!dashboardChrome.canEdit)

                if dashboardChrome.isEditing {
                    Button {
                        dashboardChrome.send(.createView)
                    } label: {
                        Label("Create View", systemImage: "rectangle.badge.plus")
                    }
                    .disabled(!dashboardChrome.canEdit)

                    Button {
                        dashboardChrome.send(.renameCurrentView)
                    } label: {
                        Label("Rename Current View", systemImage: "pencil")
                    }
                    .disabled(!dashboardChrome.canEdit || dashboardChrome.currentViewID.isEmpty)

                    Button {
                        dashboardChrome.send(.addWidget)
                    } label: {
                        Label("Add Widget", systemImage: "plus")
                    }
                    .disabled(!dashboardChrome.canEdit)

                    Button {
                        dashboardChrome.send(.save)
                    } label: {
                        Label("Save Layout", systemImage: "square.and.arrow.down")
                    }
                    .disabled(!dashboardChrome.canEdit || !dashboardChrome.isDirty || dashboardChrome.isSaving)
                }
            }

            Button {
                toggleVoiceCommands()
            } label: {
                Label(
                    voiceEnabled ? "Turn Voice Commands Off" : "Turn Voice Commands On",
                    systemImage: voiceEnabled ? "mic.slash" : "mic.fill"
                )
            }

            Picker("Appearance", selection: $themeModeRaw) {
                ForEach(HBThemeMode.allCases) { mode in
                    Label(mode.title, systemImage: mode.symbol)
                        .tag(mode.rawValue)
                }
            }

            Button {
                selection = .settings
            } label: {
                Label("Settings", systemImage: "gearshape")
            }

            Button {
                exitShell()
            } label: {
                Label(previewMode ? "Exit Preview" : "Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(HBPalette.textPrimary)
                .frame(width: chromeButtonSide, height: chromeButtonSide)
                .background(HBGlassBackground(cornerRadius: 14, variant: .panel))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("More")
    }

    private func chromeBrandCluster(compact: Bool, ultraCompact: Bool = false) -> some View {
        let subtitle = ultraCompact && showsDashboardChrome
            ? dashboardChrome.currentViewName
            : currentSection.title

        return HStack(spacing: compact ? 8 : 10) {
            Image("HomeBrainBrandIcon")
                .resizable()
                .scaledToFit()
                .frame(width: ultraCompact ? 20 : (compact ? 22 : 28), height: ultraCompact ? 20 : (compact ? 22 : 28))

            VStack(alignment: .leading, spacing: compact ? 1 : 2) {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Text("HomeBrain")
                        .font(.system(size: ultraCompact ? 13 : (compact ? 14 : 17), weight: .bold, design: .rounded))
                        .foregroundStyle(HBPalette.textPrimary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)

                    Text("OS")
                        .font(.system(size: 8, weight: .bold, design: .rounded))
                        .textCase(.uppercase)
                        .tracking(2.0)
                        .baselineOffset(compact ? 3 : 4)
                        .foregroundStyle(HBPalette.textMuted)
                }

                Text(subtitle)
                    .font(.system(size: ultraCompact ? 11 : (compact ? 12 : 14), weight: .semibold, design: .rounded))
                    .foregroundStyle(HBPalette.textSecondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
        }
        .frame(
            minWidth: ultraCompact ? 0 : (usesPortraitPhoneTopBar ? 132 : (isCompact ? 152 : (compact ? 178 : 208))),
            maxWidth: ultraCompact ? 158 : .infinity,
            alignment: .leading
        )
        .layoutPriority(2)
    }

    private func dashboardViewMenu(compact: Bool, ultraCompact: Bool = false) -> some View {
        Menu {
            ForEach(dashboardChrome.views) { view in
                Button {
                    dashboardChrome.send(.selectView(view.id))
                } label: {
                    if view.id == dashboardChrome.currentViewID {
                        Label("\(view.name) • \(view.widgetCount)", systemImage: "checkmark")
                    } else {
                        Text("\(view.name) • \(view.widgetCount)")
                    }
                }
            }
        } label: {
            HStack(spacing: compact ? 6 : 8) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(dashboardChrome.currentViewName)
                        .font(.system(size: ultraCompact ? 12 : (compact ? 13 : 14), weight: .semibold, design: .rounded))
                        .foregroundStyle(HBPalette.textPrimary)
                        .lineLimit(1)

                    Text(dashboardChromeStatusText)
                        .font(.system(size: ultraCompact ? 9 : (compact ? 10 : 11), weight: .bold, design: .rounded))
                        .foregroundStyle(dashboardChrome.isDirty ? HBPalette.accentOrange : HBPalette.textMuted)
                        .textCase(.uppercase)
                        .tracking(1.2)
                        .lineLimit(1)
                }

                Image(systemName: "chevron.down")
                    .font(.system(size: compact ? 10 : 11, weight: .bold))
                    .foregroundStyle(HBPalette.textMuted)
            }
            .frame(minWidth: ultraCompact ? 88 : (compact ? 128 : 156), maxWidth: ultraCompact ? 136 : .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func dashboardTopBarControls(compact: Bool) -> some View {
        if showsDashboardChrome {
            HStack(spacing: compact ? 8 : 10) {
                if dashboardChrome.isEditing {
                    chromeIconButton(
                        systemImage: "rectangle.badge.plus",
                        isDisabled: !dashboardChrome.canEdit
                    ) {
                        dashboardChrome.send(.createView)
                    }

                    chromeIconButton(
                        systemImage: "pencil",
                        isDisabled: !dashboardChrome.canEdit || dashboardChrome.currentViewID.isEmpty
                    ) {
                        dashboardChrome.send(.renameCurrentView)
                    }

                    chromeIconButton(
                        systemImage: "plus",
                        isDisabled: !dashboardChrome.canEdit
                    ) {
                        dashboardChrome.send(.addWidget)
                    }

                    chromeIconButton(
                        systemImage: "square.and.arrow.down",
                        isDisabled: !dashboardChrome.canEdit || !dashboardChrome.isDirty || dashboardChrome.isSaving
                    ) {
                        dashboardChrome.send(.save)
                    }
                }

                chromeIconButton(
                    systemImage: "square.grid.3x3",
                    isActive: dashboardChrome.isEditing,
                    isDisabled: !dashboardChrome.canEdit
                ) {
                    dashboardChrome.send(.toggleEditing)
                }
            }
        }
    }

    private func chromeSectionCluster(compact: Bool) -> some View {
        HStack(spacing: compact ? 8 : 10) {
            Circle()
                .fill(HBPalette.accentGreen)
                .frame(width: compact ? 10 : 12, height: compact ? 10 : 12)

            VStack(alignment: .leading, spacing: compact ? 1 : 3) {
                if !compact {
                    Text(currentSection.chromeKicker)
                        .font(.system(size: 10, weight: .bold, design: .rounded))
                        .textCase(.uppercase)
                        .tracking(2.8)
                        .foregroundStyle(HBPalette.textMuted)
                }

                Text(compact ? currentSection.title : currentSection.chromeLabel)
                    .font(.system(size: compact ? 14 : 17, weight: .bold, design: .rounded))
                    .foregroundStyle(HBPalette.textPrimary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.78)
            }
        }
        .padding(.horizontal, compact ? 10 : 14)
        .padding(.vertical, compact ? 7 : 10)
        .background(HBGlassBackground(cornerRadius: 22, variant: .panel))
        .layoutPriority(1)
    }

    private func voiceToggleButton(compact: Bool) -> some View {
        Button {
            toggleVoiceCommands()
        } label: {
            if compact {
                Label(
                    voiceEnabled
                    ? (voiceProcessing ? "Processing" : "Voice On")
                    : "Voice Off",
                    systemImage: voiceEnabled ? "mic.fill" : "mic.slash"
                )
                .labelStyle(.iconOnly)
                .font(.system(size: 14, weight: .semibold, design: .rounded))
            } else {
                Label(
                    voiceEnabled
                    ? (voiceProcessing ? "Processing" : "Voice On")
                    : "Voice Off",
                    systemImage: voiceEnabled ? "mic.fill" : "mic.slash"
                )
                .labelStyle(.titleAndIcon)
                .font(.system(size: 15, weight: .semibold, design: .rounded))
            }
        }
        .buttonStyle(HBSecondaryButtonStyle(compact: compact))
    }

    private func toggleVoiceCommands() {
        if previewMode {
            previewVoiceEnabled.toggle()
        } else {
            Task { await voiceAssistant.toggle() }
        }
    }

    private var resourceUtilizationStrip: some View {
        let noGPU = resourceStripMetrics.filter { $0.key != .gpu }
        let minimal = resourceStripMetrics.filter { $0.key == .cpu || $0.key == .ram }

        return Group {
            if isCompact && !isCompactHeight {
                resourceUtilizationStripContent(metrics: minimal, compact: true)
                    .frame(maxWidth: 150)
            } else if isCompactHeight {
                resourceUtilizationStripContent(metrics: resourceStripMetrics, compact: true)
                    .fixedSize(horizontal: true, vertical: false)
            } else if !usesSidebarDrawer {
                resourceUtilizationStripContent(metrics: resourceStripMetrics, compact: true)
                    .fixedSize(horizontal: true, vertical: false)
            } else {
                ViewThatFits(in: .horizontal) {
                    resourceUtilizationStripContent(metrics: resourceStripMetrics, compact: useCondensedChromeControls)
                    resourceUtilizationStripContent(metrics: noGPU, compact: useCondensedChromeControls)
                    resourceUtilizationStripContent(metrics: minimal, compact: true)
                }
                .frame(maxWidth: useCondensedChromeControls ? resourceStripCondensedMaxWidth : 310, alignment: .leading)
            }
        }
    }

    private func resourceUtilizationStripContent(metrics: [ResourceStripMetric], compact: Bool = false) -> some View {
        HStack(spacing: compact ? 8 : 10) {
            ForEach(Array(metrics.enumerated()), id: \.element.id) { index, metric in
                resourceMetricChip(metric, compact: compact)

                if index < metrics.count - 1 {
                    Capsule()
                        .fill(HBPalette.divider.opacity(0.8))
                        .frame(width: 1, height: compact ? 26 : 30)
                }
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
    }

    private func chromeIconButton(
        systemImage: String,
        isActive: Bool = false,
        isDisabled: Bool = false,
        action: @escaping () -> Void = {}
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(isDisabled ? HBPalette.textMuted : (isActive ? Color.white : HBPalette.textPrimary))
                .frame(width: chromeButtonSide, height: chromeButtonSide)
                .background(
                    Group {
                        if isActive {
                            Circle()
                                .fill(
                                    LinearGradient(
                                        colors: [HBPalette.accentBlue.opacity(0.98), HBPalette.accentPurple.opacity(0.9)],
                                        startPoint: .topLeading,
                                        endPoint: .bottomTrailing
                                    )
                                )
                                .overlay(
                                    Circle()
                                        .stroke(HBPalette.panelStrokeStrong.opacity(0.72), lineWidth: 1)
                                )
                        } else {
                            HBGlassBackground(cornerRadius: 14, variant: .panelSoft)
                                .opacity(isDisabled ? 0.54 : 1)
                        }
                    }
                )
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
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
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isCompactSidebarVisible ? "Close main menu" : "Open main menu")
    }

    private func syncNavigationPresentation(for width: CGFloat) {
        containerWidth = width

        let shouldUseDrawer = isCompact || width < 980
        if shouldUseDrawer {
            if !isCompact {
                isCompactSidebarCollapsed = false
            }
            isCompactSidebarVisible = false
        } else {
            isCompactSidebarVisible = false
        }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 12) {
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

            if !usesSidebarDrawer {
                if isSidebarCollapsed {
                    HBPanel {
                        VStack(spacing: 8) {
                            Circle()
                                .fill(voiceEnabled ? HBPalette.accentGreen : HBPalette.accentSlate)
                                .frame(width: 10, height: 10)

                            Image(systemName: voiceEnabled ? "mic.fill" : "mic.slash")
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundStyle(voiceEnabled ? HBPalette.accentBlue : HBPalette.textSecondary)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 4)
                    }
                } else {
                    HBPanel {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(spacing: 8) {
                                Circle()
                                    .fill(voiceEnabled ? HBPalette.accentGreen : HBPalette.accentSlate)
                                    .frame(width: 12, height: 12)

                                Text("Wake Mesh")
                                    .font(.system(size: 11, weight: .bold, design: .rounded))
                                    .textCase(.uppercase)
                                    .tracking(2.6)
                                    .foregroundStyle(HBPalette.textMuted)
                            }

                            Text(shellVoiceTitle)
                                .font(.system(size: 18, weight: .bold, design: .rounded))
                                .foregroundStyle(HBPalette.textPrimary)

                            Text(shellVoiceDescription)
                                .font(.system(size: 14, weight: .medium, design: .rounded))
                                .foregroundStyle(previewMode || voiceAssistant.errorMessage == nil ? HBPalette.textSecondary : HBPalette.accentRed)
                                .lineLimit(3)

                            if !previewMode, let pending = voiceAssistant.pendingWakeWord {
                                HBBadge(
                                    text: "Wake word: \(pending)",
                                    foreground: HBPalette.textPrimary,
                                    background: HBPalette.panelSoft.opacity(0.95),
                                    stroke: HBPalette.panelStrokeStrong
                                )
                            } else {
                                Text(shellVoiceSupplementaryText)
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
        }
        .padding(isSidebarCollapsed ? 10 : 14)
        .frame(width: sidebarWidth)
        .background(HBGlassBackground(cornerRadius: 30, variant: .panel))
    }

    private func sidebarButton(for section: AppSection) -> some View {
        let isSelected = selection == section

        return Button {
            selectSection(section)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: section.icon)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(isSelected ? HBPalette.accentBlue : HBPalette.textSecondary)
                    .frame(width: 28, height: 28)

                if !isSidebarCollapsed {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(section.title)
                            .font(.system(size: 15, weight: .semibold, design: .rounded))
                            .foregroundStyle(HBPalette.textPrimary)
                            .lineLimit(1)
                        Text(section.chromeKicker)
                            .font(.system(size: 10, weight: .bold, design: .rounded))
                            .foregroundStyle(isSelected ? HBPalette.accentBlue : HBPalette.textMuted)
                            .textCase(.uppercase)
                            .tracking(1.6)
                            .lineLimit(1)
                    }

                    Spacer(minLength: 0)

                    if isSelected {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(HBPalette.accentBlue)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: isSidebarCollapsed ? .center : .leading)
            .padding(.horizontal, isSidebarCollapsed ? 0 : 8)
            .padding(.vertical, 10)
            .background {
                if isSelected {
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [HBPalette.accentBlue.opacity(0.16), HBPalette.accentPurple.opacity(0.10)],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                }
            }
            .overlay(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(HBPalette.panelStrokeStrong.opacity(isSelected ? 0.46 : 0), lineWidth: 1)
            )
            .overlay(alignment: .leading) {
                if isSelected && !isSidebarCollapsed {
                    Capsule()
                        .fill(
                            LinearGradient(
                                colors: [HBPalette.accentBlue, HBPalette.accentPurple],
                                startPoint: .top,
                                endPoint: .bottom
                            )
                        )
                        .frame(width: 4, height: 34)
                        .padding(.leading, 2)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(section.title)
    }

    private func selectSection(_ section: AppSection) {
        if isCompact && isCompactSidebarVisible {
            withAnimation(.easeInOut(duration: 0.22)) {
                isCompactSidebarVisible = false
            }

            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(140))
                selection = section
            }
            return
        }

        selection = section
    }

    private var detailStack: some View {
        detailContent
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
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
            DashboardView(previewMode: previewMode)
                .environmentObject(dashboardChrome)
        case .weather:
            if previewMode {
                UIPreviewModuleView(section: section)
            } else {
                WeatherView()
            }
        case .views:
            if previewMode {
                UIPreviewModuleView(section: section)
            } else {
                DashboardViewsView()
            }
        case .devices:
            DevicesView(previewMode: previewMode)
        case .scenes:
            if previewMode {
                UIPreviewModuleView(section: section)
            } else {
                ScenesView()
            }
        case .workflows:
            if previewMode {
                UIPreviewModuleView(section: section)
            } else {
                WorkflowsView()
            }
        case .voiceDevices:
            if previewMode {
                UIPreviewModuleView(section: section)
            } else {
                VoiceDevicesView()
            }
        case .userProfiles:
            if previewMode {
                UIPreviewModuleView(section: section)
            } else {
                UserProfilesView()
            }
        case .settings:
            if previewMode {
                UIPreviewModuleView(section: section)
            } else {
                SettingsView()
            }
        case .operations:
            if previewMode {
                UIPreviewModuleView(section: section)
            } else {
                OperationsView()
            }
        case .platformDeploy:
            if previewMode {
                UIPreviewModuleView(section: section)
            } else {
                PlatformDeployView()
            }
        case .ollama:
            if previewMode {
                UIPreviewModuleView(section: section)
            } else {
                OllamaView()
            }
        case .whisper:
            if previewMode {
                UIPreviewModuleView(section: section)
            } else {
                WhisperView()
            }
        case .ssl:
            if previewMode {
                UIPreviewModuleView(section: section)
            } else {
                SSLView()
            }
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
        let gpuDetected = JSON.bool(gpu, "detected", fallback: gpuAvailable)
        let gpuPercent = normalizedResourcePercent(JSON.double(gpu, "usagePercent"))
        let memoryPercent = normalizedResourcePercent(JSON.double(memory, "usagePercent"))
        let diskPercent = normalizedResourcePercent(JSON.double(disk, "usagePercent"))

        resourceStripMetrics = [
            ResourceStripMetric(key: .cpu, shortLabel: "CPU", icon: "cpu", percent: cpuPercent, available: true),
            ResourceStripMetric(key: .gpu, shortLabel: "GPU", icon: "dial.medium", percent: gpuPercent, available: gpuDetected),
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

    private func previewResourceStripMetrics() -> [ResourceStripMetric] {
        [
            ResourceStripMetric(key: .cpu, shortLabel: "CPU", icon: "cpu", percent: 9, available: true),
            ResourceStripMetric(key: .gpu, shortLabel: "GPU", icon: "dial.medium", percent: 0, available: false),
            ResourceStripMetric(key: .ram, shortLabel: "RAM", icon: "memorychip", percent: 37, available: true),
            ResourceStripMetric(key: .disk, shortLabel: "DSK", icon: "externaldrive", percent: 42, available: true)
        ]
    }

    private func exitShell() {
        if previewMode {
            uiPreview.exit()
        } else {
            session.logout()
        }
    }
}
