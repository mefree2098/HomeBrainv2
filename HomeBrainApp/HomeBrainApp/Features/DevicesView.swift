import Foundation
import SwiftUI
import UIKit

private struct AddDeviceZWaveNodeSummary: Identifiable {
    let id: Int
    let name: String
    let ready: Bool
    let status: Int?
    let incomplete: Bool
    let featureCount: Int
}

private struct AddDeviceZWaveRepairCandidate: Identifiable {
    let id: String
    let nodeId: Int
    let name: String
    let subtitle: String
    let ready: Bool
    let dead: Bool
    let controllerOnly: Bool
    let canRemoveFailed: Bool
    let forceRemoveFailed: Bool
    let likelyLegacySiren: Bool
}

private struct SirenVolumeOption: Identifiable, Hashable {
    let label: String
    let value: Int

    var id: Int { value }
}

struct DevicesView: View {
    let previewMode: Bool
    let embeddedFocusDeviceID: String?
    let onClose: (() -> Void)?

    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var deviceFocusState: DeviceFocusState
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.scenePhase) private var scenePhase

    @State private var devices: [DeviceItem] = []
    @State private var isLoading = true
    @State private var errorMessage: String?

    @State private var searchText = ""
    @State private var typeFilter = "all"
    @State private var sourceFilter = DeviceItem.allSelectionSourcesValue

    @State private var lightBrightnessDrafts: [String: Double] = [:]
    @State private var lightColorDrafts: [String: String] = [:]
    @State private var lightColorTemperatureDrafts: [String: Double] = [:]
    @State private var thermostatTemperatureDrafts: [String: Double] = [:]
    @State private var pendingControls: Set<String> = []
    @State private var controlFeedback: [String: ControlFeedback] = [:]
    @State private var favoriteDeviceIds: Set<String> = []
    @State private var favoritesProfileId: String?
    @State private var pendingFavoriteDeviceIds: Set<String> = []
    @State private var highlightedDeviceID: String?
    @State private var controlSheetDeviceID: String?
    @State private var pendingDeleteDevice: DeviceItem?
    @State private var pendingMigrationDeviceIds: Set<String> = []
    @State private var pendingMigrationFinalizationDeviceIds: Set<String> = []
    @State private var pendingMigrationPlanDeviceIds: Set<String> = []
    @State private var migrationFeedback: [String: String] = [:]
    @State private var migrationPlans: [String: DirectRadioMigrationPlanRecord] = [:]
    @State private var migrationPlanErrors: [String: String] = [:]
    @State private var migrationWorkflows: [String: DirectRadioMigrationWorkflowRecord] = [:]
    @State private var lockCodeStates: [String: NativeLockCodeState] = [:]
    @State private var lockCodeEvents: [String: [NativeLockCodeEvent]] = [:]
    @State private var lockCodeDrafts: [String: NativeLockCodeDraft] = [:]
    @State private var lockCodeLoadingDeviceIds: Set<String> = []
    @State private var lockCodeSavingDeviceIds: Set<String> = []
    @State private var lockCodeDeletingKeys: Set<String> = []
    @State private var lockCodeErrors: [String: String] = [:]
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
    @State private var addDeviceZWaveSecurityMode = "insecure"
    @State private var addDeviceRepairingZWaveNodeId: Int?
    @State private var addDeviceReplacingZWaveNodeId: Int?
    @State private var addDeviceRemovingZWaveNodeId: Int?
    @State private var reinterviewingZigbeeDeviceId: String?
    @State private var addDeviceKnownZWaveNodeIds: Set<Int>?
    @State private var addDeviceKnownZWaveNodes: [AddDeviceZWaveNodeSummary] = []
    @State private var newName = ""
    @State private var newType = "light"
    @State private var newRoom = ""
    @State private var editDeviceID: String?
    @State private var editDeviceName = ""
    @State private var editDeviceRoom = ""
    @State private var editDeviceType = "switch"
    @State private var editContactOpenDebounceEnabled = false
    @State private var editContactOpenDebounceSeconds = 1.5
    @State private var savingDeviceDetails = false
    @State private var contentWidth: CGFloat = 0
    @State private var appliedPreviewLaunchActions = false

    private let availableTypes = ["all", "light", "lock", "thermostat", "garage", "sensor", "siren", "switch", "camera", "speaker"]
    private let contactOpenDebounceDefaultSeconds = 1.5
    private let contactOpenDebounceMinSeconds = 0.25
    private let contactOpenDebounceMaxSeconds = 10.0
    private let contactOpenDebounceStepSeconds = 0.25
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
    private var addDeviceSheetPadding: CGFloat { useLandscapeCompactLayout ? 12 : (isCompact ? 16 : 22) }
    private var addDeviceSheetSpacing: CGFloat { useLandscapeCompactLayout ? 12 : 16 }
    private var embeddedFocusedDevice: DeviceItem? {
        guard let embeddedFocusDeviceID else { return nil }
        return devices.first(where: { $0.id == embeddedFocusDeviceID })
    }
    private var controlSheetDevice: DeviceItem? {
        guard let controlSheetDeviceID else { return nil }
        return devices.first(where: { $0.id == controlSheetDeviceID })
    }
    private var availableRoomNames: [String] {
        var rooms = Set(["Unassigned"])
        devices.forEach { device in
            let room = device.room.trimmingCharacters(in: .whitespacesAndNewlines)
            if !room.isEmpty {
                rooms.insert(room)
            }
        }
        return rooms.sorted { left, right in
            if left.localizedCaseInsensitiveCompare("Unassigned") == .orderedSame {
                return true
            }
            if right.localizedCaseInsensitiveCompare("Unassigned") == .orderedSame {
                return false
            }
            return left.localizedCaseInsensitiveCompare(right) == .orderedAscending
        }
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
            return !isRetiredSmartThingsMigrationSource(device) && matchesSearchAndSource && matchesType
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

    private static func previewAddDeviceModeFromLaunch() -> String? {
        let processInfo = ProcessInfo.processInfo
        let allowedModes = Set(["zwave", "zigbee", "insteon", "matter", "manual"])

        if let index = processInfo.arguments.firstIndex(of: "-ui-preview-add-device-mode"),
           processInfo.arguments.indices.contains(index + 1) {
            let requestedMode = processInfo.arguments[index + 1].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            return allowedModes.contains(requestedMode) ? requestedMode : nil
        }

        if let requestedMode = processInfo.environment["UI_PREVIEW_ADD_DEVICE_MODE"]?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
           allowedModes.contains(requestedMode) {
            return requestedMode
        }

        return nil
    }

    private static func previewShouldOpenAddDeviceFromLaunch() -> Bool {
        let processInfo = ProcessInfo.processInfo
        if processInfo.arguments.contains("-ui-preview-open-add-device") {
            return true
        }
        if processInfo.arguments.contains("-ui-preview-add-device-mode") {
            return true
        }
        if let environmentValue = processInfo.environment["UI_PREVIEW_OPEN_ADD_DEVICE"] {
            return ["1", "true", "yes"].contains(environmentValue.lowercased())
        }
        return false
    }

    private var deviceStreamTaskKey: String {
        [
            String(describing: scenePhase),
            session.serverURLString,
            session.accessToken ?? "none"
        ].joined(separator: "||")
    }

    private var deviceFallbackRefreshTaskKey: String {
        [
            String(describing: scenePhase),
            session.serverURLString,
            session.accessToken ?? "none",
            isEmbeddedFocusMode ? "focused" : "list"
        ].joined(separator: "||")
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
        .confirmationDialog(
            pendingDeleteDevice == nil ? "Delete Device" : "Delete \(pendingDeleteDevice?.name ?? "Device")?",
            isPresented: Binding(
                get: { pendingDeleteDevice != nil },
                set: { isPresented in
                    if !isPresented {
                        pendingDeleteDevice = nil
                    }
                }
            ),
            presenting: pendingDeleteDevice
        ) { device in
            Button("Delete \(device.name)", role: .destructive) {
                Task { await deleteDevice(device) }
            }
            Button("Cancel", role: .cancel) {
                pendingDeleteDevice = nil
            }
        } message: { device in
            Text("This removes the HomeBrain device record and clears security, dashboard, favorites, Alexa, and telemetry references. Native Zigbee and Z-Wave records are also removed from the radio controller when possible.")
        }
        .task {
            await loadDevices(showLoading: true)
        }
        .task(id: deviceStreamTaskKey) {
            guard !previewMode, scenePhase == .active, session.accessToken != nil else { return }
            await listenForDeviceUpdates()
        }
        .task(id: deviceFallbackRefreshTaskKey) {
            guard !previewMode, scenePhase == .active, session.accessToken != nil else { return }

            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(12))
                guard !Task.isCancelled else { break }
                await refreshDeviceStatesFromAPI()
            }
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
                        .font(HBTypography.display(size: 11, weight: .bold))
                        .textCase(.uppercase)
                        .tracking(2.2)
                        .foregroundStyle(HBPalette.textMuted)

                    Text(embeddedFocusedDevice?.name ?? "Device unavailable")
                        .font(HBTypography.display(size: useLandscapeCompactLayout ? 20 : 22, weight: .bold))
                        .foregroundStyle(HBPalette.textPrimary)

                    Text(embeddedFocusedDevice?.displayRoom ?? "Close this panel to return to the Security Center exactly where you left it.")
                        .font(HBTypography.body(size: 14, weight: .medium))
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
                                .font(HBTypography.display(size: 11, weight: .bold))
                                .textCase(.uppercase)
                                .tracking(2.2)
                                .foregroundStyle(HBPalette.textMuted)
                            Text("Type")
                                .font(HBTypography.body(size: 14, weight: .semibold))
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
                                .font(HBTypography.body(size: 14, weight: .semibold))
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
                                .font(HBTypography.display(size: 11, weight: .bold))
                                .textCase(.uppercase)
                                .tracking(2.2)
                                .foregroundStyle(HBPalette.textMuted)
                            Text("Type")
                                .font(HBTypography.body(size: 14, weight: .semibold))
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
                                .font(HBTypography.body(size: 14, weight: .semibold))
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
                            .font(HBTypography.display(size: useLandscapeCompactLayout ? 18 : 20, weight: .bold))
                            .foregroundStyle(HBPalette.textPrimary)
                            .lineLimit(2)
                        Text(device.displayRoom)
                            .font(HBTypography.body(size: useLandscapeCompactLayout ? 13 : 14, weight: .medium))
                            .foregroundStyle(HBPalette.textSecondary)
                        HStack(spacing: 6) {
                            Circle()
                                .fill(device.isOnline ? HBPalette.accentGreen : HBPalette.accentOrange)
                                .frame(width: 7, height: 7)
                            Text(device.isOnline ? "Online" : "Offline")
                                .font(HBTypography.body(size: useLandscapeCompactLayout ? 11 : 12, weight: .semibold))
                                .foregroundStyle(device.isOnline ? HBPalette.accentGreen : HBPalette.accentOrange)
                            if deviceSupportsBattery(device) {
                                Text("·")
                                    .font(HBTypography.body(size: useLandscapeCompactLayout ? 11 : 12, weight: .semibold))
                                    .foregroundStyle(HBPalette.textSecondary)
                                batteryIndicator(for: device, compact: true)
                            }
                            if sensorTemperatureF(for: device) != nil {
                                Text("·")
                                    .font(HBTypography.body(size: useLandscapeCompactLayout ? 11 : 12, weight: .semibold))
                                    .foregroundStyle(HBPalette.textSecondary)
                                temperatureIndicator(for: device)
                            }
                        }
                    }

                    Spacer(minLength: 0)

                    favoriteButton(for: device)
                }

                deviceIdentityBadges(for: device)

                VStack(alignment: .leading, spacing: 4) {
                    Text(deviceControlSummary(for: device))
                        .font(HBTypography.body(size: 14, weight: .semibold))
                        .foregroundStyle(HBPalette.textPrimary)
                    Text("Direct control, grouping, voice, history, and migration context.")
                        .font(HBTypography.body(size: 12, weight: .medium))
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
                pendingDeleteDevice = device
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
                if isSmartThingsBackedDevice(device) || needsMigrationFinalization(device) {
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
                    if isSmartThingsBackedDevice(device) || needsMigrationFinalization(device) {
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
        if supportsDirectRadioPowerControl(device) {
            return true
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
        if device.type == "lock" {
            return device.status ? "lock.open.fill" : "lock.fill"
        }
        if device.type == "garage" {
            return device.status ? "door.garage.closed" : "door.garage.open"
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

    private func primaryDeviceAction(for device: DeviceItem) -> String {
        if device.type == "lock" {
            return device.status ? "unlock" : "lock"
        }
        if device.type == "garage" {
            return device.status ? "close" : "open"
        }
        return device.status ? "turn_off" : "turn_on"
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

        await handleDeviceControl(deviceId: device.id, action: primaryDeviceAction(for: device))
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
            if supportsLightColorTemperature(device) {
                parts.append("\(Int(currentLightColorTemperature(for: device)))K")
            }
            return parts.joined(separator: " · ")
        }
        if isSmartThingsAwaitingNativePairing(device) {
            return "SmartThings removed; awaiting Zigbee pairing"
        }
        if device.type == "sensor" {
            return sensorSummary(for: device)
        }
        if isSmartThingsBackedDevice(device) {
            return "SmartThings route preserved"
        }
        if needsMigrationFinalization(device) {
            return "Native route pending finalization"
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
                    .font(HBTypography.body(size: 13, weight: .bold))
                    .foregroundStyle(HBPalette.textPrimary)
                Spacer(minLength: 0)
                if isPending {
                    ProgressView()
                        .controlSize(.small)
                }
            }

            Text("HomeBrain opens the native radio operation at the right time, then waits for the physical exclude, reset, or pairing action. Retire SmartThings only after native state and controls are verified.")
                .font(HBTypography.body(size: 12, weight: .medium))
                .foregroundStyle(HBPalette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

            if planLoading {
                HStack(spacing: 8) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Loading migration plan...")
                        .font(HBTypography.body(size: 12, weight: .semibold))
                        .foregroundStyle(HBPalette.textSecondary)
                }
            } else if let planError {
                Text(planError)
                    .font(HBTypography.body(size: 12, weight: .semibold))
                    .foregroundStyle(HBPalette.accentRed)
                    .fixedSize(horizontal: false, vertical: true)
            } else if let plan {
                directRadioMigrationPlanSummary(plan)
            }

            if let workflow {
                directRadioMigrationWorkflowCard(workflow, device: device, isPending: isPending)
            } else if plan?.supported == false {
                Text("No radio workflow is available for this device. Keep it on its current integration, or replace it with a known Zigbee, Z-Wave, or Matter device before onboarding natively.")
                    .font(HBTypography.body(size: 12, weight: .semibold))
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
                    .font(HBTypography.body(size: 12, weight: .semibold))
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
                        .font(HBTypography.display(size: 10, weight: .bold))
                        .textCase(.uppercase)
                        .tracking(1.6)
                        .foregroundStyle(HBPalette.textMuted)
                    Text(plan.recommendedProtocolLabel)
                        .font(HBTypography.body(size: 14, weight: .bold))
                        .foregroundStyle(HBPalette.textPrimary)
                }
                Spacer()
                Text(plan.supported ? "\(plan.nativeFeatureCount)/\(max(plan.featureSupport.count, 1)) native" : "Do not migrate")
                    .font(HBTypography.body(size: 11, weight: .bold))
                    .foregroundStyle(plan.supported ? HBPalette.accentGreen : HBPalette.accentRed)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(HBPalette.panelSoft.opacity(0.72), in: Capsule())
            }

            if !plan.warnings.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(plan.warnings.prefix(3).enumerated()), id: \.offset) { _, warning in
                        Text(warning)
                            .font(HBTypography.body(size: 11, weight: .medium))
                            .foregroundStyle(HBPalette.accentOrange)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

            Text(plan.migrationSafetyNote)
                .font(HBTypography.body(size: 11, weight: .semibold))
                .foregroundStyle(HBPalette.accentBlue)
                .fixedSize(horizontal: false, vertical: true)

            if let profile = plan.instructionProfile {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Instruction profile")
                        .font(HBTypography.display(size: 10, weight: .bold))
                        .textCase(.uppercase)
                        .tracking(1.6)
                        .foregroundStyle(HBPalette.textMuted)
                    Text("\(profile.label) • \(profile.confidence)")
                        .font(HBTypography.body(size: 11, weight: .semibold))
                        .foregroundStyle(HBPalette.accentBlue)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            if !plan.guidedSteps.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Guided workflow")
                        .font(HBTypography.display(size: 10, weight: .bold))
                        .textCase(.uppercase)
                        .tracking(1.6)
                        .foregroundStyle(HBPalette.textMuted)
                    ForEach(Array(plan.guidedSteps.prefix(5).enumerated()), id: \.offset) { index, step in
                        Text("\(index + 1). \(step.automatic ? "HomeBrain: " : "")\(step.title)")
                            .font(HBTypography.body(size: 11, weight: .medium))
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
                        .font(HBTypography.display(size: 10, weight: .bold))
                        .textCase(.uppercase)
                        .tracking(1.6)
                        .foregroundStyle(HBPalette.textMuted)
                    Text(currentStep?.title ?? "Migration workflow")
                        .font(HBTypography.body(size: 13, weight: .bold))
                        .foregroundStyle(HBPalette.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                Text(workflow.protocolLabel)
                    .font(HBTypography.body(size: 10, weight: .bold))
                    .foregroundStyle(HBPalette.accentGreen)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(HBPalette.panelSoft.opacity(0.72), in: Capsule())
            }

            Text(workflow.statusMessage)
                .font(HBTypography.body(size: 11, weight: .semibold))
                .foregroundStyle(HBPalette.accentBlue)
                .fixedSize(horizontal: false, vertical: true)

            if !workflow.verificationGuidance.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(workflow.verificationGuidance.enumerated()), id: \.offset) { _, guidance in
                        Text(guidance)
                            .font(HBTypography.body(size: 11, weight: .semibold))
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
                            .font(HBTypography.body(size: 11, weight: .medium))
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

                if workflow.protocolName == "zwave" && !workflow.complete {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Stuck on exclusion?")
                            .font(HBTypography.display(size: 10, weight: .bold))
                            .textCase(.uppercase)
                            .tracking(1.4)
                            .foregroundStyle(HBPalette.textMuted)
                        Text("SmartThings can't reliably exclude over its cloud API. Exclude with HomeBrain's own radio, or confirm you already excluded the device to jump to pairing.")
                            .font(HBTypography.body(size: 11, weight: .medium))
                            .foregroundStyle(HBPalette.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                        Button {
                            Task { await nativeExcludeForMigration(device) }
                        } label: {
                            Label("Exclude with HomeBrain Radio", systemImage: "dot.radiowaves.left.and.right")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(HBSecondaryButtonStyle())
                        .disabled(isPending)
                        Button {
                            Task { await confirmExclusionAndPair(device) }
                        } label: {
                            Label("I Already Excluded It — Open Pairing", systemImage: "checkmark.circle")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(HBSecondaryButtonStyle())
                        .disabled(isPending)
                    }
                    .padding(.top, 4)
                }
            }
        }
        .padding(10)
        .background(HBPalette.accentBlue.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(HBPalette.accentBlue.opacity(0.25), lineWidth: 1)
        )
    }

    private func directRadioMigrationFinalizationPanel(for device: DeviceItem) -> some View {
        let isPending = pendingMigrationFinalizationDeviceIds.contains(device.id)
        let feedback = migrationFeedback[device.id]

        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 8) {
                Image(systemName: "checkmark.seal.fill")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(HBPalette.accentGreen)
                Text("Finalize migration")
                    .font(HBTypography.body(size: 13, weight: .bold))
                    .foregroundStyle(HBPalette.textPrimary)
                Spacer(minLength: 0)
                if isPending {
                    ProgressView()
                        .controlSize(.small)
                }
            }

            Text("After native state and controls work, HomeBrain can mark this device as fully moved off the SmartThings route.")
                .font(HBTypography.body(size: 12, weight: .medium))
                .foregroundStyle(HBPalette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

            Button {
                Task { await finalizeDirectRadioMigration(device) }
            } label: {
                Label("Finalize Migration", systemImage: "checkmark.circle.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(HBPrimaryButtonStyle(compact: true))
            .disabled(isPending)

            if let feedback {
                Text(feedback)
                    .font(HBTypography.body(size: 12, weight: .semibold))
                    .foregroundStyle(HBPalette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(12)
        .background(HBPalette.accentGreen.opacity(0.10), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(HBPalette.accentGreen.opacity(0.28), lineWidth: 1)
        )
    }

    private var matterControllerPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 8) {
                Image(systemName: "network")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(HBPalette.accentBlue)
                Text("Matter & Thread")
                    .font(HBTypography.body(size: 15, weight: .bold))
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
                    .font(HBTypography.body(size: 12, weight: .semibold))
                    .foregroundStyle(HBPalette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else if let matterLatestSessionStatus {
                Text("Latest Matter session: \(matterLatestSessionStatus)")
                    .font(HBTypography.body(size: 12, weight: .semibold))
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
                .font(HBTypography.display(size: 10, weight: .bold))
                .textCase(.uppercase)
                .tracking(1.4)
                .foregroundStyle(HBPalette.textMuted)
            Text(value)
                .font(HBTypography.body(size: 12, weight: .bold))
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
        } else if device.type == "sensor" {
            text = sensorStateLabel(for: device) ?? (device.status ? "Active" : "Clear")
        } else if device.type == "lock" {
            text = device.status ? "Locked" : "Unlocked"
        } else if device.type == "garage" {
            text = device.status ? "Open" : "Closed"
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
        let action = primaryDeviceAction(for: device)
        let label = primaryDeviceActionLabel(for: device)
        let icon = primaryDeviceActionIcon(for: device)
        if device.status {
            Button {
                Task {
                    await handleDeviceControl(
                        deviceId: device.id,
                        action: action
                    )
                }
            } label: {
                Label(label, systemImage: icon)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(HBSecondaryButtonStyle())
            .disabled(pendingControls.contains(device.id))
        } else {
            Button {
                Task {
                    await handleDeviceControl(
                        deviceId: device.id,
                        action: action
                    )
                }
            } label: {
                Label(label, systemImage: icon)
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
                        .font(HBTypography.display(size: 12, weight: .semibold))
                        .tracking(1.2)
                        .foregroundStyle(HBPalette.textSecondary)
                    Text("\(targetTemp)°F")
                        .font(HBTypography.display(size: useLandscapeCompactLayout ? 40 : 48, weight: .bold))
                        .foregroundStyle(HBPalette.textPrimary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }

                Spacer(minLength: 12)

                VStack(alignment: .trailing, spacing: 2) {
                    Text("CURRENT")
                        .font(HBTypography.display(size: 12, weight: .semibold))
                        .tracking(1.2)
                        .foregroundStyle(HBPalette.textSecondary)
                    Text(currentTemp.map { "\($0)°F" } ?? "--")
                        .font(HBTypography.display(size: useLandscapeCompactLayout ? 30 : 36, weight: .bold))
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
        .font(HBTypography.display(size: 14, weight: .bold))
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
        let colorTemperature = currentLightColorTemperature(for: device)

        return VStack(spacing: 10) {
            HStack {
                Text("Fade")
                    .font(HBTypography.body(size: 14, weight: .medium))
                    .foregroundStyle(HBPalette.textSecondary)
                Spacer()
                Text("\(Int(brightness.rounded()))%")
                    .font(HBTypography.body(size: 15, weight: .bold))
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
                            .font(HBTypography.body(size: 14, weight: .medium))
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

            if supportsLightColorTemperature(device) {
                VStack(spacing: 8) {
                    HStack {
                        Text("White")
                            .font(HBTypography.body(size: 14, weight: .medium))
                            .foregroundStyle(HBPalette.textSecondary)
                        Spacer()
                        Text("\(Int(colorTemperature.rounded()))K")
                            .font(HBTypography.body(size: 12, weight: .bold))
                            .foregroundStyle(HBPalette.textPrimary)
                    }

                    Slider(
                        value: Binding(
                            get: { currentLightColorTemperature(for: device) },
                            set: { lightColorTemperatureDrafts[device.id] = clampColorTemperature($0) }
                        ),
                        in: 1500...6500,
                        step: 50,
                        onEditingChanged: { editing in
                            guard !editing else { return }
                            let kelvin = Int(currentLightColorTemperature(for: device).rounded())
                            Task { await handleDeviceControl(deviceId: device.id, action: "set_color_temperature", value: kelvin) }
                        }
                    )
                    .tint(HBPalette.accentBlue)
                    .disabled(pending)

                    HStack(spacing: 8) {
                        ForEach([
                            ("Warm", 2700),
                            ("Neutral", 4000),
                            ("Cold", 5000)
                        ], id: \.0) { preset in
                            Button(preset.0) {
                                Task { await handleDeviceControl(deviceId: device.id, action: "set_color_temperature", value: preset.1) }
                            }
                            .buttonStyle(HBSecondaryButtonStyle(compact: true))
                            .frame(maxWidth: .infinity)
                            .disabled(pending)
                        }
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

    private func sirenVolumeControls(for device: DeviceItem) -> some View {
        let pending = pendingControls.contains(device.id)
        let soundOptions = sirenSoundOptions(for: device)
        let currentSound = currentSirenSound(for: device)
        let currentSoundLabel = soundOptions.first(where: { $0.value == currentSound })?.label ?? currentSound.map { String($0) } ?? "--"
        let options = sirenVolumeOptions(for: device)
        let currentVolume = currentSirenVolume(for: device)
        let currentLabel = options.first(where: { $0.value == currentVolume })?.label ?? currentVolume.map { String($0) } ?? "--"

        return VStack(spacing: 12) {
            if !soundOptions.isEmpty {
                VStack(spacing: 10) {
                    HStack {
                        Text("Sound")
                            .font(HBTypography.body(size: 14, weight: .medium))
                            .foregroundStyle(HBPalette.textSecondary)
                        Spacer()
                        Text(currentSoundLabel)
                            .font(HBTypography.body(size: 15, weight: .bold))
                            .foregroundStyle(HBPalette.textPrimary)
                    }

                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 82), spacing: 8)], spacing: 8) {
                        ForEach(soundOptions) { option in
                            if option.value == currentSound {
                                Button(option.label) {
                                    Task { await handleDeviceControl(deviceId: device.id, action: "set_siren_sound", value: option.value) }
                                }
                                .buttonStyle(HBPrimaryButtonStyle(compact: true))
                                .frame(maxWidth: .infinity)
                                .disabled(pending)
                            } else {
                                Button(option.label) {
                                    Task { await handleDeviceControl(deviceId: device.id, action: "set_siren_sound", value: option.value) }
                                }
                                .buttonStyle(HBSecondaryButtonStyle(compact: true))
                                .frame(maxWidth: .infinity)
                                .disabled(pending)
                            }
                        }
                    }
                }
                .padding(14)
                .background(HBGlassBackground(cornerRadius: 18, variant: .panelSoft))
            }

            if !options.isEmpty {
                VStack(spacing: 10) {
                    HStack {
                        Text("Volume")
                            .font(HBTypography.body(size: 14, weight: .medium))
                            .foregroundStyle(HBPalette.textSecondary)
                        Spacer()
                        Text(currentLabel)
                            .font(HBTypography.body(size: 15, weight: .bold))
                            .foregroundStyle(HBPalette.textPrimary)
                    }

                    HStack(spacing: 8) {
                        ForEach(options) { option in
                            if option.value == currentVolume {
                                Button(option.label) {
                                    Task { await handleDeviceControl(deviceId: device.id, action: "set_siren_volume", value: option.value) }
                                }
                                .buttonStyle(HBPrimaryButtonStyle(compact: true))
                                .frame(maxWidth: .infinity)
                                .disabled(pending)
                            } else {
                                Button(option.label) {
                                    Task { await handleDeviceControl(deviceId: device.id, action: "set_siren_volume", value: option.value) }
                                }
                                .buttonStyle(HBSecondaryButtonStyle(compact: true))
                                .frame(maxWidth: .infinity)
                                .disabled(pending)
                            }
                        }
                    }
                }
                .padding(14)
                .background(HBGlassBackground(cornerRadius: 18, variant: .panelSoft))
            }

            defaultPowerControl(for: device)
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
            .font(HBTypography.body(size: 12, weight: .medium))
            .foregroundStyle(HBPalette.accentBlue)
        } else if controlFeedback[device.id] == .success {
            Label("Command sent", systemImage: "checkmark.circle.fill")
                .font(HBTypography.body(size: 12, weight: .medium))
                .foregroundStyle(HBPalette.accentGreen)
        } else if controlFeedback[device.id] == .failure {
            Label("Command failed", systemImage: "exclamationmark.triangle.fill")
                .font(HBTypography.body(size: 12, weight: .medium))
                .foregroundStyle(Color.red.opacity(0.9))
        }
    }

    private func zigbeeMaintenancePanel(for device: DeviceItem) -> some View {
        let isBusy = reinterviewingZigbeeDeviceId == device.id
        let ias = JSON.object(JSON.object(device.properties["homebrainDirect"])["iasZone"])
        let hasIas = !ias.isEmpty
        let enrolled = boolValue(ias["enrolled"])
        return HBPanel {
            VStack(alignment: .leading, spacing: 12) {
                Text("Zigbee Maintenance")
                    .font(HBTypography.body(size: 17, weight: .bold))
                    .foregroundStyle(HBPalette.textPrimary)
                Text("If this sensor stopped reporting, re-run its Zigbee interview to repair IAS Zone enrollment. Wake the device first (open/close it or press its button).")
                    .font(HBTypography.body(size: 13, weight: .medium))
                    .foregroundStyle(HBPalette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                if hasIas {
                    Text(enrolled ? "Enrolled — reporting open/closed." : "Not enrolled — won't report until re-interviewed.")
                        .font(HBTypography.body(size: 12, weight: .semibold))
                        .foregroundStyle(enrolled ? HBPalette.accentGreen : HBPalette.accentOrange)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Button {
                    Task { await reinterviewZigbeeDevice(device) }
                } label: {
                    HStack(spacing: 8) {
                        if isBusy {
                            ProgressView().controlSize(.small)
                        }
                        Text(isBusy ? "Re-interviewing…" : "Re-interview / Repair Sensor")
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(HBSecondaryButtonStyle())
                .disabled(isBusy)
            }
        }
    }

    private func lockPinManagementPanel(for device: DeviceItem) -> some View {
        let native = isNativeZWaveLock(device)
        let state = lockCodeStates[device.id]
        let events = lockCodeEvents[device.id] ?? []
        let draft = lockCodeDraft(for: device)
        let isLoading = lockCodeLoadingDeviceIds.contains(device.id)
        let isSaving = lockCodeSavingDeviceIds.contains(device.id)
        let slotOptions = lockCodeSlotOptions(for: device)
        let selectedSlot = state?.slots.first(where: { $0.slot == draft.slot })
        let minPinLength = state?.capabilities.minPinLength ?? 4
        let maxPinLength = state?.capabilities.maxPinLength ?? 8

        return HBPanel {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .center) {
                    Label("Lock PINs", systemImage: "key.fill")
                        .font(HBTypography.body(size: 17, weight: .bold))
                        .foregroundStyle(HBPalette.textPrimary)
                    Spacer()
                    if native {
                        Button {
                            Task { await loadLockCodes(for: device, refresh: true) }
                        } label: {
                            Image(systemName: isLoading ? "arrow.triangle.2.circlepath" : "arrow.clockwise")
                        }
                        .buttonStyle(HBSecondaryButtonStyle(compact: true))
                        .disabled(isLoading)
                    }
                }

                if !native {
                    Text("Migrate this lock to HomeBrain Z-Wave before writing PIN slots.")
                        .font(HBTypography.body(size: 13, weight: .medium))
                        .foregroundStyle(HBPalette.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(12)
                        .background(HBGlassBackground(cornerRadius: 16, variant: .panelSoft))
                } else {
                    if let error = lockCodeErrors[device.id] {
                        InlineErrorView(message: error) {
                            Task { await loadLockCodes(for: device, refresh: true) }
                        }
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Text("Assigned Slots")
                            .font(HBTypography.body(size: 12, weight: .bold))
                            .foregroundStyle(HBPalette.textSecondary)
                        if isLoading && state == nil {
                            HStack(spacing: 8) {
                                ProgressView()
                                    .controlSize(.small)
                                Text("Loading slots...")
                                    .font(HBTypography.body(size: 13, weight: .medium))
                            }
                            .foregroundStyle(HBPalette.textSecondary)
                            .padding(12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(HBGlassBackground(cornerRadius: 16, variant: .panelSoft))
                        } else if let slots = state?.slots, !slots.isEmpty {
                            ForEach(slots) { slot in
                                HStack(spacing: 10) {
                                    Button {
                                        updateLockCodeDraft(for: device) { draft in
                                            draft.slot = slot.slot
                                            draft.name = slot.name
                                            draft.pin = ""
                                            draft.enabled = slot.enabled
                                        }
                                    } label: {
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(slot.name)
                                                .font(HBTypography.body(size: 14, weight: .semibold))
                                                .foregroundStyle(HBPalette.textPrimary)
                                                .lineLimit(1)
                                            Text("Slot \(slot.slot) · \(slot.enabled ? "Enabled" : "Disabled")")
                                                .font(HBTypography.body(size: 12, weight: .medium))
                                                .foregroundStyle(HBPalette.textSecondary)
                                        }
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                    }
                                    .buttonStyle(.plain)

                                    Button {
                                        Task { await deleteLockCode(for: device, slot: slot.slot) }
                                    } label: {
                                        if lockCodeDeletingKeys.contains("\(device.id):\(slot.slot)") {
                                            ProgressView()
                                                .controlSize(.small)
                                        } else {
                                            Image(systemName: "trash")
                                        }
                                    }
                                    .buttonStyle(HBSecondaryButtonStyle(compact: true))
                                    .disabled(isSaving)
                                }
                                .padding(12)
                                .background(HBGlassBackground(cornerRadius: 16, variant: .panelSoft))
                            }
                        } else {
                            Text("No assigned PIN slots are reported by the lock.")
                                .font(HBTypography.body(size: 13, weight: .medium))
                                .foregroundStyle(HBPalette.textSecondary)
                                .padding(12)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(HBGlassBackground(cornerRadius: 16, variant: .panelSoft))
                        }
                    }

                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 10) {
                            Picker("Slot", selection: Binding(
                                get: { lockCodeDraft(for: device).slot },
                                set: { value in
                                    updateLockCodeDraft(for: device) { draft in
                                        draft.slot = value
                                        if let slot = lockCodeStates[device.id]?.slots.first(where: { $0.slot == value }) {
                                            draft.name = slot.name
                                            draft.enabled = slot.enabled
                                        }
                                        draft.pin = ""
                                    }
                                }
                            )) {
                                ForEach(slotOptions, id: \.self) { slot in
                                    Text("\(slot)").tag(slot)
                                }
                            }
                            .pickerStyle(.menu)
                            .frame(width: 96)

                            TextField(selectedSlot?.name ?? "Code \(draft.slot)", text: Binding(
                                get: { lockCodeDraft(for: device).name },
                                set: { value in
                                    updateLockCodeDraft(for: device) { $0.name = value }
                                }
                            ))
                            .hbPanelTextField()
                        }

                        SecureField("\(minPinLength)-\(maxPinLength) digit PIN", text: Binding(
                            get: { lockCodeDraft(for: device).pin },
                            set: { value in
                                updateLockCodeDraft(for: device) {
                                    $0.pin = value.filter { $0.isNumber }
                                }
                            }
                        ))
                        .keyboardType(.numberPad)
                        .hbPanelTextField()

                        Toggle("Enabled", isOn: Binding(
                            get: { lockCodeDraft(for: device).enabled },
                            set: { value in
                                updateLockCodeDraft(for: device) { $0.enabled = value }
                            }
                        ))
                        .font(HBTypography.body(size: 14, weight: .semibold))
                        .foregroundStyle(HBPalette.textPrimary)

                        Button {
                            Task { await saveLockCode(for: device) }
                        } label: {
                            if isSaving {
                                ProgressView()
                                    .controlSize(.small)
                                    .frame(maxWidth: .infinity)
                            } else {
                                Label("Save PIN Slot", systemImage: "square.and.arrow.down")
                                    .frame(maxWidth: .infinity)
                            }
                        }
                        .buttonStyle(HBPrimaryButtonStyle())
                        .disabled(isSaving || isLoading)
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Text("PIN Activity")
                            .font(HBTypography.body(size: 12, weight: .bold))
                            .foregroundStyle(HBPalette.textSecondary)
                        if events.isEmpty {
                            Text("No PIN activity has been recorded yet.")
                                .font(HBTypography.body(size: 13, weight: .medium))
                                .foregroundStyle(HBPalette.textSecondary)
                                .padding(12)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(HBGlassBackground(cornerRadius: 16, variant: .panelSoft))
                        } else {
                            ForEach(events.prefix(8)) { event in
                                VStack(alignment: .leading, spacing: 3) {
                                    HStack {
                                        Text(event.codeName ?? event.slot.map { "Slot \($0)" } ?? event.actionLabel)
                                            .font(HBTypography.body(size: 13, weight: .semibold))
                                            .foregroundStyle(HBPalette.textPrimary)
                                        Spacer()
                                        HBBadge(text: event.source == "lock" ? "Lock" : "HomeBrain")
                                    }
                                    Text("\(event.actionLabel) · \(event.slot.map { "Slot \($0)" } ?? "No slot") · \(event.displayDate)")
                                        .font(HBTypography.body(size: 12, weight: .medium))
                                        .foregroundStyle(HBPalette.textSecondary)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                                .padding(12)
                                .background(HBGlassBackground(cornerRadius: 16, variant: .panelSoft))
                            }
                        }
                    }
                }
            }
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
                                        .font(HBTypography.display(size: 26, weight: .bold))
                                        .foregroundStyle(HBPalette.textPrimary)
                                        .fixedSize(horizontal: false, vertical: true)
                                    Text("\(device.displayRoom) · \(deviceTypeDisplayLabel(device.type)) · \(device.selectionSourceLabel)")
                                        .font(HBTypography.body(size: 14, weight: .medium))
                                        .foregroundStyle(HBPalette.textSecondary)
                                        .fixedSize(horizontal: false, vertical: true)
                                    HStack(spacing: 8) {
                                        statusBadge(for: device)
                                        HBBadge(text: device.isOnline ? "Online" : "Offline")
                                        batteryIndicator(for: device, compact: true)
                                    }
                                }
                            }
                        }

                        deviceIdentityEditor(for: device)

                        HBPanel {
                            VStack(alignment: .leading, spacing: 12) {
                                Text("Primary Controls")
                                    .font(HBTypography.body(size: 17, weight: .bold))
                                    .foregroundStyle(HBPalette.textPrimary)

                                if device.type == "thermostat" {
                                    thermostatControls(for: device)
                                } else if supportsLightFade(device) {
                                    lightControls(for: device)
                                } else if supportsSirenVolume(device) || supportsSirenSound(device) {
                                    sirenVolumeControls(for: device)
                                } else if canUsePrimaryDeviceAction(device) {
                                    defaultPowerControl(for: device)
                                } else {
                                    Text("This device does not expose a simple manual control. Use groups, workflows, telemetry, or migration guidance instead.")
                                        .font(HBTypography.body(size: 13, weight: .medium))
                                        .foregroundStyle(HBPalette.textSecondary)
                                        .fixedSize(horizontal: false, vertical: true)
                                        .padding(12)
                                        .background(HBGlassBackground(cornerRadius: 16, variant: .panelSoft))
                                }

                                controlFeedbackView(for: device)
                            }
                        }

                        if device.type == "lock" {
                            lockPinManagementPanel(for: device)
                        }

                        if isSmartThingsBackedDevice(device) {
                            directRadioMigrationPanel(for: device)
                        }

                        if needsMigrationFinalization(device) {
                            directRadioMigrationFinalizationPanel(for: device)
                        }

                        if isNativeZigbeeDevice(device) {
                            zigbeeMaintenancePanel(for: device)
                        }

                        deviceTelemetryDetailsPanel(for: device)

                        HBPanel {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Voice")
                                    .font(HBTypography.body(size: 17, weight: .bold))
                                    .foregroundStyle(HBPalette.textPrimary)
                                Text(voiceHint(for: device))
                                    .font(HBTypography.body(size: 13, weight: .medium))
                                    .foregroundStyle(HBPalette.textSecondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }

                        HBPanel {
                            VStack(alignment: .leading, spacing: 12) {
                                Text("Device Record")
                                    .font(HBTypography.body(size: 17, weight: .bold))
                                    .foregroundStyle(HBPalette.textPrimary)
                                Text("Remove stale HomeBrain records after exclusion, replacement, or controller cleanup.")
                                    .font(HBTypography.body(size: 13, weight: .medium))
                                    .foregroundStyle(HBPalette.textSecondary)
                                    .fixedSize(horizontal: false, vertical: true)
                                Button(role: .destructive) {
                                    pendingDeleteDevice = device
                                } label: {
                                    Label("Delete Device", systemImage: "trash")
                                        .frame(maxWidth: .infinity)
                                }
                                .buttonStyle(HBDestructiveButtonStyle())
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
            .onAppear {
                prepareDeviceEditor(for: device)
                prepareLockCodeDraft(for: device)
                if device.type == "lock", isNativeZWaveLock(device) {
                    Task { await loadLockCodes(for: device) }
                }
            }
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

    private func prepareDeviceEditor(for device: DeviceItem) {
        guard editDeviceID != device.id else { return }
        editDeviceID = device.id
        editDeviceName = device.name
        editDeviceRoom = device.room.isEmpty ? "Unassigned" : device.room
        editDeviceType = availableTypes.contains(device.type) && device.type != "all" ? device.type : "switch"
        let debounce = contactOpenDebounceConfig(for: device)
        editContactOpenDebounceEnabled = debounce.enabled
        editContactOpenDebounceSeconds = debounce.seconds
    }

    private func deviceDetailsChanged(for device: DeviceItem) -> Bool {
        let name = editDeviceName.trimmingCharacters(in: .whitespacesAndNewlines)
        let room = editDeviceRoom.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? "Unassigned"
            : editDeviceRoom.trimmingCharacters(in: .whitespacesAndNewlines)
        let type = availableTypes.contains(editDeviceType) && editDeviceType != "all" ? editDeviceType : device.type
        let debounce = contactOpenDebounceConfig(for: device)
        let debounceChanged = supportsContactOpenDebounce(device)
            && (editContactOpenDebounceEnabled != debounce.enabled
                || normalizedContactOpenDebounceSeconds(editContactOpenDebounceSeconds) != debounce.seconds)

        return name != device.name
            || room != (device.room.isEmpty ? "Unassigned" : device.room)
            || type != device.type
            || debounceChanged
    }

    private func roomOptions(selectedRoom: String) -> [String] {
        var rooms = Set(availableRoomNames)
        let selected = selectedRoom.trimmingCharacters(in: .whitespacesAndNewlines)
        if !selected.isEmpty {
            rooms.insert(selected)
        }
        rooms.insert("Unassigned")
        return rooms.sorted { left, right in
            if left.localizedCaseInsensitiveCompare("Unassigned") == .orderedSame {
                return true
            }
            if right.localizedCaseInsensitiveCompare("Unassigned") == .orderedSame {
                return false
            }
            return left.localizedCaseInsensitiveCompare(right) == .orderedAscending
        }
    }

    private func deviceIdentityEditor(for device: DeviceItem) -> some View {
        let canSave = deviceDetailsChanged(for: device)
            && !editDeviceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !savingDeviceDetails

        return HBPanel {
            VStack(alignment: .leading, spacing: 12) {
                Text("Device Details")
                    .font(HBTypography.body(size: 17, weight: .bold))
                    .foregroundStyle(HBPalette.textPrimary)

                VStack(alignment: .leading, spacing: 10) {
                    TextField("Name", text: $editDeviceName)
                        .hbPanelTextField()
                        .disabled(savingDeviceDetails)

                    HStack {
                        Text("Room")
                            .font(HBTypography.body(size: 14, weight: .semibold))
                            .foregroundStyle(HBPalette.textSecondary)
                        Spacer()
                        Picker("Room", selection: $editDeviceRoom) {
                            ForEach(roomOptions(selectedRoom: editDeviceRoom), id: \.self) { room in
                                Text(room).tag(room)
                            }
                        }
                        .pickerStyle(.menu)
                        .tint(HBPalette.accentBlue)
                        .disabled(savingDeviceDetails)
                    }

                    HStack {
                        Text("Type")
                            .font(HBTypography.body(size: 14, weight: .semibold))
                            .foregroundStyle(HBPalette.textSecondary)
                        Spacer()
                        Picker("Type", selection: $editDeviceType) {
                            ForEach(availableTypes.filter { $0 != "all" }, id: \.self) { type in
                                Text(deviceTypeDisplayLabel(type)).tag(type)
                            }
                        }
                        .pickerStyle(.menu)
                        .tint(HBPalette.accentBlue)
                        .disabled(savingDeviceDetails)
                }
            }

            if supportsContactOpenDebounce(device) {
                VStack(alignment: .leading, spacing: 10) {
                    Toggle("Contact debounce", isOn: $editContactOpenDebounceEnabled)
                        .font(HBTypography.body(size: 14, weight: .semibold))
                        .foregroundStyle(HBPalette.textSecondary)
                        .disabled(savingDeviceDetails)

                    Stepper(
                        value: Binding(
                            get: { normalizedContactOpenDebounceSeconds(editContactOpenDebounceSeconds) },
                            set: { editContactOpenDebounceSeconds = normalizedContactOpenDebounceSeconds($0) }
                        ),
                        in: contactOpenDebounceMinSeconds...contactOpenDebounceMaxSeconds,
                        step: contactOpenDebounceStepSeconds
                    ) {
                        HStack {
                            Text("Closed-to-open window")
                                .font(HBTypography.body(size: 14, weight: .semibold))
                                .foregroundStyle(HBPalette.textSecondary)
                            Spacer()
                            Text(String(format: "%.2fs", normalizedContactOpenDebounceSeconds(editContactOpenDebounceSeconds)))
                                .font(HBTypography.body(size: 12, weight: .semibold))
                                .foregroundStyle(HBPalette.textPrimary)
                                .monospacedDigit()
                        }
                    }
                    .disabled(savingDeviceDetails || !editContactOpenDebounceEnabled)
                }
                .padding(.top, 4)
            }

            Button {
                Task { await saveDeviceDetails(for: device) }
            } label: {
                    if savingDeviceDetails {
                        HStack(spacing: 8) {
                            ProgressView()
                                .controlSize(.small)
                            Text("Saving")
                        }
                        .frame(maxWidth: .infinity)
                    } else {
                        Label("Save Details", systemImage: "checkmark.circle.fill")
                            .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(HBPrimaryButtonStyle())
                .disabled(!canSave)
            }
        }
    }

    @ViewBuilder
    private func deviceTelemetryDetailsPanel(for device: DeviceItem) -> some View {
        let rows = deviceTelemetryRows(for: device)
        if !rows.isEmpty {
            HBPanel {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Telemetry")
                        .font(HBTypography.body(size: 17, weight: .bold))
                        .foregroundStyle(HBPalette.textPrimary)

                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                            HStack(alignment: .firstTextBaseline, spacing: 12) {
                                Text(row.label)
                                    .font(HBTypography.body(size: 13, weight: .semibold))
                                    .foregroundStyle(HBPalette.textSecondary)
                                Spacer(minLength: 12)
                                if row.label == "Battery" {
                                    batteryIndicator(for: device, compact: false)
                                } else {
                                    Text(row.value)
                                        .font(HBTypography.body(size: 13, weight: .bold))
                                        .foregroundStyle(HBPalette.textPrimary)
                                        .multilineTextAlignment(.trailing)
                                }
                            }
                        }
                    }
                    .padding(12)
                    .background(HBGlassBackground(cornerRadius: 16, variant: .panelSoft))
                }
            }
        }
    }

    private var createDeviceSheet: some View {
        NavigationStack {
            ZStack {
                HBPageBackground()
                    .ignoresSafeArea()

                ScrollView {
                    VStack(alignment: .leading, spacing: addDeviceSheetSpacing) {
                        HBPanel {
                            VStack(alignment: .leading, spacing: 16) {
                                Text("Device Provisioning")
                                    .font(HBTypography.display(size: 11, weight: .bold))
                                    .textCase(.uppercase)
                                    .tracking(2.6)
                                    .foregroundStyle(HBPalette.textMuted)

                                Text("Add a native endpoint")
                                    .font(HBTypography.display(size: isCompact ? 24 : 28, weight: .bold))
                                    .foregroundStyle(
                                        LinearGradient(
                                            colors: [HBPalette.accentBlue, HBPalette.accentPurple],
                                            startPoint: .leading,
                                            endPoint: .trailing
                                        )
                                    )
                                    .fixedSize(horizontal: false, vertical: true)

                                addDeviceModeSelector

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
                                    addDeviceProgressBanner
                                }

                                if addDeviceMode == "zwave" && !addDevicePendingDsk.isEmpty {
                                    addDeviceDskPanel
                                }

                                if let addDeviceStatusMessage {
                                    Text(addDeviceStatusMessage)
                                        .font(HBTypography.body(size: 12, weight: .semibold))
                                        .foregroundStyle(HBPalette.textSecondary)
                                        .fixedSize(horizontal: false, vertical: true)
                                        .padding(10)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .background(HBPalette.panelSoft.opacity(0.55), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                                }
                            }
                        }
                    }
                    .padding(.horizontal, addDeviceSheetPadding)
                    .padding(.top, addDeviceSheetPadding)
                    .padding(.bottom, 96)
                }
                .scrollIndicators(.hidden)
            }
            .safeAreaInset(edge: .bottom) {
                addDeviceBottomBar
            }
            .toolbar(.hidden, for: .navigationBar)
            .presentationDragIndicator(.visible)
            .presentationDetents([.large])
            .task(id: addDeviceMode) {
                if addDeviceMode == "zwave" {
                    await loadZWaveRepairNodeIds()
                } else {
                    addDeviceRepairingZWaveNodeId = nil
                    addDeviceRemovingZWaveNodeId = nil
                    addDeviceKnownZWaveNodeIds = nil
                    addDeviceKnownZWaveNodes = []
                }
            }
        }
    }

    private var addDeviceModeSelector: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Protocol")
                .font(HBTypography.display(size: 11, weight: .bold))
                .textCase(.uppercase)
                .tracking(2.0)
                .foregroundStyle(HBPalette.textMuted)

            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: isCompact ? 96 : 118), spacing: 8)],
                alignment: .leading,
                spacing: 8
            ) {
                ForEach(addDeviceModes, id: \.self) { mode in
                    addDeviceModeButton(mode)
                }
            }
        }
    }

    private func addDeviceModeButton(_ mode: String) -> some View {
        let selected = addDeviceMode == mode
        return Button {
            addDeviceMode = mode
        } label: {
            Label(addDeviceModeLabel(mode), systemImage: addDeviceModeIcon(mode))
                .font(HBTypography.body(size: 13, weight: .bold))
                .lineLimit(1)
                .minimumScaleFactor(0.82)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 10)
        .padding(.vertical, 10)
        .background(selected ? HBPalette.accentBlue.opacity(0.22) : HBPalette.panelSoft.opacity(0.68), in: Capsule())
        .overlay(
            Capsule()
                .stroke(selected ? HBPalette.accentBlue.opacity(0.8) : HBPalette.panelStrokeStrong.opacity(0.55), lineWidth: 1)
        )
        .foregroundStyle(selected ? HBPalette.textPrimary : HBPalette.textSecondary)
        .disabled(addDeviceBusy || matterIsCommissioning)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func addDeviceModeIcon(_ mode: String) -> String {
        switch mode {
        case "zwave": return "wave.3.right"
        case "zigbee": return "dot.radiowaves.left.and.right"
        case "insteon": return "link"
        case "matter": return "aqi.medium"
        default: return "plus"
        }
    }

    private var addDeviceBottomBar: some View {
        VStack(spacing: 0) {
            Divider()
                .overlay(HBPalette.panelStroke)

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) {
                    Button("Cancel") {
                        showCreateSheet = false
                    }
                    .buttonStyle(HBSecondaryButtonStyle(compact: true))

                    Button(addDevicePrimaryButtonTitle) {
                        Task { await runAddDeviceAction() }
                    }
                    .buttonStyle(HBPrimaryButtonStyle(compact: true))
                    .disabled(addDevicePrimaryButtonDisabled)
                }

                VStack(spacing: 10) {
                    Button(addDevicePrimaryButtonTitle) {
                        Task { await runAddDeviceAction() }
                    }
                    .buttonStyle(HBPrimaryButtonStyle(compact: true))
                    .frame(maxWidth: .infinity)
                    .disabled(addDevicePrimaryButtonDisabled)

                    Button("Cancel") {
                        showCreateSheet = false
                    }
                    .buttonStyle(HBSecondaryButtonStyle(compact: true))
                    .frame(maxWidth: .infinity)
                }
            }
            .padding(.horizontal, addDeviceSheetPadding)
            .padding(.vertical, 12)
            .background(.ultraThinMaterial)
        }
    }

    private var addDeviceProgressBanner: some View {
        HStack(spacing: 8) {
            ProgressView()
                .controlSize(.small)
            Text("Waiting for HomeBrain hardware confirmation...")
                .font(HBTypography.body(size: 12, weight: .semibold))
                .foregroundStyle(HBPalette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HBPalette.accentBlue.opacity(0.10), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var addDeviceDskPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("S2 security needs the 5 digit DSK PIN.")
                .font(HBTypography.body(size: 12, weight: .bold))
                .foregroundStyle(HBPalette.accentOrange)
            Text("Use the first 5 digits printed on the switch, QR label, box, or manual insert. This is not a displayed PIN; 00000 will fail unless that is literally printed.")
                .font(HBTypography.body(size: 11, weight: .semibold))
                .foregroundStyle(HBPalette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            Text("DSK challenge: \(addDevicePendingDsk)")
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .foregroundStyle(HBPalette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    addDeviceDskTextField
                    addDeviceDskSubmitButton
                }
                VStack(spacing: 8) {
                    addDeviceDskTextField
                    addDeviceDskSubmitButton
                        .frame(maxWidth: .infinity)
                }
            }
        }
        .padding(12)
        .background(HBPalette.accentOrange.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(HBPalette.accentOrange.opacity(0.35), lineWidth: 1)
        )
    }

    private var addDeviceDskTextField: some View {
        TextField("5 digit PIN", text: $addDeviceDskPin)
            .keyboardType(.numberPad)
            .hbPanelTextField()
            .onChange(of: addDeviceDskPin) { _, newValue in
                addDeviceDskPin = String(newValue.filter(\.isNumber).prefix(5))
            }
    }

    private var addDeviceDskSubmitButton: some View {
        Button("Submit PIN") {
            Task { await submitAddDeviceDskPin() }
        }
        .buttonStyle(HBSecondaryButtonStyle(compact: true))
        .disabled(addDeviceDskPin.count != 5)
    }

    private var manualCreateFields: some View {
        VStack(alignment: .leading, spacing: 12) {
            TextField("Name", text: $newName)
                .hbPanelTextField()
            TextField("Room", text: $newRoom)
                .hbPanelTextField()

            HStack {
                Text("Type")
                    .font(HBTypography.body(size: 14, weight: .semibold))
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
            addDevicePickerRow("Pairing window") {
                addDeviceWindowPicker
            }

            if addDeviceMode == "zwave" {
                addDevicePickerRow("Security") {
                    addDeviceSecurityPicker
                }
            }

            Text(nativeAddGuidance)
                .font(HBTypography.body(size: 13, weight: .medium))
                .foregroundStyle(HBPalette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func addDevicePickerRow<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        Group {
            if isCompact {
                VStack(alignment: .leading, spacing: 6) {
                    addDeviceFieldLabel(title)
                    content()
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                HStack {
                    addDeviceFieldLabel(title)
                    Spacer()
                    content()
                }
            }
        }
    }

    private func addDeviceFieldLabel(_ title: String) -> some View {
        Text(title)
            .font(HBTypography.body(size: 14, weight: .semibold))
            .foregroundStyle(HBPalette.textSecondary)
    }

    private var addDeviceWindowPicker: some View {
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

    private var addDeviceSecurityPicker: some View {
        Picker("Security", selection: $addDeviceZWaveSecurityMode) {
            Text("Standard").tag("insecure")
            Text("Legacy S0").tag("s0")
            Text("Auto secure").tag("default")
            Text("Secure S2").tag("s2")
        }
        .pickerStyle(.menu)
        .tint(HBPalette.accentBlue)
        .disabled(addDeviceBusy)
    }

    private var zwaveRepairCandidates: [AddDeviceZWaveRepairCandidate] {
        guard let knownNodeIds = addDeviceKnownZWaveNodeIds else {
            return []
        }

        var devicesByNodeId: [Int: DeviceItem] = [:]
        devices.forEach { device in
            if let nodeId = zWaveNodeId(for: device) {
                devicesByNodeId[nodeId] = device
            }
        }

        var candidates = devices.compactMap { device -> AddDeviceZWaveRepairCandidate? in
            guard let nodeId = zWaveNodeId(for: device),
                  knownNodeIds.contains(nodeId),
                  isIncompleteZWaveDirectDevice(device) else {
                return nil
            }
            let controllerNode = addDeviceKnownZWaveNodes.first { $0.id == nodeId }
            let dead = isDeadZWaveNodeStatus(controllerNode?.status)
            return AddDeviceZWaveRepairCandidate(
                id: device.id,
                nodeId: nodeId,
                name: device.name,
                subtitle: zwaveRepairSubtitle(for: device),
                ready: controllerNode?.ready ?? device.isOnline,
                dead: dead,
                controllerOnly: false,
                canRemoveFailed: dead,
                forceRemoveFailed: dead,
                likelyLegacySiren: isLikelyLegacyZWaveSirenDevice(device)
            )
        }

        addDeviceKnownZWaveNodes.forEach { node in
            guard node.incomplete, devicesByNodeId[node.id] == nil else {
                return
            }
            candidates.append(AddDeviceZWaveRepairCandidate(
                id: "controller-node-\(node.id)",
                nodeId: node.id,
                name: node.name,
                subtitle: "Node \(node.id) · controller-only partial add · \(zWaveNodeStatusLabel(node.status)) · \(node.featureCount) features · \(node.ready ? "ready" : "not fully interviewed")",
                ready: node.ready,
                dead: isDeadZWaveNodeStatus(node.status),
                controllerOnly: true,
                canRemoveFailed: true,
                forceRemoveFailed: !node.ready || isDeadZWaveNodeStatus(node.status),
                likelyLegacySiren: node.name.range(of: #"(?i)\b(zw080|siren|alarm|aeotec|aeon)\b"#, options: .regularExpression) != nil
            ))
        }

        return Array(candidates.sorted { $0.nodeId > $1.nodeId }.prefix(6))
    }

    private var zwaveRepairPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(HBPalette.accentOrange)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Incomplete Z-Wave nodes are already on the Zooz network.")
                        .font(HBTypography.body(size: 12, weight: .bold))
                        .foregroundStyle(HBPalette.accentOrange)
                    Text("Repair retries interview. Replace keeps the node id and opens a fresh include window; Remove deletes dead controller entries and matching HomeBrain records.")
                        .font(HBTypography.body(size: 11, weight: .semibold))
                        .foregroundStyle(HBPalette.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            Button {
                Task { await startZWaveCleanupExclusion() }
            } label: {
                Label("Start Exclusion Cleanup", systemImage: "minus.circle")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(HBSecondaryButtonStyle(compact: true))
            .disabled(addDeviceBusy)

            ForEach(zwaveRepairCandidates) { candidate in
                VStack(alignment: .leading, spacing: 10) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(candidate.name)
                            .font(HBTypography.body(size: 13, weight: .bold))
                            .foregroundStyle(HBPalette.textPrimary)
                            .lineLimit(2)
                        Text(candidate.subtitle)
                            .font(HBTypography.body(size: 11, weight: .semibold))
                            .foregroundStyle(HBPalette.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    zwaveRepairActionButtons(for: candidate)
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

    private func zwaveRepairActionButtons(for candidate: AddDeviceZWaveRepairCandidate) -> some View {
        let busy = addDeviceBusy
            || addDeviceRepairingZWaveNodeId != nil
            || addDeviceReplacingZWaveNodeId != nil
            || addDeviceRemovingZWaveNodeId != nil

        return ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                zwaveRepairButton(for: candidate)
                if candidate.canRemoveFailed {
                    zwaveReplaceButton(for: candidate)
                    zwaveRemoveButton(for: candidate)
                }
            }
            .disabled(busy)

            VStack(spacing: 8) {
                zwaveRepairButton(for: candidate)
                    .frame(maxWidth: .infinity)
                if candidate.canRemoveFailed {
                    zwaveReplaceButton(for: candidate)
                        .frame(maxWidth: .infinity)
                    zwaveRemoveButton(for: candidate)
                        .frame(maxWidth: .infinity)
                }
            }
            .disabled(busy)
        }
    }

    private func zwaveRepairButton(for candidate: AddDeviceZWaveRepairCandidate) -> some View {
        Button {
            Task { await repairZWaveNode(candidate) }
        } label: {
            if addDeviceRepairingZWaveNodeId == candidate.nodeId {
                ProgressView()
                    .controlSize(.small)
            } else {
                Label("Repair", systemImage: "wrench.and.screwdriver")
            }
        }
        .buttonStyle(HBSecondaryButtonStyle(compact: true))
    }

    private func zwaveReplaceButton(for candidate: AddDeviceZWaveRepairCandidate) -> some View {
        Button {
            Task { await replaceFailedZWaveNode(candidate) }
        } label: {
            if addDeviceReplacingZWaveNodeId == candidate.nodeId {
                ProgressView()
                    .controlSize(.small)
            } else {
                Label(candidate.likelyLegacySiren ? "Replace S0" : "Replace", systemImage: "plus.circle")
            }
        }
        .buttonStyle(HBSecondaryButtonStyle(compact: true))
    }

    private func zwaveRemoveButton(for candidate: AddDeviceZWaveRepairCandidate) -> some View {
        Button {
            Task { await removeFailedZWaveNode(candidate) }
        } label: {
            if addDeviceRemovingZWaveNodeId == candidate.nodeId {
                ProgressView()
                    .controlSize(.small)
            } else {
                Label("Remove", systemImage: "trash")
            }
        }
        .buttonStyle(HBDestructiveButtonStyle(compact: true))
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
        case "zwave": return addDeviceBusy ? "Starting..." : "Start Z-Wave \(zWaveSecurityLabel(addDeviceZWaveSecurityMode))"
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
            return zWaveSecurityGuidance(addDeviceZWaveSecurityMode)
        case "zigbee":
            return "HomeBrain opens Zigbee permit-join on the SONOFF coordinator. Reset or pair the device; it appears after join and interview."
        case "insteon":
            return "HomeBrain puts the PLM into link mode. Press the device set/link button; the PLM confirmation now creates or updates the HomeBrain device row."
        default:
            return ""
        }
    }

    private func zWaveSecurityLabel(_ mode: String) -> String {
        switch mode {
        case "default": return "Auto secure"
        case "s0": return "Legacy S0"
        case "s2": return "Secure S2"
        default: return "Standard"
        }
    }

    private func zWaveSecurityGuidance(_ mode: String) -> String {
        switch mode {
        case "default":
            return "HomeBrain uses S2 when available and forces legacy S0 for older secure devices."
        case "s0":
            return "Legacy S0 is for older sirens and secure accessories that do not use a DSK PIN."
        case "s2":
            return "Use Secure S2 for locks and access-control devices with the first 5 digits from the DSK label."
        default:
            return "Standard inclusion is for ordinary switches, dimmers, outlets, and sensors without secure pairing."
        }
    }

    private func zWaveReplacementSecurityMode(for candidate: AddDeviceZWaveRepairCandidate) -> String {
        if candidate.likelyLegacySiren {
            return "s0"
        }
        if addDeviceZWaveSecurityMode == "default" {
            return "s0"
        }
        return addDeviceZWaveSecurityMode
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
            if !appliedPreviewLaunchActions {
                if let previewAddDeviceMode = Self.previewAddDeviceModeFromLaunch() {
                    addDeviceMode = previewAddDeviceMode
                }
                if Self.previewShouldOpenAddDeviceFromLaunch() {
                    showCreateSheet = true
                }
                appliedPreviewLaunchActions = true
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

    private func refreshDeviceStatesFromAPI() async {
        guard !previewMode else {
            return
        }

        do {
            let response = try await session.apiClient.get("/api/devices")
            let object = JSON.object(response)
            let data = JSON.object(object["data"])
            let list = JSON.array(data["devices"]).map(DeviceItem.from)
            devices = list.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        } catch {
            // The live stream remains the primary path; avoid surfacing transient fallback misses.
        }
    }

    private func listenForDeviceUpdates() async {
        var reconnectAttempt = 0

        while !Task.isCancelled {
            guard let streamURL = session.apiClient.streamURL("/api/devices/stream") else {
                return
            }

            var streamOpenedAt: Date?

            do {
                let accessToken = try await session.validAccessToken()
                var request = URLRequest(url: streamURL)
                request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
                request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")

                let (bytes, response) = try await URLSession.shared.bytes(for: request)

                guard let httpResponse = response as? HTTPURLResponse else {
                    throw APIError.invalidResponse
                }

                if httpResponse.statusCode == 401 || httpResponse.statusCode == 403 {
                    try await session.refreshTokens()
                    continue
                }

                guard (200..<300).contains(httpResponse.statusCode) else {
                    throw APIError.server(statusCode: httpResponse.statusCode, message: "Failed to open device update stream.")
                }

                session.reportBackendRequestSucceeded()
                streamOpenedAt = Date()

                var eventName = "message"
                var dataLines: [String] = []

                for try await line in bytes.lines {
                    if Task.isCancelled {
                        return
                    }

                    if line.hasPrefix(":") {
                        continue
                    }

                    if line.isEmpty {
                        await handleDeviceStreamEvent(name: eventName, dataLines: dataLines)
                        eventName = "message"
                        dataLines.removeAll(keepingCapacity: true)
                        continue
                    }

                    if line.hasPrefix("event:") {
                        eventName = String(line.dropFirst("event:".count)).trimmingCharacters(in: .whitespaces)
                        continue
                    }

                    if line.hasPrefix("data:") {
                        dataLines.append(String(line.dropFirst("data:".count)).trimmingCharacters(in: .whitespaces))
                    }
                }

                await handleDeviceStreamEvent(name: eventName, dataLines: dataLines)

                guard !Task.isCancelled else {
                    return
                }

                session.reportTransientBackendFailure(
                    APIError.transientBackendUnavailable(message: "Live device updates are reconnecting."),
                    path: "/api/devices/stream"
                )
                let delayAttempt = deviceStreamReconnectDelayAttempt(
                    current: reconnectAttempt,
                    streamOpenedAt: streamOpenedAt
                )
                reconnectAttempt = nextDeviceStreamReconnectAttempt(
                    current: reconnectAttempt,
                    streamOpenedAt: streamOpenedAt
                )
                await sleepBeforeDeviceStreamReconnect(attempt: delayAttempt)
            } catch {
                if Task.isCancelled {
                    return
                }

                if case APIError.unauthorized = error {
                    return
                }

                session.reportTransientBackendFailure(error, path: "/api/devices/stream")
                let delayAttempt = deviceStreamReconnectDelayAttempt(
                    current: reconnectAttempt,
                    streamOpenedAt: streamOpenedAt
                )
                reconnectAttempt = nextDeviceStreamReconnectAttempt(
                    current: reconnectAttempt,
                    streamOpenedAt: streamOpenedAt
                )
                await sleepBeforeDeviceStreamReconnect(attempt: delayAttempt)
            }
        }
    }

    private func deviceStreamReconnectDelayAttempt(current: Int, streamOpenedAt: Date?) -> Int {
        if let streamOpenedAt, Date().timeIntervalSince(streamOpenedAt) >= 30 {
            return 0
        }

        return current
    }

    private func nextDeviceStreamReconnectAttempt(current: Int, streamOpenedAt: Date?) -> Int {
        if let streamOpenedAt, Date().timeIntervalSince(streamOpenedAt) >= 30 {
            return 0
        }

        return min(current + 1, 4)
    }

    private func sleepBeforeDeviceStreamReconnect(attempt: Int) async {
        let delays: [TimeInterval] = [2, 5, 10, 20, 30]
        let delay = delays[min(attempt, delays.count - 1)]
        do {
            try await Task.sleep(for: .seconds(delay))
        } catch {
            // The enclosing SwiftUI task owns cancellation.
        }
    }

    private func handleDeviceStreamEvent(name: String, dataLines: [String]) async {
        guard name != "ready", !dataLines.isEmpty else {
            return
        }

        let rawPayload = dataLines.joined(separator: "\n")
        guard let data = rawPayload.data(using: .utf8) else {
            return
        }

        guard let json = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else {
            return
        }

        let payloadObject = JSON.object(json)
        let deviceObjects = JSON.array(payloadObject["devices"])
        guard !deviceObjects.isEmpty else {
            return
        }

        deviceObjects
            .map { DeviceItem.from(JSON.object($0)) }
            .forEach(upsertDevice)
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

    private func nativeExcludeForMigration(_ device: DeviceItem) async {
        guard var workflow = migrationWorkflows[device.id],
              !pendingMigrationDeviceIds.contains(device.id) else {
            return
        }
        pendingMigrationDeviceIds.insert(device.id)
        defer { pendingMigrationDeviceIds.remove(device.id) }

        if previewMode {
            workflow.statusMessage = "HomeBrain would open Z-Wave exclusion on its own radio. Trigger the device's exclude action, then continue."
            migrationWorkflows[device.id] = workflow
            migrationFeedback[device.id] = workflow.statusMessage
            return
        }

        var body: [String: Any] = [
            "protocol": "zwave",
            "durationSeconds": 120,
            "deviceId": device.id,
            "useNativeExclusion": true
        ]
        if let migrationId = workflow.migrationId, !migrationId.isEmpty {
            body["migrationId"] = migrationId
        }
        do {
            let response = try await session.apiClient.post("/api/direct-radios/exclusion/start", body: body)
            let root = JSON.object(response)
            let result = JSON.object(root["result"])
            let migration = JSON.object(result["migration"])
            if let newId = JSON.optionalString(migration, "id"), !newId.isEmpty {
                workflow.migrationId = newId
            }
            workflow.statusMessage = "HomeBrain opened Z-Wave exclusion on its own radio. Trigger the device's exclude action now, then tap “I already excluded it” to open pairing."
            workflow.verificationGuidance = []
            migrationWorkflows[device.id] = workflow
            migrationFeedback[device.id] = workflow.statusMessage
        } catch {
            migrationFeedback[device.id] = "Native exclusion failed: \(error.localizedDescription)"
            errorMessage = error.localizedDescription
        }
    }

    private func confirmExclusionAndPair(_ device: DeviceItem) async {
        guard var workflow = migrationWorkflows[device.id],
              !pendingMigrationDeviceIds.contains(device.id) else {
            return
        }
        pendingMigrationDeviceIds.insert(device.id)
        defer { pendingMigrationDeviceIds.remove(device.id) }

        if previewMode {
            workflow.statusMessage = "HomeBrain would confirm exclusion and open Z-Wave inclusion."
            migrationWorkflows[device.id] = workflow
            migrationFeedback[device.id] = workflow.statusMessage
            return
        }

        var body: [String: Any] = [
            "deviceId": device.id,
            "protocol": "zwave",
            "exclusionConfirmed": true
        ]
        if let migrationId = workflow.migrationId, !migrationId.isEmpty {
            body["migrationId"] = migrationId
        }
        do {
            let response = try await session.apiClient.post("/api/direct-radios/migrations", body: body)
            let root = JSON.object(response)
            let returnedPlan = JSON.object(root["plan"])
            if !returnedPlan.isEmpty {
                migrationPlans[device.id] = DirectRadioMigrationPlanRecord.from(returnedPlan)
            }
            let migration = JSON.object(root["migration"])
            if let newId = JSON.optionalString(migration, "id"), !newId.isEmpty {
                workflow.migrationId = newId
            }
            if let inclusionIndex = workflow.plan.guidedSteps.firstIndex(where: { $0.action == "start_direct_migration" }) {
                workflow.stepIndex = inclusionIndex
            }
            workflow.statusMessage = "Exclusion confirmed. HomeBrain opened Z-Wave inclusion — put the device into pairing/inclusion mode now."
            workflow.verificationGuidance = []
            migrationWorkflows[device.id] = workflow
            migrationFeedback[device.id] = workflow.statusMessage
        } catch {
            migrationFeedback[device.id] = "Could not open pairing: \(error.localizedDescription)"
            errorMessage = error.localizedDescription
        }
    }

    private func finalizeDirectRadioMigration(_ device: DeviceItem) async {
        if pendingMigrationFinalizationDeviceIds.contains(device.id) {
            return
        }

        pendingMigrationFinalizationDeviceIds.insert(device.id)
        migrationFeedback[device.id] = "Finalizing native HomeBrain migration."
        defer {
            pendingMigrationFinalizationDeviceIds.remove(device.id)
        }

        if previewMode {
            migrationFeedback[device.id] = "Migration finalized."
            return
        }

        do {
            let migration = smartThingsMigration(for: device)
            var body: [String: Any] = [
                "deviceId": device.id,
                "reason": "Native HomeBrain controls verified from iOS"
            ]
            if let migrationId = JSON.optionalString(migration, "migrationId") {
                body["migrationId"] = migrationId
            }

            let response = try await session.apiClient.post(
                "/api/direct-radios/migrations/finalize",
                body: body
            )
            let root = JSON.object(response)
            let updated = DeviceItem.from(JSON.object(root["device"]))
            if !updated.id.isEmpty {
                upsertDevice(updated)
            }
            migrationFeedback[device.id] = "Migration finalized on native HomeBrain radio."
            Task {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                await loadDevices(showLoading: false)
            }
        } catch {
            migrationFeedback[device.id] = "Migration could not be finalized: \(error.localizedDescription)"
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

    private func preferredLockCodeSlot(for device: DeviceItem) -> Int {
        let state = lockCodeStates[device.id]
        return state?.availableSlots.first
            ?? state?.slots.first?.slot
            ?? 1
    }

    private func lockCodeSlotOptions(for device: DeviceItem) -> [Int] {
        var slots = Set<Int>()
        if let state = lockCodeStates[device.id] {
            state.slots.forEach { slots.insert($0.slot) }
            state.availableSlots.forEach { slots.insert($0) }
            if slots.isEmpty {
                let maxSlots = max(1, min(state.capabilities.maxSlots == 0 ? 30 : state.capabilities.maxSlots, 30))
                (1...maxSlots).forEach { slots.insert($0) }
            }
        } else {
            (1...30).forEach { slots.insert($0) }
        }
        return slots.sorted()
    }

    private func lockCodeDraft(for device: DeviceItem) -> NativeLockCodeDraft {
        lockCodeDrafts[device.id] ?? NativeLockCodeDraft(slot: preferredLockCodeSlot(for: device))
    }

    private func updateLockCodeDraft(for device: DeviceItem, _ update: (inout NativeLockCodeDraft) -> Void) {
        var draft = lockCodeDraft(for: device)
        update(&draft)
        lockCodeDrafts[device.id] = draft
    }

    private func prepareLockCodeDraft(for device: DeviceItem) {
        guard device.type == "lock" else { return }
        if lockCodeDrafts[device.id] == nil {
            lockCodeDrafts[device.id] = NativeLockCodeDraft(slot: preferredLockCodeSlot(for: device))
        }
    }

    private func applyLockCodeState(_ state: NativeLockCodeState, for device: DeviceItem) {
        lockCodeStates[device.id] = state
        var draft = lockCodeDraft(for: device)
        let options = Set(lockCodeSlotOptions(for: device))
        if !options.contains(draft.slot) {
            draft.slot = preferredLockCodeSlot(for: device)
            draft.name = ""
            draft.pin = ""
            draft.enabled = true
        }
        lockCodeDrafts[device.id] = draft
    }

    private func loadLockCodes(for device: DeviceItem, refresh: Bool = false) async {
        guard device.type == "lock", isNativeZWaveLock(device) else {
            return
        }
        if lockCodeLoadingDeviceIds.contains(device.id) {
            return
        }

        if previewMode {
            applyLockCodeState(.preview(for: device), for: device)
            lockCodeEvents[device.id] = NativeLockCodeEvent.previewEvents
            return
        }

        lockCodeLoadingDeviceIds.insert(device.id)
        lockCodeErrors.removeValue(forKey: device.id)
        defer {
            lockCodeLoadingDeviceIds.remove(device.id)
        }

        do {
            async let stateResponse = session.apiClient.get(
                "/api/devices/\(device.id)/lock-codes",
                query: [URLQueryItem(name: "refresh", value: refresh ? "true" : "false")]
            )
            async let eventsResponse = session.apiClient.get(
                "/api/devices/\(device.id)/lock-code-events",
                query: [URLQueryItem(name: "limit", value: "30")]
            )

            let stateRoot = JSON.object(try await stateResponse)
            let state = NativeLockCodeState.from(JSON.object(stateRoot["data"]))
            applyLockCodeState(state, for: device)

            let eventsRoot = JSON.object(try await eventsResponse)
            let eventsData = JSON.object(eventsRoot["data"])
            lockCodeEvents[device.id] = JSON.array(eventsData["events"]).map(NativeLockCodeEvent.from)
        } catch {
            lockCodeErrors[device.id] = error.localizedDescription
        }
    }

    private func refreshLockCodeEvents(for device: DeviceItem) async {
        guard !previewMode else {
            lockCodeEvents[device.id] = NativeLockCodeEvent.previewEvents
            return
        }
        do {
            let response = try await session.apiClient.get(
                "/api/devices/\(device.id)/lock-code-events",
                query: [URLQueryItem(name: "limit", value: "30")]
            )
            let root = JSON.object(response)
            let data = JSON.object(root["data"])
            lockCodeEvents[device.id] = JSON.array(data["events"]).map(NativeLockCodeEvent.from)
        } catch {
            lockCodeErrors[device.id] = error.localizedDescription
        }
    }

    private func saveLockCode(for device: DeviceItem) async {
        guard device.type == "lock", isNativeZWaveLock(device) else {
            return
        }
        if lockCodeSavingDeviceIds.contains(device.id) {
            return
        }

        var draft = lockCodeDraft(for: device)
        let existing = lockCodeStates[device.id]?.slots.first(where: { $0.slot == draft.slot })
        let pin = draft.pin.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? (existing?.name ?? "Code \(draft.slot)")
            : draft.name.trimmingCharacters(in: .whitespacesAndNewlines)

        guard existing != nil || !pin.isEmpty else {
            lockCodeErrors[device.id] = "Enter a PIN for an empty slot."
            return
        }

        if previewMode {
            let state = lockCodeStates[device.id] ?? .preview(for: device)
            applyLockCodeState(state.upserting(slot: draft.slot, name: name, enabled: draft.enabled), for: device)
            lockCodeDrafts[device.id]?.pin = ""
            lockCodeEvents[device.id] = NativeLockCodeEvent.previewEvents
            return
        }

        lockCodeSavingDeviceIds.insert(device.id)
        lockCodeErrors.removeValue(forKey: device.id)
        defer {
            lockCodeSavingDeviceIds.remove(device.id)
        }

        do {
            var body: [String: Any] = [
                "name": name,
                "enabled": draft.enabled
            ]
            if !pin.isEmpty {
                body["pin"] = pin
            }

            let response = try await session.apiClient.put(
                "/api/devices/\(device.id)/lock-codes/\(draft.slot)",
                body: body
            )
            let root = JSON.object(response)
            let state = NativeLockCodeState.from(JSON.object(root["data"]))
            applyLockCodeState(state, for: device)
            draft.name = ""
            draft.pin = ""
            lockCodeDrafts[device.id] = draft
            await refreshLockCodeEvents(for: device)
        } catch {
            lockCodeErrors[device.id] = error.localizedDescription
        }
    }

    private func deleteLockCode(for device: DeviceItem, slot: Int) async {
        guard device.type == "lock", isNativeZWaveLock(device) else {
            return
        }
        let key = "\(device.id):\(slot)"
        if lockCodeDeletingKeys.contains(key) {
            return
        }

        if previewMode {
            if let state = lockCodeStates[device.id] {
                applyLockCodeState(state.removing(slot: slot), for: device)
            }
            return
        }

        lockCodeDeletingKeys.insert(key)
        lockCodeErrors.removeValue(forKey: device.id)
        defer {
            lockCodeDeletingKeys.remove(key)
        }

        do {
            let response = try await session.apiClient.delete("/api/devices/\(device.id)/lock-codes/\(slot)")
            let root = JSON.object(response)
            let state = NativeLockCodeState.from(JSON.object(root["data"]))
            applyLockCodeState(state, for: device)
            await refreshLockCodeEvents(for: device)
        } catch {
            lockCodeErrors[device.id] = error.localizedDescription
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
            } else if action == "set_color_temperature" {
                lightColorTemperatureDrafts.removeValue(forKey: deviceId)
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

        case "set_color_temperature":
            if let numeric = numberValue(from: value) {
                let kelvin = clampColorTemperature(numeric)
                updated.colorTemperature = kelvin
                updated.status = true
                lightColorTemperatureDrafts[deviceId] = kelvin
            }

        case "set_siren_volume":
            if let numeric = numberValue(from: value) {
                updated.properties["supportsSirenVolume"] = true
                updated.properties["sirenVolume"] = Int(numeric.rounded())
            }

        case "set_siren_sound":
            if let numeric = numberValue(from: value) {
                updated.properties["supportsSirenSound"] = true
                updated.properties["sirenSound"] = Int(numeric.rounded())
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

    private func saveDeviceDetails(for device: DeviceItem) async {
        let name = editDeviceName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            errorMessage = "Device name is required."
            return
        }

        let roomDraft = editDeviceRoom.trimmingCharacters(in: .whitespacesAndNewlines)
        let room = roomDraft.isEmpty ? "Unassigned" : roomDraft
        let type = availableTypes.contains(editDeviceType) && editDeviceType != "all" ? editDeviceType : device.type
        var nextProperties = device.properties
        if supportsContactOpenDebounce(device) {
            var debounce = JSON.object(nextProperties["contactOpenDebounce"])
            debounce["enabled"] = editContactOpenDebounceEnabled
            debounce["seconds"] = normalizedContactOpenDebounceSeconds(editContactOpenDebounceSeconds)
            nextProperties["contactOpenDebounce"] = debounce
        }

        savingDeviceDetails = true
        defer { savingDeviceDetails = false }

        if previewMode {
            var updated = device
            updated.name = name
            updated.room = room
            updated.type = type
            updated.properties = nextProperties
            upsertDevice(updated)
            editDeviceID = nil
            prepareDeviceEditor(for: updated)
            return
        }

        do {
            let response = try await session.apiClient.put("/api/devices/\(device.id)", body: [
                "name": name,
                "room": room,
                "type": type,
                "properties": nextProperties
            ])
            let object = JSON.object(response)
            let data = JSON.object(object["data"])
            let updated = DeviceItem.from(JSON.object(data["device"]))
            upsertDevice(updated)
            editDeviceID = nil
            prepareDeviceEditor(for: updated)
        } catch {
            errorMessage = error.localizedDescription
            pendingDeleteDevice = nil
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
            var body: [String: Any] = [
                "protocol": protocolName,
                "durationSeconds": addDeviceDurationSeconds
            ]
            if protocolName == "zwave" {
                body["zwaveSecurityMode"] = addDeviceZWaveSecurityMode
            }
            let response = try await session.apiClient.post(
                "/api/direct-radios/pairing/start",
                body: body
            )
            let root = JSON.object(response)
            let result = JSON.object(root["result"])
            let expiresAt = JSON.optionalString(result, "expiresAt") ?? ""
            let suffix = expiresAt.isEmpty ? "" : " Window expires at \(JSON.displayDate(from: expiresAt))."
            addDeviceStatusMessage = protocolName == "zwave"
                ? "Z-Wave \(zWaveSecurityLabel(addDeviceZWaveSecurityMode)) inclusion is live. \(zWaveSecurityGuidance(addDeviceZWaveSecurityMode))\(suffix)"
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
                if protocolName == "zwave" {
                    updateKnownZWaveNodeIds(from: status)
                }
                let pairings = JSON.object(status["pairings"])
                let pairing = JSON.object(pairings[protocolName])
                let pairingStatus = JSON.string(pairing, "status")
                let message = JSON.string(pairing, "message")

                if protocolName == "zwave" {
                    let pendingDsk = JSON.string(pairing, "pendingDsk")
                    if pairingStatus == "awaiting_dsk" && !pendingDsk.isEmpty {
                        addDevicePendingDsk = pendingDsk
                        addDeviceStatusMessage = "Z-Wave secure inclusion needs the first 5 digits printed on the device DSK label. 00000 is not a valid fallback."
                    }
                    if pairingStatus == "interviewing" && !message.isEmpty {
                        addDeviceStatusMessage = message
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
            addDeviceStatusMessage = "Enter the first 5 digits printed on the Z-Wave DSK label or QR code."
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

    private func updateKnownZWaveNodeIds(from status: [String: Any]) {
        let controllers = JSON.object(status["controllers"])
        let zwave = JSON.object(controllers["zwave"])
        let nodes = JSON.array(zwave["nodes"])
            .filter { !JSON.bool($0, "isControllerNode") }
        let nodeIds = Set(
            nodes
                .map { JSON.int($0, "id") }
                .filter { $0 > 0 }
        )
        addDeviceKnownZWaveNodeIds = nodeIds
        addDeviceKnownZWaveNodes = nodes.compactMap { node in
            let nodeId = JSON.int(node, "id")
            guard nodeId > 0 else {
                return nil
            }
            return AddDeviceZWaveNodeSummary(
                id: nodeId,
                name: JSON.string(node, "name", fallback: "Z-Wave Node \(nodeId)"),
                ready: JSON.bool(node, "ready"),
                status: node["status"] == nil ? nil : JSON.int(node, "status"),
                incomplete: JSON.bool(node, "incomplete"),
                featureCount: JSON.stringArray(node["features"]).count
            )
        }
    }

    private func loadZWaveRepairNodeIds() async {
        if previewMode {
            addDeviceKnownZWaveNodes = UIPreviewData.devices.compactMap { device in
                guard let nodeId = zWaveNodeId(for: device),
                      nodeId != 1 else {
                    return nil
                }

                let direct = JSON.object(device.properties["homebrainDirect"])
                let catalog = JSON.object(direct["catalog"])
                let nodeName = JSON.string(catalog, "label", fallback: device.name)
                return AddDeviceZWaveNodeSummary(
                    id: nodeId,
                    name: nodeName,
                    ready: JSON.bool(direct, "ready", fallback: device.isOnline),
                    status: direct["status"] == nil ? nil : JSON.int(direct, "status"),
                    incomplete: isIncompleteZWaveDirectDevice(device),
                    featureCount: propertyStringSet(for: device, key: "directRadioFeatures").count
                )
            }
            addDeviceKnownZWaveNodeIds = Set(addDeviceKnownZWaveNodes.map(\.id))
            return
        }

        do {
            let response = try await session.apiClient.get("/api/direct-radios/status")
            let root = JSON.object(response)
            updateKnownZWaveNodeIds(from: JSON.object(root["status"]))
        } catch {
            addDeviceKnownZWaveNodeIds = []
            addDeviceKnownZWaveNodes = []
        }
    }

    private func repairZWaveNode(_ candidate: AddDeviceZWaveRepairCandidate) async {
        let nodeId = candidate.nodeId
        if previewMode {
            addDeviceStatusMessage = "HomeBrain would ping node \(nodeId) first and skip a fresh interview if it responds."
            return
        }

        addDeviceRepairingZWaveNodeId = nodeId
        addDeviceStatusMessage = "Checking \(candidate.name) before requesting a fresh Z-Wave interview."
        errorMessage = nil
        defer { addDeviceRepairingZWaveNodeId = nil }

        do {
            let response = try await session.apiClient.post(
                "/api/direct-radios/zwave/nodes/\(nodeId)/refresh-info",
                body: [
                    "waitForWakeup": false,
                    "resetSecurityClasses": candidate.likelyLegacySiren,
                    "pingFirst": true,
                    "skipRefreshIfPingSucceeds": !candidate.likelyLegacySiren
                ]
            )
            let root = JSON.object(response)
            updateKnownZWaveNodeIds(from: JSON.object(root["status"]))
            let result = JSON.object(root["result"])
            let ping = result["ping"] as? Bool
            let skippedRefresh = JSON.bool(result, "skippedRefresh")
            if skippedRefresh {
                addDeviceStatusMessage = "Node \(nodeId) answered the Z-Wave ping, so HomeBrain skipped a fresh interview. Refresh devices to confirm the recovered state."
            } else if ping == false && candidate.canRemoveFailed {
                addDeviceStatusMessage = "Node \(nodeId) did not answer and is marked dead by the Zooz controller. Remove Failed will clean up this stuck controller entry and its HomeBrain record."
            } else if ping == false {
                addDeviceStatusMessage = "HomeBrain requested a fresh interview for node \(nodeId), but it did not answer the first ping. Use the device include or wake action once and refresh devices."
            } else {
                addDeviceStatusMessage = "HomeBrain requested a fresh interview for node \(nodeId). If it does not update, use the device include or wake action once and refresh devices."
            }
            await loadDevices(showLoading: false)
        } catch {
            addDeviceStatusMessage = error.localizedDescription
            errorMessage = error.localizedDescription
        }
    }

    private func reinterviewZigbeeDevice(_ device: DeviceItem) async {
        let ieeeAddr = zigbeeIeeeAddr(for: device)
        guard !ieeeAddr.isEmpty else {
            errorMessage = "This Zigbee device has no IEEE address to re-interview."
            return
        }
        if previewMode {
            addDeviceStatusMessage = "HomeBrain would re-run the Zigbee interview for \(device.name)."
            return
        }

        reinterviewingZigbeeDeviceId = device.id
        addDeviceStatusMessage = "Re-running the Zigbee interview for \(device.name). Keep the sensor awake (open/close it or press its button)."
        errorMessage = nil
        defer { reinterviewingZigbeeDeviceId = nil }

        let encoded = ieeeAddr.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ieeeAddr
        do {
            let response = try await session.apiClient.post(
                "/api/direct-radios/zigbee/devices/\(encoded)/reinterview"
            )
            let root = JSON.object(response)
            let result = JSON.object(root["result"])
            let ias = JSON.object(result["iasZone"])
            let message = stringValue(result["message"])
            var note = message.isEmpty ? "HomeBrain re-ran the Zigbee interview for \(device.name)." : message
            if let enrolled = ias["enrolled"] as? Bool {
                note += enrolled
                    ? " Sensor is enrolled and should report open/closed again."
                    : " Sensor is not enrolled yet — keep it awake (open/close or press its button) and retry."
            }
            addDeviceStatusMessage = note
            await loadDevices(showLoading: false)
        } catch {
            addDeviceStatusMessage = error.localizedDescription
            errorMessage = error.localizedDescription
        }
    }

    private func replaceFailedZWaveNode(_ candidate: AddDeviceZWaveRepairCandidate) async {
        let nodeId = candidate.nodeId
        let securityMode = zWaveReplacementSecurityMode(for: candidate)
        if previewMode {
            addDeviceStatusMessage = "HomeBrain would open \(zWaveSecurityLabel(securityMode)) replacement for Z-Wave node \(nodeId)."
            return
        }

        addDeviceReplacingZWaveNodeId = nodeId
        addDeviceStatusMessage = "Opening \(zWaveSecurityLabel(securityMode)) replacement for \(candidate.name)."
        errorMessage = nil
        defer { addDeviceReplacingZWaveNodeId = nil }

        do {
            let response = try await session.apiClient.post(
                "/api/direct-radios/zwave/nodes/\(nodeId)/replace-failed",
                body: [
                    "confirm": true,
                    "force": candidate.forceRemoveFailed,
                    "durationSeconds": addDeviceDurationSeconds,
                    "zwaveSecurityMode": securityMode
                ]
            )
            let root = JSON.object(response)
            updateKnownZWaveNodeIds(from: JSON.object(root["status"]))
            let result = JSON.object(root["result"])
            let message = JSON.string(result, "message")
            addDeviceStatusMessage = message.isEmpty
                ? "\(zWaveSecurityLabel(securityMode)) replacement is live. Press the device include/action button now."
                : message
        } catch {
            addDeviceStatusMessage = error.localizedDescription
            errorMessage = error.localizedDescription
        }
    }

    private func removeFailedZWaveNode(_ candidate: AddDeviceZWaveRepairCandidate) async {
        let nodeId = candidate.nodeId
        if previewMode {
            addDeviceStatusMessage = "HomeBrain would remove failed Z-Wave node \(nodeId) from the controller."
            return
        }

        addDeviceRemovingZWaveNodeId = nodeId
        addDeviceStatusMessage = "Removing failed Z-Wave node \(nodeId) from the Zooz controller."
        errorMessage = nil
        defer { addDeviceRemovingZWaveNodeId = nil }

        do {
            let response = try await session.apiClient.post(
                "/api/direct-radios/zwave/nodes/\(nodeId)/remove-failed",
                body: [
                    "confirm": true,
                    "force": candidate.forceRemoveFailed
                ]
            )
            let root = JSON.object(response)
            updateKnownZWaveNodeIds(from: JSON.object(root["status"]))
            let result = JSON.object(root["result"])
            let deletedCount = JSON.int(result, "deletedDeviceCount")
            addDeviceStatusMessage = deletedCount > 0
                ? "Z-Wave node \(nodeId) was removed and \(deletedCount) HomeBrain device record\(deletedCount == 1 ? "" : "s") were cleaned up."
                : "Z-Wave node \(nodeId) was removed from the controller."
            await loadDevices(showLoading: false)
        } catch {
            addDeviceStatusMessage = error.localizedDescription
            errorMessage = error.localizedDescription
        }
    }

    private func startZWaveCleanupExclusion() async {
        if previewMode {
            addDeviceStatusMessage = "HomeBrain would open Z-Wave exclusion cleanup. Use the switch exclude action, then retry standard inclusion."
            return
        }

        addDeviceBusy = true
        addDevicePendingDsk = ""
        errorMessage = nil
        defer { addDeviceBusy = false }

        do {
            let response = try await session.apiClient.post(
                "/api/direct-radios/exclusion/start",
                body: [
                    "protocol": "zwave",
                    "durationSeconds": addDeviceDurationSeconds
                ]
            )
            let root = JSON.object(response)
            let result = JSON.object(root["result"])
            let expiresAt = JSON.optionalString(result, "expiresAt") ?? ""
            let suffix = expiresAt.isEmpty ? "" : " Window expires at \(JSON.displayDate(from: expiresAt))."
            addDeviceStatusMessage = "Z-Wave exclusion cleanup is live. Tap the switch exclude action now, then retry standard inclusion.\(suffix)"
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
            if controlSheetDeviceID == device.id {
                controlSheetDeviceID = nil
            }
            pendingDeleteDevice = nil
            return
        }

        do {
            _ = try await session.apiClient.delete("/api/devices/\(device.id)")
            devices.removeAll { $0.id == device.id }
            favoriteDeviceIds.remove(device.id)
            if controlSheetDeviceID == device.id {
                controlSheetDeviceID = nil
            }
            pendingDeleteDevice = nil
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
        case "siren":
            return "bell"
        case "speaker":
            return "speaker.wave.3"
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
        case "siren":
            return "Sirens"
        case "camera":
            return "Cameras"
        case "speaker":
            return "Speakers"
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
        case "siren":
            return "Siren"
        case "camera":
            return "Camera"
        case "speaker":
            return "Speaker"
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

    private func formatNumber(_ value: Double, digits: Int = 0) -> String {
        String(format: "%.\(digits)f", value)
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

    private func clampColorTemperature(_ value: Double) -> Double {
        min(6500, max(1500, value)).rounded()
    }

    private func directRadioState(for device: DeviceItem) -> [String: Any] {
        device.directRadioState
    }

    private func percentValue(_ value: Any?) -> Int? {
        let numeric: Double?
        if let value = value as? Double {
            numeric = value
        } else if let value = value as? NSNumber {
            numeric = value.doubleValue
        } else if let value = value as? String {
            numeric = Double(value.trimmingCharacters(in: .whitespacesAndNewlines))
        } else {
            numeric = nil
        }

        guard let numeric, numeric.isFinite else {
            return nil
        }

        return Int(min(100, max(0, numeric)).rounded())
    }

    private func batteryLevel(for device: DeviceItem) -> Int? {
        let attributeValues = JSON.object(device.properties["smartThingsAttributeValues"])
        let batteryAttributes = JSON.object(attributeValues["battery"])
        let directState = directRadioState(for: device)
        var candidates: [Any?] = [
            directState["batteryLevel"],
            device.properties["homeBrainBatteryLevel"],
            device.properties["directBatteryLevel"],
            device.properties["batteryLevel"],
            device.properties["matterBatteryLevel"]
        ]
        if !isDirectRadioBackedDevice(device) {
            candidates.append(contentsOf: [
                device.properties["smartThingsBatteryLevel"],
                device.properties["battery"],
                batteryAttributes["battery"],
                batteryAttributes["batteryLevel"]
            ])
        }

        for candidate in candidates {
            if let percent = percentValue(candidate) {
                return percent
            }
        }

        if let voltage = batteryVoltage(for: device) {
            return batteryLevelFromVoltage(voltage)
        }

        return nil
    }

    private func batteryVoltage(for device: DeviceItem) -> Double? {
        let directState = directRadioState(for: device)
        let candidates: [Any?] = [
            directState["batteryVoltage"],
            device.properties["homeBrainBatteryVoltage"],
            device.properties["directBatteryVoltage"],
            device.properties["batteryVoltage"],
            device.properties["matterBatteryVoltage"]
        ]

        for candidate in candidates {
            if let voltage = numberValue(from: candidate), voltage > 0 {
                return (voltage * 100).rounded() / 100
            }
        }

        return nil
    }

    private func batteryLevelFromVoltage(_ voltage: Double) -> Int? {
        if voltage >= 2, voltage <= 3.3 {
            return percentValue(((voltage - 2.1) / 0.9) * 100)
        }
        if voltage >= 1, voltage <= 1.8 {
            return percentValue(((voltage - 1) / 0.6) * 100)
        }
        if voltage >= 4, voltage <= 6.6 {
            return percentValue(((voltage - 4.2) / 1.8) * 100)
        }
        return nil
    }

    private func deviceSupportsBattery(_ device: DeviceItem) -> Bool {
        if boolValue(device.properties["supportsBattery"]) {
            return true
        }
        if batteryLevel(for: device) != nil || batteryVoltage(for: device) != nil {
            return true
        }
        return propertyStringSet(for: device, key: "directRadioFeatures").contains("battery")
    }

    private func batteryStatusText(for device: DeviceItem) -> String? {
        if let battery = batteryLevel(for: device) {
            return "\(battery)% battery"
        }
        if let voltage = batteryVoltage(for: device) {
            return "\(formatNumber(voltage, digits: 2)) V battery"
        }
        return deviceSupportsBattery(device) ? "Battery awaiting report" : nil
    }

    private func batteryStatusColor(for device: DeviceItem) -> Color {
        guard let battery = batteryLevel(for: device) else {
            return batteryVoltage(for: device) == nil ? HBPalette.textSecondary : HBPalette.accentGreen
        }
        return hbBatteryTint(for: battery)
    }

    private func batteryFallbackText(for device: DeviceItem) -> String? {
        guard batteryLevel(for: device) == nil, let voltage = batteryVoltage(for: device) else {
            return nil
        }
        return "\(formatNumber(voltage, digits: 2))V"
    }

    @ViewBuilder
    private func batteryIndicator(for device: DeviceItem, compact: Bool = true) -> some View {
        if deviceSupportsBattery(device) {
            HBBatteryIndicator(
                percent: batteryLevel(for: device),
                fallbackText: batteryFallbackText(for: device),
                isAwaitingReport: batteryLevel(for: device) == nil && batteryVoltage(for: device) == nil,
                compact: compact
            )
        }
    }

    private func sensorTemperatureF(for device: DeviceItem) -> Double? {
        let state = directRadioState(for: device)
        if let temperatureF = numberValue(from: state["temperatureF"] ?? device.temperature) {
            return temperatureF
        }
        if let temperatureC = numberValue(from: state["temperatureC"]) {
            return (temperatureC * 9 / 5) + 32
        }
        return nil
    }

    @ViewBuilder
    private func temperatureIndicator(for device: DeviceItem) -> some View {
        if let temperature = sensorTemperatureF(for: device) {
            HStack(spacing: 3) {
                Image(systemName: "thermometer.medium")
                    .font(.system(size: 11, weight: .bold))
                Text("\(formatNumber(temperature))°")
                    .font(HBTypography.body(size: 11, weight: .bold))
            }
            .foregroundStyle(HBPalette.accentBlue)
            .accessibilityLabel("Temperature \(formatNumber(temperature)) degrees")
        }
    }

    private func sensorStateLabel(for device: DeviceItem) -> String? {
        if let label = device.effectiveSensorStateLabel {
            return label
        }

        let state = directRadioState(for: device)
        if state["contactOpen"] != nil {
            return boolValue(state["contactOpen"]) ? "Open" : "Closed"
        }
        let contact = stringValue(state["contact"]).lowercased()
        if contact == "open" || contact == "closed" {
            return contact == "open" ? "Open" : "Closed"
        }
        if state["motionActive"] != nil {
            return boolValue(state["motionActive"]) ? "Motion" : "Clear"
        }
        if state["vibrationActive"] != nil || state["accelerationActive"] != nil {
            return boolValue(state["vibrationActive"]) || boolValue(state["accelerationActive"]) ? "Vibration" : "Clear"
        }
        if state["tamperActive"] != nil || state["tamper"] != nil {
            return boolValue(state["tamperActive"]) || boolValue(state["tamper"]) ? "Tamper" : "Clear"
        }
        if state["waterDetected"] != nil {
            return boolValue(state["waterDetected"]) ? "Wet" : "Dry"
        }
        return nil
    }

    private func deviceTelemetryRows(for device: DeviceItem) -> [(label: String, value: String)] {
        let state = directRadioState(for: device)
        var rows: [(label: String, value: String)] = []

        if let batteryStatus = batteryStatusText(for: device) {
            rows.append(("Battery", batteryStatus))
        }
        if let voltage = batteryVoltage(for: device) {
            rows.append(("Battery voltage", "\(formatNumber(voltage, digits: 2)) V"))
        }
        if state["batteryLow"] != nil {
            rows.append(("Battery low", boolValue(state["batteryLow"]) ? "Yes" : "No"))
        }
        if let sensorState = sensorStateLabel(for: device) {
            rows.append(("Sensor state", sensorState))
        }

        let temperatureF = sensorTemperatureF(for: device)
        if let temperatureF {
            rows.append(("Temperature", "\(formatNumber(temperatureF))°"))
        }
        if let humidity = numberValue(from: state["humidity"]) {
            rows.append(("Humidity", "\(formatNumber(humidity))%"))
        }
        if let illuminance = numberValue(from: state["illuminance"]) {
            rows.append(("Illuminance", "\(formatNumber(illuminance)) lx"))
        }
        if state["vibrationActive"] != nil || state["accelerationActive"] != nil {
            rows.append(("Vibration", boolValue(state["vibrationActive"]) || boolValue(state["accelerationActive"]) ? "Detected" : "Clear"))
        }
        if state["tamperActive"] != nil || state["tamper"] != nil {
            rows.append(("Tamper", boolValue(state["tamperActive"]) || boolValue(state["tamper"]) ? "Detected" : "Clear"))
        }

        return rows
    }

    private func sensorSummary(for device: DeviceItem) -> String {
        let state = directRadioState(for: device)
        let values: [String?] = [
            sensorStateLabel(for: device),
            sensorTemperatureF(for: device).map { "\(Int($0.rounded()))°" },
            batteryStatusText(for: device),
            numberValue(from: state["humidity"]).map { "\(Int($0.rounded()))% humidity" },
            numberValue(from: state["illuminance"]).map { "\(Int($0.rounded())) lx" }
        ]
        let parts = values.compactMap { $0 }.filter { !$0.isEmpty }
        return parts.isEmpty ? "Sensor telemetry" : parts.joined(separator: " · ")
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

    private func currentLightColorTemperature(for device: DeviceItem) -> Double {
        if let draft = lightColorTemperatureDrafts[device.id] {
            return clampColorTemperature(draft)
        }
        if let value = device.colorTemperature {
            return clampColorTemperature(value)
        }
        if let value = numberValue(from: directRadioState(for: device)["colorTemperatureK"]) {
            return clampColorTemperature(value)
        }
        return 4000
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

    private func isLikelyLegacyZWaveSirenDevice(_ device: DeviceItem) -> Bool {
        let features = propertyStringSet(for: device, key: "directRadioFeatures")
        let catalog = JSON.object(device.properties["directRadioCatalog"])
        let directCatalog = JSON.object(JSON.object(device.properties["homebrainDirect"])["catalog"])
        let text = [
            device.name,
            device.type,
            stringValue(device.properties["brand"]),
            stringValue(device.properties["model"]),
            JSON.string(catalog, "label"),
            JSON.string(catalog, "manufacturer"),
            JSON.string(directCatalog, "label"),
            JSON.string(directCatalog, "manufacturer"),
            features.joined(separator: " ")
        ]
            .joined(separator: " ")
            .lowercased()
        return device.type.lowercased() == "siren"
            || features.contains("alarm")
            || text.range(of: #"(?i)\b(zw080|siren|alarm|aeotec|aeon)\b"#, options: .regularExpression) != nil
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

    private func zWaveNodeStatusLabel(_ status: Int?) -> String {
        guard let status else {
            return "status unknown"
        }
        switch status {
        case 0:
            return "unknown"
        case 1:
            return "asleep"
        case 2:
            return "awake"
        case 3:
            return "dead"
        case 4:
            return "alive"
        default:
            return "status \(status)"
        }
    }

    private func isDeadZWaveNodeStatus(_ status: Int?) -> Bool {
        status == 3
    }

    private func zwaveRepairSubtitle(for device: DeviceItem) -> String {
        let nodeId = zWaveNodeId(for: device)
        let node = nodeId.map { "Node \($0)" } ?? "Node ?"
        let status = nodeId.flatMap { nodeId in addDeviceKnownZWaveNodes.first { $0.id == nodeId }?.status }
        let featureCount = propertyStringSet(for: device, key: "directRadioFeatures").count
        let state = device.isOnline ? "not fully interviewed" : "offline"
        return "\(node) · \(zWaveNodeStatusLabel(status)) · \(featureCount) features · \(state)"
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

    private func normalizedContactOpenDebounceSeconds(_ value: Any?) -> Double {
        let parsed = numberValue(from: value) ?? contactOpenDebounceDefaultSeconds
        let stepped = (parsed / contactOpenDebounceStepSeconds).rounded() * contactOpenDebounceStepSeconds
        return min(contactOpenDebounceMaxSeconds, max(contactOpenDebounceMinSeconds, stepped))
    }

    private func contactOpenDebounceConfig(for device: DeviceItem) -> (enabled: Bool, seconds: Double) {
        let config = JSON.object(device.properties["contactOpenDebounce"])
        return (
            enabled: boolValue(config["enabled"]),
            seconds: normalizedContactOpenDebounceSeconds(config["seconds"])
        )
    }

    private func supportsContactOpenDebounce(_ device: DeviceItem) -> Bool {
        guard device.type == "sensor" else { return false }
        let state = directRadioState(for: device)
        let features = propertyStringSet(for: device, key: "directRadioFeatures")
        let contact = stringValue(state["contact"]).lowercased()
        return boolValue(device.properties["supportsContactSensor"])
            || features.contains("contact")
            || state.keys.contains("contactOpen")
            || contact == "open"
            || contact == "closed"
    }

    private func isDirectRadioBackedDevice(_ device: DeviceItem) -> Bool {
        let source = stringValue(device.properties["source"]).lowercased()
        let direct = JSON.object(device.properties["homebrainDirect"])
        let protocolName = stringValue(direct["protocol"]).lowercased()
        return source == "homebrain-zigbee"
            || source == "homebrain-zwave"
            || protocolName == "zigbee"
            || protocolName == "zwave"
    }

    private func isNativeZWaveLock(_ device: DeviceItem) -> Bool {
        guard device.type == "lock" else {
            return false
        }
        let source = stringValue(device.properties["source"]).lowercased()
        let direct = JSON.object(device.properties["homebrainDirect"])
        let protocolName = stringValue(direct["protocol"]).lowercased()
        return source == "homebrain-zwave" || protocolName == "zwave"
    }

    private func isNativeZigbeeDevice(_ device: DeviceItem) -> Bool {
        let source = stringValue(device.properties["source"]).lowercased()
        let direct = JSON.object(device.properties["homebrainDirect"])
        let protocolName = stringValue(direct["protocol"]).lowercased()
        return source == "homebrain-zigbee" || protocolName == "zigbee"
    }

    private func zigbeeIeeeAddr(for device: DeviceItem) -> String {
        let direct = JSON.object(device.properties["homebrainDirect"])
        return stringValue(direct["ieeeAddr"])
    }

    private func smartThingsMigration(for device: DeviceItem) -> [String: Any] {
        JSON.object(device.properties["smartThingsMigration"])
    }

    private func isSmartThingsMigrationFinalized(_ device: DeviceItem) -> Bool {
        let migration = smartThingsMigration(for: device)
        guard !migration.isEmpty else { return false }
        let validation = JSON.object(migration["validation"])
        let validationStatus = stringValue(validation["status"]).lowercased()
        return JSON.optionalString(migration, "finalizedAt") != nil
            || boolValue(validation["finalized"])
            || validationStatus == "passed"
    }

    private func isRetiredSmartThingsMigrationSource(_ device: DeviceItem) -> Bool {
        let migration = smartThingsMigration(for: device)
        let status = stringValue(migration["status"]).lowercased()
        return boolValue(migration["retiredSource"]) || status == "finalized_source"
    }

    private func isSmartThingsAwaitingNativePairing(_ device: DeviceItem) -> Bool {
        let migration = smartThingsMigration(for: device)
        let status = stringValue(migration["status"]).lowercased()
        return status == "awaiting_native_pairing"
    }

    private func needsMigrationFinalization(_ device: DeviceItem) -> Bool {
        return isDirectRadioBackedDevice(device)
            && !smartThingsMigration(for: device).isEmpty
            && !isSmartThingsMigrationFinalized(device)
    }

    private func isSmartThingsBackedDevice(_ device: DeviceItem) -> Bool {
        let source = stringValue(device.properties["source"]).lowercased()
        let isDirectRadio = isDirectRadioBackedDevice(device)
        let hasDeviceId = !stringValue(device.properties["smartThingsDeviceId"]).isEmpty
        return source == "smartthings" || (!isDirectRadio && hasDeviceId)
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

    private func supportsDirectRadioPowerControl(_ device: DeviceItem) -> Bool {
        let features = propertyStringSet(for: device, key: "directRadioFeatures")
        return features.contains("switch") || features.contains("lock")
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

    private func supportsLightColorTemperature(_ device: DeviceItem) -> Bool {
        if isSmartThingsBackedDevice(device) {
            let capabilities = smartThingsCapabilities(for: device)
            return capabilities.contains("colorTemperature") || boolValue(device.properties["supportsColorTemperature"])
        }

        return boolValue(device.properties["supportsColorTemperature"])
            || propertyStringSet(for: device, key: "directRadioFeatures").contains("colortemperature")
            || propertyStringSet(for: device, key: "matterFeatures").contains("colortemperature")
    }

    private func sirenVolumeConfigParameter(for device: DeviceItem) -> [String: Any]? {
        let catalog = JSON.object(device.properties["directRadioCatalog"])
        return JSON.array(catalog["configParameters"]).first { parameter in
            if boolValue(parameter["readOnly"]) || boolValue(parameter["writeOnly"]) || boolValue(parameter["hidden"]) {
                return false
            }
            guard numberValue(from: parameter["parameter"]) != nil else {
                return false
            }
            let label = [
                stringValue(parameter["label"]),
                stringValue(parameter["name"]),
                stringValue(parameter["purpose"]),
                stringValue(parameter["description"])
            ]
                .filter { !$0.isEmpty }
                .joined(separator: " ")
                .lowercased()
            return label.range(of: #"\bvolume\b"#, options: .regularExpression) != nil
        }
    }

    private func sirenVolumeOptions(from rawOptions: Any?) -> [SirenVolumeOption] {
        JSON.array(rawOptions).compactMap { option in
            guard let rawValue = numberValue(from: option["value"]) else {
                return nil
            }
            let label = [
                stringValue(option["label"]),
                stringValue(option["name"]),
                stringValue(option["value"])
            ].first(where: { !$0.isEmpty }) ?? ""
            guard !label.isEmpty else {
                return nil
            }
            return SirenVolumeOption(label: label, value: Int(rawValue.rounded()))
        }
    }

    private func sirenVolumeOptions(for device: DeviceItem) -> [SirenVolumeOption] {
        let explicit = sirenVolumeOptions(from: device.properties["sirenVolumeOptions"])
        if !explicit.isEmpty {
            return explicit
        }

        guard let parameter = sirenVolumeConfigParameter(for: device) else {
            return []
        }
        let catalogOptions = sirenVolumeOptions(from: parameter["options"])
        if !catalogOptions.isEmpty {
            return catalogOptions
        }

        guard let min = numberValue(from: parameter["minValue"]),
              let max = numberValue(from: parameter["maxValue"]),
              max >= min,
              max - min <= 8 else {
            return []
        }
        return (Int(min.rounded())...Int(max.rounded())).map { value in
            SirenVolumeOption(label: String(value), value: value)
        }
    }

    private func currentSirenVolume(for device: DeviceItem) -> Int? {
        if let explicit = numberValue(from: device.properties["sirenVolume"]) {
            return Int(explicit.rounded())
        }
        if let parameter = sirenVolumeConfigParameter(for: device),
           let defaultValue = numberValue(from: parameter["defaultValue"]) {
            return Int(defaultValue.rounded())
        }
        return sirenVolumeOptions(for: device).last?.value
    }

    private func sirenSoundConfigParameter(for device: DeviceItem) -> [String: Any]? {
        let catalog = JSON.object(device.properties["directRadioCatalog"])
        return JSON.array(catalog["configParameters"]).first { parameter in
            if boolValue(parameter["readOnly"]) || boolValue(parameter["writeOnly"]) || boolValue(parameter["hidden"]) {
                return false
            }
            guard numberValue(from: parameter["parameter"]) != nil else {
                return false
            }
            let label = [
                stringValue(parameter["label"]),
                stringValue(parameter["name"]),
                stringValue(parameter["purpose"]),
                stringValue(parameter["description"])
            ]
                .filter { !$0.isEmpty }
                .joined(separator: " ")
                .lowercased()
            return label.range(of: #"\bvolume\b"#, options: .regularExpression) == nil
                && label.range(of: #"\b(sound|tone)\b"#, options: .regularExpression) != nil
        }
    }

    private func sirenSoundOptions(for device: DeviceItem) -> [SirenVolumeOption] {
        let explicit = sirenVolumeOptions(from: device.properties["sirenSoundOptions"])
        if !explicit.isEmpty {
            return explicit
        }

        guard let parameter = sirenSoundConfigParameter(for: device) else {
            return []
        }
        let catalogOptions = sirenVolumeOptions(from: parameter["options"])
        if !catalogOptions.isEmpty {
            return catalogOptions
        }

        guard let min = numberValue(from: parameter["minValue"]),
              let max = numberValue(from: parameter["maxValue"]),
              max >= min,
              max - min <= 32 else {
            return []
        }
        return (Int(min.rounded())...Int(max.rounded())).map { value in
            SirenVolumeOption(label: String(value), value: value)
        }
    }

    private func currentSirenSound(for device: DeviceItem) -> Int? {
        if let explicit = numberValue(from: device.properties["sirenSound"]) {
            return Int(explicit.rounded())
        }
        if let parameter = sirenSoundConfigParameter(for: device),
           let defaultValue = numberValue(from: parameter["defaultValue"]) {
            return Int(defaultValue.rounded())
        }
        return sirenSoundOptions(for: device).first?.value
    }

    private func supportsSirenVolume(_ device: DeviceItem) -> Bool {
        device.type == "siren"
            && (
                boolValue(device.properties["supportsSirenVolume"])
                || sirenVolumeConfigParameter(for: device) != nil
                || !sirenVolumeOptions(for: device).isEmpty
            )
    }

    private func supportsSirenSound(_ device: DeviceItem) -> Bool {
        device.type == "siren"
            && (
                boolValue(device.properties["supportsSirenSound"])
                || sirenSoundConfigParameter(for: device) != nil
                || !sirenSoundOptions(for: device).isEmpty
            )
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

private struct NativeLockCodeDraft {
    var slot: Int
    var name: String = ""
    var pin: String = ""
    var enabled: Bool = true
}

private struct NativeLockCodeCapabilities {
    let maxSlots: Int
    let minPinLength: Int
    let maxPinLength: Int
    let supportsNames: Bool
    let supportsLockAudit: Bool

    nonisolated static func from(_ object: [String: Any]) -> NativeLockCodeCapabilities {
        NativeLockCodeCapabilities(
            maxSlots: JSON.int(object, "maxSlots"),
            minPinLength: JSON.int(object, "minPinLength", fallback: 4),
            maxPinLength: JSON.int(object, "maxPinLength", fallback: 8),
            supportsNames: JSON.bool(object, "supportsNames"),
            supportsLockAudit: JSON.bool(object, "supportsLockAudit")
        )
    }
}

private struct NativeLockCodeSlot: Identifiable {
    let id: Int
    let slot: Int
    let name: String
    let enabled: Bool
    let source: String
    let updatedAt: String?
    let updatedBy: String?

    nonisolated static func from(_ object: [String: Any]) -> NativeLockCodeSlot {
        let slot = JSON.int(object, "slot", fallback: 1)
        return NativeLockCodeSlot(
            id: slot,
            slot: slot,
            name: JSON.string(object, "name", fallback: "Code \(slot)"),
            enabled: JSON.bool(object, "enabled", fallback: true),
            source: JSON.string(object, "source", fallback: "lock"),
            updatedAt: JSON.optionalString(object, "updatedAt"),
            updatedBy: JSON.optionalString(object, "updatedBy")
        )
    }
}

private struct NativeLockCodeEvent: Identifiable {
    let id: String
    let source: String
    let action: String
    let label: String
    let slot: Int?
    let codeName: String?
    let actor: String?
    let createdAt: Any?

    var actionLabel: String {
        let raw = action.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return "Event" }
        return raw
            .replacingOccurrences(of: "_", with: " ")
            .split(separator: " ")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }

    var displayDate: String {
        JSON.displayDate(from: createdAt)
    }

    nonisolated static func from(_ object: [String: Any]) -> NativeLockCodeEvent {
        let slotValue = JSON.int(object, "slot")
        return NativeLockCodeEvent(
            id: JSON.string(object, "id", fallback: UUID().uuidString),
            source: JSON.string(object, "source", fallback: "homebrain"),
            action: JSON.string(object, "action", fallback: "event"),
            label: JSON.string(object, "label", fallback: "Lock event"),
            slot: slotValue > 0 ? slotValue : nil,
            codeName: JSON.optionalString(object, "codeName"),
            actor: JSON.optionalString(object, "actor"),
            createdAt: object["createdAt"]
        )
    }

    nonisolated static var previewEvents: [NativeLockCodeEvent] {
        [
            NativeLockCodeEvent(
                id: "preview-lock-code-used",
                source: "homebrain",
                action: "unlock",
                label: "Unlocked by PIN",
                slot: 1,
                codeName: "Household",
                actor: nil,
                createdAt: Date()
            )
        ]
    }
}

private struct NativeLockCodeState {
    let deviceId: String
    let deviceName: String
    let nodeId: Int
    let capabilities: NativeLockCodeCapabilities
    let slots: [NativeLockCodeSlot]
    let availableSlots: [Int]

    nonisolated static func from(_ object: [String: Any]) -> NativeLockCodeState {
        let capabilities = NativeLockCodeCapabilities.from(JSON.object(object["capabilities"]))
        let slots = JSON.array(object["slots"]).map(NativeLockCodeSlot.from)
        let availableSlots = (object["availableSlots"] as? [Any] ?? [])
            .compactMap { value -> Int? in
                if let intValue = value as? Int {
                    return intValue
                }
                if let numberValue = value as? NSNumber {
                    return numberValue.intValue
                }
                if let stringValue = value as? String {
                    return Int(stringValue)
                }
                return nil
            }
            .filter { $0 > 0 }
        return NativeLockCodeState(
            deviceId: JSON.string(object, "deviceId"),
            deviceName: JSON.string(object, "deviceName", fallback: "Lock"),
            nodeId: JSON.int(object, "nodeId"),
            capabilities: capabilities,
            slots: slots,
            availableSlots: availableSlots
        )
    }

    nonisolated static func preview(for device: DeviceItem) -> NativeLockCodeState {
        NativeLockCodeState(
            deviceId: device.id,
            deviceName: device.name,
            nodeId: 9,
            capabilities: NativeLockCodeCapabilities(
                maxSlots: 30,
                minPinLength: 4,
                maxPinLength: 8,
                supportsNames: false,
                supportsLockAudit: true
            ),
            slots: [
                NativeLockCodeSlot(
                    id: 1,
                    slot: 1,
                    name: "Household",
                    enabled: true,
                    source: "homebrain",
                    updatedAt: nil,
                    updatedBy: nil
                )
            ],
            availableSlots: Array(2...30)
        )
    }

    nonisolated func upserting(slot: Int, name: String, enabled: Bool) -> NativeLockCodeState {
        let nextSlot = NativeLockCodeSlot(
            id: slot,
            slot: slot,
            name: name,
            enabled: enabled,
            source: "homebrain",
            updatedAt: nil,
            updatedBy: nil
        )
        let remaining = slots.filter { $0.slot != slot }
        return NativeLockCodeState(
            deviceId: deviceId,
            deviceName: deviceName,
            nodeId: nodeId,
            capabilities: capabilities,
            slots: (remaining + [nextSlot]).sorted { $0.slot < $1.slot },
            availableSlots: availableSlots.filter { $0 != slot }
        )
    }

    nonisolated func removing(slot: Int) -> NativeLockCodeState {
        var nextAvailable = Set(availableSlots)
        nextAvailable.insert(slot)
        return NativeLockCodeState(
            deviceId: deviceId,
            deviceName: deviceName,
            nodeId: nodeId,
            capabilities: capabilities,
            slots: slots.filter { $0.slot != slot },
            availableSlots: nextAvailable.sorted()
        )
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
        return "HomeBrain requests SmartThings removal before opening Zigbee pairing. Confirm native state, battery, and controls before finalizing migration."
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
