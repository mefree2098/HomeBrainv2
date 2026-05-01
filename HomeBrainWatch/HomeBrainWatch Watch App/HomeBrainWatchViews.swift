import SwiftUI

enum SecurityAction: String, Identifiable {
    case armStay
    case armAway
    case disarm

    var id: String { rawValue }

    var title: String {
        switch self {
        case .armStay: return "Arm Stay"
        case .armAway: return "Arm Away"
        case .disarm: return "Disarm"
        }
    }

    var apiAction: String {
        switch self {
        case .armStay: return "armStay"
        case .armAway: return "armAway"
        case .disarm: return "disarm"
        }
    }

    var tint: Color {
        switch self {
        case .armStay: return .orange
        case .armAway: return .red
        case .disarm: return .green
        }
    }
}

struct SignInView: View {
    @ObservedObject var store: HomeBrainWatchStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 5) {
                    Image(systemName: "house.and.flag.fill")
                        .font(.system(size: 30, weight: .semibold))
                        .foregroundStyle(.cyan)
                    Text("HomeBrain")
                        .font(.system(size: 25, weight: .bold, design: .rounded))
                    Text("Watch control")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(.bottom, 4)

                TextField("HomeBrain URL", text: $store.serverURL)
                    .textContentType(.URL)
                    .textInputAutocapitalization(.never)

                Button {
                    store.requestCompanionSignIn()
                } label: {
                    Label("Sync From iPhone", systemImage: "iphone.and.arrow.forward")
                }
                .buttonStyle(.borderedProminent)

                Text(store.companionStatusMessage ?? "Open HomeBrain on iPhone, then sync your signed-in session to this watch.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)

                TextField("Email", text: $store.email)
                    .textContentType(.emailAddress)
                    .textInputAutocapitalization(.never)
                SecureField("Password", text: $store.password)

                Button {
                    Task { await store.signIn() }
                } label: {
                    HStack {
                        if store.isSigningIn {
                            ProgressView()
                        } else {
                            Image(systemName: "person.crop.circle.badge.checkmark")
                        }
                        Text(store.isSigningIn ? "Signing In" : "Sign In")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(store.isSigningIn || store.email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.password.isEmpty)

                if let message = store.errorMessage {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .padding(.top, 2)
                }
            }
            .padding(.vertical, 8)
        }
    }
}

struct WatchDashboardRootView: View {
    @ObservedObject var store: HomeBrainWatchStore

    var body: some View {
        Group {
            if let dashboard = store.dashboard {
                OverviewPage(store: store, dashboard: dashboard)
            } else {
                LoadingPage(store: store)
            }
        }
        .task {
            if store.dashboard == nil {
                await store.refreshDashboard()
            }
        }
    }

}

struct LoadingPage: View {
    @ObservedObject var store: HomeBrainWatchStore

    var body: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Loading HomeBrain")
                .font(.headline)
            if let message = store.errorMessage {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                Button("Sign Out") {
                    store.signOut()
                }
            }
        }
        .padding()
    }
}

struct OverviewPage: View {
    @ObservedObject var store: HomeBrainWatchStore
    let dashboard: WatchDashboard

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                HeaderBlock(title: "HomeBrain", subtitle: dashboard.user.name.isEmpty ? dashboard.user.email : dashboard.user.name, symbol: "house.fill", tint: .cyan)

                ForEach(dashboard.config.sections) { section in
                    NavigationLink {
                        sectionPage(section)
                    } label: {
                        DashboardLinkRow(summary: summary(for: section))
                    }
                    .buttonStyle(.plain)
                }

                Button {
                    Task { await store.refreshDashboard() }
                } label: {
                    Label(store.isLoading ? "Refreshing" : "Refresh", systemImage: "arrow.clockwise")
                }
                .disabled(store.isLoading)

                NavigationLink {
                    AccountPage(store: store, dashboard: dashboard)
                } label: {
                    DashboardLinkRow(
                        summary: DashboardSummary(
                            symbol: "person.crop.circle.fill",
                            title: "Account",
                            value: store.serverURL,
                            tint: .purple
                        )
                    )
                }
                .buttonStyle(.plain)
            }
            .padding(.vertical, 8)
        }
    }

    @ViewBuilder
    private func sectionPage(_ section: WatchSection) -> some View {
        switch section {
        case .security:
            SecurityPage(store: store, security: dashboard.sections.security)
        case .lights:
            LightsPage(store: store, lights: dashboard.sections.lights)
        case .power:
            PowerPage(power: dashboard.sections.power)
        case .weather:
            WeatherPage(weather: dashboard.sections.weather)
        }
    }

    private func summary(for section: WatchSection) -> DashboardSummary {
        switch section {
        case .security:
            let security = dashboard.sections.security
            return DashboardSummary(
                symbol: "shield.fill",
                title: "Security",
                value: security?.stateLabel ?? "Open controls",
                tint: security?.isTriggered == true ? .red : .green
            )
        case .lights:
            let lights = dashboard.sections.lights
            return DashboardSummary(
                symbol: "lightbulb.fill",
                title: "Lights",
                value: "\(lights?.onCount ?? 0)/\(lights?.totalCount ?? 0) on",
                tint: .yellow
            )
        case .power:
            return DashboardSummary(
                symbol: "bolt.fill",
                title: "Power",
                value: formatWatts(dashboard.sections.power?.powerW),
                tint: .cyan
            )
        case .weather:
            return DashboardSummary(
                symbol: "cloud.sun.fill",
                title: "Weather",
                value: formatTemp(dashboard.sections.weather?.temperatureF),
                tint: .blue
            )
        }
    }
}

struct SecurityPage: View {
    @ObservedObject var store: HomeBrainWatchStore
    let security: WatchSecuritySection?
    @State private var pendingAction: SecurityAction?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                HeaderBlock(title: "Security", subtitle: security?.stateLabel ?? "Unavailable", symbol: "shield.lefthalf.filled", tint: security?.isTriggered == true ? .red : .green)

                WatchPanel {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(alignment: .firstTextBaseline) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(security?.stateLabel ?? "--")
                                    .font(.system(size: 24, weight: .bold, design: .rounded))
                                Text(security?.isOnline == false ? "Offline" : "Online")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Image(systemName: security?.isTriggered == true ? "exclamationmark.triangle.fill" : "checkmark.seal.fill")
                                .foregroundStyle(security?.isTriggered == true ? .red : .green)
                        }

                        VStack(spacing: 7) {
                            SecurityButton(action: .armStay, pendingAction: $pendingAction)
                            SecurityButton(action: .armAway, pendingAction: $pendingAction)
                            SecurityButton(action: .disarm, pendingAction: $pendingAction)
                        }
                        .disabled(store.commandInFlight != nil || security?.available != true)
                    }
                }

                HStack(spacing: 8) {
                    MetricChip(title: "Active", value: "\(security?.activeSensorCount ?? 0)")
                    MetricChip(title: "Attention", value: "\(security?.attentionSensorCount ?? 0)")
                }
                HStack(spacing: 8) {
                    MetricChip(title: "Locks", value: "\(security?.unlockedDoorCount ?? 0) open")
                    MetricChip(title: "Sensors", value: "\(security?.sensorCount ?? 0)")
                }

                if let message = security?.error ?? store.errorMessage {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
            .padding(.vertical, 8)
        }
        .confirmationDialog(
            "Confirm security change",
            isPresented: Binding(
                get: { pendingAction != nil },
                set: { isPresented in
                    if !isPresented {
                        pendingAction = nil
                    }
                }
            )
        ) {
            if let action = pendingAction {
                Button(action.title, role: action == .disarm ? .destructive : nil) {
                    pendingAction = nil
                    Task { await store.controlSecurity(action.apiAction) }
                }
            }
            Button("Cancel", role: .cancel) {
                pendingAction = nil
            }
        } message: {
            Text(pendingAction.map { "Send \($0.title) to HomeBrain?" } ?? "")
        }
    }
}

struct SecurityButton: View {
    let action: SecurityAction
    @Binding var pendingAction: SecurityAction?

    var body: some View {
        Button {
            pendingAction = action
        } label: {
            HStack {
                Image(systemName: action == .disarm ? "lock.open.fill" : "lock.fill")
                Text(action.title)
                Spacer()
            }
        }
        .tint(action.tint)
    }
}

struct LightsPage: View {
    @ObservedObject var store: HomeBrainWatchStore
    let lights: WatchLightsSection?
    @State private var brightness: Double = 70
    @State private var selectedRoomName = ""

    private var roomOptions: [WatchLightRoom] {
        if let rooms = lights?.rooms, !rooms.isEmpty {
            return rooms
        }

        guard let lights else {
            return []
        }

        let fallbackName = lights.room?.isEmpty == false ? lights.room! : "Lights"
        return [
            WatchLightRoom(
                available: lights.available,
                name: fallbackName,
                room: fallbackName,
                totalCount: lights.totalCount,
                onCount: lights.onCount,
                onlineCount: lights.onlineCount,
                dimmableCount: lights.dimmableCount,
                averageBrightness: lights.averageBrightness,
                defaultLightBrightness: lights.defaultLightBrightness,
                devices: lights.devices,
                error: lights.error
            )
        ]
    }

    private var selectedRoom: WatchLightRoom? {
        roomOptions.first { $0.name == selectedRoomName }
            ?? roomOptions.first { $0.name == lights?.room }
            ?? roomOptions.first
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                HeaderBlock(title: "Lights", subtitle: selectedRoom?.name ?? lights?.room ?? "No room", symbol: "lightbulb.fill", tint: .yellow)

                if roomOptions.count > 1 {
                    Picker("Room", selection: $selectedRoomName) {
                        ForEach(roomOptions) { room in
                            Text(room.name).tag(room.name)
                        }
                    }
                    .pickerStyle(.navigationLink)
                }

                WatchPanel {
                    HStack(alignment: .center) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("\(selectedRoom?.onCount ?? 0)/\(selectedRoom?.totalCount ?? 0)")
                                .font(.system(size: 28, weight: .bold, design: .rounded))
                            Text("lights on")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text("\(selectedRoom?.averageBrightness ?? 0)%")
                            .font(.headline)
                            .foregroundStyle(.yellow)
                    }
                }

                HStack(spacing: 8) {
                    Button("On") {
                        Task { await store.controlLights(room: selectedRoom?.name, action: "turn_on", brightness: Int(brightness.rounded())) }
                    }
                    .tint(.yellow)
                    Button("Off") {
                        Task { await store.controlLights(room: selectedRoom?.name, action: "turn_off") }
                    }
                    .tint(.gray)
                }
                .disabled(store.commandInFlight != nil || selectedRoom?.available != true)

                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text("Dimmer")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text("\(Int(brightness.rounded()))%")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Slider(value: $brightness, in: 1...100, step: 1)
                    Button {
                        Task { await store.controlLights(room: selectedRoom?.name, action: "set_brightness", brightness: Int(brightness.rounded())) }
                    } label: {
                        Label("Set", systemImage: "slider.horizontal.3")
                    }
                    .disabled(store.commandInFlight != nil || selectedRoom?.available != true || selectedRoom?.dimmableCount == 0)
                }

                HStack(spacing: 8) {
                    MetricChip(title: "Online", value: "\(selectedRoom?.onlineCount ?? 0)")
                    MetricChip(title: "Dimmable", value: "\(selectedRoom?.dimmableCount ?? 0)")
                }

                ForEach((selectedRoom?.devices ?? []).prefix(5)) { device in
                    MiniStatusRow(
                        symbol: device.isOn ? "lightbulb.fill" : "lightbulb",
                        title: device.name,
                        value: device.isOnline ? (device.isOn ? "On" : "Off") : "Offline",
                        tint: device.isOn ? .yellow : .secondary
                    )
                }

                if roomOptions.isEmpty {
                    Text("No watch light devices configured.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                if let message = lights?.error ?? store.errorMessage {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
            .padding(.vertical, 8)
        }
        .onAppear {
            syncLightState()
        }
        .onChange(of: selectedRoomName) { _, _ in
            syncBrightnessFromSelectedRoom()
        }
        .onChange(of: lights?.room ?? "") { _, _ in
            syncLightState()
        }
    }

    private func syncLightState() {
        let names = roomOptions.map(\.name)
        if !names.contains(selectedRoomName) {
            selectedRoomName = names.first { $0 == lights?.room } ?? names.first ?? ""
        }
        syncBrightnessFromSelectedRoom()
    }

    private func syncBrightnessFromSelectedRoom() {
        let suggested = selectedRoom?.defaultLightBrightness
            ?? selectedRoom?.averageBrightness
            ?? lights?.defaultLightBrightness
            ?? lights?.averageBrightness
            ?? 70
        brightness = Double(max(1, min(100, suggested)))
    }
}

struct PowerPage: View {
    let power: WatchPowerSection?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                HeaderBlock(title: "Power", subtitle: power?.monitorName ?? "Sense", symbol: "bolt.fill", tint: .cyan)

                WatchPanel {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(formatWatts(power?.powerW))
                            .font(.system(size: 32, weight: .bold, design: .rounded))
                        Text("current draw")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }

                HStack(spacing: 8) {
                    MetricChip(title: "Always", value: formatWatts(power?.alwaysOnW))
                    MetricChip(title: "Net", value: formatWatts(power?.netW))
                }
                HStack(spacing: 8) {
                    MetricChip(title: "Solar", value: formatWatts(power?.solarW))
                    MetricChip(title: "Today", value: formatKwh(power?.dayKwh))
                }
                HStack(spacing: 8) {
                    MetricChip(title: "Cost", value: formatCurrencyPerHour(power?.currentCostUsdPerHour))
                    MetricChip(title: "Month", value: formatCurrency(power?.projectedMonthUsd))
                }

                MiniStatusRow(symbol: "number.circle.fill", title: "Active devices", value: "\(power?.activeDeviceCount ?? 0)", tint: .cyan)

                ForEach((power?.activeDevices ?? []).prefix(5)) { device in
                    MiniStatusRow(
                        symbol: "bolt.circle.fill",
                        title: device.name,
                        value: "\(formatWatts(device.powerW)) \(formatPercent(device.sharePct))",
                        tint: .cyan
                    )
                }

                if let observedAt = power?.observedAt {
                    MiniStatusRow(symbol: "clock.fill", title: "Updated", value: formatTime(observedAt), tint: .secondary)
                }

                if let message = power?.error {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
            .padding(.vertical, 8)
        }
    }
}

struct WeatherPage: View {
    let weather: WatchWeatherSection?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                HeaderBlock(title: "Weather", subtitle: weather?.locationName ?? "Saved location", symbol: weatherSymbol(for: weather?.icon), tint: .blue)

                WatchPanel {
                    HStack(alignment: .firstTextBaseline) {
                        Text(formatTemp(weather?.temperatureF))
                            .font(.system(size: 34, weight: .bold, design: .rounded))
                        Spacer()
                        Text(weather?.condition ?? "--")
                            .font(.caption)
                            .multilineTextAlignment(.trailing)
                    }
                }

                HStack(spacing: 8) {
                    MetricChip(title: "High", value: formatTemp(weather?.highF))
                    MetricChip(title: "Low", value: formatTemp(weather?.lowF))
                }
                HStack(spacing: 8) {
                    MetricChip(title: "Feels", value: formatTemp(weather?.apparentTemperatureF))
                    MetricChip(title: "Humidity", value: formatPercent(weather?.humidity))
                }
                HStack(spacing: 8) {
                    MetricChip(title: "Rain", value: formatPercent(weather?.precipitationChance))
                    MetricChip(title: "Wind", value: formatMph(weather?.windSpeedMph))
                }

                if let fetchedAt = weather?.fetchedAt {
                    MiniStatusRow(symbol: "clock.fill", title: "Updated", value: formatTime(fetchedAt), tint: .secondary)
                }

                if let message = weather?.error {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
            .padding(.vertical, 8)
        }
    }
}

struct AccountPage: View {
    @ObservedObject var store: HomeBrainWatchStore
    let dashboard: WatchDashboard

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                HeaderBlock(title: "Account", subtitle: dashboard.user.email, symbol: "person.crop.circle.fill", tint: .purple)
                MiniStatusRow(symbol: "network", title: "Server", value: store.serverURL, tint: .cyan)
                MiniStatusRow(symbol: "rectangle.grid.2x2.fill", title: "Screens", value: "\(dashboard.config.sections.count)", tint: .purple)
                Button(role: .destructive) {
                    store.signOut()
                } label: {
                    Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
                }
            }
            .padding(.vertical, 8)
        }
    }
}

struct DashboardSummary {
    let symbol: String
    let title: String
    let value: String
    let tint: Color
}

struct DashboardLinkRow: View {
    let summary: DashboardSummary

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: summary.symbol)
                .foregroundStyle(summary.tint)
                .frame(width: 22)

            VStack(alignment: .leading, spacing: 2) {
                Text(summary.title)
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                    .foregroundStyle(.primary)
                Text(summary.value)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }

            Spacer(minLength: 0)

            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

struct HeaderBlock: View {
    let title: String
    let subtitle: String
    let symbol: String
    let tint: Color

    var body: some View {
        HStack(spacing: 9) {
            ZStack {
                Circle()
                    .fill(tint.opacity(0.18))
                Image(systemName: symbol)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(tint)
            }
            .frame(width: 38, height: 38)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 18, weight: .bold, design: .rounded))
                Text(subtitle)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }
}

struct WatchPanel<Content: View>: View {
    @ViewBuilder var content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        content
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(.white.opacity(0.08))
                    .overlay(
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .stroke(.white.opacity(0.12), lineWidth: 1)
                    )
            )
    }
}

struct MetricChip: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(size: 15, weight: .semibold, design: .rounded))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

struct MiniStatusRow: View {
    let symbol: String
    let title: String
    let value: String
    let tint: Color

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: symbol)
                .foregroundStyle(tint)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Text(value)
                    .font(.system(size: 14, weight: .semibold, design: .rounded))
                    .lineLimit(1)
                    .minimumScaleFactor(0.65)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 8)
        .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

func formatWatts(_ value: Double?) -> String {
    guard let value, value.isFinite else { return "-- W" }
    return "\(Int(value.rounded()).formatted()) W"
}

func formatKwh(_ value: Double?) -> String {
    guard let value, value.isFinite else { return "-- kWh" }
    return String(format: "%.1f kWh", value)
}

func formatTemp(_ value: Double?) -> String {
    guard let value, value.isFinite else { return "-- F" }
    return "\(Int(value.rounded())) F"
}

func formatPercent(_ value: Double?) -> String {
    guard let value, value.isFinite else { return "--%" }
    return "\(Int(value.rounded()))%"
}

func formatMph(_ value: Double?) -> String {
    guard let value, value.isFinite else { return "-- mph" }
    return "\(Int(value.rounded())) mph"
}

func formatCurrency(_ value: Double?) -> String {
    guard let value, value.isFinite else { return "--" }
    let formatter = NumberFormatter()
    formatter.numberStyle = .currency
    formatter.maximumFractionDigits = value >= 10 ? 0 : 2
    return formatter.string(from: NSNumber(value: value)) ?? String(format: "$%.2f", value)
}

func formatCurrencyPerHour(_ value: Double?) -> String {
    guard let value, value.isFinite else { return "--/hr" }
    return "\(formatCurrency(value))/hr"
}

func formatTime(_ value: String?) -> String {
    guard let value, !value.isEmpty else { return "--" }
    let iso = ISO8601DateFormatter()
    if let date = iso.date(from: value) {
        return DateFormatter.localizedString(from: date, dateStyle: .none, timeStyle: .short)
    }
    return value
}

func weatherSymbol(for icon: String?) -> String {
    switch icon {
    case "clear": return "sun.max.fill"
    case "rain": return "cloud.rain.fill"
    case "snow": return "cloud.snow.fill"
    case "storm": return "cloud.bolt.rain.fill"
    case "fog": return "cloud.fog.fill"
    case "partly-cloudy": return "cloud.sun.fill"
    default: return "cloud.fill"
    }
}
