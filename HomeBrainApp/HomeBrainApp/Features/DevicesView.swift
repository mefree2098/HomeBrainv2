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
    @State private var controlSheetDeviceID: String?
    @State private var pendingMigrationDeviceIds: Set<String> = []
    @State private var pendingMigrationPlanDeviceIds: Set<String> = []
    @State private var migrationFeedback: [String: String] = [:]
    @State private var migrationPlans: [String: DirectRadioMigrationPlanRecord] = [:]
    @State private var migrationPlanErrors: [String: String] = [:]
    @State private var migrationWorkflows: [String: DirectRadioMigrationWorkflowRecord] = [:]
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
    @State private var addDeviceMode = "zwave"
    @State private var addDeviceBusy = false
    @State private var addDeviceStatusMessage: String?
    @State private var addDeviceDurationSeconds = 180
    @State private var addDevicePendingDsk = ""
    @State private var addDeviceDskPin = ""
    @State private var addDeviceRepairingZWaveNodeId: Int?
    @State private var newName = ""
    @State private var newType = "light"
    @State private var newRoom = ""
    @State private var contentWidth: CGFloat = 0

    private let availableTypes = ["all", "light", "lock", "thermostat", "garage", "sensor", "switch", "camera"]
    private let addDeviceModes = ["zwave", "zigbee", "insteon", "matter", "manual"]
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
    private var controlSheetDevice: DeviceItem? {
        guard let controlSheetDeviceID else { return nil }
        return devices.first(where: { $0.id == controlSheetDeviceID })
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

    private static func previewDeviceTypeFilterFromLaunch() -> String? {
        let processInfo = ProcessInfo.processInfo
        let allowedTypes = Set(["all", "light", "switch", "thermostat", "lock", "garage", "sensor", "camera", "speaker"])

        if let index = processInfo.arguments.firstIndex(of: "-ui-preview-device-type"),
           processInfo.arguments.indices.contains(index + 1) {
            let requestedType = processInfo.arguments[index + 1].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            return allowedTypes.contains(requestedType) ? requestedType : nil
        }

        if let requestedType = processInfo.environment["UI_PREVIEW_DEVICE_TYPE"]?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
           allowedTypes.contains(requestedType) {
            return requestedType
        }

        return nil
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
        .sheet(
            isPresented: Binding(
                get: { controlSheetDeviceID != nil },
                set: { isPresented in
                    if !isPresented {
                        controlSheetDeviceID = nil
                    }
                }
            )
        ) {
            if let controlSheetDevice {
                deviceControlSheet(for: controlSheetDevice)
            } else {
                EmptyStateView(
                    title: "Device unavailable",
                    subtitle: "The selected device is no longer available."
                )
                .padding(20)
            }
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

                    Text(embeddedFocusedDevice?.displayRoom ?? "Close this panel to return to the Security Center exactly where you left it.")
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

                deviceSummaryBadges
            }
        }
    }

    private var deviceSummaryBadges: some View {
        let showsTypeFilter = typeFilter != "all"
        let showsSourceFilter = sourceFilter != DeviceItem.allSelectionSourcesValue
        let showsSearchFilter = !searchText.isEmpty

        return ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                HBBadge(text: "\(filteredDevices.count) matched")
                HBBadge(text: "\(devices.filter(\.isOnline).count) online")
                if showsTypeFilter {
                    HBBadge(text: deviceTypeFilterLabel(typeFilter))
                }
                if showsSourceFilter {
                    HBBadge(text: sourceFilterLabel)
                }
                if showsSearchFilter {
                    HBBadge(text: "Search active")
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    HBBadge(text: "\(filteredDevices.count) matched")
                    HBBadge(text: "\(devices.filter(\.isOnline).count) online")
                }

                if showsTypeFilter || showsSourceFilter || showsSearchFilter {
                    HStack(spacing: 8) {
                        if showsTypeFilter {
                            HBBadge(text: deviceTypeFilterLabel(typeFilter))
                        }
                        if showsSourceFilter {
                            HBBadge(text: sourceFilterLabel)
                        }
                        if showsSearchFilter {
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
                                Text(deviceTypeFilterLabel(type)).tag(type)
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
                                Text(deviceTypeFilterLabel(type)).tag(type)
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
                        Text(device.displayRoom)
                            .font(.system(size: useLandscapeCompactLayout ? 13 : 14, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textSecondary)
                        HStack(spacing: 6) {
                            Circle()
                                .fill(device.isOnline ? HBPalette.accentGreen : HBPalette.accentOrange)
                                .frame(width: 7, height: 7)
                            Text(device.isOnline ? "Online" : "Offline")
                                .font(.system(size: useLandscapeCompactLayout ? 11 : 12, weight: .semibold, design: .rounded))
                                .foregroundStyle(device.isOnline ? HBPalette.accentGreen : HBPalette.accentOrange)
                        }
                    }

                    Spacer(minLength: 0)

                    favoriteButton(for: device)
                }

                deviceIdentityBadges(for: device)

                VStack(alignment: .leading, spacing: 4) {
                    Text(deviceControlSummary(for: device))
                        .font(.system(size: 14, weight: .semibold, design: .rounded))
                        .foregroundStyle(HBPalette.textPrimary)
                    Text("Direct control, grouping, voice, history, and migration context.")
                        .font(.system(size: 12, weight: .medium, design: .rounded))
                        .foregroundStyle(HBPalette.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(12)
                .background(HBGlassBackground(cornerRadius: 16, variant: .panelSoft))

                HStack(spacing: 8) {
                    primaryDeviceActionButton(for: device)
                    Button {
                        controlSheetDeviceID = device.id
                    } label: {
                        Image(systemName: "slider.horizontal.3")
                            .font(.system(size: 14, weight: .bold))
                            .frame(width: 42, height: 42)
                    }
                    .buttonStyle(HBSecondaryButtonStyle(compact: true))
                    .accessibilityLabel("Open controls for \(device.name)")
                }

                controlFeedbackView(for: device)
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

    private func deviceIdentityBadges(for device: DeviceItem) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                statusBadge(for: device)
                deviceTypeBadge(for: device)
                deviceSourceBadge(for: device)
                if isSmartThingsBackedDevice(device) {
                    migrationBadge()
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    statusBadge(for: device)
                    deviceTypeBadge(for: device)
                }
                HStack(spacing: 8) {
                    deviceSourceBadge(for: device)
                    if isSmartThingsBackedDevice(device) {
                        migrationBadge()
                    }
                }
            }
        }
        .lineLimit(1)
    }

    private func deviceTypeBadge(for device: DeviceItem) -> some View {
        HBBadge(
            text: deviceTypeDisplayLabel(device.type),
            foreground: HBPalette.textPrimary,
            background: HBPalette.panelSoft.opacity(0.88),
            stroke: HBPalette.panelStrokeStrong
        )
    }

    private func deviceSourceBadge(for device: DeviceItem) -> some View {
        HBBadge(
            text: device.selectionSourceLabel,
            foreground: HBPalette.textPrimary,
            background: HBPalette.panelSoft.opacity(0.88),
            stroke: HBPalette.panelStrokeStrong
        )
    }

    private func migrationBadge() -> some View {
        HBBadge(
            text: "Migration",
            foreground: HBPalette.accentBlue,
            background: HBPalette.accentBlue.opacity(0.12),
            stroke: HBPalette.accentBlue.opacity(0.55)
        )
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

    @ViewBuilder
    private func primaryDeviceActionButton(for device: DeviceItem) -> some View {
        if primaryDeviceActionIsProminent(for: device) {
            Button {
                if canUsePrimaryDeviceAction(device) {
                    Task { await runPrimaryDeviceAction(for: device) }
                } else {
                    controlSheetDeviceID = device.id
                }
            } label: {
                Label(primaryDeviceActionLabel(for: device), systemImage: primaryDeviceActionIcon(for: device))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(HBPrimaryButtonStyle(compact: true))
            .disabled(pendingControls.contains(device.id))
        } else {
            Button {
                if canUsePrimaryDeviceAction(device) {
                    Task { await runPrimaryDeviceAction(for: device) }
                } else {
                    controlSheetDeviceID = device.id
                }
            } label: {
                Label(primaryDeviceActionLabel(for: device), systemImage: primaryDeviceActionIcon(for: device))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(HBSecondaryButtonStyle(compact: true))
            .disabled(pendingControls.contains(device.id))
        }
    }

    private func canUsePrimaryDeviceAction(_ device: DeviceItem) -> Bool {
        if device.type == "camera" || device.type == "sensor" {
            return false
        }
        return device.type == "thermostat"
            || supportsLightFade(device)
            || ["light", "switch", "lock", "garage"].contains(device.type)
    }

    private func primaryDeviceActionIsProminent(for device: DeviceItem) -> Bool {
        if device.type == "thermostat" {
            return thermostatMode(for: device) == "off"
        }
        return !device.status
    }

    private func primaryDeviceActionIcon(for device: DeviceItem) -> String {
        if !canUsePrimaryDeviceAction(device) {
            return "slider.horizontal.3"
        }
        if device.type == "thermostat" {
            return thermostatMode(for: device) == "off" ? "power.circle.fill" : "power.circle"
        }
        return device.status ? "power.circle" : "power.circle.fill"
    }

    private func primaryDeviceActionLabel(for device: DeviceItem) -> String {
        if !canUsePrimaryDeviceAction(device) {
            return "Details"
        }
        if device.type == "thermostat" {
            return thermostatMode(for: device) == "off" ? "Turn On" : "Turn Off"
        }
        if device.type == "lock" {
            return device.status ? "Unlock" : "Lock"
        }
        if device.type == "garage" {
            return device.status ? "Close" : "Open"
        }
        return device.status ? "Turn Off" : "Turn On"
    }

    private func runPrimaryDeviceAction(for device: DeviceItem) async {
        if device.type == "thermostat" {
            let mode = thermostatMode(for: device)
            await handleDeviceControl(
                deviceId: device.id,
                action: "set_mode",
                value: mode == "off" ? thermostatOnMode(for: device) : "off"
            )
            return
        }

        await handleDeviceControl(deviceId: device.id, action: device.status ? "turn_off" : "turn_on")
    }

    private func deviceControlSummary(for device: DeviceItem) -> String {
        if device.type == "thermostat" {
            let current = device.temperature.map { " · \(Int($0.rounded()))° current" } ?? ""
            return "\(thermostatTargetTemperature(for: device))° setpoint\(current)"
        }
        if supportsLightFade(device) {
            var parts = ["\(Int(currentLightBrightness(for: device).rounded()))%"]
            if supportsLightColor(device) {
                parts.append("color")
            }
            return parts.joined(separator: " · ")
        }
        if isSmartThingsBackedDevice(device) {
            return "SmartThings route preserved"
        }
        return "\(deviceTypeDisplayLabel(device.type)) control"
    }

    private func directRadioMigrationPanel(for device: DeviceItem) -> some View {
        let isPending = pendingMigrationDeviceIds.contains(device.id)
        let planLoading = pendingMigrationPlanDeviceIds.contains(device.id)
        let plan = migrationPlans[device.id]
        let planError = migrationPlanErrors[device.id]
        let feedback = migrationFeedback[device.id]
        let workflow = migrationWorkflows[device.id]

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

            Text("HomeBrain opens the native radio operation at the right time, then waits for the physical exclude, reset, or pairing action. Retire SmartThings only after native state and controls are verified.")
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

            if let workflow {
                directRadioMigrationWorkflowCard(workflow, device: device, isPending: isPending)
            } else if plan?.supported == false {
                Text("No radio workflow is available for this device. Keep it on its current integration, or replace it with a known Zigbee, Z-Wave, or Matter device before onboarding natively.")
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                    .foregroundStyle(HBPalette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(10)
                    .background(HBPalette.panelSoft.opacity(0.45), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            } else {
                HStack(spacing: 8) {
                    ForEach(plan?.protocolButtonOrder ?? ["zigbee", "zwave"], id: \.self) { protocolName in
                        migrationProtocolButton(
                            plan: plan,
                            device: device,
                            protocolName: protocolName,
                            isPending: isPending
                        )
                    }
                }
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

    @ViewBuilder
    private func migrationProtocolButton(plan: DirectRadioMigrationPlanRecord?, device: DeviceItem, protocolName: String, isPending: Bool) -> some View {
        let recommended = protocolName == plan?.normalizedRecommendedProtocol
        let title = migrationProtocolButtonTitle(plan: plan, protocolName: protocolName)
        let icon = migrationProtocolIcon(protocolName)

        if recommended {
            Button {
                Task { await startDirectRadioMigration(device, protocolName: protocolName) }
            } label: {
                Label(title, systemImage: icon)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(HBPrimaryButtonStyle(compact: true))
            .disabled(isPending)
        } else {
            Button {
                Task { await startDirectRadioMigration(device, protocolName: protocolName) }
            } label: {
                Label(title, systemImage: icon)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(HBSecondaryButtonStyle(compact: true))
            .disabled(isPending)
        }
    }

    private func migrationProtocolIcon(_ protocolName: String) -> String {
        protocolName == "zigbee" ? "dot.radiowaves.left.and.right" : "wave.3.right"
    }

    private func migrationProtocolButtonTitle(plan: DirectRadioMigrationPlanRecord?, protocolName: String) -> String {
        plan?.buttonTitle(for: protocolName) ?? (protocolName == "zigbee" ? "Zigbee" : "Z-Wave")
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
                Text(plan.supported ? "\(plan.nativeFeatureCount)/\(max(plan.featureSupport.count, 1)) native" : "Do not migrate")
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

            Text(plan.migrationSafetyNote)
                .font(.system(size: 11, weight: .semibold, design: .rounded))
                .foregroundStyle(HBPalette.accentBlue)
                .fixedSize(horizontal: false, vertical: true)

            if let profile = plan.instructionProfile {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Instruction profile")
                        .font(.system(size: 10, weight: .bold, design: .rounded))
                        .textCase(.uppercase)
                        .tracking(1.6)
                        .foregroundStyle(HBPalette.textMuted)
                    Text("\(profile.label) • \(profile.confidence)")
                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                        .foregroundStyle(HBPalette.accentBlue)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            if !plan.guidedSteps.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Guided workflow")
                        .font(.system(size: 10, weight: .bold, design: .rounded))
                        .textCase(.uppercase)
                        .tracking(1.6)
                        .foregroundStyle(HBPalette.textMuted)
                    ForEach(Array(plan.guidedSteps.prefix(5).enumerated()), id: \.offset) { index, step in
                        Text("\(index + 1). \(step.automatic ? "HomeBrain: " : "")\(step.title)")
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

    private func directRadioMigrationWorkflowCard(
        _ workflow: DirectRadioMigrationWorkflowRecord,
        device: DeviceItem,
        isPending: Bool
    ) -> some View {
        let steps = workflow.plan.guidedSteps
        let currentStep = workflow.currentStep

        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Step \(min(workflow.stepIndex + 1, max(steps.count, 1)))/\(max(steps.count, 1))")
                        .font(.system(size: 10, weight: .bold, design: .rounded))
                        .textCase(.uppercase)
                        .tracking(1.6)
                        .foregroundStyle(HBPalette.textMuted)
                    Text(currentStep?.title ?? "Migration workflow")
                        .font(.system(size: 13, weight: .bold, design: .rounded))
                        .foregroundStyle(HBPalette.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                Text(workflow.protocolLabel)
                    .font(.system(size: 10, weight: .bold, design: .rounded))
                    .foregroundStyle(HBPalette.accentGreen)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(HBPalette.panelSoft.opacity(0.72), in: Capsule())
            }

            Text(workflow.statusMessage)
                .font(.system(size: 11, weight: .semibold, design: .rounded))
                .foregroundStyle(HBPalette.accentBlue)
                .fixedSize(horizontal: false, vertical: true)

            if !workflow.verificationGuidance.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(workflow.verificationGuidance.enumerated()), id: \.offset) { _, guidance in
                        Text(guidance)
                            .font(.system(size: 11, weight: .semibold, design: .rounded))
                            .foregroundStyle(HBPalette.textPrimary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(8)
                .background(HBPalette.accentOrange.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }

            if let currentStep {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(currentStep.instructions.enumerated()), id: \.offset) { index, instruction in
                        Text("\(index + 1). \(instruction)")
                            .font(.system(size: 11, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                Button {
                    Task { await advanceDirectRadioMigrationWorkflow(device) }
                } label: {
                    Label(workflow.complete ? "Workflow complete" : currentStep.confirmLabel, systemImage: workflow.complete ? "checkmark.circle.fill" : "arrow.forward.circle.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(HBPrimaryButtonStyle(compact: true))
                .disabled(isPending || workflow.complete)
            }
        }
        .padding(10)
        .background(HBPalette.accentBlue.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(HBPalette.accentBlue.opacity(0.25), lineWidth: 1)
        )
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

    private func deviceControlSheet(for device: DeviceItem) -> some View {
        NavigationStack {
            ZStack {
                HBPageBackground()
                    .ignoresSafeArea()

                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        HBPanel {
                            HStack(alignment: .top, spacing: 14) {
                                Image(systemName: iconName(for: device))
                                    .font(.system(size: 18, weight: .bold))
                                    .foregroundStyle(Color.white)
                                    .frame(width: 46, height: 46)
                                    .background(
                                        LinearGradient(
                                            colors: device.status
                                                ? [HBPalette.accentGreen, HBPalette.accentBlue]
                                                : [HBPalette.accentSlate, HBPalette.panelSoft],
                                            startPoint: .topLeading,
                                            endPoint: .bottomTrailing
                                        ),
                                        in: RoundedRectangle(cornerRadius: 16, style: .continuous)
                                    )

                                VStack(alignment: .leading, spacing: 6) {
                                    Text(device.name)
                                        .font(.system(size: 26, weight: .bold, design: .rounded))
                                        .foregroundStyle(HBPalette.textPrimary)
                                        .fixedSize(horizontal: false, vertical: true)
                                    Text("\(device.displayRoom) · \(deviceTypeDisplayLabel(device.type)) · \(device.selectionSourceLabel)")
                                        .font(.system(size: 14, weight: .medium, design: .rounded))
                                        .foregroundStyle(HBPalette.textSecondary)
                                        .fixedSize(horizontal: false, vertical: true)
                                    HStack(spacing: 8) {
                                        statusBadge(for: device)
                                        HBBadge(text: device.isOnline ? "Online" : "Offline")
                                    }
                                }
                            }
                        }

                        HBPanel {
                            VStack(alignment: .leading, spacing: 12) {
                                Text("Primary Controls")
                                    .font(.system(size: 17, weight: .bold, design: .rounded))
                                    .foregroundStyle(HBPalette.textPrimary)

                                if device.type == "thermostat" {
                                    thermostatControls(for: device)
                                } else if supportsLightFade(device) {
                                    lightControls(for: device)
                                } else if canUsePrimaryDeviceAction(device) {
                                    defaultPowerControl(for: device)
                                } else {
                                    Text("This device does not expose a simple manual control. Use groups, workflows, telemetry, or migration guidance instead.")
                                        .font(.system(size: 13, weight: .medium, design: .rounded))
                                        .foregroundStyle(HBPalette.textSecondary)
                                        .fixedSize(horizontal: false, vertical: true)
                                        .padding(12)
                                        .background(HBGlassBackground(cornerRadius: 16, variant: .panelSoft))
                                }

                                controlFeedbackView(for: device)
                            }
                        }

                        if isSmartThingsBackedDevice(device) {
                            directRadioMigrationPanel(for: device)
                        }

                        HBPanel {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Voice")
                                    .font(.system(size: 17, weight: .bold, design: .rounded))
                                    .foregroundStyle(HBPalette.textPrimary)
                                Text(voiceHint(for: device))
                                    .font(.system(size: 13, weight: .medium, design: .rounded))
                                    .foregroundStyle(HBPalette.textSecondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                    .padding(16)
                    .padding(.bottom, 20)
                }
                .scrollIndicators(.hidden)
            }
            .navigationTitle("Controls")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") {
                        controlSheetDeviceID = nil
                    }
                    .buttonStyle(HBSecondaryButtonStyle(compact: true))
                }
            }
        }
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

                        Button(addDevicePrimaryButtonTitle) {
                            Task { await runAddDeviceAction() }
                        }
                        .buttonStyle(HBPrimaryButtonStyle())
                        .disabled(addDevicePrimaryButtonDisabled)
                    }

                    HBPanel {
                        VStack(alignment: .leading, spacing: 16) {
                            Text("Device Provisioning")
                                .font(.system(size: 11, weight: .bold, design: .rounded))
                                .textCase(.uppercase)
                                .tracking(2.6)
                                .foregroundStyle(HBPalette.textMuted)

                            Text("Add a native endpoint")
                                .font(.system(size: 28, weight: .bold, design: .rounded))
                                .foregroundStyle(
                                    LinearGradient(
                                        colors: [HBPalette.accentBlue, HBPalette.accentPurple],
                                        startPoint: .leading,
                                        endPoint: .trailing
                                    )
                                )

                            HStack {
                                Text("Protocol")
                                    .font(.system(size: 14, weight: .semibold, design: .rounded))
                                    .foregroundStyle(HBPalette.textSecondary)
                                Spacer()
                                Picker("Protocol", selection: $addDeviceMode) {
                                    ForEach(addDeviceModes, id: \.self) { mode in
                                        Text(addDeviceModeLabel(mode)).tag(mode)
                                    }
                                }
                                .pickerStyle(.menu)
                                .tint(HBPalette.accentBlue)
                            }

                            if addDeviceMode == "manual" {
                                manualCreateFields
                            } else if addDeviceMode == "matter" {
                                matterAddFields
                            } else {
                                nativeRadioAddFields
                            }

                            if addDeviceMode == "zwave" && !zwaveRepairCandidates.isEmpty {
                                zwaveRepairPanel
                            }

                            if addDeviceBusy {
                                HStack(spacing: 8) {
                                    ProgressView()
                                        .controlSize(.small)
                                    Text("Waiting for HomeBrain hardware confirmation...")
                                        .font(.system(size: 12, weight: .semibold, design: .rounded))
                                        .foregroundStyle(HBPalette.textSecondary)
                                }
                            }

                            if addDeviceMode == "zwave" && !addDevicePendingDsk.isEmpty {
                                VStack(alignment: .leading, spacing: 10) {
                                    Text("S2 security needs the 5 digit DSK PIN.")
                                        .font(.system(size: 12, weight: .bold, design: .rounded))
                                        .foregroundStyle(HBPalette.accentOrange)
                                    Text("DSK challenge: \(addDevicePendingDsk)")
                                        .font(.system(size: 11, weight: .semibold, design: .monospaced))
                                        .foregroundStyle(HBPalette.textSecondary)
                                        .fixedSize(horizontal: false, vertical: true)
                                    HStack(spacing: 8) {
                                        TextField("5 digit PIN", text: $addDeviceDskPin)
                                            .keyboardType(.numberPad)
                                            .hbPanelTextField()
                                            .onChange(of: addDeviceDskPin) { _, newValue in
                                                addDeviceDskPin = String(newValue.filter(\.isNumber).prefix(5))
                                            }
                                        Button("Submit PIN") {
                                            Task { await submitAddDeviceDskPin() }
                                        }
                                        .buttonStyle(HBSecondaryButtonStyle(compact: true))
                                        .disabled(addDeviceDskPin.count != 5)
                                    }
                                }
                                .padding(12)
                                .background(HBPalette.accentOrange.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                                        .stroke(HBPalette.accentOrange.opacity(0.35), lineWidth: 1)
                                )
                            }

                            if let addDeviceStatusMessage {
                                Text(addDeviceStatusMessage)
                                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                                    .foregroundStyle(HBPalette.textSecondary)
                                    .fixedSize(horizontal: false, vertical: true)
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

    private var manualCreateFields: some View {
        VStack(alignment: .leading, spacing: 12) {
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
                        Text(deviceTypeDisplayLabel(type)).tag(type)
                    }
                }
                .pickerStyle(.menu)
                .tint(HBPalette.accentBlue)
            }
        }
    }

    private var nativeRadioAddFields: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Window")
                    .font(.system(size: 14, weight: .semibold, design: .rounded))
                    .foregroundStyle(HBPalette.textSecondary)
                Spacer()
                Picker("Window", selection: $addDeviceDurationSeconds) {
                    Text("1 min").tag(60)
                    Text("3 min").tag(180)
                    Text("5 min").tag(300)
                    Text("10 min").tag(600)
                }
                .pickerStyle(.menu)
                .tint(HBPalette.accentBlue)
                .disabled(addDeviceBusy)
            }

            Text(nativeAddGuidance)
                .font(.system(size: 13, weight: .medium, design: .rounded))
                .foregroundStyle(HBPalette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var zwaveRepairCandidates: [DeviceItem] {
        Array(
            devices
                .filter(isIncompleteZWaveDirectDevice)
                .sorted { (zWaveNodeId(for: $0) ?? 0) > (zWaveNodeId(for: $1) ?? 0) }
                .prefix(4)
        )
    }

    private var zwaveRepairPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(HBPalette.accentOrange)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Already-paired Z-Wave nodes need interview repair.")
                        .font(.system(size: 12, weight: .bold, design: .rounded))
                        .foregroundStyle(HBPalette.accentOrange)
                    Text("Use this when inclusion times out because the switch is already on the Zooz network.")
                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                        .foregroundStyle(HBPalette.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            ForEach(zwaveRepairCandidates) { device in
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(device.name)
                            .font(.system(size: 13, weight: .bold, design: .rounded))
                            .foregroundStyle(HBPalette.textPrimary)
                            .lineLimit(1)
                        Text(zwaveRepairSubtitle(for: device))
                            .font(.system(size: 11, weight: .semibold, design: .rounded))
                            .foregroundStyle(HBPalette.textSecondary)
                            .lineLimit(2)
                    }

                    Spacer(minLength: 8)

                    let nodeId = zWaveNodeId(for: device)
                    Button {
                        Task { await repairZWaveNode(device) }
                    } label: {
                        if addDeviceRepairingZWaveNodeId == nodeId {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Label("Repair", systemImage: "wrench.and.screwdriver")
                        }
                    }
                    .buttonStyle(HBSecondaryButtonStyle(compact: true))
                    .disabled(addDeviceBusy || addDeviceRepairingZWaveNodeId != nil || nodeId == nil)
                }
                .padding(10)
                .background(HBGlassBackground(cornerRadius: 10, variant: .panelSoft))
            }
        }
        .padding(12)
        .background(HBPalette.accentOrange.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(HBPalette.accentOrange.opacity(0.35), lineWidth: 1)
        )
    }

    private var matterAddFields: some View {
        VStack(alignment: .leading, spacing: 12) {
            TextField("Matter QR or manual code", text: $matterSetupCode)
                .hbPanelTextField()
                .disabled(addDeviceBusy)

            HStack(spacing: 8) {
                Picker("Transport", selection: $matterTransport) {
                    Text("Thread").tag("thread")
                    Text("IP").tag("ip")
                    Text("Wi-Fi").tag("wifi")
                    Text("Ethernet").tag("ethernet")
                    Text("BLE").tag("ble")
                }
                .pickerStyle(.menu)
                .tint(HBPalette.accentBlue)
                .disabled(addDeviceBusy)

                TextField("Known IP", text: $matterKnownAddress)
                    .hbPanelTextField()
                    .disabled(addDeviceBusy)
            }

            HStack(spacing: 8) {
                TextField("Room", text: $matterRoom)
                    .hbPanelTextField()
                    .disabled(addDeviceBusy)
                TextField("Name", text: $matterDeviceName)
                    .hbPanelTextField()
                    .disabled(addDeviceBusy)
            }

            if matterTransport == "wifi" {
                HStack(spacing: 8) {
                    TextField("Wi-Fi SSID", text: $matterWifiSsid)
                        .hbPanelTextField()
                        .disabled(addDeviceBusy)
                    SecureField("Password", text: $matterWifiPassword)
                        .textFieldStyle(.roundedBorder)
                        .disabled(addDeviceBusy)
                }
            }

            if matterTransport == "thread" {
                TextField("Thread dataset override", text: $matterThreadDataset)
                    .hbPanelTextField()
                    .disabled(addDeviceBusy)
            }
        }
    }

    private var addDevicePrimaryButtonTitle: String {
        switch addDeviceMode {
        case "zwave": return addDeviceBusy ? "Starting..." : "Start Z-Wave"
        case "zigbee": return addDeviceBusy ? "Opening..." : "Open Zigbee"
        case "insteon": return addDeviceBusy ? "Linking..." : "Link Insteon"
        case "matter": return matterIsCommissioning || addDeviceBusy ? "Commissioning..." : "Commission"
        default: return "Create"
        }
    }

    private var addDevicePrimaryButtonDisabled: Bool {
        if addDeviceBusy || matterIsCommissioning {
            return true
        }
        if addDeviceMode == "manual" {
            return newName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || newRoom.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        if addDeviceMode == "matter" {
            return matterSetupCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        return false
    }

    private var nativeAddGuidance: String {
        switch addDeviceMode {
        case "zwave":
            return "HomeBrain opens native Z-Wave inclusion on the Zooz controller. Perform the switch include action while the window is live; the device is added when zwave-js reports the new node."
        case "zigbee":
            return "HomeBrain opens Zigbee permit-join on the SONOFF coordinator. Reset or pair the device; it appears after join and interview."
        case "insteon":
            return "HomeBrain puts the PLM into link mode. Press the device set/link button; the PLM confirmation now creates or updates the HomeBrain device row."
        default:
            return ""
        }
    }

    private func addDeviceModeLabel(_ mode: String) -> String {
        switch mode {
        case "zwave": return "Z-Wave"
        case "zigbee": return "Zigbee"
        case "insteon": return "Insteon"
        case "matter": return "Matter"
        default: return "Manual"
        }
    }

    private func loadDevices(showLoading: Bool) async {
        if previewMode {
            devices = UIPreviewData.devices.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            if let previewTypeFilter = Self.previewDeviceTypeFilterFromLaunch() {
                typeFilter = previewTypeFilter
            }
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

    private func migrationActionMessage(for step: DirectRadioMigrationGuidedStepRecord, protocolName: String) -> String {
        switch step.action {
        case "start_zwave_exclusion":
            return "HomeBrain requested SmartThings removal over API and is watching for removal, an exclusion-counter change, or OFFLINE health before opening native inclusion."
        case "start_direct_migration":
            return protocolName == "zigbee"
                ? "HomeBrain requested SmartThings removal and opened Zigbee pairing. Complete the device action below; HomeBrain will verify discovery before continuing."
                : "HomeBrain opened Z-Wave inclusion. Complete the device action below; HomeBrain will verify the new node before continuing."
        default:
            return "Complete the current device step, then continue."
        }
    }

    private func migrationStepRequiresVerification(_ step: DirectRadioMigrationGuidedStepRecord?) -> Bool {
        guard let step else { return false }
        return ["physical_exclusion", "physical_inclusion", "physical_pairing", "verification"].contains(step.phase)
    }

    private func executeDirectRadioMigrationStep(
        _ step: DirectRadioMigrationGuidedStepRecord,
        device: DeviceItem,
        protocolName: String,
        migrationId: String?
    ) async throws -> String? {
        switch step.action {
        case "start_zwave_exclusion":
            var body: [String: Any] = [
                "protocol": "zwave",
                "durationSeconds": step.durationSeconds ?? 120,
                "deviceId": device.id
            ]
            if let migrationId, !migrationId.isEmpty {
                body["migrationId"] = migrationId
            }
            let response = try await session.apiClient.post(
                "/api/direct-radios/exclusion/start",
                body: body
            )
            let root = JSON.object(response)
            let result = JSON.object(root["result"])
            let migration = JSON.object(result["migration"])
            return JSON.optionalString(migration, "id") ?? migrationId
        case "start_direct_migration":
            var body: [String: Any] = [
                "deviceId": device.id,
                "protocol": protocolName,
                "durationSeconds": step.durationSeconds ?? (protocolName == "zwave" ? 240 : 180)
            ]
            if let migrationId, !migrationId.isEmpty {
                body["migrationId"] = migrationId
            }
            let response = try await session.apiClient.post(
                "/api/direct-radios/migrations",
                body: body
            )
            let root = JSON.object(response)
            let returnedPlan = JSON.object(root["plan"])
            if !returnedPlan.isEmpty {
                migrationPlans[device.id] = DirectRadioMigrationPlanRecord.from(returnedPlan)
            }
            let migration = JSON.object(root["migration"])
            return JSON.optionalString(migration, "id") ?? migrationId
        default:
            return migrationId
        }
    }

    private func advancePastAutomatedMigrationSteps(
        plan: DirectRadioMigrationPlanRecord,
        device: DeviceItem,
        protocolName: String,
        startIndex: Int,
        migrationId: String?
    ) async throws -> (stepIndex: Int, statusMessage: String, migrationId: String?) {
        var stepIndex = startIndex
        var statusMessage = ""
        var currentMigrationId = migrationId

        while stepIndex < plan.guidedSteps.count, plan.guidedSteps[stepIndex].automatic {
            let step = plan.guidedSteps[stepIndex]
            currentMigrationId = try await executeDirectRadioMigrationStep(
                step,
                device: device,
                protocolName: protocolName,
                migrationId: currentMigrationId
            )
            statusMessage = migrationActionMessage(for: step, protocolName: protocolName)
            stepIndex += 1
        }

        return (stepIndex, statusMessage, currentMigrationId)
    }

    private func startDirectRadioMigration(_ device: DeviceItem, protocolName: String) async {
        if pendingMigrationDeviceIds.contains(device.id) {
            return
        }

        pendingMigrationDeviceIds.insert(device.id)
        migrationFeedback[device.id] = protocolName == "zwave"
            ? "Requesting SmartThings Z-Wave removal."
            : "Opening guided Zigbee pairing."

        defer {
            pendingMigrationDeviceIds.remove(device.id)
        }

        if previewMode {
            let previewPlan = DirectRadioMigrationPlanRecord.preview(for: device, protocolName: protocolName)
            migrationPlans[device.id] = previewPlan
            migrationWorkflows[device.id] = DirectRadioMigrationWorkflowRecord(
                protocolName: protocolName,
                plan: previewPlan,
                migrationId: nil,
                stepIndex: min(1, max(previewPlan.guidedSteps.count - 1, 0)),
                statusMessage: "Guided migration started. Complete the current device action.",
                verificationGuidance: [],
                complete: false
            )
            return
        }

        do {
            let response = try await session.apiClient.get(
                "/api/direct-radios/migration-plan/\(device.id)",
                query: [URLQueryItem(name: "protocol", value: protocolName)]
            )
            let root = JSON.object(response)
            let selectedPlan = DirectRadioMigrationPlanRecord.from(JSON.object(root["plan"]))
            guard !selectedPlan.guidedSteps.isEmpty else {
                throw URLError(.cannotParseResponse)
            }
            migrationPlans[device.id] = selectedPlan

            let result = try await advancePastAutomatedMigrationSteps(
                plan: selectedPlan,
                device: device,
                protocolName: protocolName,
                startIndex: 0,
                migrationId: nil
            )
            let safeIndex = min(result.stepIndex, max(selectedPlan.guidedSteps.count - 1, 0))
            migrationWorkflows[device.id] = DirectRadioMigrationWorkflowRecord(
                protocolName: protocolName,
                plan: selectedPlan,
                migrationId: result.migrationId,
                stepIndex: safeIndex,
                statusMessage: result.statusMessage.isEmpty ? "Guided migration started." : result.statusMessage,
                verificationGuidance: [],
                complete: false
            )
            migrationFeedback[device.id] = selectedPlan.guidedSteps[safeIndex].title
        } catch {
            migrationFeedback[device.id] = "Migration could not start: \(error.localizedDescription)"
            errorMessage = error.localizedDescription
        }
    }

    private func verifyDirectRadioMigrationStep(
        workflow: DirectRadioMigrationWorkflowRecord,
        step: DirectRadioMigrationGuidedStepRecord,
        device: DeviceItem
    ) async throws -> DirectRadioMigrationStepVerificationRecord {
        var body: [String: Any] = [
            "deviceId": device.id,
            "protocol": workflow.protocolName,
            "phase": step.phase,
            "stepId": step.id
        ]
        if let migrationId = workflow.migrationId, !migrationId.isEmpty {
            body["migrationId"] = migrationId
        }

        let response = try await session.apiClient.post(
            "/api/direct-radios/migrations/verify-step",
            body: body
        )
        let root = JSON.object(response)
        return DirectRadioMigrationStepVerificationRecord.from(JSON.object(root["verification"]))
    }

    private func advanceDirectRadioMigrationWorkflow(_ device: DeviceItem) async {
        guard var workflow = migrationWorkflows[device.id],
              !pendingMigrationDeviceIds.contains(device.id) else {
            return
        }

        pendingMigrationDeviceIds.insert(device.id)
        defer {
            pendingMigrationDeviceIds.remove(device.id)
        }

        if previewMode {
            workflow.stepIndex = min(workflow.stepIndex + 1, max(workflow.plan.guidedSteps.count - 1, 0))
            workflow.complete = workflow.stepIndex >= workflow.plan.guidedSteps.count - 1
            workflow.statusMessage = workflow.complete ? "Guided workflow complete." : "Next migration step ready."
            workflow.verificationGuidance = []
            migrationWorkflows[device.id] = workflow
            migrationFeedback[device.id] = workflow.statusMessage
            return
        }

        do {
            let currentStep = workflow.currentStep
            if migrationStepRequiresVerification(currentStep), let currentStep {
                let verification = try await verifyDirectRadioMigrationStep(
                    workflow: workflow,
                    step: currentStep,
                    device: device
                )
                if (workflow.migrationId ?? "").isEmpty, !verification.migrationId.isEmpty {
                    workflow.migrationId = verification.migrationId
                }
                if !verification.canAdvance {
                    workflow.statusMessage = verification.message
                    workflow.verificationGuidance = verification.guidance
                    migrationWorkflows[device.id] = workflow
                    migrationFeedback[device.id] = verification.message
                    return
                }
            }

            let nextStartIndex = workflow.stepIndex + 1
            if nextStartIndex >= workflow.plan.guidedSteps.count {
                workflow.complete = true
                workflow.statusMessage = "Guided workflow complete. HomeBrain verified the native migration gate before finishing."
                workflow.verificationGuidance = []
                migrationWorkflows[device.id] = workflow
                migrationFeedback[device.id] = workflow.statusMessage
                return
            }

            let result = try await advancePastAutomatedMigrationSteps(
                plan: workflow.plan,
                device: device,
                protocolName: workflow.protocolName,
                startIndex: nextStartIndex,
                migrationId: workflow.migrationId
            )
            workflow.migrationId = result.migrationId ?? workflow.migrationId

            if result.stepIndex >= workflow.plan.guidedSteps.count {
                workflow.stepIndex = max(workflow.plan.guidedSteps.count - 1, 0)
                workflow.complete = true
                workflow.statusMessage = "Guided workflow complete. HomeBrain verified the native migration gate before finishing."
                workflow.verificationGuidance = []
            } else {
                workflow.stepIndex = result.stepIndex
                workflow.statusMessage = result.statusMessage.isEmpty ? "Next migration step ready." : result.statusMessage
                workflow.verificationGuidance = []
            }

            migrationWorkflows[device.id] = workflow
            migrationFeedback[device.id] = workflow.statusMessage
        } catch {
            migrationFeedback[device.id] = "Migration step failed: \(error.localizedDescription)"
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

    private func runAddDeviceAction() async {
        addDeviceStatusMessage = nil
        errorMessage = nil

        switch addDeviceMode {
        case "manual":
            await createDevice()
        case "zwave", "zigbee":
            await startDirectRadioAdd(protocolName: addDeviceMode)
        case "insteon":
            await startInsteonAdd()
        case "matter":
            await startMatterCommissioning()
            addDeviceStatusMessage = matterStatusMessage ?? "Matter commissioning started. HomeBrain will add the device after commissioning completes."
        default:
            await createDevice()
        }
    }

    private func startDirectRadioAdd(protocolName: String) async {
        if previewMode {
            addDeviceStatusMessage = "\(addDeviceModeLabel(protocolName)) pairing would start on real HomeBrain hardware."
            return
        }

        addDeviceBusy = true
        addDevicePendingDsk = ""
        addDeviceDskPin = ""
        defer { addDeviceBusy = false }

        do {
            let response = try await session.apiClient.post(
                "/api/direct-radios/pairing/start",
                body: [
                    "protocol": protocolName,
                    "durationSeconds": addDeviceDurationSeconds
                ]
            )
            let root = JSON.object(response)
            let result = JSON.object(root["result"])
            let expiresAt = JSON.optionalString(result, "expiresAt") ?? ""
            let suffix = expiresAt.isEmpty ? "" : " Window expires at \(JSON.displayDate(from: expiresAt))."
            addDeviceStatusMessage = protocolName == "zwave"
                ? "Z-Wave inclusion is live. Perform the device include action; HomeBrain will move on as soon as the controller detects the node.\(suffix)"
                : "Zigbee permit-join is live. Pair or reset the device; HomeBrain adds it after join and interview.\(suffix)"
            await monitorDirectRadioAdd(protocolName: protocolName, durationSeconds: addDeviceDurationSeconds)
        } catch {
            addDeviceStatusMessage = error.localizedDescription
            errorMessage = error.localizedDescription
        }
    }

    private func monitorDirectRadioAdd(protocolName: String, durationSeconds: Int) async {
        let deadline = Date().addingTimeInterval(TimeInterval(durationSeconds + 30))

        while Date() < deadline && showCreateSheet {
            do {
                let response = try await session.apiClient.get("/api/direct-radios/status")
                let root = JSON.object(response)
                let status = JSON.object(root["status"])
                let pairings = JSON.object(status["pairings"])
                let pairing = JSON.object(pairings[protocolName])
                let pairingStatus = JSON.string(pairing, "status")
                let message = JSON.string(pairing, "message")

                if protocolName == "zwave" {
                    let pendingDsk = JSON.string(pairing, "pendingDsk")
                    if pairingStatus == "awaiting_dsk" && !pendingDsk.isEmpty {
                        addDevicePendingDsk = pendingDsk
                        addDeviceStatusMessage = "Z-Wave found the switch and needs the 5 digit DSK PIN to finish S2 security."
                    }
                }

                if pairingStatus == "completed" {
                    addDevicePendingDsk = ""
                    addDeviceStatusMessage = message.isEmpty ? "\(addDeviceModeLabel(protocolName)) device joined HomeBrain." : message
                    await loadDevices(showLoading: false)
                    return
                }

                if pairingStatus == "failed" || pairingStatus == "expired" {
                    addDeviceStatusMessage = message.isEmpty ? "\(addDeviceModeLabel(protocolName)) pairing did not complete." : message
                    errorMessage = addDeviceStatusMessage
                    await loadDevices(showLoading: false)
                    return
                }

                await loadDevices(showLoading: false)
            } catch {
                addDeviceStatusMessage = error.localizedDescription
                errorMessage = error.localizedDescription
                return
            }

            try? await Task.sleep(nanoseconds: 1_500_000_000)
        }

        if showCreateSheet {
            addDeviceStatusMessage = "\(addDeviceModeLabel(protocolName)) pairing window ended before HomeBrain verified a new device. Start pairing again and repeat the physical include action while the window is open."
            errorMessage = addDeviceStatusMessage
        }
    }

    private func submitAddDeviceDskPin() async {
        let pin = String(addDeviceDskPin.filter(\.isNumber).prefix(5))
        guard pin.count == 5 else {
            addDeviceStatusMessage = "Enter the 5 digit DSK PIN from the switch label or QR code."
            return
        }

        do {
            _ = try await session.apiClient.post(
                "/api/direct-radios/pairing/zwave/dsk-pin",
                body: ["pin": pin]
            )
            addDeviceDskPin = ""
            addDevicePendingDsk = ""
            addDeviceStatusMessage = "Z-Wave S2 PIN submitted. Keep the switch powered while HomeBrain finishes the interview."
        } catch {
            addDeviceStatusMessage = error.localizedDescription
            errorMessage = error.localizedDescription
        }
    }

    private func repairZWaveNode(_ device: DeviceItem) async {
        guard let nodeId = zWaveNodeId(for: device) else {
            addDeviceStatusMessage = "HomeBrain could not find the Z-Wave node id for that device."
            return
        }
        if previewMode {
            addDeviceStatusMessage = "HomeBrain would request a fresh Z-Wave interview for node \(nodeId)."
            return
        }

        addDeviceRepairingZWaveNodeId = nodeId
        addDeviceStatusMessage = "Requesting a fresh Z-Wave interview for \(device.name)."
        errorMessage = nil
        defer { addDeviceRepairingZWaveNodeId = nil }

        do {
            let response = try await session.apiClient.post(
                "/api/direct-radios/zwave/nodes/\(nodeId)/refresh-info",
                body: [
                    "waitForWakeup": false,
                    "pingFirst": true
                ]
            )
            let root = JSON.object(response)
            let result = JSON.object(root["result"])
            let ping = result["ping"] as? Bool
            addDeviceStatusMessage = ping == false
                ? "HomeBrain requested a fresh interview for node \(nodeId), but it did not answer the first ping. Tap the switch once and refresh devices."
                : "HomeBrain requested a fresh interview for node \(nodeId). Tap the switch once if it does not update in a few seconds."
            await loadDevices(showLoading: false)
        } catch {
            addDeviceStatusMessage = error.localizedDescription
            errorMessage = error.localizedDescription
        }
    }

    private func startInsteonAdd() async {
        if previewMode {
            addDeviceStatusMessage = "Insteon PLM link mode would start on real HomeBrain hardware."
            return
        }

        addDeviceBusy = true
        defer { addDeviceBusy = false }

        do {
            let response = try await session.apiClient.post(
                "/api/insteon/devices/link",
                body: ["timeout": 90]
            )
            let root = JSON.object(response)
            let linkedAddress = JSON.optionalString(root, "normalizedAddress")
                ?? JSON.optionalString(root, "address")
                ?? "device"
            let deviceObject = JSON.object(root["device"])
            let linkedDevice = DeviceItem.from(deviceObject)
            if !linkedDevice.id.isEmpty {
                upsertDevice(linkedDevice)
                addDeviceStatusMessage = "\(linkedDevice.name) was linked and added to HomeBrain."
            } else {
                addDeviceStatusMessage = "Insteon linked \(linkedAddress). Refreshing device list."
            }
            await loadDevices(showLoading: false)
        } catch {
            addDeviceStatusMessage = error.localizedDescription
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
        if device.type == "switch" {
            return "switch.2"
        }

        if device.type == "light" || supportsLightFade(device) {
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

    private func deviceTypeFilterLabel(_ type: String) -> String {
        switch type {
        case "all":
            return "All types"
        case "light":
            return "Lights"
        case "switch":
            return "Switches"
        case "lock":
            return "Locks"
        case "thermostat":
            return "Thermostats"
        case "garage":
            return "Garage"
        case "sensor":
            return "Sensors"
        case "camera":
            return "Cameras"
        default:
            return type.capitalized
        }
    }

    private func deviceTypeDisplayLabel(_ type: String) -> String {
        switch type {
        case "light":
            return "Light"
        case "switch":
            return "Switch"
        case "lock":
            return "Lock"
        case "thermostat":
            return "Thermostat"
        case "garage":
            return "Garage"
        case "sensor":
            return "Sensor"
        case "camera":
            return "Camera"
        default:
            return type.capitalized
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

    private func propertyStringSet(for device: DeviceItem, key: String) -> Set<String> {
        let raw = device.properties[key] as? [Any] ?? []
        return Set(
            raw
                .map(normalizedSmartThingsValue)
                .filter { !$0.isEmpty }
                .map { $0.lowercased() }
        )
    }

    private func zWaveNodeId(for device: DeviceItem) -> Int? {
        let direct = JSON.object(device.properties["homebrainDirect"])
        let nodeId = JSON.int(direct, "nodeId")
        return nodeId > 0 ? nodeId : nil
    }

    private func isIncompleteZWaveDirectDevice(_ device: DeviceItem) -> Bool {
        guard device.selectionSource == "homebrain-zwave",
              let nodeId = zWaveNodeId(for: device),
              nodeId != 1 else {
            return false
        }

        let direct = JSON.object(device.properties["homebrainDirect"])
        let hasIdentity = direct["manufacturerId"] != nil
            || direct["productType"] != nil
            || direct["productId"] != nil
        return !device.isOnline
            || propertyStringSet(for: device, key: "directRadioFeatures").isEmpty
            || !hasIdentity
    }

    private func zwaveRepairSubtitle(for device: DeviceItem) -> String {
        let node = zWaveNodeId(for: device).map { "Node \($0)" } ?? "Node ?"
        let featureCount = propertyStringSet(for: device, key: "directRadioFeatures").count
        let state = device.isOnline ? "not fully interviewed" : "offline"
        return "\(node) · \(featureCount) features · \(state)"
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
            || propertyStringSet(for: device, key: "directRadioFeatures").contains("brightness")
            || propertyStringSet(for: device, key: "matterFeatures").contains("brightness")
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

private struct DirectRadioMigrationInstructionProfileRecord {
    let key: String
    let label: String
    let confidence: String
    let reference: String?

    nonisolated static func from(_ object: [String: Any]) -> DirectRadioMigrationInstructionProfileRecord? {
        guard !object.isEmpty else {
            return nil
        }

        let key = JSON.string(object, "key")
        return DirectRadioMigrationInstructionProfileRecord(
            key: key,
            label: JSON.string(object, "label", fallback: key.isEmpty ? "Device instructions" : key),
            confidence: JSON.string(object, "confidence", fallback: "medium"),
            reference: JSON.optionalString(object, "reference")
        )
    }
}

private struct DirectRadioMigrationGuidedStepRecord: Identifiable {
    let id: String
    let title: String
    let phase: String
    let protocolName: String
    let action: String
    let automatic: Bool
    let durationSeconds: Int?
    let instructions: [String]
    let confirmLabel: String

    nonisolated static func from(_ object: [String: Any]) -> DirectRadioMigrationGuidedStepRecord {
        let id = JSON.string(object, "id", fallback: UUID().uuidString)
        let durationValue = object["durationSeconds"]
        let durationSeconds: Int?
        if let value = durationValue as? Int {
            durationSeconds = value
        } else if let value = durationValue as? Double {
            durationSeconds = Int(value)
        } else if let value = durationValue as? String, let parsed = Int(value) {
            durationSeconds = parsed
        } else {
            durationSeconds = nil
        }

        return DirectRadioMigrationGuidedStepRecord(
            id: id,
            title: JSON.string(object, "title", fallback: "Migration step"),
            phase: JSON.string(object, "phase"),
            protocolName: JSON.string(object, "protocol", fallback: "unknown"),
            action: JSON.string(object, "action", fallback: "user_confirm"),
            automatic: JSON.bool(object, "automatic"),
            durationSeconds: durationSeconds,
            instructions: JSON.stringArray(object["instructions"]),
            confirmLabel: JSON.string(object, "confirmLabel", fallback: "Done")
        )
    }
}

private struct DirectRadioMigrationWorkflowRecord {
    let protocolName: String
    var plan: DirectRadioMigrationPlanRecord
    var migrationId: String?
    var stepIndex: Int
    var statusMessage: String
    var verificationGuidance: [String]
    var complete: Bool

    var currentStep: DirectRadioMigrationGuidedStepRecord? {
        guard plan.guidedSteps.indices.contains(stepIndex) else {
            return nil
        }
        return plan.guidedSteps[stepIndex]
    }

    var protocolLabel: String {
        protocolName == "zigbee" ? "Zigbee" : "Z-Wave"
    }
}

private struct DirectRadioMigrationStepVerificationRecord {
    let migrationId: String
    let status: String
    let canAdvance: Bool
    let message: String
    let guidance: [String]

    nonisolated static func from(_ object: [String: Any]) -> DirectRadioMigrationStepVerificationRecord {
        DirectRadioMigrationStepVerificationRecord(
            migrationId: JSON.string(object, "migrationId"),
            status: JSON.string(object, "status", fallback: "pending"),
            canAdvance: JSON.bool(object, "canAdvance"),
            message: JSON.string(object, "message", fallback: "HomeBrain is still waiting for migration verification."),
            guidance: JSON.stringArray(object["guidance"])
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
    let guidedSteps: [DirectRadioMigrationGuidedStepRecord]
    let instructionProfile: DirectRadioMigrationInstructionProfileRecord?
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

    var normalizedRecommendedProtocol: String? {
        switch recommendedProtocol {
        case "zigbee":
            return "zigbee"
        case "zwave", "z-wave":
            return "zwave"
        default:
            return nil
        }
    }

    var protocolButtonOrder: [String] {
        guard let recommended = normalizedRecommendedProtocol else {
            return ["zigbee", "zwave"]
        }

        return [
            recommended,
            recommended == "zigbee" ? "zwave" : "zigbee"
        ]
    }

    func buttonTitle(for protocolName: String) -> String {
        let label = protocolName == "zigbee" ? "Zigbee" : "Z-Wave"
        if protocolName == normalizedRecommendedProtocol {
            return "Recommended \(label)"
        }
        if normalizedRecommendedProtocol != nil {
            return "Use \(label)"
        }
        return label
    }

    var migrationSafetyNote: String {
        if !supported {
            return "HomeBrain will not open an exclusion, pairing, or migration window for this device. Keep it on its current integration unless you replace it with native radio hardware."
        }
        if normalizedRecommendedProtocol == "zwave" {
            return "Z-Wave transition starts with exclusion from the SmartThings hub. HomeBrain waits for SmartThings removal before opening native inclusion on the Zooz stick."
        }
        return "HomeBrain keeps the SmartThings-backed record until you verify the native HomeBrain replacement. Confirm battery, state, and controls before retiring SmartThings."
    }

    var nativeFeatureCount: Int {
        featureSupport.filter { $0.supported }.count
    }

    nonisolated static func from(_ object: [String: Any]) -> DirectRadioMigrationPlanRecord {
        return DirectRadioMigrationPlanRecord(
            recommendedProtocol: JSON.string(object, "recommendedProtocol", fallback: "unknown"),
            inferredProtocol: JSON.string(object, "inferredProtocol", fallback: "unknown"),
            supported: JSON.bool(object, "supported"),
            features: JSON.stringArray(object["features"]),
            featureSupport: JSON.array(object["featureSupport"]).map(DirectRadioMigrationFeatureSupportRecord.from),
            manualSteps: JSON.stringArray(object["manualSteps"]),
            guidedSteps: JSON.array(object["guidedSteps"]).map(DirectRadioMigrationGuidedStepRecord.from),
            instructionProfile: DirectRadioMigrationInstructionProfileRecord.from(JSON.object(object["instructionProfile"])),
            warnings: JSON.stringArray(object["warnings"]),
            targetSource: JSON.string(object, "targetSource")
        )
    }

    nonisolated static func preview(for device: DeviceItem, protocolName: String = "unknown") -> DirectRadioMigrationPlanRecord {
        let selectedProtocol = protocolName == "zigbee" || protocolName == "zwave" ? protocolName : "unknown"
        let firstAction = selectedProtocol == "zwave" ? "start_zwave_exclusion" : "start_direct_migration"
        let firstTitle = selectedProtocol == "zwave" ? "Start SmartThings Z-Wave removal" : "Open HomeBrain Zigbee pairing"
        let secondTitle = selectedProtocol == "zwave" ? "Trigger exclusion on \(device.name)" : "Put \(device.name) into Zigbee pairing mode"
        let guidedSteps = [
            DirectRadioMigrationGuidedStepRecord(
                id: "preview-start",
                title: firstTitle,
                phase: selectedProtocol == "zwave" ? "exclusion" : "permit_join",
                protocolName: selectedProtocol,
                action: firstAction,
                automatic: true,
                durationSeconds: selectedProtocol == "zwave" ? 120 : 180,
                instructions: ["HomeBrain opens the radio window automatically."],
                confirmLabel: "Start"
            ),
            DirectRadioMigrationGuidedStepRecord(
                id: "preview-device-action",
                title: secondTitle,
                phase: "physical_action",
                protocolName: selectedProtocol,
                action: "user_confirm",
                automatic: false,
                durationSeconds: nil,
                instructions: ["Use the device-specific reset, exclusion, or pairing action shown by HomeBrain."],
                confirmLabel: "I completed this"
            )
        ]
        return DirectRadioMigrationPlanRecord(
            recommendedProtocol: selectedProtocol,
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
            guidedSteps: guidedSteps,
            instructionProfile: DirectRadioMigrationInstructionProfileRecord(
                key: "preview",
                label: "Preview device instructions",
                confidence: "medium",
                reference: nil
            ),
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
