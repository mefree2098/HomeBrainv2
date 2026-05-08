import SwiftUI
import UIKit

struct DevicesView: View {
    let previewMode: Bool
    let embeddedFocusDeviceID: String?
    let onClose: (() -> Void)?

    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var deviceFocusState: DeviceFocusState
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    @State private var devices: [DeviceItem] = []
    @State private var isLoading = true
    @State private var errorMessage: String?

    @State private var searchText = ""
    @State private var typeFilter = "all"
    @State private var sourceFilter = DeviceItem.allSelectionSourcesValue

    @State private var lightBrightnessDrafts: [String: Double] = [:]
    @State private var lightColorDrafts: [String: String] = [:]
    @State private var thermostatTemperatureDrafts: [String: Double] = [:]
    @State private var pendingControls: Set<String> = []
    @State private var controlFeedback: [String: ControlFeedback] = [:]
    @State private var favoriteDeviceIds: Set<String> = []
    @State private var favoritesProfileId: String?
    @State private var pendingFavoriteDeviceIds: Set<String> = []
    @State private var highlightedDeviceID: String?
    @State private var pendingMigrationDeviceIds: Set<String> = []
    @State private var pendingMigrationPlanDeviceIds: Set<String> = []
    @State private var migrationFeedback: [String: String] = [:]
    @State private var migrationPlans: [String: DirectRadioMigrationPlanRecord] = [:]
    @State private var migrationPlanErrors: [String: String] = [:]
    @State private var matterControllerReady = false
    @State private var matterRcpDetected = false
    @State private var matterOtbrOnline = false
    @State private var matterThreadReady = false
    @State private var matterLatestSessionStatus: String?
    @State private var matterStatusMessage: String?
    @State private var matterIsLoading = false
    @State private var matterIsCommissioning = false
    @State private var matterSetupCode = ""
    @State private var matterTransport = "thread"
    @State private var matterKnownAddress = ""
    @State private var matterRoom = "Unassigned"
    @State private var matterDeviceName = ""
    @State private var matterWifiSsid = ""
    @State private var matterWifiPassword = ""
    @State private var matterThreadDataset = ""

    @State private var showCreateSheet = false
    @State private var newName = ""
    @State private var newType = "light"
    @State private var newRoom = ""
    @State private var contentWidth: CGFloat = 0

    private let availableTypes = ["all", "light", "lock", "thermostat", "garage", "sensor", "switch", "camera"]
    private let thermostatModes = ["auto", "cool", "heat", "off"]

    private enum ControlFeedback: Equatable {
        case success
        case failure
    }

    private var isCompact: Bool { horizontalSizeClass == .compact }
    private var isCompactHeight: Bool { verticalSizeClass == .compact }
    private var useLandscapeCompactLayout: Bool { isCompact && isCompactHeight }
    private var useTwoColumnLayout: Bool { useLandscapeCompactLayout || contentWidth >= 860 }
    private var usesStackedFilterLayout: Bool { contentWidth < 620 }
    private var isEmbeddedFocusMode: Bool { embeddedFocusDeviceID?.isEmpty == false }
    private var embeddedFocusedDevice: DeviceItem? {
        guard let embeddedFocusDeviceID else { return nil }
        return devices.first(where: { $0.id == embeddedFocusDeviceID })
    }

    private var gridColumns: [GridItem] {
        if useTwoColumnLayout {
            return [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]
        }
        return [GridItem(.flexible(), spacing: 12)]
    }

    private var filteredDevices: [DeviceItem] {
        devices.filter { device in
            let matchesSearchAndSource = device.matchesSelectionFilters(
                searchText: searchText,
                sourceFilter: sourceFilter
            )
            let matchesType: Bool
            if typeFilter == "all" {
                matchesType = true
            } else if typeFilter == "light" {
                matchesType = supportsLightFade(device)
            } else {
                matchesType = device.type == typeFilter
            }
            return matchesSearchAndSource && matchesType
        }
    }

    private var sourceFilterLabel: String {
        DeviceItem.selectionSourceOptions(for: devices)
            .first(where: { $0.value == sourceFilter })?
            .label ?? "All sources"
    }

    private var thermostatDevices: [DeviceItem] {
        filteredDevices.filter { $0.type == "thermostat" }
    }

    private var nonThermostatDevices: [DeviceItem] {
        filteredDevices.filter { $0.type != "thermostat" }
    }

    init(previewMode: Bool = false, embeddedFocusDeviceID: String? = nil, onClose: (() -> Void)? = nil) {
        self.previewMode = previewMode
        self.embeddedFocusDeviceID = embeddedFocusDeviceID
        self.onClose = onClose
    }

    var body: some View {
        GeometryReader { proxy in
            ScrollViewReader { scrollProxy in
                Group {
                    if isLoading {
                        LoadingView(title: "Loading devices...")
                            .padding(useLandscapeCompactLayout ? 10 : 16)
                    } else if isEmbeddedFocusMode {
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 12) {
                                embeddedDeviceHeaderPanel

                                if let errorMessage {
                                    InlineErrorView(message: errorMessage) {
                                        Task { await loadDevices(showLoading: true) }
                                    }
                                }

                                matterControllerPanel

                                if let embeddedFocusedDevice {
                                    focusedDeviceCard(embeddedFocusedDevice)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                } else {
                                    EmptyStateView(
                                        title: "Device unavailable",
                                        subtitle: "This security sensor is not currently available in the device catalog."
                                    )
                                }
                            }
                            .padding(useLandscapeCompactLayout ? 10 : 16)
                            .padding(.bottom, 8)
                        }
                        .scrollIndicators(.hidden)
                        .refreshable {
                            await loadDevices(showLoading: false)
                        }
                    } else {
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: useLandscapeCompactLayout ? 10 : 12) {
                                deviceHeaderPanel

                                if let errorMessage {
                                    InlineErrorView(message: errorMessage) {
                                        Task { await loadDevices(showLoading: true) }
                                    }
                                }

                                if filteredDevices.isEmpty {
                                    EmptyStateView(
                                        title: "No devices match",
                                        subtitle: "Adjust filters or create a new device."
                                    )
                                } else {
                                    VStack(alignment: .leading, spacing: 12) {
                                        ForEach(thermostatDevices) { device in
                                            focusedDeviceCard(device)
                                                .frame(maxWidth: .infinity, alignment: .leading)
                                        }

                                        if !nonThermostatDevices.isEmpty {
                                            LazyVGrid(columns: gridColumns, spacing: 12) {
                                                ForEach(nonThermostatDevices) { device in
                                                    focusedDeviceCard(device)
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            .padding(useLandscapeCompactLayout ? 10 : 16)
                            .padding(.bottom, 8)
                        }
                        .scrollIndicators(.hidden)
                        .refreshable {
                            await loadDevices(showLoading: false)
                        }
                    }
                }
                .onChange(of: deviceFocusState.request?.token) { _, _ in
                    applyPendingDeviceFocus(using: scrollProxy)
                }
                .onChange(of: devices.map(\.id)) { _, _ in
                    applyPendingDeviceFocus(using: scrollProxy)
                }
            }
            .onAppear {
                contentWidth = proxy.size.width
            }
            .onChange(of: proxy.size.width) { _, newWidth in
                contentWidth = newWidth
            }
        }
        .sheet(isPresented: $showCreateSheet) {
            createDeviceSheet
        }
        .task {
            await loadDevices(showLoading: true)
        }
    }

    private func focusedDeviceCard(_ device: DeviceItem) -> some View {
        let isHighlighted = highlightedDeviceID == device.id

        return deviceCard(device)
            .id(device.id)
            .overlay(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .stroke(isHighlighted ? HBPalette.accentBlue.opacity(0.9) : Color.clear, lineWidth: 2)
            )
            .shadow(color: isHighlighted ? HBPalette.accentBlue.opacity(0.22) : .clear, radius: 18)
    }

    private var embeddedDeviceHeaderPanel: some View {
        HBPanel {
            HStack(alignment: .top, spacing: 14) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Security Device")
                        .font(.system(size: 11, weight: .bold, design: .rounded))
                        .textCase(.uppercase)
                        .tracking(2.2)
                        .foregroundStyle(HBPalette.textMuted)

                    Text(embeddedFocusedDevice?.name ?? "Device unavailable")
                        .font(.system(size: useLandscapeCompactLayout ? 20 : 22, weight: .bold, design: .rounded))
                        .foregroundStyle(HBPalette.textPrimary)

                    Text(embeddedFocusedDevice?.room ?? "Close this panel to return to the Security Center exactly where you left it.")
                        .font(.system(size: 14, weight: .medium, design: .rounded))
                        .foregroundStyle(HBPalette.textSecondary)
                }

                Spacer(minLength: 12)

                if let onClose {
                    Button(action: onClose) {
                        Label("Back", systemImage: "chevron.left")
                    }
                    .buttonStyle(HBSecondaryButtonStyle(compact: true))
                }
            }
        }
    }

    private var deviceHeaderPanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 16) {
                HBSectionHeader(
                    title: "Smart Devices",
                    subtitle: "Manage dimming, color, thermostat, and power controls across the residence mesh.",
                    eyebrow: "Hardware Orchestration",
                    buttonTitle: "Add Device",
                    buttonIcon: "plus"
                ) {
                    showCreateSheet = true
                }

                filterPanel

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        HBBadge(text: "\(filteredDevices.count) matched")
                        HBBadge(text: "\(devices.filter(\.isOnline).count) online")
                        HBBadge(text: typeFilter == "all" ? "All types" : typeFilter.capitalized)
                        HBBadge(text: sourceFilter == DeviceItem.allSelectionSourcesValue ? "All sources" : sourceFilterLabel)
                        if !searchText.isEmpty {
                            HBBadge(text: "Search active")
                        }
                    }
                }
            }
        }
    }

    private var filterPanel: some View {
        HBCardRow {
            VStack(alignment: .leading, spacing: 12) {
                TextField("Search devices", text: $searchText)
                    .hbPanelTextField()

                if usesStackedFilterLayout {
                    VStack(alignment: .leading, spacing: 10) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Filter Matrix")
                                .font(.system(size: 11, weight: .bold, design: .rounded))
                                .textCase(.uppercase)
                                .tracking(2.2)
                                .foregroundStyle(HBPalette.textMuted)
                            Text("Type")
                                .font(.system(size: 14, weight: .semibold, design: .rounded))
                                .foregroundStyle(HBPalette.textSecondary)
                        }

                        Picker("Type", selection: $typeFilter) {
                            ForEach(availableTypes, id: \.self) { type in
                                Text(type.capitalized).tag(type)
                            }
                        }
                        .pickerStyle(.menu)
                        .tint(HBPalette.accentBlue)

                        VStack(alignment: .leading, spacing: 4) {
                            Text("Source")
                                .font(.system(size: 14, weight: .semibold, design: .rounded))
                                .foregroundStyle(HBPalette.textSecondary)
                            Picker("Source", selection: $sourceFilter) {
                                ForEach(DeviceItem.selectionSourceOptions(for: devices)) { option in
                                    Text(option.label).tag(option.value)
                                }
                            }
                            .pickerStyle(.menu)
                            .tint(HBPalette.accentBlue)
                        }
                    }
                } else {
                    HStack(spacing: 14) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Filter Matrix")
                                .font(.system(size: 11, weight: .bold, design: .rounded))
                                .textCase(.uppercase)
                                .tracking(2.2)
                                .foregroundStyle(HBPalette.textMuted)
                            Text("Type")
                                .font(.system(size: 14, weight: .semibold, design: .rounded))
                                .foregroundStyle(HBPalette.textSecondary)
                        }
                        Spacer(minLength: 12)
                        Picker("Type", selection: $typeFilter) {
                            ForEach(availableTypes, id: \.self) { type in
                                Text(type.capitalized).tag(type)
                            }
                        }
                        .pickerStyle(.menu)
                        .tint(HBPalette.accentBlue)

                        VStack(alignment: .leading, spacing: 4) {
                            Text("Source")
                                .font(.system(size: 14, weight: .semibold, design: .rounded))
                                .foregroundStyle(HBPalette.textSecondary)
                            Picker("Source", selection: $sourceFilter) {
                                ForEach(DeviceItem.selectionSourceOptions(for: devices)) { option in
                                    Text(option.label).tag(option.value)
                                }
                            }
                            .pickerStyle(.menu)
                            .tint(HBPalette.accentBlue)
                        }
                    }
                }
            }
        }
    }

    private func deviceCard(_ device: DeviceItem) -> some View {
        HBPanel {
            VStack(alignment: .leading, spacing: useLandscapeCompactLayout ? 10 : 12) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: iconName(for: device))
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(Color.white)
                        .frame(width: 38, height: 38)
                        .background(
                            LinearGradient(
                                colors: device.status
                                    ? [HBPalette.accentGreen, HBPalette.accentBlue]
                                    : [HBPalette.accentSlate, HBPalette.panelSoft],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            ),
                            in: Circle()
                        )

                    VStack(alignment: .leading, spacing: 4) {
                        Text(device.name)
                            .font(.system(size: useLandscapeCompactLayout ? 18 : 20, weight: .bold, design: .rounded))
                            .foregroundStyle(HBPalette.textPrimary)
                            .lineLimit(2)
                        Text(device.room)
                            .font(.system(size: useLandscapeCompactLayout ? 13 : 14, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textSecondary)
                        Text(device.isOnline ? "Online" : "Offline")
                            .font(.system(size: useLandscapeCompactLayout ? 11 : 12, weight: .semibold, design: .rounded))
                            .foregroundStyle(device.isOnline ? HBPalette.accentGreen : Color.red.opacity(0.85))
                    }

                    Spacer(minLength: 0)

                    favoriteButton(for: device)
                }

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        statusBadge(for: device)
                        HBBadge(
                            text: device.type.uppercased(),
                            foreground: HBPalette.textPrimary,
                            background: HBPalette.panelSoft.opacity(0.88),
                            stroke: HBPalette.panelStrokeStrong
                        )
                        HBBadge(
                            text: device.selectionSourceLabel,
                            foreground: HBPalette.textPrimary,
                            background: HBPalette.panelSoft.opacity(0.88),
                            stroke: HBPalette.panelStrokeStrong
                        )
                        if supportsLightFade(device) && device.type != "thermostat" {
                            HBBadge(
                                text: "Dimmable",
                                foreground: HBPalette.textPrimary,
                                background: HBPalette.panelSoft.opacity(0.88),
                                stroke: HBPalette.panelStrokeStrong
                            )
                        }
                        if supportsLightColor(device) {
                            HBBadge(
                                text: "Color",
                                foreground: HBPalette.textPrimary,
                                background: HBPalette.panelSoft.opacity(0.88),
                                stroke: HBPalette.panelStrokeStrong
                            )
                        }
                    }
                }

                if device.type == "thermostat" {
                    thermostatControls(for: device)
                } else if supportsLightFade(device) {
                    lightControls(for: device)
                } else {
                    defaultPowerControl(for: device)
                }

                controlFeedbackView(for: device)

                if isSmartThingsBackedDevice(device) {
                    directRadioMigrationPanel(for: device)
                }

                Text(voiceHint(for: device))
                    .font(.system(size: 13, weight: .medium, design: .rounded))
                    .foregroundStyle(HBPalette.textSecondary)
                    .lineLimit(3)
            }
        }
        .contextMenu {
            Button(role: .destructive) {
                Task { await deleteDevice(device) }
            } label: {
                Label("Delete Device", systemImage: "trash")
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

    private func directRadioMigrationPanel(for device: DeviceItem) -> some View {
        let isPending = pendingMigrationDeviceIds.contains(device.id)
        let planLoading = pendingMigrationPlanDeviceIds.contains(device.id)
        let plan = migrationPlans[device.id]
        let planError = migrationPlanErrors[device.id]
        let feedback = migrationFeedback[device.id]

        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 8) {
                Image(systemName: "antenna.radiowaves.left.and.right")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(HBPalette.accentBlue)
                Text("Migrate to HomeBrain")
                    .font(.system(size: 13, weight: .bold, design: .rounded))
                    .foregroundStyle(HBPalette.textPrimary)
                Spacer(minLength: 0)
                if isPending {
                    ProgressView()
                        .controlSize(.small)
                }
            }

            Text("Start pairing, then put the device into reset or inclusion mode. Z-Wave devices should run exclusion first.")
                .font(.system(size: 12, weight: .medium, design: .rounded))
                .foregroundStyle(HBPalette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

            if planLoading {
                HStack(spacing: 8) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Loading migration plan...")
                        .font(.system(size: 12, weight: .semibold, design: .rounded))
                        .foregroundStyle(HBPalette.textSecondary)
                }
            } else if let planError {
                Text(planError)
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                    .foregroundStyle(HBPalette.accentRed)
                    .fixedSize(horizontal: false, vertical: true)
            } else if let plan {
                directRadioMigrationPlanSummary(plan)
            }

            HStack(spacing: 8) {
                Button {
                    Task { await startDirectRadioMigration(device, protocolName: "zigbee") }
                } label: {
                    Label("Zigbee", systemImage: "dot.radiowaves.left.and.right")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(HBSecondaryButtonStyle(compact: true))
                .disabled(isPending || plan?.supported == false)

                Button {
                    Task { await startDirectRadioMigration(device, protocolName: "zwave") }
                } label: {
                    Label("Z-Wave", systemImage: "wave.3.right")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(HBSecondaryButtonStyle(compact: true))
                .disabled(isPending || plan?.supported == false)
            }

            if let feedback {
                Text(feedback)
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                    .foregroundStyle(HBPalette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(12)
        .background(HBGlassBackground(cornerRadius: 16, variant: .panelSoft))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(HBPalette.panelStroke.opacity(0.6), lineWidth: 1)
        )
        .task(id: device.id) {
            await loadDirectRadioMigrationPlan(for: device)
        }
    }

    private func directRadioMigrationPlanSummary(_ plan: DirectRadioMigrationPlanRecord) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Recommended radio")
                        .font(.system(size: 10, weight: .bold, design: .rounded))
                        .textCase(.uppercase)
                        .tracking(1.6)
                        .foregroundStyle(HBPalette.textMuted)
                    Text(plan.recommendedProtocolLabel)
                        .font(.system(size: 14, weight: .bold, design: .rounded))
                        .foregroundStyle(HBPalette.textPrimary)
                }
                Spacer()
                Text(plan.supported ? "\(plan.nativeFeatureCount)/\(max(plan.featureSupport.count, 1)) native" : "Blocked")
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .foregroundStyle(plan.supported ? HBPalette.accentGreen : HBPalette.accentRed)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(HBPalette.panelSoft.opacity(0.72), in: Capsule())
            }

            if !plan.warnings.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(plan.warnings.prefix(3).enumerated()), id: \.offset) { _, warning in
                        Text(warning)
                            .font(.system(size: 11, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.accentOrange)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

            if !plan.manualSteps.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Manual steps")
                        .font(.system(size: 10, weight: .bold, design: .rounded))
                        .textCase(.uppercase)
                        .tracking(1.6)
                        .foregroundStyle(HBPalette.textMuted)
                    ForEach(Array(plan.manualSteps.prefix(4).enumerated()), id: \.offset) { index, step in
                        Text("\(index + 1). \(step)")
                            .font(.system(size: 11, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .padding(10)
        .background(HBPalette.panelSoft.opacity(0.5), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var matterControllerPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 8) {
                Image(systemName: "network")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(HBPalette.accentBlue)
                Text("Matter & Thread")
                    .font(.system(size: 15, weight: .bold, design: .rounded))
                    .foregroundStyle(HBPalette.textPrimary)
                Spacer(minLength: 0)
                Button {
                    Task { await loadMatterStatus() }
                } label: {
                    if matterIsLoading {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 13, weight: .bold))
                    }
                }
                .buttonStyle(.plain)
                .disabled(matterIsLoading)
            }

            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                matterStatusBadge(title: "Controller", value: matterControllerReady ? "Ready" : "Waiting", good: matterControllerReady)
                matterStatusBadge(title: "MG24", value: matterRcpDetected ? "Detected" : "Not plugged in", good: matterRcpDetected)
                matterStatusBadge(title: "OTBR", value: matterOtbrOnline ? "Online" : "Offline", good: matterOtbrOnline)
                matterStatusBadge(title: "Thread", value: matterThreadReady ? "Ready" : "Needs setup", good: matterThreadReady)
            }

            TextField("Matter QR or manual code", text: $matterSetupCode)
                .textFieldStyle(.roundedBorder)

            HStack(spacing: 8) {
                Picker("Transport", selection: $matterTransport) {
                    Text("Thread").tag("thread")
                    Text("IP").tag("ip")
                    Text("Wi-Fi").tag("wifi")
                    Text("Ethernet").tag("ethernet")
                    Text("BLE").tag("ble")
                }
                .pickerStyle(.menu)

                TextField("Known IP", text: $matterKnownAddress)
                    .textFieldStyle(.roundedBorder)
            }

            HStack(spacing: 8) {
                TextField("Room", text: $matterRoom)
                    .textFieldStyle(.roundedBorder)
                TextField("Name", text: $matterDeviceName)
                    .textFieldStyle(.roundedBorder)
            }

            if matterTransport == "wifi" {
                HStack(spacing: 8) {
                    TextField("Wi-Fi SSID", text: $matterWifiSsid)
                        .textFieldStyle(.roundedBorder)
                    SecureField("Password", text: $matterWifiPassword)
                        .textFieldStyle(.roundedBorder)
                }
            }

            if matterTransport == "thread" {
                TextField("Thread dataset override", text: $matterThreadDataset)
                    .textFieldStyle(.roundedBorder)
            }

            Button {
                Task { await startMatterCommissioning() }
            } label: {
                if matterIsCommissioning {
                    ProgressView()
                        .controlSize(.small)
                        .frame(maxWidth: .infinity)
                } else {
                    Label("Add Matter Device", systemImage: "plus.circle")
                        .frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(HBPrimaryButtonStyle())
            .disabled(matterIsCommissioning || matterSetupCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

            if let matterStatusMessage {
                Text(matterStatusMessage)
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                    .foregroundStyle(HBPalette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else if let matterLatestSessionStatus {
                Text("Latest Matter session: \(matterLatestSessionStatus)")
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                    .foregroundStyle(HBPalette.textSecondary)
            }
        }
        .padding(14)
        .background(HBGlassBackground(cornerRadius: 16, variant: .panelSoft))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(HBPalette.panelStroke.opacity(0.6), lineWidth: 1)
        )
    }

    private func matterStatusBadge(title: String, value: String, good: Bool) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.system(size: 10, weight: .bold, design: .rounded))
                .textCase(.uppercase)
                .tracking(1.4)
                .foregroundStyle(HBPalette.textMuted)
            Text(value)
                .font(.system(size: 12, weight: .bold, design: .rounded))
                .foregroundStyle(good ? HBPalette.accentGreen : HBPalette.textSecondary)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(HBGlassBackground(cornerRadius: 12, variant: .panelSoft))
    }

    private func statusBadge(for device: DeviceItem) -> some View {
        let text: String
        if device.type == "thermostat" {
            text = thermostatMode(for: device).uppercased()
        } else {
            text = device.status ? "On" : "Off"
        }

        return HBBadge(
            text: text,
            foreground: device.status ? HBPalette.textPrimary : HBPalette.textSecondary,
            background: device.status ? HBPalette.accentBlue.opacity(0.22) : HBPalette.panelSoft.opacity(0.88),
            stroke: device.status ? HBPalette.accentBlue : HBPalette.panelStrokeStrong
        )
    }

    @ViewBuilder
    private func defaultPowerControl(for device: DeviceItem) -> some View {
        if device.status {
            Button {
                Task {
                    await handleDeviceControl(
                        deviceId: device.id,
                        action: device.status ? "turn_off" : "turn_on"
                    )
                }
            } label: {
                Label(device.status ? "Turn Off" : "Turn On", systemImage: device.status ? "power.circle" : "power.circle.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(HBSecondaryButtonStyle())
            .disabled(pendingControls.contains(device.id))
        } else {
            Button {
                Task {
                    await handleDeviceControl(
                        deviceId: device.id,
                        action: device.status ? "turn_off" : "turn_on"
                    )
                }
            } label: {
                Label(device.status ? "Turn Off" : "Turn On", systemImage: device.status ? "power.circle" : "power.circle.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(HBPrimaryButtonStyle())
            .disabled(pendingControls.contains(device.id))
        }
    }

    private func thermostatControls(for device: DeviceItem) -> some View {
        let pending = pendingControls.contains(device.id)
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
                ForEach(thermostatModes, id: \.self) { thermostatMode in
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

    private func lightControls(for device: DeviceItem) -> some View {
        let pending = pendingControls.contains(device.id)
        let brightness = currentLightBrightness(for: device)
        let colorHex = currentLightColor(for: device)

        return VStack(spacing: 10) {
            HStack {
                Text("Fade")
                    .font(.system(size: 14, weight: .medium, design: .rounded))
                    .foregroundStyle(HBPalette.textSecondary)
                Spacer()
                Text("\(Int(brightness.rounded()))%")
                    .font(.system(size: 15, weight: .bold, design: .rounded))
                    .foregroundStyle(HBPalette.textPrimary)
            }

            Slider(
                value: Binding(
                    get: { currentLightBrightness(for: device) },
                    set: { lightBrightnessDrafts[device.id] = clampBrightness($0) }
                ),
                in: 0...100,
                step: 1,
                onEditingChanged: { editing in
                    guard !editing else { return }
                    let level = Int(currentLightBrightness(for: device).rounded())
                    Task { await handleDeviceControl(deviceId: device.id, action: "set_brightness", value: level) }
                }
            )
            .tint(HBPalette.accentBlue)
            .disabled(pending)

            HStack(spacing: 8) {
                Button("Fade Down") {
                    let next = Int(clampBrightness(brightness - 10).rounded())
                    Task { await handleDeviceControl(deviceId: device.id, action: "set_brightness", value: next) }
                }
                .buttonStyle(HBSecondaryButtonStyle(compact: true))
                .frame(maxWidth: .infinity)
                .disabled(pending)

                Button("Fade Up") {
                    let next = Int(clampBrightness(brightness + 10).rounded())
                    Task { await handleDeviceControl(deviceId: device.id, action: "set_brightness", value: next) }
                }
                .buttonStyle(HBSecondaryButtonStyle(compact: true))
                .frame(maxWidth: .infinity)
                .disabled(pending)
            }

            if supportsLightColor(device) {
                VStack(spacing: 8) {
                    HStack {
                        Text("Color")
                            .font(.system(size: 14, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textSecondary)
                        Spacer()
                        Text(colorHex.uppercased())
                            .font(.system(size: 12, weight: .bold, design: .monospaced))
                            .foregroundStyle(HBPalette.textPrimary)
                    }

                    HStack(spacing: 10) {
                        ColorPicker("", selection: colorBinding(for: device), supportsOpacity: false)
                            .labelsHidden()
                            .frame(width: 34, height: 34)
                            .background(HBGlassBackground(cornerRadius: 12, variant: .panelSoft))
                            .disabled(pending)

                        Button("Apply Color") {
                            Task { await handleDeviceControl(deviceId: device.id, action: "set_color", value: currentLightColor(for: device)) }
                        }
                        .buttonStyle(HBPrimaryButtonStyle())
                        .frame(maxWidth: .infinity)
                        .disabled(pending)
                    }
                }
            }

            if device.status {
                Button {
                    Task {
                        await handleDeviceControl(
                            deviceId: device.id,
                            action: device.status ? "turn_off" : "turn_on"
                        )
                    }
                } label: {
                    Label(device.status ? "Turn Off" : "Turn On", systemImage: device.status ? "power.circle" : "power.circle.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(HBSecondaryButtonStyle())
                .disabled(pending)
            } else {
                Button {
                    Task {
                        await handleDeviceControl(
                            deviceId: device.id,
                            action: device.status ? "turn_off" : "turn_on"
                        )
                    }
                } label: {
                    Label(device.status ? "Turn Off" : "Turn On", systemImage: device.status ? "power.circle" : "power.circle.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(HBPrimaryButtonStyle())
                .disabled(pending)
            }
        }
    }

    @ViewBuilder
    private func controlFeedbackView(for device: DeviceItem) -> some View {
        if pendingControls.contains(device.id) {
            HStack(spacing: 6) {
                ProgressView()
                    .controlSize(.small)
                Text("Sending command...")
            }
            .font(.system(size: 12, weight: .medium, design: .rounded))
            .foregroundStyle(HBPalette.accentBlue)
        } else if controlFeedback[device.id] == .success {
            Label("Command sent", systemImage: "checkmark.circle.fill")
                .font(.system(size: 12, weight: .medium, design: .rounded))
                .foregroundStyle(HBPalette.accentGreen)
        } else if controlFeedback[device.id] == .failure {
            Label("Command failed", systemImage: "exclamationmark.triangle.fill")
                .font(.system(size: 12, weight: .medium, design: .rounded))
                .foregroundStyle(Color.red.opacity(0.9))
        }
    }

    private func voiceHint(for device: DeviceItem) -> String {
        if device.type == "thermostat" {
            return "Voice: \"Hey Anna, set \(device.name) to \(thermostatTargetTemperature(for: device)) degrees\""
        }
        if supportsLightFade(device) {
            return "Voice: \"Hey Anna, fade \(device.name) to 30 percent\" or \"set \(device.name) to blue\""
        }
        return "Voice: \"Hey Anna, turn \(device.status ? "off" : "on") \(device.name)\""
    }

    private var createDeviceSheet: some View {
        NavigationStack {
            ZStack {
                HBPageBackground()
                    .ignoresSafeArea()

                VStack(spacing: 16) {
                    HStack {
                        Button("Cancel") {
                            showCreateSheet = false
                        }
                        .buttonStyle(HBSecondaryButtonStyle())

                        Spacer()

                        Button("Create") {
                            Task { await createDevice() }
                        }
                        .buttonStyle(HBPrimaryButtonStyle())
                        .disabled(
                            newName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                || newRoom.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        )
                    }

                    HBPanel {
                        VStack(alignment: .leading, spacing: 16) {
                            Text("Device Provisioning")
                                .font(.system(size: 11, weight: .bold, design: .rounded))
                                .textCase(.uppercase)
                                .tracking(2.6)
                                .foregroundStyle(HBPalette.textMuted)

                            Text("Add a new endpoint to the device matrix")
                                .font(.system(size: 28, weight: .bold, design: .rounded))
                                .foregroundStyle(
                                    LinearGradient(
                                        colors: [HBPalette.accentBlue, HBPalette.accentPurple],
                                        startPoint: .leading,
                                        endPoint: .trailing
                                    )
                                )

                            TextField("Name", text: $newName)
                                .hbPanelTextField()
                            TextField("Room", text: $newRoom)
                                .hbPanelTextField()

                            HStack {
                                Text("Type")
                                    .font(.system(size: 14, weight: .semibold, design: .rounded))
                                    .foregroundStyle(HBPalette.textSecondary)
                                Spacer()
                                Picker("Type", selection: $newType) {
                                    ForEach(availableTypes.filter { $0 != "all" }, id: \.self) { type in
                                        Text(type.capitalized).tag(type)
                                    }
                                }
                                .pickerStyle(.menu)
                                .tint(HBPalette.accentBlue)
                            }
                        }
                    }

                    Spacer()
                }
                .padding(18)
            }
            .toolbar(.hidden, for: .navigationBar)
        }
    }

    private func loadDevices(showLoading: Bool) async {
        if previewMode {
            devices = UIPreviewData.devices.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            favoritesProfileId = UIPreviewData.favoriteProfileId
            favoriteDeviceIds = UIPreviewData.favoriteDeviceIds
            errorMessage = nil
            isLoading = false
            return
        }

        if showLoading {
            isLoading = true
        }

        errorMessage = nil

        do {
            async let devicesTask = session.apiClient.get("/api/devices")
            async let profilesTask = session.apiClient.get("/api/profiles")

            let response = try await devicesTask
            let object = JSON.object(response)
            let data = JSON.object(object["data"])
            let list = JSON.array(data["devices"]).map(DeviceItem.from)
            devices = list.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            await loadMatterStatus()

            if let profilesResponse = try? await profilesTask {
                applyFavoriteContext(FavoritesSupport.deviceContext(fromProfilesPayload: profilesResponse))
            } else {
                applyFavoriteContext(.empty)
            }
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    private func loadMatterStatus() async {
        guard !previewMode else {
            matterControllerReady = false
            matterRcpDetected = false
            matterOtbrOnline = false
            matterThreadReady = false
            matterLatestSessionStatus = nil
            matterStatusMessage = "Matter hardware has not been connected in preview mode."
            return
        }

        matterIsLoading = true
        defer { matterIsLoading = false }

        do {
            async let statusTask = session.apiClient.get("/api/matter/status")
            async let sessionsTask = session.apiClient.get("/api/matter/commissioning-sessions")

            let statusResponse = try await statusTask
            let statusRoot = JSON.object(statusResponse)
            let status = JSON.object(statusRoot["status"])
            let thread = JSON.object(status["thread"])
            let otbr = JSON.object(thread["otbr"])

            matterControllerReady = JSON.bool(status, "controllerStarted")
            matterRcpDetected = JSON.bool(thread, "rcpDetected")
            matterOtbrOnline = JSON.bool(otbr, "online")
            matterThreadReady = JSON.bool(thread, "readyForThreadCommissioning")

            if let sessionsResponse = try? await sessionsTask {
                let sessionsRoot = JSON.object(sessionsResponse)
                let sessions = JSON.array(sessionsRoot["sessions"])
                matterLatestSessionStatus = sessions.first.flatMap { JSON.optionalString($0, "status") }
            }

            if let startError = JSON.optionalString(status, "startError"), !startError.isEmpty {
                matterStatusMessage = startError
            } else if !matterRcpDetected {
                matterStatusMessage = "The SONOFF MG24 Thread stick is not plugged in yet."
            } else if !matterThreadReady {
                matterStatusMessage = "Thread devices need OpenThread Border Router and an active Thread dataset."
            } else {
                matterStatusMessage = nil
            }
        } catch {
            matterStatusMessage = error.localizedDescription
        }
    }

    private func startMatterCommissioning() async {
        let setupCode = matterSetupCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !setupCode.isEmpty else {
            matterStatusMessage = "Enter a Matter setup code first."
            return
        }

        matterIsCommissioning = true
        defer { matterIsCommissioning = false }

        do {
            var payload: [String: Any] = [
                "setupCode": setupCode,
                "transport": matterTransport,
                "room": matterRoom.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Unassigned" : matterRoom
            ]
            if !matterKnownAddress.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                payload["knownAddress"] = matterKnownAddress
            }
            if !matterDeviceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                payload["name"] = matterDeviceName
            }
            if matterTransport == "wifi" {
                payload["wifiSsid"] = matterWifiSsid
                payload["wifiCredentials"] = matterWifiPassword
            }
            if matterTransport == "thread", !matterThreadDataset.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                payload["threadOperationalDataset"] = matterThreadDataset
            }

            let response = try await session.apiClient.post("/api/matter/commissioning/start", body: payload)
            let root = JSON.object(response)
            let sessionObject = JSON.object(root["session"])
            let steps = JSON.stringArray(sessionObject["manualSteps"])
            matterLatestSessionStatus = JSON.optionalString(sessionObject, "status")
            matterStatusMessage = steps.first ?? "Matter commissioning started. Keep the device in pairing mode."
            matterSetupCode = ""
            matterKnownAddress = ""
            matterDeviceName = ""
            matterWifiPassword = ""
            matterThreadDataset = ""
            await loadMatterStatus()
        } catch {
            matterStatusMessage = error.localizedDescription
            errorMessage = error.localizedDescription
        }
    }

    private func applyFavoriteContext(_ context: FavoriteDeviceContext) {
        favoritesProfileId = context.profileId
        favoriteDeviceIds = context.favoriteDeviceIds
    }

    private func applyPendingDeviceFocus(using scrollProxy: ScrollViewProxy) {
        guard let request = deviceFocusState.request,
              let targetDevice = devices.first(where: { $0.id == request.deviceID }) else {
            return
        }

        if typeFilter != "all" {
            typeFilter = "all"
        }

        let targetSearch = targetDevice.name.trimmingCharacters(in: .whitespacesAndNewlines)
        if !targetSearch.isEmpty, searchText != targetSearch {
            searchText = targetSearch
        }

        highlightedDeviceID = targetDevice.id
        let token = request.token

        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(150))
            withAnimation(.easeInOut(duration: 0.24)) {
                scrollProxy.scrollTo(targetDevice.id, anchor: .center)
            }
            deviceFocusState.clear(token: token)
        }

        Task { @MainActor in
            try? await Task.sleep(for: .seconds(2.5))
            if highlightedDeviceID == targetDevice.id {
                withAnimation(.easeInOut(duration: 0.2)) {
                    highlightedDeviceID = nil
                }
            }
        }
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
            favoritesProfileId = UIPreviewData.favoriteProfileId
            if favoriteDeviceIds.contains(device.id) {
                favoriteDeviceIds.remove(device.id)
            } else {
                favoriteDeviceIds.insert(device.id)
            }
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

    private func startDirectRadioMigration(_ device: DeviceItem, protocolName: String) async {
        if pendingMigrationDeviceIds.contains(device.id) {
            return
        }

        pendingMigrationDeviceIds.insert(device.id)
        migrationFeedback[device.id] = protocolName == "zwave"
            ? "Starting Z-Wave exclusion, then HomeBrain inclusion."
            : "Starting Zigbee permit-join."

        defer {
            pendingMigrationDeviceIds.remove(device.id)
        }

        if previewMode {
            migrationFeedback[device.id] = "Migration pairing window started. Put the device into pairing mode."
            return
        }

        do {
            if protocolName == "zwave" {
                _ = try? await session.apiClient.post(
                    "/api/direct-radios/exclusion/start",
                    body: ["durationSeconds": 120]
                )
            }

            _ = try await session.apiClient.post(
                "/api/direct-radios/migrations",
                body: [
                    "deviceId": device.id,
                    "protocol": protocolName,
                    "durationSeconds": 180
                ]
            )
            migrationFeedback[device.id] = protocolName == "zwave"
                ? "HomeBrain is listening. Run the lock or device inclusion sequence now."
                : "HomeBrain is listening. Hold the device reset button until it blinks, then keep it nearby."
        } catch {
            migrationFeedback[device.id] = "Migration could not start: \(error.localizedDescription)"
            errorMessage = error.localizedDescription
        }
    }

    private func loadDirectRadioMigrationPlan(for device: DeviceItem) async {
        guard isSmartThingsBackedDevice(device),
              migrationPlans[device.id] == nil,
              migrationPlanErrors[device.id] == nil,
              !pendingMigrationPlanDeviceIds.contains(device.id) else {
            return
        }

        pendingMigrationPlanDeviceIds.insert(device.id)
        defer {
            pendingMigrationPlanDeviceIds.remove(device.id)
        }

        if previewMode {
            migrationPlans[device.id] = DirectRadioMigrationPlanRecord.preview(for: device)
            return
        }

        do {
            let response = try await session.apiClient.get("/api/direct-radios/migration-plan/\(device.id)")
            let root = JSON.object(response)
            migrationPlans[device.id] = DirectRadioMigrationPlanRecord.from(JSON.object(root["plan"]))
        } catch {
            migrationPlanErrors[device.id] = error.localizedDescription
        }
    }

    private func handleDeviceControl(deviceId: String, action: String, value: Any? = nil) async {
        pendingControls.insert(deviceId)
        controlFeedback.removeValue(forKey: deviceId)
        applyControlOptimistically(deviceId: deviceId, action: action, value: value)

        if previewMode {
            setControlFeedback(deviceId: deviceId, status: .success)
            pendingControls.remove(deviceId)
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
            let object = JSON.object(response)
            let data = JSON.object(object["data"])
            let updated = DeviceItem.from(JSON.object(data["device"]))
            upsertDevice(updated)

            if action == "set_brightness" {
                lightBrightnessDrafts.removeValue(forKey: deviceId)
            } else if action == "set_color" {
                lightColorDrafts.removeValue(forKey: deviceId)
            } else if action == "set_temperature" {
                thermostatTemperatureDrafts.removeValue(forKey: deviceId)
            }

            setControlFeedback(deviceId: deviceId, status: .success)

            Task {
                try? await Task.sleep(nanoseconds: 1_200_000_000)
                await loadDevices(showLoading: false)
            }
        } catch {
            setControlFeedback(deviceId: deviceId, status: .failure)
            errorMessage = error.localizedDescription
            Task {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                await loadDevices(showLoading: false)
            }
        }

        pendingControls.remove(deviceId)
    }

    private func applyControlOptimistically(deviceId: String, action: String, value: Any?) {
        guard let index = devices.firstIndex(where: { $0.id == deviceId }) else {
            return
        }

        var updated = devices[index]

        switch action {
        case "turn_on":
            updated.status = true
            if supportsLightFade(updated), updated.brightness <= 0 {
                updated.brightness = 75
            }

        case "turn_off":
            updated.status = false
            if supportsLightFade(updated) {
                updated.brightness = 0
            }

        case "set_brightness":
            if let numeric = numberValue(from: value) {
                let brightness = clampBrightness(numeric)
                updated.brightness = brightness
                updated.status = brightness > 0
                lightBrightnessDrafts[deviceId] = brightness
            }

        case "set_color":
            if let stringValue = value as? String, let normalized = normalizedHexColor(stringValue) {
                updated.color = normalized
                updated.status = true
                lightColorDrafts[deviceId] = normalized
            }

        case "set_temperature":
            if let target = numberValue(from: value) {
                let clamped = clampThermostatTemperature(target)
                updated.targetTemperature = clamped
                updated.status = true
                thermostatTemperatureDrafts[deviceId] = clamped
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

    private func setControlFeedback(deviceId: String, status: ControlFeedback) {
        controlFeedback[deviceId] = status
        Task {
            try? await Task.sleep(nanoseconds: 1_800_000_000)
            if controlFeedback[deviceId] == status {
                controlFeedback.removeValue(forKey: deviceId)
            }
        }
    }

    private func createDevice() async {
        if previewMode {
            let created = DeviceItem(
                id: UUID().uuidString,
                name: newName.trimmingCharacters(in: .whitespacesAndNewlines),
                type: newType,
                room: newRoom.trimmingCharacters(in: .whitespacesAndNewlines),
                status: false,
                isOnline: true,
                brightness: newType == "light" ? 0 : 0,
                color: "#ffffff",
                temperature: newType == "thermostat" ? 68 : nil,
                targetTemperature: newType == "thermostat" ? 68 : nil,
                properties: newType == "thermostat" ? ["hvacMode": "auto"] : [:],
                lastSeen: "Just now"
            )
            devices.append(created)
            devices.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            showCreateSheet = false
            newName = ""
            newRoom = ""
            newType = "light"
            return
        }

        do {
            let payload: [String: Any] = [
                "name": newName.trimmingCharacters(in: .whitespacesAndNewlines),
                "room": newRoom.trimmingCharacters(in: .whitespacesAndNewlines),
                "type": newType,
                "status": false,
                "isOnline": true
            ]

            let response = try await session.apiClient.post("/api/devices", body: payload)
            let object = JSON.object(response)
            let data = JSON.object(object["data"])
            let created = DeviceItem.from(JSON.object(data["device"]))
            devices.append(created)
            devices.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }

            showCreateSheet = false
            newName = ""
            newRoom = ""
            newType = "light"
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func deleteDevice(_ device: DeviceItem) async {
        if previewMode {
            devices.removeAll { $0.id == device.id }
            favoriteDeviceIds.remove(device.id)
            return
        }

        do {
            _ = try await session.apiClient.delete("/api/devices/\(device.id)")
            devices.removeAll { $0.id == device.id }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func iconName(for device: DeviceItem) -> String {
        if supportsLightFade(device) {
            return "lightbulb.max"
        }

        switch device.type {
        case "light":
            return "lightbulb"
        case "lock":
            return "lock"
        case "thermostat":
            return "thermometer"
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

    private func numberValue(from value: Any?) -> Double? {
        if let value = value as? Double { return value }
        if let value = value as? Int { return Double(value) }
        if let value = value as? NSNumber { return value.doubleValue }
        if let value = value as? String, let parsed = Double(value) { return parsed }
        return nil
    }

    private func normalizedHexColor(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let regex = try? NSRegularExpression(pattern: "^#[0-9a-fA-F]{6}$"),
              regex.firstMatch(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed)) != nil else {
            return nil
        }
        return trimmed.lowercased()
    }

    private func clampBrightness(_ value: Double) -> Double {
        let clamped = min(100, max(0, value))
        return clamped.rounded()
    }

    private func currentLightBrightness(for device: DeviceItem) -> Double {
        if let draft = lightBrightnessDrafts[device.id] {
            return clampBrightness(draft)
        }
        return clampBrightness(device.brightness)
    }

    private func currentLightColor(for device: DeviceItem) -> String {
        if let draft = lightColorDrafts[device.id], let normalized = normalizedHexColor(draft) {
            return normalized
        }
        if let normalized = normalizedHexColor(device.color) {
            return normalized
        }
        return "#ffffff"
    }

    private func colorBinding(for device: DeviceItem) -> Binding<Color> {
        Binding {
            Color(hex: currentLightColor(for: device)) ?? .white
        } set: { newColor in
            if let hex = newColor.toHexRGB() {
                lightColorDrafts[device.id] = hex.lowercased()
            }
        }
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

    private func normalizedSmartThingsValue(_ value: Any) -> String {
        if let string = value as? String {
            return string.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if let object = value as? [String: Any] {
            if let id = object["id"] as? String, !id.isEmpty { return id.trimmingCharacters(in: .whitespacesAndNewlines) }
            if let capabilityId = object["capabilityId"] as? String, !capabilityId.isEmpty { return capabilityId.trimmingCharacters(in: .whitespacesAndNewlines) }
            if let name = object["name"] as? String, !name.isEmpty { return name.trimmingCharacters(in: .whitespacesAndNewlines) }
        }
        return ""
    }

    private func smartThingsCapabilities(for device: DeviceItem) -> Set<String> {
        let raw = (device.properties["smartThingsCapabilities"] as? [Any] ?? [])
            + (device.properties["smartthingsCapabilities"] as? [Any] ?? [])

        return Set(
            raw
                .map(normalizedSmartThingsValue)
                .filter { !$0.isEmpty }
        )
    }

    private func smartThingsCategories(for device: DeviceItem) -> Set<String> {
        let raw = (device.properties["smartThingsCategories"] as? [Any] ?? [])
            + (device.properties["smartthingsCategories"] as? [Any] ?? [])

        return Set(
            raw
                .map(normalizedSmartThingsValue)
                .filter { !$0.isEmpty }
                .map { $0.lowercased() }
        )
    }

    private func looksLikeSmartThingsDimmer(_ device: DeviceItem) -> Bool {
        let descriptor = [
            stringValue(device.properties["smartThingsDeviceTypeName"]),
            stringValue(device.properties["smartThingsPresentationId"]),
            device.name
        ]
            .filter { !$0.isEmpty }
            .joined(separator: " ")
            .lowercased()

        return descriptor.contains("dimmer")
    }

    private func hasSmartThingsLevelState(_ device: DeviceItem) -> Bool {
        let attributeValues = JSON.object(device.properties["smartThingsAttributeValues"])
        let attributeMetadata = JSON.object(device.properties["smartThingsAttributeMetadata"])
        let levelValue = JSON.object(attributeValues["switchLevel"])["level"]
        let levelObject = JSON.object(levelValue)
        let levelMetadata = JSON.object(JSON.object(attributeMetadata["switchLevel"])["level"])

        return levelValue is NSNumber
            || levelValue is String
            || !levelObject.isEmpty
            || !levelMetadata.isEmpty
    }

    private func isSmartThingsBackedDevice(_ device: DeviceItem) -> Bool {
        let source = stringValue(device.properties["source"]).lowercased()
        let hasDeviceId = !stringValue(device.properties["smartThingsDeviceId"]).isEmpty
        return source == "smartthings" || hasDeviceId
    }

    private func supportsLightFade(_ device: DeviceItem) -> Bool {
        if device.type == "light" {
            return true
        }

        if isSmartThingsBackedDevice(device) {
            let capabilities = smartThingsCapabilities(for: device)
            if capabilities.contains("switchLevel") || capabilities.contains("colorControl") {
                return true
            }

            if device.type == "switch" {
                let categories = smartThingsCategories(for: device)
                if categories.contains("light") || looksLikeSmartThingsDimmer(device) {
                    return true
                }
            }

            if hasSmartThingsLevelState(device) {
                return true
            }
        }

        return boolValue(device.properties["supportsBrightness"])
    }

    private func supportsLightColor(_ device: DeviceItem) -> Bool {
        if isSmartThingsBackedDevice(device) {
            let capabilities = smartThingsCapabilities(for: device)
            if capabilities.contains("colorControl") {
                return true
            }
            return boolValue(device.properties["supportsColor"]) && supportsLightFade(device)
        }

        if device.type == "light" {
            return true
        }

        return boolValue(device.properties["supportsColor"])
    }

    private func stringValue(_ value: Any?) -> String {
        if let value = value as? String {
            return value
        }
        if let value {
            return String(describing: value)
        }
        return ""
    }

    private func boolValue(_ value: Any?) -> Bool {
        if let value = value as? Bool {
            return value
        }
        if let value = value as? NSNumber {
            return value.boolValue
        }
        if let value = value as? String {
            switch value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
            case "true", "1", "yes", "on":
                return true
            case "false", "0", "no", "off":
                return false
            default:
                return false
            }
        }
        return false
    }
}

private struct DirectRadioMigrationFeatureSupportRecord: Identifiable {
    let id: String
    let label: String
    let supported: Bool
    let support: String

    nonisolated static func from(_ object: [String: Any]) -> DirectRadioMigrationFeatureSupportRecord {
        let key = JSON.string(object, "key", fallback: UUID().uuidString)
        return DirectRadioMigrationFeatureSupportRecord(
            id: key,
            label: JSON.string(object, "label", fallback: key),
            supported: JSON.bool(object, "supported"),
            support: JSON.string(object, "support")
        )
    }
}

private struct DirectRadioMigrationPlanRecord {
    let recommendedProtocol: String
    let inferredProtocol: String
    let supported: Bool
    let features: [String]
    let featureSupport: [DirectRadioMigrationFeatureSupportRecord]
    let manualSteps: [String]
    let warnings: [String]
    let targetSource: String

    var recommendedProtocolLabel: String {
        switch recommendedProtocol {
        case "zigbee":
            return "HomeBrain Zigbee"
        case "zwave", "z-wave":
            return "HomeBrain Z-Wave"
        default:
            return "Choose manually"
        }
    }

    var nativeFeatureCount: Int {
        featureSupport.filter { $0.supported }.count
    }

    nonisolated static func from(_ object: [String: Any]) -> DirectRadioMigrationPlanRecord {
        DirectRadioMigrationPlanRecord(
            recommendedProtocol: JSON.string(object, "recommendedProtocol", fallback: "unknown"),
            inferredProtocol: JSON.string(object, "inferredProtocol", fallback: "unknown"),
            supported: JSON.bool(object, "supported"),
            features: JSON.stringArray(object["features"]),
            featureSupport: JSON.array(object["featureSupport"]).map(DirectRadioMigrationFeatureSupportRecord.from),
            manualSteps: JSON.stringArray(object["manualSteps"]),
            warnings: JSON.stringArray(object["warnings"]),
            targetSource: JSON.string(object, "targetSource")
        )
    }

    nonisolated static func preview(for device: DeviceItem) -> DirectRadioMigrationPlanRecord {
        DirectRadioMigrationPlanRecord(
            recommendedProtocol: "unknown",
            inferredProtocol: "unknown",
            supported: true,
            features: [device.type],
            featureSupport: [
                DirectRadioMigrationFeatureSupportRecord(id: "state", label: "State", supported: true, support: "native")
            ],
            manualSteps: [
                "Start the migration window.",
                "Reset or exclude the device from SmartThings.",
                "Put the device into pairing or inclusion mode near the HomeBrain radio."
            ],
            warnings: [],
            targetSource: ""
        )
    }
}

private extension Color {
    init?(hex: String) {
        let trimmed = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("#"), trimmed.count == 7 else {
            return nil
        }

        let hexValue = String(trimmed.dropFirst())
        guard let intValue = Int(hexValue, radix: 16) else {
            return nil
        }

        let red = Double((intValue >> 16) & 0xFF) / 255.0
        let green = Double((intValue >> 8) & 0xFF) / 255.0
        let blue = Double(intValue & 0xFF) / 255.0
        self.init(red: red, green: green, blue: blue)
    }

    func toHexRGB() -> String? {
        let uiColor = UIColor(self)
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0

        guard uiColor.getRed(&red, green: &green, blue: &blue, alpha: &alpha) else {
            return nil
        }

        return String(
            format: "#%02X%02X%02X",
            Int(red * 255.0),
            Int(green * 255.0),
            Int(blue * 255.0)
        )
    }
}
