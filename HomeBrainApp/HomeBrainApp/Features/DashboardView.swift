import Combine
import CoreLocation
import SwiftUI

private struct DashboardTempestStationSnapshot {
    let name: String
    let room: String
    let temperatureF: Double?
    let feelsLikeF: Double?
    let humidityPct: Double?
    let uvIndex: Double?
    let windAvgMph: Double?
    let windGustMph: Double?
    let windDirectionDeg: Double?
    let pressureInHg: Double?
    let pressureTrend: String
    let rainTodayIn: Double?
    let rainRateInPerHr: Double?
    let websocketConnected: Bool

    static func from(_ payload: Any?) -> DashboardTempestStationSnapshot? {
        let station = JSON.object(payload)
        guard !station.isEmpty else {
            return nil
        }

        let metrics = JSON.object(station["metrics"])
        let status = JSON.object(station["status"])

        return DashboardTempestStationSnapshot(
            name: JSON.string(station, "name", fallback: "Tempest Station"),
            room: JSON.string(station, "room", fallback: "Outside"),
            temperatureF: optionalNumber(metrics["temperatureF"]),
            feelsLikeF: optionalNumber(metrics["feelsLikeF"]),
            humidityPct: optionalNumber(metrics["humidityPct"]),
            uvIndex: optionalNumber(metrics["uvIndex"]),
            windAvgMph: optionalNumber(metrics["windAvgMph"]),
            windGustMph: optionalNumber(metrics["windGustMph"]),
            windDirectionDeg: optionalNumber(metrics["windDirectionDeg"]),
            pressureInHg: optionalNumber(metrics["pressureInHg"]),
            pressureTrend: JSON.string(metrics, "pressureTrend", fallback: "steady"),
            rainTodayIn: optionalNumber(metrics["rainTodayIn"]),
            rainRateInPerHr: optionalNumber(metrics["rainRateInPerHr"]),
            websocketConnected: JSON.bool(status, "websocketConnected")
        )
    }

    private static func optionalNumber(_ value: Any?) -> Double? {
        if let number = value as? Double {
            return number
        }
        if let number = value as? NSNumber {
            return number.doubleValue
        }
        if let string = value as? String, let parsed = Double(string) {
            return parsed
        }
        return nil
    }
}

private struct DashboardWeatherSnapshot {
    let locationName: String
    let source: DashboardWeatherLocationMode
    let temperatureF: Double?
    let apparentTemperatureF: Double?
    let humidity: Double?
    let windSpeedMph: Double?
    let precipitationIn: Double?
    let isDay: Bool
    let condition: String
    let icon: String
    let highF: Double?
    let lowF: Double?
    let precipitationChance: Double?
    let todayCondition: String
    let sunrise: String?
    let sunset: String?
    let tempest: DashboardTempestStationSnapshot?

    static func from(_ payload: Any?) -> DashboardWeatherSnapshot? {
        let root = JSON.object(payload)
        let location = JSON.object(root["location"])
        let current = JSON.object(root["current"])
        let today = JSON.object(root["today"])
        let tempest = JSON.object(root["tempest"])
        let source = DashboardWeatherLocationMode(rawValue: JSON.string(location, "source")) ?? .saved

        guard !location.isEmpty, !current.isEmpty, !today.isEmpty else {
            return nil
        }

        return DashboardWeatherSnapshot(
            locationName: JSON.string(location, "name", fallback: "Saved location"),
            source: source,
            temperatureF: Self.optionalNumber(current["temperatureF"]),
            apparentTemperatureF: Self.optionalNumber(current["apparentTemperatureF"]),
            humidity: Self.optionalNumber(current["humidity"]),
            windSpeedMph: Self.optionalNumber(current["windSpeedMph"]),
            precipitationIn: Self.optionalNumber(current["precipitationIn"]),
            isDay: JSON.bool(current, "isDay", fallback: true),
            condition: JSON.string(current, "condition", fallback: "Unknown"),
            icon: JSON.string(current, "icon", fallback: "cloudy"),
            highF: Self.optionalNumber(today["highF"]),
            lowF: Self.optionalNumber(today["lowF"]),
            precipitationChance: Self.optionalNumber(today["precipitationChance"]),
            todayCondition: JSON.string(today, "condition", fallback: JSON.string(current, "condition", fallback: "Unknown")),
            sunrise: JSON.optionalString(today, "sunrise"),
            sunset: JSON.optionalString(today, "sunset"),
            tempest: JSON.bool(tempest, "available") ? DashboardTempestStationSnapshot.from(tempest["station"]) : nil
        )
    }

    static func preview(mode: DashboardWeatherLocationMode, query: String?) -> DashboardWeatherSnapshot {
        let trimmedQuery = query?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        return DashboardWeatherSnapshot(
            locationName: mode == .custom ? (trimmedQuery.isEmpty ? "Denver, CO" : trimmedQuery) : (mode == .auto ? "Current location" : "Saved location"),
            source: mode,
            temperatureF: 67,
            apparentTemperatureF: 65,
            humidity: 42,
            windSpeedMph: 8,
            precipitationIn: 0,
            isDay: true,
            condition: "Partly Cloudy",
            icon: "partly-cloudy",
            highF: 74,
            lowF: 49,
            precipitationChance: 20,
            todayCondition: "Overcast",
            sunrise: "2026-03-23T07:01:00-06:00",
            sunset: "2026-03-23T19:14:00-06:00",
            tempest: nil
        )
    }

    var sourceLabel: String {
        switch source {
        case .saved:
            return "Saved Address"
        case .custom:
            return "Custom Address"
        case .auto:
            return "Auto Detect"
        }
    }

    var displayTemperatureF: Double? {
        tempest?.temperatureF ?? temperatureF
    }

    var displayFeelsLikeF: Double? {
        tempest?.feelsLikeF ?? apparentTemperatureF
    }

    var displayHumidityPct: Double? {
        tempest?.humidityPct ?? humidity
    }

    var displayWindMph: Double? {
        tempest?.windAvgMph ?? windSpeedMph
    }

    private static func optionalNumber(_ value: Any?) -> Double? {
        if let number = value as? Double {
            return number
        }
        if let number = value as? NSNumber {
            return number.doubleValue
        }
        if let string = value as? String, let parsed = Double(string) {
            return parsed
        }
        return nil
    }
}

private final class DashboardLocationManager: NSObject, ObservableObject, CLLocationManagerDelegate {
    @Published private(set) var coordinate: CLLocationCoordinate2D?
    @Published private(set) var errorMessage: String?
    @Published private(set) var isRequesting = false

    private let manager = CLLocationManager()

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyKilometer
    }

    func requestLocation() {
        guard CLLocationManager.locationServicesEnabled() else {
            errorMessage = "Location services are disabled on this iPad."
            return
        }

        errorMessage = nil
        isRequesting = true

        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            manager.requestLocation()
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .denied, .restricted:
            isRequesting = false
            errorMessage = "Allow location access in Settings to use auto-detected weather."
        @unknown default:
            isRequesting = false
            errorMessage = "Location permission is unavailable."
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            manager.requestLocation()
        case .denied, .restricted:
            isRequesting = false
            errorMessage = "Allow location access in Settings to use auto-detected weather."
        case .notDetermined:
            break
        @unknown default:
            isRequesting = false
            errorMessage = "Location permission is unavailable."
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        coordinate = locations.last?.coordinate
        errorMessage = nil
        isRequesting = false
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        isRequesting = false
        errorMessage = error.localizedDescription
    }
}

struct DashboardView: View {
    let previewMode: Bool

    private enum DashboardNameAction {
        case create
        case rename(String)
    }

    private struct DashboardWidgetRow: Identifiable {
        let id: String
        let items: [DashboardWidgetRowItem]
    }

    private struct DashboardWidgetRowItem: Identifiable {
        let widget: DashboardWidgetItem
        let index: Int
        let span: Int

        var id: String { widget.id }
    }

    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var dashboardChrome: DashboardChromeState
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
    @State private var dashboardViews: [DashboardViewItem] = [DashboardSupport.defaultView()]
    @State private var selectedDashboardViewID = ""
    @State private var dashboardDirty = false
    @State private var isEditingDashboard = false
    @State private var isSavingDashboard = false
    @State private var showingAddWidgetSheet = false
    @State private var pendingWidgetType: DashboardWidgetType = .hero
    @State private var pendingWidgetTitle = DashboardWidgetType.hero.title
    @State private var pendingWidgetSize: DashboardWidgetSize = .full
    @State private var pendingWidgetDeviceID = ""
    @State private var pendingWidgetDeviceSearch = ""
    @State private var pendingWeatherLocationMode: DashboardWeatherLocationMode = .saved
    @State private var pendingWeatherLocationQuery = ""
    @State private var dashboardNameAction: DashboardNameAction?
    @State private var pendingDashboardName = ""
    @State private var infoMessage: String?
    @State private var pendingFavoriteDeviceIds: Set<String> = []
    @State private var thermostatTemperatureDrafts: [String: Double] = [:]
    @State private var pendingControlDeviceIds: Set<String> = []
    @State private var weatherByWidgetID: [String: DashboardWeatherSnapshot] = [:]
    @State private var weatherErrorsByWidgetID: [String: String] = [:]
    @State private var weatherRequestKeyByWidgetID: [String: String] = [:]
    @State private var weatherLoadingWidgetIDs: Set<String> = []

    @State private var commandText = ""
    @State private var commandResponse = ""
    @State private var isSendingCommand = false
    @State private var contentWidth: CGFloat = 0

    @StateObject private var locationManager = DashboardLocationManager()

    private var isCompact: Bool { horizontalSizeClass == .compact }
    private var isCompactHeight: Bool { verticalSizeClass == .compact }
    private var useLandscapeCompactLayout: Bool { isCompact && isCompactHeight }
    private var usesPortraitCompactLayout: Bool { isCompact && !isCompactHeight }
    private var dashboardOuterPadding: CGFloat {
        if usesPortraitCompactLayout {
            return 10
        }
        return useLandscapeCompactLayout ? 8 : 12
    }
    private var layoutWidth: CGFloat {
        max(contentWidth - (dashboardOuterPadding * 2), 0)
    }
    private var usesHeroSplitLayout: Bool { !usesPortraitCompactLayout && (useLandscapeCompactLayout || layoutWidth >= 860) }
    private var supportsTwoColumnCards: Bool { !usesPortraitCompactLayout && (useLandscapeCompactLayout || layoutWidth >= 820) }
    private var usesCompactWidgetToolbar: Bool { usesPortraitCompactLayout || layoutWidth < 440 }
    private var currentDashboardView: DashboardViewItem? {
        dashboardViews.first(where: { $0.id == selectedDashboardViewID }) ?? dashboardViews.first
    }
    private var currentDashboardWidgets: [DashboardWidgetItem] {
        currentDashboardView?.widgets ?? []
    }
    private var sortedDevices: [DeviceItem] {
        devices.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    private var filteredPendingDevices: [DeviceItem] {
        let query = pendingWidgetDeviceSearch.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let matches: [DeviceItem]

        if query.isEmpty {
            matches = sortedDevices
        } else {
            matches = sortedDevices.filter { device in
                let haystack = "\(device.name) \(device.room) \(device.type)".lowercased()
                return haystack.contains(query)
            }
        }

        if pendingWidgetDeviceID.isEmpty || matches.contains(where: { $0.id == pendingWidgetDeviceID }) {
            return matches
        }

        if let selected = sortedDevices.first(where: { $0.id == pendingWidgetDeviceID }) {
            return [selected] + matches
        }

        return matches
    }

    private var onlineDevices: Int {
        devices.filter { $0.status }.count
    }

    private var onlineVoiceDevices: Int {
        voiceDevices.filter { $0.status == "online" }.count
    }

    private var dashboardGridColumnCount: Int {
        if usesPortraitCompactLayout {
            return 1
        }
        if useLandscapeCompactLayout || contentWidth >= 1160 {
            return 4
        }
        if layoutWidth >= 760 {
            return 2
        }
        return 1
    }

    private var metricColumns: [GridItem] {
        if useLandscapeCompactLayout {
            return Array(repeating: GridItem(.flexible(), spacing: 10), count: 4)
        }
        if layoutWidth >= 1060 {
            return Array(repeating: GridItem(.flexible(), spacing: 12), count: 4)
        }
        if layoutWidth >= 620 {
            return [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]
        }
        return [GridItem(.flexible(), spacing: 12)]
    }

    private var featuredHalfColumns: [GridItem] {
        if layoutWidth >= 720 {
            return [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]
        }
        return [GridItem(.flexible(), spacing: 12)]
    }

    private var commandSuggestionColumns: [GridItem] {
        if layoutWidth >= 720 {
            return [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]
        }
        return [GridItem(.flexible(), spacing: 8)]
    }

    private var dashboardWidgetRows: [DashboardWidgetRow] {
        let columnCount = dashboardGridColumnCount
        guard columnCount > 1 else {
            return currentDashboardWidgets.enumerated().map { entry in
                DashboardWidgetRow(
                    id: "row-\(entry.offset)-\(entry.element.id)",
                    items: [DashboardWidgetRowItem(widget: entry.element, index: entry.offset, span: 1)]
                )
            }
        }

        var rows: [DashboardWidgetRow] = []
        var currentRow: [DashboardWidgetRowItem] = []
        var usedColumns = 0

        for (index, widget) in currentDashboardWidgets.enumerated() {
            let span = columnSpan(for: widget.size, columnCount: columnCount)

            if usedColumns + span > columnCount, !currentRow.isEmpty {
                rows.append(
                    DashboardWidgetRow(
                        id: "row-\(rows.count)-\(currentRow.first?.widget.id ?? UUID().uuidString)",
                        items: currentRow
                    )
                )
                currentRow = []
                usedColumns = 0
            }

            currentRow.append(DashboardWidgetRowItem(widget: widget, index: index, span: span))
            usedColumns += span

            if usedColumns >= columnCount {
                rows.append(
                    DashboardWidgetRow(
                        id: "row-\(rows.count)-\(currentRow.first?.widget.id ?? UUID().uuidString)",
                        items: currentRow
                    )
                )
                currentRow = []
                usedColumns = 0
            }
        }

        if !currentRow.isEmpty {
            rows.append(
                DashboardWidgetRow(
                    id: "row-\(rows.count)-\(currentRow.first?.widget.id ?? UUID().uuidString)",
                    items: currentRow
                )
            )
        }

        return rows
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

    private var addableWidgetTypes: [DashboardWidgetType] {
        [.hero, .summary, .security, .favoriteScenes, .weather, .voiceCommand, .device]
    }

    private var dashboardChromeSyncToken: String {
        let viewToken = dashboardViews
            .map { "\($0.id):\($0.name):\($0.widgets.count)" }
            .joined(separator: "|")

        return [
            favoritesProfileId ?? "none",
            selectedDashboardViewID,
            currentDashboardView?.name ?? "Dashboard",
            String(currentDashboardWidgets.count),
            String(dashboardDirty),
            String(isEditingDashboard),
            String(isSavingDashboard),
            viewToken
        ].joined(separator: "||")
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
                        .padding(dashboardOuterPadding)
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: useLandscapeCompactLayout ? 10 : 14) {
                            if let errorMessage {
                                InlineErrorView(message: errorMessage) {
                                    Task { await loadDashboard() }
                                }
                            }

                            if let infoMessage, !infoMessage.isEmpty {
                                HBBadge(
                                    text: infoMessage,
                                    foreground: HBPalette.textPrimary,
                                    background: HBPalette.panelSoft.opacity(0.96),
                                    stroke: HBPalette.panelStrokeStrong
                                )
                            }

                            if currentDashboardWidgets.isEmpty {
                                EmptyStateView(
                                    title: "No widgets in this view",
                                    subtitle: "Enter layout editing mode and add the controls you want for this screen."
                                )
                            } else {
                                Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 12) {
                                    ForEach(dashboardWidgetRows) { row in
                                        GridRow(alignment: .top) {
                                            ForEach(row.items) { item in
                                                dashboardWidgetPanel(item.widget, index: item.index)
                                                    .gridCellColumns(item.span)
                                            }
                                        }
                                    }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                        .padding(dashboardOuterPadding)
                        .padding(.bottom, 8)
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
        .sheet(isPresented: $showingAddWidgetSheet) {
            dashboardAddWidgetSheet
        }
        .alert(dashboardNameAlertTitle, isPresented: dashboardNameAlertBinding(), actions: {
            TextField("Dashboard name", text: $pendingDashboardName)
            Button("Cancel", role: .cancel) {
                dashboardNameAction = nil
            }
            Button("Save") {
                submitDashboardNameAction()
            }
            .disabled(pendingDashboardName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }, message: {
            Text(dashboardNameAlertMessage)
        })
        .onAppear {
            syncDashboardChrome()
        }
        .onChange(of: dashboardChromeSyncToken) { _, _ in
            syncDashboardChrome()
        }
        .onChange(of: dashboardChrome.commandToken) { _, _ in
            handleDashboardChromeCommand()
        }
        .onDisappear {
            dashboardChrome.reset()
        }
    }

    private func dashboardWidgetPanel(_ widget: DashboardWidgetItem, index: Int) -> some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 12) {
                if usesCompactWidgetToolbar {
                    VStack(alignment: .leading, spacing: 10) {
                        Label(widget.title, systemImage: widgetSystemImage(widget.type))
                            .font(.system(size: 17, weight: .bold, design: .rounded))
                            .foregroundStyle(HBPalette.textPrimary)
                            .fixedSize(horizontal: false, vertical: true)

                        HStack(spacing: 8) {
                            HBBadge(
                                text: widget.size.title,
                                foreground: HBPalette.textPrimary,
                                background: HBPalette.panelSoft.opacity(0.92),
                                stroke: HBPalette.panelStrokeStrong
                            )

                            Spacer(minLength: 8)

                            if isEditingDashboard {
                                compactWidgetToolbarMenu(widget: widget, index: index)
                            }
                        }
                    }
                } else {
                    HStack(alignment: .top, spacing: 12) {
                        Label(widget.title, systemImage: widgetSystemImage(widget.type))
                            .font(.system(size: 18, weight: .bold, design: .rounded))
                            .foregroundStyle(HBPalette.textPrimary)

                        Spacer(minLength: 8)

                        if isEditingDashboard {
                            HStack(spacing: 8) {
                                widgetSizeMenu(widget)

                                widgetToolbarButton(
                                    systemImage: widget.minimized ? "arrow.down.left.and.arrow.up.right" : "arrow.up.left.and.arrow.down.right"
                                ) {
                                    updateWidget(widget.id) { current in
                                        current.minimized.toggle()
                                    }
                                }

                                widgetToolbarButton(systemImage: "arrow.up", isDisabled: index == 0) {
                                    moveWidget(widget.id, offset: -1)
                                }

                                widgetToolbarButton(systemImage: "arrow.down", isDisabled: index == currentDashboardWidgets.count - 1) {
                                    moveWidget(widget.id, offset: 1)
                                }

                                widgetToolbarButton(systemImage: "trash", tint: HBPalette.accentRed) {
                                    removeWidget(widget.id)
                                }
                            }
                        } else {
                            HBBadge(
                                text: widget.size.title,
                                foreground: HBPalette.textPrimary,
                                background: HBPalette.panelSoft.opacity(0.92),
                                stroke: HBPalette.panelStrokeStrong
                            )
                        }
                    }
                }

                if widget.minimized {
                    Text("This widget is minimized. Turn on layout editing to expand it again.")
                        .font(.system(size: 14, weight: .medium, design: .rounded))
                        .foregroundStyle(HBPalette.textSecondary)
                        .padding(.vertical, 10)
                } else {
                    dashboardWidgetContent(widget)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .frame(minHeight: minimumHeight(for: widget.size), alignment: .topLeading)
                }
            }
        }
    }

    private func widgetSizeMenu(_ widget: DashboardWidgetItem) -> some View {
        Menu {
            ForEach(DashboardWidgetSize.allCases) { size in
                Button {
                    updateWidget(widget.id) { current in
                        current.size = size
                    }
                } label: {
                    if widget.size == size {
                        Label(size.title, systemImage: "checkmark")
                    } else {
                        Text(size.title)
                    }
                }
            }
        } label: {
            HBBadge(
                text: widget.size.title,
                foreground: HBPalette.textPrimary,
                background: HBPalette.panelSoft.opacity(0.92),
                stroke: HBPalette.panelStrokeStrong
            )
        }
        .buttonStyle(.plain)
    }

    private func widgetToolbarButton(
        systemImage: String,
        isDisabled: Bool = false,
        tint: Color = HBPalette.textPrimary,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(isDisabled ? HBPalette.textMuted : tint)
                .frame(width: 30, height: 30)
        }
        .buttonStyle(.plain)
        .background(HBGlassBackground(cornerRadius: 12, variant: .panelSoft))
        .disabled(isDisabled)
    }

    private func compactWidgetToolbarMenu(widget: DashboardWidgetItem, index: Int) -> some View {
        Menu {
            Section("Widget Size") {
                ForEach(DashboardWidgetSize.allCases) { size in
                    Button {
                        updateWidget(widget.id) { current in
                            current.size = size
                        }
                    } label: {
                        if widget.size == size {
                            Label(size.title, systemImage: "checkmark")
                        } else {
                            Text(size.title)
                        }
                    }
                }
            }

            Button(widget.minimized ? "Expand Widget" : "Minimize Widget") {
                updateWidget(widget.id) { current in
                    current.minimized.toggle()
                }
            }

            Button("Move Up") {
                moveWidget(widget.id, offset: -1)
            }
            .disabled(index == 0)

            Button("Move Down") {
                moveWidget(widget.id, offset: 1)
            }
            .disabled(index == currentDashboardWidgets.count - 1)

            Button("Remove Widget", role: .destructive) {
                removeWidget(widget.id)
            }
        } label: {
            Image(systemName: "ellipsis.circle")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(HBPalette.textPrimary)
                .frame(width: 34, height: 34)
                .background(HBGlassBackground(cornerRadius: 12, variant: .panelSoft))
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func dashboardWidgetContent(_ widget: DashboardWidgetItem) -> some View {
        switch widget.type {
        case .hero:
            dashboardHeader(for: widget)
        case .summary:
            LazyVGrid(columns: summaryColumns(for: widget.size), spacing: 12) {
                metricCard(
                    title: "Live Devices",
                    value: "\(onlineDevices)/\(devices.count)",
                    subtitle: "Realtime endpoints responding",
                    icon: "lightbulb.max",
                    colors: [HBPalette.accentBlue.opacity(0.24), HBPalette.accentPurple.opacity(0.14)],
                    accent: HBPalette.accentBlue,
                    compact: widget.size == .small
                )
                metricCard(
                    title: "Voice Mesh",
                    value: "\(onlineVoiceDevices)/\(voiceDevices.count)",
                    subtitle: "Wake hubs currently connected",
                    icon: "mic",
                    colors: [HBPalette.accentGreen.opacity(0.22), HBPalette.accentBlue.opacity(0.12)],
                    accent: HBPalette.accentGreen,
                    compact: widget.size == .small
                )
                metricCard(
                    title: "Scene Library",
                    value: "\(scenes.count)",
                    subtitle: "Pinned atmospheres available",
                    icon: "play.fill",
                    colors: [HBPalette.accentPurple.opacity(0.24), HBPalette.panelSoft.opacity(0.18)],
                    accent: HBPalette.accentPurple,
                    compact: widget.size == .small
                )
                metricCard(
                    title: "Automation Signal",
                    value: systemStatus,
                    subtitle: "Residence mesh health",
                    icon: "waveform.path.ecg",
                    colors: [HBPalette.accentOrange.opacity(0.22), HBPalette.panelSoft.opacity(0.16)],
                    accent: HBPalette.accentOrange,
                    compact: widget.size == .small
                )
            }
        case .security:
            securityPanel(for: widget)
        case .favoriteScenes:
            quickScenePanel(for: widget)
        case .favoriteDevices:
            favoriteDevicesWidget(for: widget)
        case .weather:
            weatherWidget(for: widget)
        case .voiceCommand:
            voiceCommandPanel
        case .device:
            singleDeviceWidget(for: widget)
        }
    }

    private var dashboardAddWidgetSheet: some View {
        NavigationStack {
            Form {
                Section("Widget Type") {
                    Picker("Type", selection: $pendingWidgetType) {
                        ForEach(addableWidgetTypes) { type in
                            Text(type.title).tag(type)
                        }
                    }
                    .pickerStyle(.navigationLink)

                    Text(pendingWidgetType.details)
                        .font(.system(size: 13, weight: .medium, design: .rounded))
                        .foregroundStyle(HBPalette.textSecondary)
                }

                Section("Widget Details") {
                    TextField("Title", text: $pendingWidgetTitle)

                    Picker("Size", selection: $pendingWidgetSize) {
                        ForEach(DashboardWidgetSize.allCases) { size in
                            Text(size.title).tag(size)
                        }
                    }
                }

                if pendingWidgetType == .device {
                    Section("Device") {
                        TextField("Search devices", text: $pendingWidgetDeviceSearch)
                            .textInputAutocapitalization(.never)
                            .disableAutocorrection(true)

                        Picker("Device", selection: $pendingWidgetDeviceID) {
                            Text("Select a device").tag("")
                            ForEach(filteredPendingDevices) { device in
                                Text("\(device.name) · \(device.room)").tag(device.id)
                            }
                        }

                        if filteredPendingDevices.isEmpty {
                            Text("No devices match your search.")
                                .font(.system(size: 13, weight: .medium, design: .rounded))
                                .foregroundStyle(HBPalette.textSecondary)
                        }
                    }
                }

                if pendingWidgetType == .weather {
                    Section("Weather Location") {
                        Picker("Source", selection: $pendingWeatherLocationMode) {
                            ForEach(DashboardWeatherLocationMode.allCases) { mode in
                                Text(mode.title).tag(mode)
                            }
                        }

                        if pendingWeatherLocationMode == .custom {
                            TextField("Address", text: $pendingWeatherLocationQuery)
                                .textInputAutocapitalization(.words)
                                .disableAutocorrection(true)
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(HBPageBackground().ignoresSafeArea())
            .navigationTitle("Add Widget")
            .onChange(of: pendingWidgetType) { _, newValue in
                pendingWidgetTitle = newValue.title
                pendingWidgetSize = defaultWidgetSize(for: newValue)
                if newValue != .device {
                    pendingWidgetDeviceID = ""
                    pendingWidgetDeviceSearch = ""
                }
                if newValue != .weather {
                    pendingWeatherLocationMode = .saved
                    pendingWeatherLocationQuery = ""
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        showingAddWidgetSheet = false
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        addWidgetToCurrentDashboard()
                    }
                    .disabled(
                        (pendingWidgetType == .device && pendingWidgetDeviceID.isEmpty)
                        || (pendingWidgetType == .weather && pendingWeatherLocationMode == .custom && pendingWeatherLocationQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    )
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func widgetSystemImage(_ type: DashboardWidgetType) -> String {
        switch type {
        case .hero: return "house"
        case .summary: return "square.grid.2x2"
        case .security: return "shield"
        case .favoriteScenes: return "play.fill"
        case .favoriteDevices: return "heart.fill"
        case .weather: return "cloud.sun.fill"
        case .voiceCommand: return "waveform"
        case .device: return "lightbulb.max"
        }
    }

    private func defaultWidgetSize(for type: DashboardWidgetType) -> DashboardWidgetSize {
        switch type {
        case .hero, .summary:
            return .full
        case .device:
            return .small
        case .weather:
            return .medium
        default:
            return .medium
        }
    }

    private func columnSpan(for size: DashboardWidgetSize, columnCount: Int) -> Int {
        switch columnCount {
        case 4:
            switch size {
            case .small: return 1
            case .medium: return 2
            case .large: return 3
            case .full: return 4
            }
        case 3:
            switch size {
            case .small: return 1
            case .medium: return 2
            case .large, .full: return 3
            }
        case 2:
            switch size {
            case .small, .medium: return 1
            case .large, .full: return 2
            }
        default:
            return 1
        }
    }

    private func summaryColumns(for size: DashboardWidgetSize) -> [GridItem] {
        switch size {
        case .small:
            return [GridItem(.flexible(), spacing: 10)]
        case .medium:
            return [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)]
        case .large:
            return Array(repeating: GridItem(.flexible(), spacing: 10), count: min(3, dashboardGridColumnCount))
        case .full:
            return Array(repeating: GridItem(.flexible(), spacing: 10), count: min(4, max(2, dashboardGridColumnCount)))
        }
    }

    private func favoriteDeviceColumns(for widget: DashboardWidgetItem) -> [GridItem] {
        let count: Int
        switch widget.size {
        case .small:
            count = 1
        case .medium:
            count = min(2, max(1, dashboardGridColumnCount))
        case .large:
            count = min(3, max(1, dashboardGridColumnCount))
        case .full:
            count = min(4, max(1, dashboardGridColumnCount))
        }

        return Array(repeating: GridItem(.flexible(), spacing: 10), count: max(1, count))
    }

    private func favoriteDeviceCardSize(for widget: DashboardWidgetItem, device: DeviceItem) -> DashboardFavoriteDeviceCardSize {
        if let size = widget.settings.favoriteDeviceSizes[device.id] {
            return size
        }

        return device.type == "thermostat" ? .medium : .small
    }

    private func setFavoriteDeviceCardSize(widgetID: String, deviceID: String, size: DashboardFavoriteDeviceCardSize) {
        updateWidget(widgetID) { current in
            current.settings.favoriteDeviceSizes[deviceID] = size
        }
    }

    private func deviceCardSize(for widgetSize: DashboardWidgetSize) -> DashboardFavoriteDeviceCardSize {
        switch widgetSize {
        case .small:
            return .small
        case .medium:
            return .medium
        case .large, .full:
            return .large
        }
    }

    private func weatherTaskKey(for widget: DashboardWidgetItem) -> String {
        let mode = widget.settings.weatherLocationMode
        switch mode {
        case .saved:
            return "saved"
        case .custom:
            return "custom:\(widget.settings.weatherLocationQuery?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "")"
        case .auto:
            if let coordinate = locationManager.coordinate {
                return String(format: "auto:%.4f:%.4f", coordinate.latitude, coordinate.longitude)
            }
            if let error = locationManager.errorMessage, !error.isEmpty {
                return "auto:error:\(error)"
            }
            return "auto:pending"
        }
    }

    private func refreshWeather(for widget: DashboardWidgetItem) async {
        weatherRequestKeyByWidgetID.removeValue(forKey: widget.id)
        await loadWeather(for: widget, force: true)
    }

    private func loadWeather(for widget: DashboardWidgetItem, force: Bool = false) async {
        let taskKey = weatherTaskKey(for: widget)

        if !force,
           weatherRequestKeyByWidgetID[widget.id] == taskKey,
           weatherByWidgetID[widget.id] != nil {
            return
        }

        if previewMode {
            weatherByWidgetID[widget.id] = DashboardWeatherSnapshot.preview(
                mode: widget.settings.weatherLocationMode,
                query: widget.settings.weatherLocationQuery
            )
            weatherErrorsByWidgetID[widget.id] = nil
            weatherRequestKeyByWidgetID[widget.id] = taskKey
            return
        }

        if widget.settings.weatherLocationMode == .auto && locationManager.coordinate == nil {
            if locationManager.errorMessage == nil && !locationManager.isRequesting {
                locationManager.requestLocation()
            }
            return
        }

        if weatherLoadingWidgetIDs.contains(widget.id) {
            return
        }

        weatherLoadingWidgetIDs.insert(widget.id)
        defer { weatherLoadingWidgetIDs.remove(widget.id) }

        do {
            var query: [URLQueryItem] = []

            switch widget.settings.weatherLocationMode {
            case .saved:
                break
            case .custom:
                let trimmedQuery = widget.settings.weatherLocationQuery?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if !trimmedQuery.isEmpty {
                    query.append(URLQueryItem(name: "address", value: trimmedQuery))
                }
            case .auto:
                guard let coordinate = locationManager.coordinate else {
                    return
                }

                query.append(URLQueryItem(name: "latitude", value: String(coordinate.latitude)))
                query.append(URLQueryItem(name: "longitude", value: String(coordinate.longitude)))
                query.append(URLQueryItem(name: "label", value: "Current location"))
            }

            let response = try await session.apiClient.get("/api/weather/current", query: query)
            let root = JSON.object(response)
            let weatherPayload = root["weather"] ?? JSON.object(root["data"])["weather"]

            guard let snapshot = DashboardWeatherSnapshot.from(weatherPayload) else {
                throw APIError.parsingFailed
            }

            weatherByWidgetID[widget.id] = snapshot
            weatherErrorsByWidgetID[widget.id] = nil
            weatherRequestKeyByWidgetID[widget.id] = taskKey
        } catch {
            weatherErrorsByWidgetID[widget.id] = error.localizedDescription
        }
    }

    private func minimumHeight(for size: DashboardWidgetSize) -> CGFloat? {
        switch size {
        case .small: return 120
        case .medium: return 180
        case .large: return 240
        case .full: return nil
        }
    }

    @ViewBuilder
    private func dashboardHeader(for widget: DashboardWidgetItem) -> some View {
        let compactHero = widget.size == .small || widget.size == .medium || usesPortraitCompactLayout

        Group {
            if compactHero {
                VStack(alignment: .leading, spacing: 12) {
                    dashboardHeroCopy(compact: true)

                    if widget.size != .small {
                        dashboardHeroCommandSurface(compact: true)
                    }
                }
            } else if usesHeroSplitLayout {
                HStack(alignment: .top, spacing: 16) {
                    dashboardHeroCopy(compact: false)
                    dashboardHeroCommandSurface(compact: false)
                        .frame(maxWidth: 320, alignment: .trailing)
                }
            } else {
                VStack(alignment: .leading, spacing: 14) {
                    dashboardHeroCopy(compact: false)
                    dashboardHeroCommandSurface(compact: false)
                }
            }
        }
    }

    private func dashboardHeroCopy(compact: Bool) -> some View {
        VStack(alignment: .leading, spacing: compact ? 10 : 14) {
            Text("Residence Control Nexus")
                .font(.system(size: 11, weight: .bold, design: .rounded))
                .textCase(.uppercase)
                .tracking(3.0)
                .foregroundStyle(HBPalette.textMuted)

            Text("Welcome home. Every room, routine, and wake-word path is online.")
                .font(
                    .system(
                        size: compact ? 26 : (useLandscapeCompactLayout ? 28 : (layoutWidth < 520 ? 30 : (layoutWidth < 760 ? 34 : (layoutWidth < 960 ? 38 : 42)))),
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
                .fixedSize(horizontal: false, vertical: true)

            Text(compact
                ? "Keep the controls you use, shrink the rest, and tune this deck per room."
                : "Control the home as one responsive system with cinematic visibility across devices, scenes, voice hubs, and workflows."
            )
                .font(.system(size: compact ? 14 : (useLandscapeCompactLayout ? 14 : 17), weight: .medium, design: .rounded))
                .foregroundStyle(HBPalette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

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

    private func dashboardHeroCommandSurface(compact: Bool) -> some View {
        VStack(alignment: .leading, spacing: compact ? 10 : 12) {
            Text("Natural Language Interface")
                .font(.system(size: 11, weight: .bold, design: .rounded))
                .textCase(.uppercase)
                .tracking(2.6)
                .foregroundStyle(HBPalette.textMuted)

            Text(compact ? "Voice console" : "Speak the next move")
                .font(.system(size: compact ? 20 : (useLandscapeCompactLayout ? 22 : (contentWidth < 760 ? 24 : 28)), weight: .bold, design: .rounded))
                .foregroundStyle(HBPalette.textPrimary)

            Text(compact
                ? "Launch scenes, lights, and routines from a tighter command dock."
                : "Trigger a scene, dim a room, or compose a workflow from a single command surface."
            )
                .font(.system(size: compact ? 14 : 15, weight: .medium, design: .rounded))
                .foregroundStyle(HBPalette.textSecondary)

            LazyVGrid(columns: compact ? [GridItem(.flexible(), spacing: 8)] : commandSuggestionColumns, spacing: 8) {
                ForEach(Array(commandSuggestions.prefix(compact ? 2 : commandSuggestions.count)), id: \.self) { suggestion in
                    Text(suggestion)
                        .font(.system(size: compact ? 12 : 13, weight: .medium, design: .rounded))
                        .foregroundStyle(HBPalette.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 12)
                        .padding(.vertical, compact ? 8 : 10)
                        .background(HBGlassBackground(cornerRadius: 16, variant: .panelSoft))
                }
            }

            Button {
                selectionHaptic()
            } label: {
                Label("Open Voice Console", systemImage: "waveform")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(HBPrimaryButtonStyle(compact: compact))
        }
        .padding(compact ? 14 : 16)
        .background(HBGlassBackground(cornerRadius: 20, variant: .panelSoft))
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(HBPalette.panelStroke.opacity(0.45), lineWidth: 1)
        )
    }

    private func metricCard(
        title: String,
        value: String,
        subtitle: String,
        icon: String,
        colors: [Color],
        accent: Color,
        compact: Bool
    ) -> some View {
        VStack(alignment: .leading, spacing: compact ? 6 : 8) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(title)
                        .font(.system(size: 11, weight: .bold, design: .rounded))
                        .textCase(.uppercase)
                        .tracking(2.2)
                        .foregroundStyle(HBPalette.textMuted)

                    Text(value)
                        .font(.system(size: compact ? 28 : (useLandscapeCompactLayout ? 28 : 34), weight: .bold, design: .rounded))
                        .foregroundStyle(HBPalette.textPrimary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.65)
                }

                Spacer(minLength: 10)

                Image(systemName: icon)
                    .font(.system(size: compact ? 14 : 16, weight: .bold))
                    .foregroundStyle(accent)
                    .frame(width: compact ? 34 : 38, height: compact ? 34 : 38)
                    .background(HBGlassBackground(cornerRadius: compact ? 12 : 14, variant: .panelSoft))
            }

            Text(subtitle)
                .font(.system(size: compact ? 13 : (useLandscapeCompactLayout ? 13 : 15), weight: .medium, design: .rounded))
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
        .padding(compact ? 14 : 18)
        .background {
            ZStack {
                HBGlassBackground(cornerRadius: compact ? 18 : 22, variant: .panelSoft)
                RoundedRectangle(cornerRadius: compact ? 18 : 22, style: .continuous)
                    .fill(LinearGradient(colors: colors, startPoint: .topLeading, endPoint: .bottomTrailing))
                    .opacity(0.92)
            }
        }
        .overlay(
            RoundedRectangle(cornerRadius: compact ? 18 : 22, style: .continuous)
                .stroke(accent.opacity(0.32), lineWidth: 1)
        )
    }

    private func securityPanel(for widget: DashboardWidgetItem) -> some View {
        let compact = widget.size == .small
        let usesStackedActions = compact || usesPortraitCompactLayout || layoutWidth < 540
        let summaryColumns: [GridItem]

        switch widget.size {
        case .small:
            summaryColumns = [GridItem(.flexible(), spacing: 10)]
        case .medium:
            summaryColumns = [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)]
        case .large, .full:
            summaryColumns = Array(repeating: GridItem(.flexible(), spacing: 10), count: min(3, max(2, dashboardGridColumnCount)))
        }

        return VStack(alignment: .leading, spacing: compact ? 10 : 12) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Security Envelope")
                        .font(.system(size: 11, weight: .bold, design: .rounded))
                        .textCase(.uppercase)
                        .tracking(2.6)
                        .foregroundStyle(HBPalette.textMuted)

                    Label("Security Alarm", systemImage: "shield")
                        .font(.system(size: compact ? 18 : 22, weight: .bold, design: .rounded))
                        .foregroundStyle(HBPalette.textPrimary)
                }

                Spacer()

                HBBadge(
                    text: securityStatusLabel,
                    foreground: securityBadgeForeground,
                    background: securityBadgeBackground,
                    stroke: securityBadgeStroke
                )
            }

            LazyVGrid(columns: summaryColumns, spacing: 10) {
                securitySummaryTile(
                    title: "Zones",
                    value: "\(securityZonesActive)/\(securityZonesTotal)",
                    detail: "Active perimeter points",
                    accent: HBPalette.accentBlue,
                    compact: compact
                )
                securitySummaryTile(
                    title: "Link State",
                    value: systemStatus,
                    detail: systemStatus.lowercased() == "online" ? "Security services responding" : "Security services degraded",
                    accent: systemStatus.lowercased() == "online" ? HBPalette.accentGreen : HBPalette.accentOrange,
                    compact: compact
                )
                securitySummaryTile(
                    title: "Alarm State",
                    value: securityStatusLabel,
                    detail: securityStatusDetail,
                    accent: securityStatusAccent,
                    compact: compact,
                    titleColor: securityStateTitleColor,
                    valueColor: securityStateValueColor,
                    detailColor: securityStateDetailColor,
                    backgroundVariant: securityStateBackgroundVariant,
                    backgroundTint: securityStateBackgroundTint,
                    backgroundTintOpacity: securityStateBackgroundOpacity
                )
            }

            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Zones:")
                        .foregroundStyle(HBPalette.textSecondary)
                    Spacer()
                    Text("\(securityZonesActive)/\(securityZonesTotal) active")
                        .foregroundStyle(HBPalette.textPrimary)
                        .fontWeight(.semibold)
                }

                HStack {
                    Text("Status:")
                        .foregroundStyle(HBPalette.textSecondary)
                    Spacer()
                    Text(systemStatus)
                        .foregroundStyle(systemStatusAccent)
                        .fontWeight(.semibold)
                }
            }
            .font(.system(size: compact ? 14 : 15, weight: .medium, design: .rounded))
            .padding(compact ? 12 : 14)
            .background(HBGlassBackground(cornerRadius: compact ? 16 : 18, variant: .panelSoft))

            if usesStackedActions {
                VStack(spacing: 8) {
                    securityPrimaryActions(compact: true, stacked: true)
                    securitySyncAction(compact: true)
                }
            } else {
                HStack(alignment: .center, spacing: 10) {
                    securityPrimaryActions(compact: false, stacked: false)
                    securitySyncAction(compact: true)
                        .frame(maxWidth: 220)
                }
            }
        }
    }

    private func securitySummaryTile(
        title: String,
        value: String,
        detail: String,
        accent: Color,
        compact: Bool,
        titleColor: Color = HBPalette.textMuted,
        valueColor: Color = HBPalette.textPrimary,
        detailColor: Color = HBPalette.textSecondary,
        backgroundVariant: HBGlassVariant = .panelSoft,
        backgroundTint: Color = .clear,
        backgroundTintOpacity: Double = 0
    ) -> some View {
        let shape = RoundedRectangle(cornerRadius: compact ? 16 : 18, style: .continuous)

        return VStack(alignment: .leading, spacing: compact ? 4 : 6) {
            Text(title)
                .font(.system(size: 11, weight: .bold, design: .rounded))
                .textCase(.uppercase)
                .tracking(2.0)
                .foregroundStyle(titleColor)

            Text(value)
                .font(.system(size: compact ? 24 : 28, weight: .bold, design: .rounded))
                .foregroundStyle(valueColor)
                .lineLimit(1)
                .minimumScaleFactor(0.7)

            Text(detail)
                .font(.system(size: compact ? 12 : 13, weight: .medium, design: .rounded))
                .foregroundStyle(detailColor)
                .lineLimit(2)

            Capsule()
                .fill(accent)
                .frame(width: compact ? 38 : 46, height: 4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(compact ? 12 : 14)
        .background(
            ZStack {
                HBGlassBackground(cornerRadius: compact ? 16 : 18, variant: backgroundVariant)
                shape
                    .fill(backgroundTint.opacity(backgroundTintOpacity))
            }
        )
        .overlay(
            shape
                .stroke(accent.opacity(backgroundTintOpacity > 0 ? 0.72 : 0.22), lineWidth: backgroundTintOpacity > 0 ? 1.4 : 1)
        )
    }

    private var securityAlarmStateKey: String {
        securityStatus
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: " ", with: "")
            .replacingOccurrences(of: "_", with: "")
            .replacingOccurrences(of: "-", with: "")
    }

    private var isSecurityStayArmed: Bool {
        securityAlarmStateKey == "armedstay" || securityAlarmStateKey == "armedhome"
    }

    private var isSecurityAwayArmed: Bool {
        securityAlarmStateKey == "armedaway"
    }

    private var isSecurityArmed: Bool {
        isSecurityStayArmed || isSecurityAwayArmed
    }

    private var isSecurityTriggered: Bool {
        securityAlarmStateKey == "triggered"
    }

    private var securityStatusLabel: String {
        switch securityAlarmStateKey {
        case "disarmed":
            return "Disarmed"
        case "armedstay", "armedhome":
            return "Armed Stay"
        case "armedaway":
            return "Armed Away"
        case "triggered":
            return "Triggered"
        case "arming":
            return "Arming"
        case "disarming":
            return "Disarming"
        default:
            let trimmed = securityStatus.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? "Unknown" : trimmed
        }
    }

    private var securityStatusDetail: String {
        switch securityAlarmStateKey {
        case "armedstay", "armedhome":
            return "Home perimeter mode is active"
        case "armedaway":
            return "Away mode is active"
        case "triggered":
            return "Immediate attention required"
        case "arming":
            return "System is arming"
        case "disarming":
            return "System is disarming"
        default:
            return "System currently disarmed"
        }
    }

    private var securityStatusAccent: Color {
        switch securityAlarmStateKey {
        case "armedstay", "armedhome":
            return HBPalette.accentYellow
        case "armedaway", "triggered":
            return HBPalette.accentRed
        default:
            return HBPalette.accentSlate
        }
    }

    private var securityBadgeForeground: Color {
        if isSecurityAwayArmed || isSecurityTriggered {
            return .white
        }
        if isSecurityStayArmed {
            return Color.black.opacity(0.82)
        }
        return HBPalette.textPrimary
    }

    private var securityBadgeBackground: Color {
        if isSecurityStayArmed {
            return HBPalette.accentYellow.opacity(0.96)
        }
        if isSecurityAwayArmed || isSecurityTriggered {
            return HBPalette.accentRed.opacity(0.96)
        }
        return HBPalette.panelSoft.opacity(0.95)
    }

    private var securityBadgeStroke: Color {
        if isSecurityArmed || isSecurityTriggered {
            return securityStatusAccent
        }
        return HBPalette.panelStrokeStrong
    }

    private var securityStateTitleColor: Color {
        if isSecurityAwayArmed || isSecurityTriggered {
            return Color.white.opacity(0.84)
        }
        if isSecurityStayArmed {
            return Color.black.opacity(0.72)
        }
        return HBPalette.textMuted
    }

    private var securityStateValueColor: Color {
        if isSecurityAwayArmed || isSecurityTriggered {
            return .white
        }
        if isSecurityStayArmed {
            return Color.black.opacity(0.86)
        }
        return HBPalette.textPrimary
    }

    private var securityStateDetailColor: Color {
        if isSecurityAwayArmed || isSecurityTriggered {
            return Color.white.opacity(0.92)
        }
        if isSecurityStayArmed {
            return Color.black.opacity(0.76)
        }
        return HBPalette.textSecondary
    }

    private var securityStateBackgroundVariant: HBGlassVariant {
        isSecurityArmed || isSecurityTriggered ? .panelStrong : .panelSoft
    }

    private var securityStateBackgroundTint: Color {
        if isSecurityStayArmed {
            return HBPalette.accentYellow
        }
        if isSecurityAwayArmed || isSecurityTriggered {
            return HBPalette.accentRed
        }
        return .clear
    }

    private var securityStateBackgroundOpacity: Double {
        if isSecurityStayArmed {
            return 0.5
        }
        if isSecurityAwayArmed {
            return 0.58
        }
        if isSecurityTriggered {
            return 0.62
        }
        return 0
    }

    private var systemStatusAccent: Color {
        systemStatus.lowercased() == "online" ? HBPalette.accentGreen : HBPalette.accentOrange
    }

    private func securityPrimaryActions(compact: Bool, stacked: Bool) -> some View {
        Group {
            if isSecurityTriggered {
                Button {
                    Task { await dismissSecurityAlarm() }
                } label: {
                    Label("Dismiss Alarm", systemImage: "exclamationmark.triangle")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(HBSecondaryButtonStyle(compact: compact))
            } else if isSecurityArmed {
                Button {
                    Task { await disarmSecurity() }
                } label: {
                    Label("Disarm", systemImage: "shield.slash")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(HBDestructiveButtonStyle(compact: compact))
            } else if stacked {
                VStack(spacing: 8) {
                    Button {
                        Task { await armSecurity(stay: true) }
                    } label: {
                        Label("Arm Stay", systemImage: "house")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(HBSecondaryButtonStyle(compact: compact))

                    Button {
                        Task { await armSecurity(stay: false) }
                    } label: {
                        Label("Arm Away", systemImage: "car")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(HBSecondaryButtonStyle(compact: compact))
                }
            } else {
                HStack(spacing: 10) {
                    Button {
                        Task { await armSecurity(stay: true) }
                    } label: {
                        Label("Arm Stay", systemImage: "house")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(HBSecondaryButtonStyle(compact: compact))

                    Button {
                        Task { await armSecurity(stay: false) }
                    } label: {
                        Label("Arm Away", systemImage: "car")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(HBSecondaryButtonStyle(compact: compact))
                }
            }
        }
    }

    private func securitySyncAction(compact: Bool) -> some View {
        Button("Sync with SmartThings") {
            Task { await syncSecurity() }
        }
        .buttonStyle(HBGhostButtonStyle(compact: compact))
        .frame(maxWidth: .infinity)
    }

    private func weatherWidget(for widget: DashboardWidgetItem) -> some View {
        let compact = widget.size == .small
        let condensed = widget.size == .small || widget.size == .medium
        let snapshot = weatherByWidgetID[widget.id]
        let error = weatherErrorsByWidgetID[widget.id]

        return VStack(alignment: .leading, spacing: condensed ? 12 : 14) {
            if let snapshot {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Local Forecast")
                            .font(.system(size: 11, weight: .bold, design: .rounded))
                            .textCase(.uppercase)
                            .tracking(2.6)
                            .foregroundStyle(HBPalette.textMuted)

                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Text(formattedTemperature(snapshot.displayTemperatureF))
                                .font(.system(size: compact ? 34 : 42, weight: .bold, design: .rounded))
                                .foregroundStyle(HBPalette.textPrimary)

                            if !compact {
                                Text("Feels like \(formattedTemperature(snapshot.displayFeelsLikeF))")
                                    .font(.system(size: 14, weight: .medium, design: .rounded))
                                    .foregroundStyle(HBPalette.textSecondary)
                            }
                        }

                        Text(snapshot.condition)
                            .font(.system(size: compact ? 15 : 17, weight: .semibold, design: .rounded))
                            .foregroundStyle(HBPalette.textPrimary)

                        Label(snapshot.locationName, systemImage: "mappin.and.ellipse")
                            .font(.system(size: 13, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textSecondary)
                            .lineLimit(condensed ? 1 : 2)
                    }

                    Spacer(minLength: 10)

                    VStack(alignment: .trailing, spacing: 10) {
                        HStack(alignment: .center, spacing: 10) {
                            if let tempest = snapshot.tempest {
                                weatherUVIndicator(value: formattedUV(tempest.uvIndex), compact: compact)
                            }

                            Image(systemName: weatherIconName(icon: snapshot.icon, isDay: snapshot.isDay))
                                .font(.system(size: compact ? 28 : 34, weight: .semibold))
                                .foregroundStyle(
                                    LinearGradient(
                                        colors: [HBPalette.accentBlue, HBPalette.accentPurple],
                                        startPoint: .topLeading,
                                        endPoint: .bottomTrailing
                                    )
                                )
                                .frame(width: compact ? 50 : 58, height: compact ? 50 : 58)
                                .background(HBGlassBackground(cornerRadius: compact ? 16 : 18, variant: .panelSoft))
                        }

                        HBBadge(
                            text: snapshot.sourceLabel,
                            foreground: HBPalette.textPrimary,
                            background: HBPalette.panelSoft.opacity(0.92),
                            stroke: HBPalette.panelStrokeStrong
                        )

                        if let tempest = snapshot.tempest {
                            HBBadge(
                                text: tempest.websocketConnected ? "Tempest Live" : "Tempest Snapshot",
                                foreground: HBPalette.textPrimary,
                                background: HBPalette.heroCore.opacity(0.22),
                                stroke: HBPalette.heroCore.opacity(0.42)
                            )
                        }
                    }
                }

                let metricColumns: [GridItem] = {
                    if widget.size == .small {
                        return [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)]
                    }
                    if widget.size == .medium {
                        return [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)]
                    }
                    return Array(repeating: GridItem(.flexible(), spacing: 10), count: 4)
                }()

                if let tempest = snapshot.tempest {
                    let tempestColumns: [GridItem] = condensed
                        ? [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)]
                        : Array(repeating: GridItem(.flexible(), spacing: 10), count: 4)

                    LazyVGrid(columns: tempestColumns, spacing: 10) {
                        weatherLiveMetricTile(
                            title: "Live Wind",
                            value: formattedWind(tempest.windAvgMph),
                            detail: "Gust \(formattedWind(tempest.windGustMph))",
                            accent: HBPalette.accentBlue,
                            iconSystemName: "wind",
                            iconColor: HBPalette.accentBlue,
                            backgroundTint: HBPalette.heroCore,
                            backgroundOpacity: 0.22
                        )

                        weatherLiveMetricTile(
                            title: "Rainfall",
                            value: formattedRain(tempest.rainTodayIn),
                            detail: "Rate \(formattedRain(tempest.rainRateInPerHr))/hr",
                            accent: HBPalette.panelStrokeStrong,
                            iconSystemName: "drop",
                            iconColor: HBPalette.accentBlue
                        )

                        if !compact {
                            weatherLiveMetricTile(
                                title: "Pressure",
                                value: formattedPressure(tempest.pressureInHg),
                                detail: formattedPressureTrend(tempest.pressureTrend),
                                accent: HBPalette.panelStrokeStrong,
                                iconSystemName: "gauge",
                                iconColor: HBPalette.accentGreen
                            )

                            weatherLiveMetricTile(
                                title: "Station",
                                value: tempest.name,
                                detail: tempest.websocketConnected ? "WebSocket live" : "Recent snapshot",
                                accent: HBPalette.panelStrokeStrong,
                                iconSystemName: "waveform.path.ecg",
                                iconColor: HBPalette.accentPurple
                            )
                        }
                    }
                }

                LazyVGrid(columns: metricColumns, spacing: 10) {
                    weatherMetricTile(title: "Today", value: "\(formattedTemperature(snapshot.highF)) / \(formattedTemperature(snapshot.lowF))", detail: snapshot.todayCondition, accent: HBPalette.accentBlue)
                    weatherMetricTile(title: "Humidity", value: formattedPercent(snapshot.humidity), detail: "Indoor comfort check", accent: HBPalette.accentGreen)
                    weatherSunCycleTile(sunrise: snapshot.sunrise, sunset: snapshot.sunset, accent: HBPalette.accentPurple)
                    weatherMetricTile(
                        title: "Rain Chance",
                        value: formattedPercent(snapshot.precipitationChance),
                        detail: snapshot.precipitationIn.map { String(format: "%.2f in now", $0) } ?? "No live precipitation feed",
                        accent: HBPalette.accentOrange
                    )
                }
            } else if locationManager.isRequesting && widget.settings.weatherLocationMode == .auto {
                EmptyStateView(
                    title: "Finding current location",
                    subtitle: "HomeBrain is requesting this iPad's location for the weather widget."
                )
            } else {
                EmptyStateView(
                    title: "Weather unavailable",
                    subtitle: error ?? (widget.settings.weatherLocationMode == .auto
                        ? locationManager.errorMessage ?? "Allow location access or choose a saved/custom address."
                        : "Configure a saved location or add a custom address.")
                )
            }

            HStack(spacing: 10) {
                Button {
                    Task { await refreshWeather(for: widget) }
                } label: {
                    Label(weatherLoadingWidgetIDs.contains(widget.id) ? "Refreshing..." : "Refresh", systemImage: "arrow.clockwise")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(HBSecondaryButtonStyle(compact: true))
                .disabled(weatherLoadingWidgetIDs.contains(widget.id))

                if widget.settings.weatherLocationMode == .auto {
                    Button {
                        locationManager.requestLocation()
                    } label: {
                        Label("Use Device Location", systemImage: "location")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(HBGhostButtonStyle(compact: true))
                }
            }

            if let error, !error.isEmpty, snapshot != nil {
                Text(error)
                    .font(.system(size: 12, weight: .medium, design: .rounded))
                    .foregroundStyle(HBPalette.accentOrange)
            }
        }
        .task(id: weatherTaskKey(for: widget)) {
            await loadWeather(for: widget)
        }
    }

    private func weatherMetricTile(title: String, value: String, detail: String, accent: Color) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.system(size: 11, weight: .bold, design: .rounded))
                .textCase(.uppercase)
                .tracking(2.0)
                .foregroundStyle(HBPalette.textMuted)

            Text(value)
                .font(.system(size: 20, weight: .bold, design: .rounded))
                .foregroundStyle(HBPalette.textPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.72)

            Text(detail)
                .font(.system(size: 12, weight: .medium, design: .rounded))
                .foregroundStyle(HBPalette.textSecondary)
                .lineLimit(2)

            Capsule()
                .fill(accent)
                .frame(width: 42, height: 4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(HBGlassBackground(cornerRadius: 16, variant: .panelSoft))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(accent.opacity(0.2), lineWidth: 1)
        )
    }

    private func weatherSunCycleTile(sunrise: String?, sunset: String?, accent: Color) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                Text("Sun Cycle")
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .textCase(.uppercase)
                    .tracking(2.0)
                    .foregroundStyle(HBPalette.textMuted)

                Spacer(minLength: 8)

                HStack(spacing: 8) {
                    Image(systemName: "sunrise")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(HBPalette.accentYellow)
                    Image(systemName: "sunset")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(HBPalette.accentOrange)
                }
            }

            weatherSunCycleRow(label: "Sunrise", value: formattedWeatherTime(sunrise))
            weatherSunCycleRow(label: "Sunset", value: formattedWeatherTime(sunset))

            Capsule()
                .fill(accent)
                .frame(width: 42, height: 4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(HBGlassBackground(cornerRadius: 16, variant: .panelSoft))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(accent.opacity(0.2), lineWidth: 1)
        )
    }

    private func weatherSunCycleRow(label: String, value: String) -> some View {
        HStack(spacing: 8) {
            Text(label)
                .font(.system(size: 12, weight: .medium, design: .rounded))
                .foregroundStyle(HBPalette.textSecondary)

            Spacer()

            Text(value)
                .font(.system(size: 15, weight: .semibold, design: .rounded))
                .foregroundStyle(HBPalette.textPrimary)
        }
    }

    private func weatherLiveMetricTile(
        title: String,
        value: String,
        detail: String,
        accent: Color,
        iconSystemName: String,
        iconColor: Color,
        backgroundTint: Color = .clear,
        backgroundOpacity: Double = 0
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top) {
                Text(title)
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .textCase(.uppercase)
                    .tracking(2.0)
                    .foregroundStyle(HBPalette.textMuted)

                Spacer(minLength: 8)

                Image(systemName: iconSystemName)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(iconColor)
            }

            Text(value)
                .font(.system(size: 20, weight: .bold, design: .rounded))
                .foregroundStyle(HBPalette.textPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.72)

            Text(detail)
                .font(.system(size: 12, weight: .medium, design: .rounded))
                .foregroundStyle(HBPalette.textSecondary)
                .lineLimit(2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(
            ZStack {
                HBGlassBackground(cornerRadius: 16, variant: .panelSoft)
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(backgroundTint.opacity(backgroundOpacity))
            }
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(accent.opacity(backgroundOpacity > 0 ? 0.3 : 0.2), lineWidth: 1)
        )
    }

    private func weatherUVIndicator(value: String, compact: Bool) -> some View {
        VStack(alignment: .trailing, spacing: 2) {
            Text("UV")
                .font(.system(size: 10, weight: .bold, design: .rounded))
                .textCase(.uppercase)
                .tracking(1.8)
                .foregroundStyle(HBPalette.textMuted)

            Text(value)
                .font(.system(size: compact ? 16 : 18, weight: .bold, design: .rounded))
                .foregroundStyle(HBPalette.textPrimary)
        }
        .padding(.horizontal, compact ? 10 : 12)
        .padding(.vertical, compact ? 8 : 10)
        .background(HBGlassBackground(cornerRadius: compact ? 14 : 16, variant: .panelSoft))
    }

    private func weatherDetailRow(title: String, value: String, systemImage: String, iconColor: Color) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .textCase(.uppercase)
                    .tracking(2.0)
                    .foregroundStyle(HBPalette.textMuted)
                Text(value)
                    .font(.system(size: 16, weight: .semibold, design: .rounded))
                    .foregroundStyle(HBPalette.textPrimary)
            }

            Spacer()

            Image(systemName: systemImage)
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(iconColor)
        }
        .padding(12)
        .background(HBGlassBackground(cornerRadius: 16, variant: .panelSoft))
    }

    private func weatherIconName(icon: String, isDay: Bool) -> String {
        switch icon {
        case "sunny":
            return isDay ? "sun.max.fill" : "moon.stars.fill"
        case "partly-cloudy":
            return isDay ? "cloud.sun.fill" : "cloud.moon.fill"
        case "fog":
            return "cloud.fog.fill"
        case "drizzle", "rain":
            return "cloud.rain.fill"
        case "sleet", "snow":
            return "cloud.snow.fill"
        case "storm":
            return "cloud.bolt.rain.fill"
        default:
            return "cloud.fill"
        }
    }

    private func formattedTemperature(_ value: Double?) -> String {
        guard let value else { return "--" }
        return "\(Int(value.rounded()))°"
    }

    private func formattedPercent(_ value: Double?) -> String {
        guard let value else { return "--" }
        return "\(Int(value.rounded()))%"
    }

    private func formattedWind(_ value: Double?) -> String {
        guard let value else { return "--" }
        return "\(Int(value.rounded())) mph"
    }

    private func formattedRain(_ value: Double?) -> String {
        guard let value else { return "--" }
        return String(format: "%.2f in", value)
    }

    private func formattedPressure(_ value: Double?) -> String {
        guard let value else { return "--" }
        return String(format: "%.2f inHg", value)
    }

    private func formattedUV(_ value: Double?) -> String {
        guard let value else { return "--" }
        return String(format: "%.1f", value)
    }

    private func formattedPressureTrend(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Steady" : trimmed.capitalized
    }

    private func compassDirection(_ value: Double?) -> String {
        guard let value else { return "--" }
        let directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
        let index = Int((value / 45).rounded()) % directions.count
        return directions[index]
    }

    private func formattedWeatherTime(_ value: String?) -> String {
        if let date = JSON.date(from: value) {
            return DateFormatter.localizedString(from: date, dateStyle: .none, timeStyle: .short)
        }

        return "--"
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
                        subtitle: "Pin your most-used scenes and workflows so they appear here for instant launch."
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

    private func featuredDeviceCard(_ device: DeviceItem, cardSize: DashboardFavoriteDeviceCardSize = .large) -> some View {
        let isThermostat = device.type == "thermostat"
        let mode = thermostatMode(for: device)
        let statusText = isThermostat ? mode.uppercased() : (device.status ? "On" : "Off")
        let statusEnabled = isThermostat ? mode != "off" : device.status
        let compact = cardSize == .small
        let expanded = cardSize == .large
        let pending = pendingControlDeviceIds.contains(device.id)
        let targetTemp = Int(currentThermostatSetpoint(for: device).rounded())
        let currentTemp = device.temperature.map { Int($0.rounded()) }
        let onMode = thermostatOnMode(for: device)
        let isOff = mode == "off"

        return HBPanel {
            VStack(alignment: .leading, spacing: compact ? 10 : 12) {
                HStack(alignment: .top, spacing: compact ? 10 : 12) {
                    Image(systemName: iconForDevice(device.type))
                        .font(.system(size: compact ? 14 : 16, weight: .bold))
                        .foregroundStyle(Color.white)
                        .frame(width: compact ? 34 : 38, height: compact ? 34 : 38)
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
                            .font(.system(size: compact ? 17 : (useLandscapeCompactLayout ? 20 : 22), weight: .bold, design: .rounded))
                            .foregroundStyle(HBPalette.textPrimary)
                            .lineLimit(2)
                        if !device.room.isEmpty {
                            Text(device.room)
                                .font(.system(size: compact ? 12 : (useLandscapeCompactLayout ? 13 : 15), weight: .medium, design: .rounded))
                                .foregroundStyle(HBPalette.textSecondary)
                        }
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
                    if compact {
                        compactThermostatCard(
                            device: device,
                            mode: mode,
                            targetTemp: targetTemp,
                            currentTemp: currentTemp,
                            pending: pending,
                            isOff: isOff,
                            onMode: onMode
                        )
                    } else {
                        featuredThermostatControls(for: device, compact: !expanded)
                    }
                } else {
                    if device.status {
                        Button("Turn Off") {
                            Task { await toggleDevice(device) }
                        }
                        .buttonStyle(HBSecondaryButtonStyle(compact: compact))
                        .frame(maxWidth: .infinity)
                        .disabled(pending)
                    } else {
                        Button("Turn On") {
                            Task { await toggleDevice(device) }
                        }
                        .buttonStyle(HBPrimaryButtonStyle(compact: compact))
                        .frame(maxWidth: .infinity)
                        .disabled(pending)
                    }

                    if !compact {
                        Text("Say: \"Hey Anna, \(device.status ? "turn off" : "turn on") \(device.name)\"")
                            .font(.system(size: 13, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textSecondary)
                            .lineLimit(2)
                    }
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

    private func compactThermostatCard(
        device: DeviceItem,
        mode: String,
        targetTemp: Int,
        currentTemp: Int?,
        pending: Bool,
        isOff: Bool,
        onMode: String
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("SETPOINT")
                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                        .tracking(1.0)
                        .foregroundStyle(HBPalette.textSecondary)
                    Text("\(targetTemp)°F")
                        .font(.system(size: 24, weight: .bold, design: .rounded))
                        .foregroundStyle(HBPalette.textPrimary)
                }

                Spacer(minLength: 8)

                VStack(alignment: .trailing, spacing: 2) {
                    Text("CURRENT")
                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                        .tracking(1.0)
                        .foregroundStyle(HBPalette.textSecondary)
                    Text(currentTemp.map { "\($0)°F" } ?? "--")
                        .font(.system(size: 15, weight: .semibold, design: .rounded))
                        .foregroundStyle(HBPalette.textPrimary)
                }
            }

            if isOff {
                Button {
                    let nextMode = isOff ? onMode : "off"
                    Task { await handleDeviceControl(deviceId: device.id, action: "set_mode", value: nextMode) }
                } label: {
                    Label("Turn On", systemImage: "power.circle.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(HBPrimaryButtonStyle(compact: true))
                .disabled(pending)
            } else {
                Button {
                    let nextMode = isOff ? onMode : "off"
                    Task { await handleDeviceControl(deviceId: device.id, action: "set_mode", value: nextMode) }
                } label: {
                    Label("Turn Off", systemImage: "power.circle")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(HBSecondaryButtonStyle(compact: true))
                .disabled(pending)
            }
        }
        .padding(12)
        .background(HBGlassBackground(cornerRadius: 16, variant: .panelSoft))
    }

    private func featuredThermostatControls(for device: DeviceItem, compact: Bool) -> some View {
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
                .buttonStyle(HBPrimaryButtonStyle(compact: compact))
                .disabled(pending)
            } else {
                Button {
                    let nextMode = isOff ? onMode : "off"
                    Task { await handleDeviceControl(deviceId: device.id, action: "set_mode", value: nextMode) }
                } label: {
                    Label(isOff ? "Turn On" : "Turn Off", systemImage: isOff ? "power.circle.fill" : "power.circle")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(HBSecondaryButtonStyle(compact: compact))
                .disabled(pending)
            }

            thermostatSetpointPanel(
                device: device,
                mode: mode,
                targetTemp: targetTemp,
                currentTemp: currentTemp,
                pending: pending,
                compact: compact
            )

            if !compact {
                Text("Say: \"Hey Anna, set \(device.name) to \(targetTemp) degrees\"")
                    .font(.system(size: 13, weight: .medium, design: .rounded))
                    .foregroundStyle(HBPalette.textSecondary)
                    .lineLimit(2)
            }
        }
    }

    private func thermostatSetpointPanel(
        device: DeviceItem,
        mode: String,
        targetTemp: Int,
        currentTemp: Int?,
        pending: Bool,
        compact: Bool
    ) -> some View {
        let modeColumns = compact
            ? [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]
            : Array(repeating: GridItem(.flexible(), spacing: 8), count: 4)

        return VStack(spacing: compact ? 10 : 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("SETPOINT")
                        .font(.system(size: 12, weight: .semibold, design: .rounded))
                        .tracking(1.2)
                        .foregroundStyle(HBPalette.textSecondary)
                    Text("\(targetTemp)°F")
                        .font(.system(size: compact ? 34 : (useLandscapeCompactLayout ? 40 : 48), weight: .bold, design: .rounded))
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
                        .font(.system(size: compact ? 24 : (useLandscapeCompactLayout ? 30 : 36), weight: .bold, design: .rounded))
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

            LazyVGrid(columns: modeColumns, spacing: 8) {
                ForEach(["auto", "cool", "heat", "off"], id: \.self) { thermostatMode in
                    thermostatModeChip(
                        device: device,
                        mode: thermostatMode,
                        activeMode: mode,
                        pending: pending,
                        compact: compact
                    )
                }
            }
        }
        .padding(compact ? 12 : 14)
        .background(HBGlassBackground(cornerRadius: compact ? 16 : 18, variant: .panelSoft))
    }

    private func thermostatModeChip(
        device: DeviceItem,
        mode: String,
        activeMode: String,
        pending: Bool,
        compact: Bool
    ) -> some View {
        let active = activeMode == mode

        return Button(mode.uppercased()) {
            Task { await handleDeviceControl(deviceId: device.id, action: "set_mode", value: mode) }
        }
        .buttonStyle(.plain)
        .font(.system(size: compact ? 12 : 14, weight: .bold, design: .rounded))
        .foregroundStyle(active ? Color.white : HBPalette.textPrimary)
        .frame(maxWidth: .infinity)
        .padding(.vertical, compact ? 8 : (useLandscapeCompactLayout ? 9 : 11))
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
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Voice Command Surface")
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .textCase(.uppercase)
                    .tracking(2.6)
                    .foregroundStyle(HBPalette.textMuted)

                Text("Launch a natural-language control pass")
                    .font(.system(size: useLandscapeCompactLayout ? 20 : 24, weight: .bold, design: .rounded))
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
                .buttonStyle(HBPrimaryButtonStyle(compact: true))
                .disabled(commandText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSendingCommand)

                Button("Refresh") {
                    Task { await loadDashboard() }
                }
                .buttonStyle(HBSecondaryButtonStyle(compact: true))
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

    private func quickScenePanel(for widget: DashboardWidgetItem) -> some View {
        let sceneCount: Int
        switch widget.size {
        case .small:
            sceneCount = 2
        case .medium:
            sceneCount = 3
        case .large:
            sceneCount = 4
        case .full:
            sceneCount = useLandscapeCompactLayout ? 5 : 6
        }

        let scopedScenes = Array(scenes.prefix(sceneCount))

        return VStack(alignment: .leading, spacing: 12) {
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

            if scopedScenes.isEmpty {
                EmptyStateView(
                    title: "No favorite scenes yet",
                    subtitle: "Pin your most-used scenes and they will appear here for instant launch."
                )
            } else {
                ForEach(scopedScenes) { scene in
                    HBCardRow {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(scene.name)
                                    .font(.system(size: 18, weight: .semibold, design: .rounded))
                                    .foregroundStyle(HBPalette.textPrimary)
                                Text(scene.details)
                                    .font(.system(size: 14, weight: .medium, design: .rounded))
                                    .foregroundStyle(HBPalette.textSecondary)
                                    .lineLimit(widget.size == .small ? 1 : 2)
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
        }
    }

    private func favoriteDevicesWidget(for widget: DashboardWidgetItem) -> some View {
        let limitedDevices: [DeviceItem]
        switch widget.size {
        case .small:
            limitedDevices = Array(featuredDevices.prefix(2))
        case .medium:
            limitedDevices = Array(featuredDevices.prefix(4))
        case .large:
            limitedDevices = Array(featuredDevices.prefix(6))
        case .full:
            limitedDevices = featuredDevices
        }

        return VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Priority Controls")
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .textCase(.uppercase)
                    .tracking(2.6)
                    .foregroundStyle(HBPalette.textMuted)

                Text("Favorite Devices")
                    .font(.system(size: useLandscapeCompactLayout ? 20 : 24, weight: .bold, design: .rounded))
                    .foregroundStyle(
                        LinearGradient(
                            colors: [HBPalette.accentBlue, HBPalette.accentPurple],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )

                Text(
                    favoritesProfileId == nil
                    ? "Activate a user profile to pin favorite controls."
                    : "Profile-tuned shortcuts for your most-used devices."
                )
                .font(.system(size: 14, weight: .medium, design: .rounded))
                .foregroundStyle(HBPalette.textSecondary)
            }

            if limitedDevices.isEmpty {
                EmptyStateView(
                    title: "No favorite devices yet",
                    subtitle: favoritesProfileId == nil
                        ? "Create or activate a user profile, then favorite devices to pin them here."
                        : "Favorite your go-to devices from the Devices screen to pin them here."
                )
            } else {
                LazyVGrid(columns: favoriteDeviceColumns(for: widget), spacing: 10) {
                    ForEach(limitedDevices) { device in
                        VStack(alignment: .leading, spacing: 8) {
                            if isEditingDashboard {
                                favoriteDeviceSizeControls(for: widget, device: device)
                            }

                            featuredDeviceCard(device, cardSize: favoriteDeviceCardSize(for: widget, device: device))
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
            }
        }
    }

    private func favoriteDeviceSizeControls(for widget: DashboardWidgetItem, device: DeviceItem) -> some View {
        let activeSize = favoriteDeviceCardSize(for: widget, device: device)

        return HStack(spacing: 8) {
            Text(device.name)
                .font(.system(size: 12, weight: .semibold, design: .rounded))
                .foregroundStyle(HBPalette.textPrimary)
                .lineLimit(1)

            Spacer(minLength: 8)

            ForEach(DashboardFavoriteDeviceCardSize.allCases) { size in
                let isActive = activeSize == size

                Button {
                    setFavoriteDeviceCardSize(widgetID: widget.id, deviceID: device.id, size: size)
                } label: {
                    Text(String(size.title.prefix(1)))
                        .font(.system(size: 11, weight: .bold, design: .rounded))
                        .foregroundStyle(isActive ? Color.white : HBPalette.textSecondary)
                        .frame(width: 26, height: 26)
                        .background(
                            Capsule()
                                .fill(
                                    isActive
                                    ? LinearGradient(
                                        colors: [HBPalette.accentBlue, HBPalette.accentPurple],
                                        startPoint: .leading,
                                        endPoint: .trailing
                                    )
                                    : LinearGradient(
                                        colors: [HBPalette.panelSoft.opacity(0.92), HBPalette.panel.opacity(0.72)],
                                        startPoint: .topLeading,
                                        endPoint: .bottomTrailing
                                    )
                                )
                        )
                        .overlay(
                            Capsule()
                                .stroke(isActive ? HBPalette.accentBlue.opacity(0.25) : HBPalette.panelStroke.opacity(0.4), lineWidth: 1)
                        )
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(HBGlassBackground(cornerRadius: 16, variant: .panelSoft))
    }

    @ViewBuilder
    private func singleDeviceWidget(for widget: DashboardWidgetItem) -> some View {
        if let deviceId = widget.settings.deviceId,
           let device = devices.first(where: { $0.id == deviceId }) {
            featuredDeviceCard(device, cardSize: deviceCardSize(for: widget.size))
        } else {
            EmptyStateView(
                title: "Device unavailable",
                subtitle: "This widget points to a device that is no longer available."
            )
        }
    }

    private func prepareAddWidgetSheet() {
        pendingWidgetType = .hero
        pendingWidgetTitle = DashboardWidgetType.hero.title
        pendingWidgetSize = .full
        pendingWidgetDeviceID = ""
        pendingWidgetDeviceSearch = ""
        pendingWeatherLocationMode = .saved
        pendingWeatherLocationQuery = ""
        showingAddWidgetSheet = true
    }

    private func updateWidget(_ widgetID: String, mutate: (inout DashboardWidgetItem) -> Void) {
        guard let currentView = currentDashboardView else { return }

        if let index = dashboardViews.firstIndex(where: { $0.id == currentView.id }) {
            var nextView = dashboardViews[index]
            guard let widgetIndex = nextView.widgets.firstIndex(where: { $0.id == widgetID }) else { return }
            mutate(&nextView.widgets[widgetIndex])
            dashboardViews[index] = nextView
            dashboardDirty = true
        }
    }

    private func moveWidget(_ widgetID: String, offset: Int) {
        guard let currentView = currentDashboardView,
              let viewIndex = dashboardViews.firstIndex(where: { $0.id == currentView.id }),
              let widgetIndex = dashboardViews[viewIndex].widgets.firstIndex(where: { $0.id == widgetID }) else {
            return
        }

        let destination = widgetIndex + offset
        guard dashboardViews[viewIndex].widgets.indices.contains(destination) else {
            return
        }

        var nextWidgets = dashboardViews[viewIndex].widgets
        let widget = nextWidgets.remove(at: widgetIndex)
        nextWidgets.insert(widget, at: destination)
        dashboardViews[viewIndex].widgets = nextWidgets
        dashboardDirty = true
    }

    private func removeWidget(_ widgetID: String) {
        guard let currentView = currentDashboardView,
              let viewIndex = dashboardViews.firstIndex(where: { $0.id == currentView.id }) else {
            return
        }

        dashboardViews[viewIndex].widgets.removeAll { $0.id == widgetID }
        dashboardDirty = true
    }

    private func addWidgetToCurrentDashboard() {
        guard let currentView = currentDashboardView,
              let viewIndex = dashboardViews.firstIndex(where: { $0.id == currentView.id }) else {
            return
        }

        if pendingWidgetType == .device && pendingWidgetDeviceID.isEmpty {
            return
        }
        if pendingWidgetType == .weather
            && pendingWeatherLocationMode == .custom
            && pendingWeatherLocationQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return
        }

        let selectedDevice = sortedDevices.first(where: { $0.id == pendingWidgetDeviceID })
        var settings = DashboardWidgetSettings()

        if pendingWidgetType == .device {
            settings.deviceId = pendingWidgetDeviceID
        }

        if pendingWidgetType == .weather {
            settings.weatherLocationMode = pendingWeatherLocationMode
            if pendingWeatherLocationMode == .custom {
                settings.weatherLocationQuery = pendingWeatherLocationQuery.trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }

        let trimmedTitle = pendingWidgetTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedTitle = pendingWidgetType == .device && (trimmedTitle.isEmpty || trimmedTitle == pendingWidgetType.title)
            ? selectedDevice?.name ?? pendingWidgetType.title
            : (trimmedTitle.isEmpty ? pendingWidgetType.title : trimmedTitle)

        let widget = DashboardSupport.makeWidget(
            type: pendingWidgetType,
            title: resolvedTitle,
            size: pendingWidgetSize,
            settings: settings
        )

        dashboardViews[viewIndex].widgets.append(widget)
        dashboardDirty = true
        pendingWidgetDeviceSearch = ""
        showingAddWidgetSheet = false
    }

    private func saveDashboardViews() async {
        guard let profileID = favoritesProfileId, !profileID.isEmpty else {
            errorMessage = "Create or activate a user profile to save dashboard layouts."
            return
        }

        isSavingDashboard = true
        defer { isSavingDashboard = false }

        do {
            let savedViews = try await DashboardSupport.saveViews(dashboardViews, profileId: profileID, apiClient: session.apiClient)
            dashboardViews = savedViews
            selectedDashboardViewID = DashboardSupport.resolveSelectedViewID(
                profileId: profileID,
                views: savedViews,
                current: selectedDashboardViewID
            )
            dashboardDirty = false
            infoMessage = "Dashboard layout saved for this profile."
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
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

    private func syncDashboardChrome() {
        dashboardChrome.update(
            currentViewName: currentDashboardView?.name ?? "Dashboard",
            currentViewID: selectedDashboardViewID,
            views: dashboardViews.map { view in
                DashboardChromeState.ViewSummary(
                    id: view.id,
                    name: view.name,
                    widgetCount: view.widgets.count
                )
            },
            widgetCount: currentDashboardWidgets.count,
            isEditing: isEditingDashboard,
            isDirty: dashboardDirty,
            isSaving: isSavingDashboard,
            canEdit: favoritesProfileId != nil
        )
    }

    private func handleDashboardChromeCommand() {
        guard let command = dashboardChrome.takePendingCommand() else { return }

        switch command {
        case .toggleEditing:
            guard favoritesProfileId != nil else { return }
            withAnimation(.easeInOut(duration: 0.22)) {
                isEditingDashboard.toggle()
            }

        case .save:
            guard favoritesProfileId != nil, dashboardDirty, !isSavingDashboard else { return }
            Task { await saveDashboardViews() }

        case .addWidget:
            guard favoritesProfileId != nil, isEditingDashboard else { return }
            prepareAddWidgetSheet()

        case .createView:
            guard favoritesProfileId != nil, isEditingDashboard else { return }
            pendingDashboardName = ""
            dashboardNameAction = .create

        case .renameCurrentView:
            guard favoritesProfileId != nil,
                  isEditingDashboard,
                  let currentView = currentDashboardView else { return }
            pendingDashboardName = currentView.name
            dashboardNameAction = .rename(currentView.id)

        case .selectView(let viewID):
            guard dashboardViews.contains(where: { $0.id == viewID }) else { return }
            selectedDashboardViewID = viewID
        }
    }

    private var dashboardNameAlertTitle: String {
        switch dashboardNameAction {
        case .create:
            return "Create Dashboard"
        case .rename:
            return "Rename Dashboard"
        case nil:
            return "Dashboard"
        }
    }

    private var dashboardNameAlertMessage: String {
        switch dashboardNameAction {
        case .create:
            return "Create a new empty dashboard for this profile."
        case .rename:
            return "Update the name of the current dashboard."
        case nil:
            return ""
        }
    }

    private func dashboardNameAlertBinding() -> Binding<Bool> {
        Binding(
            get: { dashboardNameAction != nil },
            set: { if !$0 { dashboardNameAction = nil } }
        )
    }

    private func submitDashboardNameAction() {
        let trimmedName = pendingDashboardName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else {
            return
        }

        switch dashboardNameAction {
        case .create:
            let nextView = DashboardSupport.emptyView(name: trimmedName)
            dashboardViews.append(nextView)
            selectedDashboardViewID = nextView.id
            dashboardDirty = true
            infoMessage = "\"\(trimmedName)\" created. Add widgets, then save when ready."

        case .rename(let viewID):
            guard let index = dashboardViews.firstIndex(where: { $0.id == viewID }) else {
                dashboardNameAction = nil
                return
            }

            dashboardViews[index].name = trimmedName
            if selectedDashboardViewID.isEmpty {
                selectedDashboardViewID = viewID
            }
            dashboardDirty = true
            infoMessage = "Dashboard renamed to \"\(trimmedName)\"."

        case nil:
            break
        }

        dashboardNameAction = nil
    }

    private func loadDashboard() async {
        if previewMode {
            errorMessage = nil
            infoMessage = nil
            devices = UIPreviewData.devices.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            scenes = UIPreviewData.scenes.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            voiceDevices = UIPreviewData.voiceDevices
            securityStatus = "Disarmed"
            securityZonesActive = 0
            securityZonesTotal = 9
            systemStatus = "Online"
            favoritesProfileId = UIPreviewData.favoriteProfileId
            favoriteDeviceIds = UIPreviewData.favoriteDeviceIds
            let previewViews = [DashboardSupport.defaultView(name: "Preview Dashboard")]
            dashboardViews = previewViews
            selectedDashboardViewID = DashboardSupport.resolveSelectedViewID(
                profileId: UIPreviewData.favoriteProfileId,
                views: previewViews,
                current: selectedDashboardViewID
            )
            dashboardDirty = false
            isLoading = false
            return
        }

        isLoading = true
        errorMessage = nil
        infoMessage = nil

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
            let profilesResponse = try? await profilesTask
            let favoritesContext = profilesResponse.map(FavoritesSupport.deviceContext(fromProfilesPayload:)) ?? .empty
            let dashboardContext = profilesResponse.map(DashboardSupport.profileContext(fromProfilesPayload:)) ?? .empty

            let devicesObject = JSON.object(devicesResponse)
            let devicesData = JSON.object(devicesObject["data"])
            let deviceList = JSON.array(devicesData["devices"]).map(DeviceItem.from)

            let sceneObject = JSON.object(scenesResponse)
            let sceneList = JSON.array(sceneObject["scenes"]).map(SceneItem.from)

            let voiceObject = JSON.object(voiceResponse)
            let voiceList = JSON.array(voiceObject["devices"]).map(VoiceDeviceItem.from)

            devices = deviceList.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            scenes = sceneList.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            voiceDevices = voiceList.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            applySecurityStatusResponse(securityResponse)
            applyFavoriteContext(favoritesContext)
            dashboardViews = dashboardContext.views
            selectedDashboardViewID = DashboardSupport.resolveSelectedViewID(
                profileId: dashboardContext.profileId,
                views: dashboardContext.views,
                current: selectedDashboardViewID
            )
            dashboardDirty = false
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    private func applySecurityStatusResponse(_ response: Any) {
        let securityObject = JSON.object(response)
        let statusObject = JSON.object(securityObject["status"])
        let alarmState = JSON.string(statusObject, "alarmState", fallback: "Unknown")
        let zoneObjects = JSON.array(statusObject["zones"])
        let totalZones = JSON.int(statusObject, "zoneCount", fallback: zoneObjects.count)
        let activeZones = JSON.int(
            statusObject,
            "activeZones",
            fallback: zoneObjects.filter { JSON.bool($0, "active") }.count
        )
        let isOnline = JSON.bool(statusObject, "isOnline", fallback: true)

        securityStatus = alarmState
        securityZonesActive = activeZones
        securityZonesTotal = totalZones
        systemStatus = isOnline ? "Online" : "Offline"
    }

    private func refreshSecurityStatus() async {
        if previewMode {
            systemStatus = "Online"
            return
        }

        do {
            let response = try await session.apiClient.get("/api/security-alarm/status")
            applySecurityStatusResponse(response)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
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
            securityStatus = stay ? "armedStay" : "armedAway"
            systemStatus = "Online"
            return
        }

        do {
            _ = try await session.apiClient.post(
                "/api/security-alarm/arm",
                body: ["mode": stay ? "stay" : "away"]
            )
            await refreshSecurityStatus()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func disarmSecurity() async {
        if previewMode {
            securityStatus = "disarmed"
            systemStatus = "Online"
            return
        }

        do {
            _ = try await session.apiClient.post("/api/security-alarm/disarm", body: [:])
            await refreshSecurityStatus()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func dismissSecurityAlarm() async {
        if previewMode {
            securityStatus = "disarmed"
            systemStatus = "Online"
            return
        }

        do {
            _ = try await session.apiClient.post("/api/security-alarm/dismiss", body: [:])
            await refreshSecurityStatus()
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
            _ = try await session.apiClient.post("/api/security-alarm/sync", body: [:])
            await refreshSecurityStatus()
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
