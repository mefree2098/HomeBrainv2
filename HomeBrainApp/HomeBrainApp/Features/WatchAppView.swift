import SwiftUI

private enum IOSWatchSection: String, CaseIterable, Identifiable {
    case security
    case lights
    case power
    case weather

    var id: String { rawValue }

    var title: String {
        switch self {
        case .security: return "Security"
        case .lights: return "Room Lights"
        case .power: return "Power"
        case .weather: return "Weather"
        }
    }

    var subtitle: String {
        switch self {
        case .security: return "Arm stay, arm away, and disarm controls."
        case .lights: return "Fast controls for the room you choose below."
        case .power: return "Live whole-home draw and energy glance."
        case .weather: return "Current conditions and today at a glance."
        }
    }

    var symbol: String {
        switch self {
        case .security: return "shield.lefthalf.filled"
        case .lights: return "lightbulb.fill"
        case .power: return "bolt.fill"
        case .weather: return "cloud.sun.fill"
        }
    }

    var tint: Color {
        switch self {
        case .security: return HBPalette.accentGreen
        case .lights: return HBPalette.accentYellow
        case .power: return HBPalette.accentBlue
        case .weather: return HBPalette.accentPurple
        }
    }
}

private struct WatchRoomOption: Identifiable, Hashable {
    let name: String
    let lightCount: Int
    let onCount: Int

    var id: String { name }
}

struct WatchAppView: View {
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var watchSync: WatchSyncManager

    @State private var enabledSections = Set(IOSWatchSection.allCases)
    @State private var availableRooms: [WatchRoomOption] = []
    @State private var primaryRoom = ""
    @State private var defaultBrightness = 70.0
    @State private var isLoading = false
    @State private var isSaving = false
    @State private var statusMessage: String?
    @State private var errorMessage: String?

    private var selectedRoomLabel: String {
        primaryRoom.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Auto-select room" : primaryRoom
    }

    private var watchStatusText: String {
        guard watchSync.isSupported else { return "Watch sync unavailable" }
        guard watchSync.isPaired else { return "No paired Apple Watch" }
        guard watchSync.isWatchAppInstalled else { return "Install the Watch app" }
        return watchSync.isReachable ? "Apple Watch reachable" : "Ready for next watch launch"
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HBSectionHeader(
                    title: "Watch App",
                    subtitle: "Choose the watch surfaces for your account and send this iPhone's signed-in HomeBrain session to Apple Watch.",
                    eyebrow: "Personal Control Surface",
                    showBrandIcon: true,
                    buttonTitle: "Refresh",
                    buttonIcon: "arrow.clockwise"
                ) {
                    Task { await loadConfig() }
                }

                pairingPanel
                screensPanel
                lightsPanel
            }
            .padding(18)
        }
        .task {
            watchSync.bind(sessionStore: session)
            await loadConfig()
        }
        .onChange(of: session.isAuthenticated) { _, isAuthenticated in
            Task {
                if isAuthenticated {
                    _ = await watchSync.syncNow()
                    await loadConfig()
                } else {
                    watchSync.clearWatchSession()
                }
            }
        }
    }

    private var pairingPanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 14) {
                panelHeading("iPhone Pairing", symbol: "applewatch.radiowaves.left.and.right", tint: HBPalette.accentBlue)

                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: watchSync.isWatchAppInstalled ? "checkmark.seal.fill" : "applewatch")
                        .font(.system(size: 24, weight: .semibold))
                        .foregroundStyle(watchSync.isWatchAppInstalled ? HBPalette.accentGreen : HBPalette.accentOrange)
                        .frame(width: 42, height: 42)
                        .background(HBGlassBackground(cornerRadius: 14, variant: .panelSoft))

                    VStack(alignment: .leading, spacing: 5) {
                        Text(watchStatusText)
                            .font(.system(size: 17, weight: .bold, design: .rounded))
                            .foregroundStyle(HBPalette.textPrimary)
                        Text(syncDetailText)
                            .font(.system(size: 13, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textSecondary)
                    }

                    Spacer(minLength: 0)
                }

                HStack(spacing: 10) {
                    Button {
                        Task {
                            let ok = await watchSync.syncNow()
                            statusMessage = ok ? "HomeBrain session sent to Apple Watch." : nil
                            errorMessage = ok ? nil : watchSync.lastErrorMessage
                        }
                    } label: {
                        Label("Sync Session", systemImage: "arrow.up.forward.circle.fill")
                    }
                    .buttonStyle(HBPrimaryButtonStyle(compact: true))
                    .disabled(!session.isAuthenticated)

                    Button {
                        watchSync.clearWatchSession()
                        statusMessage = "Watch sign-in cleared."
                    } label: {
                        Label("Clear Watch", systemImage: "xmark.circle")
                    }
                    .buttonStyle(HBSecondaryButtonStyle(compact: true))
                }

                if let statusMessage {
                    Text(statusMessage)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(HBPalette.accentGreen)
                }

                if let errorMessage = errorMessage ?? watchSync.lastErrorMessage {
                    Text(errorMessage)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(HBPalette.accentRed)
                }
            }
        }
    }

    private var screensPanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 14) {
                panelHeading("Watch Screens", symbol: "rectangle.stack.fill", tint: HBPalette.accentPurple)

                LazyVGrid(columns: [GridItem(.adaptive(minimum: 210), spacing: 12)], spacing: 12) {
                    ForEach(IOSWatchSection.allCases) { section in
                        sectionToggle(section)
                    }
                }

                saveButton
            }
        }
    }

    private var lightsPanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 14) {
                panelHeading("Room Lights", symbol: "lightbulb.2.fill", tint: HBPalette.accentYellow)

                VStack(alignment: .leading, spacing: 8) {
                    Text("Primary room")
                        .font(.system(size: 12, weight: .bold, design: .rounded))
                        .textCase(.uppercase)
                        .tracking(2.0)
                        .foregroundStyle(HBPalette.textMuted)

                    Picker("Primary room", selection: $primaryRoom) {
                        Text("Auto-select room").tag("")
                        ForEach(availableRooms) { room in
                            Text("\(room.name) • \(room.onCount)/\(room.lightCount) on").tag(room.name)
                        }
                    }
                    .pickerStyle(.menu)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
                    .background(HBGlassBackground(cornerRadius: 16, variant: .panelSoft))
                }

                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("Default brightness")
                            .font(.system(size: 12, weight: .bold, design: .rounded))
                            .textCase(.uppercase)
                            .tracking(2.0)
                            .foregroundStyle(HBPalette.textMuted)
                        Spacer()
                        Text("\(Int(defaultBrightness.rounded()))%")
                            .font(.system(size: 15, weight: .bold, design: .rounded))
                            .foregroundStyle(HBPalette.textPrimary)
                    }
                    Slider(value: $defaultBrightness, in: 1...100, step: 1)
                        .tint(HBPalette.accentYellow)
                }

                saveButton
            }
        }
    }

    private var syncDetailText: String {
        if let lastSyncDate = watchSync.lastSyncDate {
            return "Last sync \(DateFormatter.localizedString(from: lastSyncDate, dateStyle: .none, timeStyle: .short)). Server: \(session.serverURLString)"
        }
        return session.isAuthenticated ? "No session sent yet. Server: \(session.serverURLString)" : "Sign in on this iPhone to send HomeBrain to the watch."
    }

    private var saveButton: some View {
        Button {
            Task { await saveConfig() }
        } label: {
            Label(isSaving ? "Saving" : "Save Watch Layout", systemImage: "checkmark.circle.fill")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(HBPrimaryButtonStyle(compact: true))
        .disabled(isSaving || isLoading)
    }

    private func sectionToggle(_ section: IOSWatchSection) -> some View {
        let isOn = Binding<Bool>(
            get: { enabledSections.contains(section) },
            set: { nextValue in
                if nextValue {
                    enabledSections.insert(section)
                } else if enabledSections.count > 1 {
                    enabledSections.remove(section)
                }
            }
        )

        return HBCardRow {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: section.symbol)
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(section.tint)
                    .frame(width: 40, height: 40)
                    .background(HBGlassBackground(cornerRadius: 14, variant: .panel))

                VStack(alignment: .leading, spacing: 4) {
                    Text(section.title)
                        .font(.system(size: 16, weight: .bold, design: .rounded))
                        .foregroundStyle(HBPalette.textPrimary)
                    Text(section.subtitle)
                        .font(.system(size: 12, weight: .medium, design: .rounded))
                        .foregroundStyle(HBPalette.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 6)
                Toggle(section.title, isOn: isOn)
                    .labelsHidden()
                    .tint(section.tint)
            }
        }
    }

    private func panelHeading(_ title: String, symbol: String, tint: Color) -> some View {
        HStack(spacing: 10) {
            Image(systemName: symbol)
                .font(.system(size: 16, weight: .bold))
                .foregroundStyle(tint)
            Text(title)
                .font(.system(size: 18, weight: .bold, design: .rounded))
                .foregroundStyle(HBPalette.textPrimary)
        }
    }

    private func loadConfig() async {
        guard session.isAuthenticated else {
            return
        }

        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            let response = try await session.apiClient.get("/api/watch/config")
            let root = JSON.object(response)
            let config = JSON.object(root["config"])
            let sections = (config["sections"] as? [String] ?? [])
                .compactMap(IOSWatchSection.init(rawValue:))
            enabledSections = Set(sections.isEmpty ? IOSWatchSection.allCases : sections)
            primaryRoom = JSON.string(config, "primaryRoom")
            defaultBrightness = Double(JSON.int(config, "defaultLightBrightness", fallback: 70))
            availableRooms = JSON.array(root["availableRooms"]).map { room in
                WatchRoomOption(
                    name: JSON.string(room, "name", fallback: "Unassigned"),
                    lightCount: JSON.int(room, "lightCount"),
                    onCount: JSON.int(room, "onCount")
                )
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func saveConfig() async {
        guard session.isAuthenticated else {
            errorMessage = "Sign in before changing watch settings."
            return
        }

        isSaving = true
        statusMessage = nil
        errorMessage = nil
        defer { isSaving = false }

        let payload: [String: Any] = [
            "sections": IOSWatchSection.allCases
                .filter { enabledSections.contains($0) }
                .map(\.rawValue),
            "primaryRoom": primaryRoom,
            "defaultLightBrightness": Int(defaultBrightness.rounded())
        ]

        do {
            let response = try await session.apiClient.put("/api/watch/config", body: payload)
            let root = JSON.object(response)
            let config = JSON.object(root["config"])
            primaryRoom = JSON.string(config, "primaryRoom", fallback: primaryRoom)
            defaultBrightness = Double(JSON.int(config, "defaultLightBrightness", fallback: Int(defaultBrightness.rounded())))
            statusMessage = "Watch layout saved."
            _ = await watchSync.syncNow()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
