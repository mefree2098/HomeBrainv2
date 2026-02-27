import SwiftUI

struct AppShellView: View {
    enum AppSection: String, CaseIterable, Identifiable {
        case dashboard
        case devices
        case scenes
        case automations
        case workflows
        case voiceDevices
        case userProfiles
        case settings
        case operations
        case platformDeploy
        case ollama
        case whisper
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

    @State private var selection: AppSection? = .dashboard
    @State private var isVoiceMuted = true
    @State private var activeDevicesSummary = "--/--"

    private var isCompact: Bool { horizontalSizeClass == .compact }

    private var visibleSections: [AppSection] {
        AppSection.allCases.filter { !($0.adminOnly && session.currentUser?.role != "admin") }
    }

    var body: some View {
        ZStack {
            HBPageBackground()
                .ignoresSafeArea()

            if isCompact {
                compactShell
            } else {
                regularShell
            }
        }
        .tint(HBPalette.accentBlue)
        .preferredColorScheme(.dark)
        .onAppear {
            syncSelectionWithVisibleSections()
        }
        .onChange(of: session.currentUser?.role) { _, _ in
            syncSelectionWithVisibleSections()
        }
        .task(id: session.currentUser?.id ?? "guest") {
            await refreshHeaderSummary()
        }
    }

    private var regularShell: some View {
        VStack(spacing: 0) {
            topBar

            HStack(spacing: 0) {
                sidebar
                detailStack
            }
        }
    }

    private var compactShell: some View {
        VStack(spacing: 0) {
            topBar
            detailStack
        }
    }

    private var topBar: some View {
        HStack(spacing: 10) {
            if isCompact {
                sectionsMenuButton
            }

            Text("Home Brain")
                .font(.system(size: isCompact ? 18 : 32, weight: .bold, design: .rounded))
                .foregroundStyle(
                    LinearGradient(
                        colors: [HBPalette.accentBlue, HBPalette.accentPurple],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                )
                .lineLimit(1)
                .minimumScaleFactor(0.8)

            Text(isCompact ? activeDevicesSummary : "\(activeDevicesSummary) devices active")
                .font(.system(size: 14, weight: .semibold, design: .rounded))
                .foregroundStyle(Color.black.opacity(0.85))
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Color.white.opacity(0.92), in: Capsule())
                .lineLimit(1)

            Spacer(minLength: 8)

            Button {
                isVoiceMuted.toggle()
            } label: {
                Group {
                    if isCompact {
                        Label("", systemImage: isVoiceMuted ? "mic.slash" : "mic")
                            .labelStyle(.iconOnly)
                    } else {
                        Label(isVoiceMuted ? "Voice Off" : "Voice On", systemImage: isVoiceMuted ? "mic.slash" : "mic")
                            .labelStyle(.titleAndIcon)
                    }
                }
                .font(.system(size: 15, weight: .semibold, design: .rounded))
                .foregroundStyle(HBPalette.textPrimary)
                .padding(.horizontal, isCompact ? 10 : 14)
                .padding(.vertical, 8)
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
        .padding(.vertical, 12)
        .background(HBPalette.chrome.opacity(0.98))
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color.white.opacity(0.08))
                .frame(height: 1)
        }
    }

    private var sectionsMenuButton: some View {
        Menu {
            if let user = session.currentUser {
                Section("Signed In") {
                    Text("\(user.name) (\(user.role))")
                }
            }

            Section("Sections") {
                ForEach(visibleSections) { section in
                    Button {
                        selection = section
                    } label: {
                        if selection == section {
                            Label(section.title, systemImage: "checkmark")
                        } else {
                            Label(section.title, systemImage: section.icon)
                        }
                    }
                }
            }
        } label: {
            Image(systemName: "line.3.horizontal")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(HBPalette.textPrimary)
                .frame(width: 36, height: 36)
                .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
    }

    private func chromeIconButton(systemImage: String, action: @escaping () -> Void = {}) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(HBPalette.textSecondary)
                .frame(width: 36, height: 36)
                .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(visibleSections) { section in
                Button {
                    selection = section
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: section.icon)
                            .font(.system(size: 15, weight: .semibold))
                            .frame(width: 18)

                        Text(section.title)
                            .font(.system(size: 24, weight: .semibold, design: .rounded))

                        Spacer()

                        if selection == section {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 12, weight: .bold))
                        }
                    }
                    .foregroundStyle(selection == section ? HBPalette.textPrimary : HBPalette.textSecondary)
                    .padding(.horizontal, 14)
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
            }

            Spacer()

            HBPanel {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Voice Commands Active")
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .foregroundStyle(HBPalette.textPrimary)
                    Text("Say \"Hey Anna\" or \"Henry\" to control your home")
                        .font(.system(size: 12, weight: .regular, design: .rounded))
                        .foregroundStyle(HBPalette.textSecondary)
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 12)
        .frame(width: 245)
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
                .padding(isCompact ? 12 : 16)
        }
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
                .navigationTitle(current.title)
                .navigationBarTitleDisplayMode(.inline)
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
}
