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
    @State private var selection: AppSection? = .dashboard
    @State private var columnVisibility: NavigationSplitViewVisibility = .automatic

    private var visibleSections: [AppSection] {
        AppSection.allCases.filter { !($0.adminOnly && session.currentUser?.role != "admin") }
    }

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            List {
                Section("HomeBrain") {
                    ForEach(visibleSections) { section in
                        Button {
                            selection = section
                        } label: {
                            Label(section.title, systemImage: section.icon)
                        }
                        .buttonStyle(.plain)
                        .listRowBackground(
                            selection == section
                            ? Color.accentColor.opacity(0.15)
                            : Color.clear
                        )
                    }
                }
            }
            .listStyle(.sidebar)
            .navigationTitle("HomeBrain")
        } detail: {
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
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                if let user = session.currentUser {
                    Text("\(user.name) (\(user.role))")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

            ToolbarItem(placement: .topBarTrailing) {
                Button("Logout") {
                    session.logout()
                }
            }
        }
        .onAppear {
            syncSelectionWithVisibleSections()
        }
        .onChange(of: session.currentUser?.role) { _, _ in
            syncSelectionWithVisibleSections()
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
}
