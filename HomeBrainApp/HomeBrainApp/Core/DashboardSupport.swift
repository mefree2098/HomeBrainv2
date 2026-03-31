import Foundation

enum DashboardWidgetType: String, CaseIterable, Identifiable {
    case hero
    case summary
    case security
    case favoriteScenes = "favorite-scenes"
    case favoriteDevices = "favorite-devices"
    case weather
    case voiceCommand = "voice-command"
    case devices
    case device

    var id: String { rawValue }

    var title: String {
        switch self {
        case .hero: return "Welcome Hero"
        case .summary: return "System Summary"
        case .security: return "Security Center"
        case .favoriteScenes: return "Quick Scenes"
        case .favoriteDevices: return "Favorite Devices"
        case .weather: return "Weather"
        case .voiceCommand: return "Voice Commands"
        case .devices: return "Devices"
        case .device: return "Device Control"
        }
    }

    var details: String {
        switch self {
        case .hero: return "Top-level residence overview copy and badges."
        case .summary: return "Live devices, voice mesh, scenes, and workflow activity."
        case .security: return "Alarm state and security control actions."
        case .favoriteScenes: return "Pinned scenes for one-tap launch."
        case .favoriteDevices: return "Dock of favorite devices with live controls."
        case .weather: return "Current conditions and forecast for a saved or detected location."
        case .voiceCommand: return "Natural-language command surface."
        case .devices: return "A dense control grid for a selected set of devices."
        case .device: return "A dedicated control card for one specific device."
        }
    }
}

enum DashboardWidgetSize: String, CaseIterable, Identifiable {
    case small
    case medium
    case large
    case full

    var id: String { rawValue }

    var title: String {
        switch self {
        case .small: return "Small"
        case .medium: return "Medium"
        case .large: return "Large"
        case .full: return "Full Width"
        }
    }
}

enum DashboardFavoriteDeviceCardSize: String, CaseIterable, Identifiable {
    case small
    case medium
    case large

    var id: String { rawValue }

    var title: String {
        switch self {
        case .small: return "Small"
        case .medium: return "Medium"
        case .large: return "Large"
        }
    }
}

enum DashboardWeatherLocationMode: String, CaseIterable, Identifiable {
    case saved
    case custom
    case auto

    var id: String { rawValue }

    var title: String {
        switch self {
        case .saved: return "Saved Address"
        case .custom: return "Specific Address"
        case .auto: return "Auto Detect"
        }
    }
}

struct DashboardWidgetSettings: Hashable {
    var deviceId: String?
    var deviceIds: [String] = []
    var favoriteDeviceSizes: [String: DashboardFavoriteDeviceCardSize] = [:]
    var weatherLocationMode: DashboardWeatherLocationMode = .saved
    var weatherLocationQuery: String?

    var payload: [String: Any] {
        var result: [String: Any] = [:]

        if let deviceId, !deviceId.isEmpty {
            result["deviceId"] = deviceId
        }

        if !deviceIds.isEmpty {
            result["deviceIds"] = deviceIds
        }

        if !favoriteDeviceSizes.isEmpty {
            result["favoriteDeviceSizes"] = favoriteDeviceSizes.mapValues(\.rawValue)
        }

        result["weatherLocationMode"] = weatherLocationMode.rawValue

        if let weatherLocationQuery,
           !weatherLocationQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            result["weatherLocationQuery"] = weatherLocationQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        return result
    }
}

struct DashboardWidgetItem: Identifiable, Hashable {
    var id: String
    var type: DashboardWidgetType
    var title: String
    var size: DashboardWidgetSize
    var minimized: Bool
    var settings: DashboardWidgetSettings

    var payload: [String: Any] {
        [
            "id": id,
            "type": type.rawValue,
            "title": title,
            "size": size.rawValue,
            "minimized": minimized,
            "settings": settings.payload
        ]
    }
}

struct DashboardViewItem: Identifiable, Hashable {
    var id: String
    var name: String
    var widgets: [DashboardWidgetItem]

    var payload: [String: Any] {
        [
            "id": id,
            "name": name,
            "widgets": widgets.map(\.payload)
        ]
    }
}

struct DashboardProfileContext {
    var profileId: String?
    var views: [DashboardViewItem]
    var remoteViewCount: Int?

    static let empty = DashboardProfileContext(profileId: nil, views: [DashboardSupport.defaultView()], remoteViewCount: nil)
}

enum DashboardSupport {
    private static let defaults = UserDefaults.standard

    private static let defaultWidgetDescriptors: [(DashboardWidgetType, String, DashboardWidgetSize)] = [
        (.hero, "Welcome Home", .full),
        (.summary, "System Summary", .full),
        (.security, "Security Center", .medium),
        (.favoriteScenes, "Quick Scenes", .large),
        (.voiceCommand, "Voice Commands", .large)
    ]

    static func createID(prefix: String) -> String {
        "\(prefix)-\(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(12))"
    }

    static func defaultView(name: String = "Main Dashboard") -> DashboardViewItem {
        DashboardViewItem(
            id: createID(prefix: "view"),
            name: name,
            widgets: defaultWidgetDescriptors.map { descriptor in
                DashboardWidgetItem(
                    id: createID(prefix: "widget"),
                    type: descriptor.0,
                    title: descriptor.1,
                    size: descriptor.2,
                    minimized: false,
                    settings: DashboardWidgetSettings()
                )
            }
        )
    }

    static func emptyView(name: String) -> DashboardViewItem {
        DashboardViewItem(
            id: createID(prefix: "view"),
            name: sanitizedTitle(name, fallback: "Untitled Dashboard"),
            widgets: []
        )
    }

    static func makeWidget(
        type: DashboardWidgetType,
        title: String? = nil,
        size: DashboardWidgetSize? = nil,
        minimized: Bool = false,
        deviceId: String? = nil,
        settings: DashboardWidgetSettings? = nil
    ) -> DashboardWidgetItem {
        let descriptor = defaultWidgetDescriptors.first(where: { $0.0 == type })
        let resolvedTitle = sanitizedTitle(title, fallback: descriptor?.1 ?? type.title)
        let resolvedSize = size ?? descriptor?.2 ?? .medium
        var resolvedSettings = settings ?? DashboardWidgetSettings()

        if let deviceId, !deviceId.isEmpty {
            resolvedSettings.deviceId = deviceId
        }

        return DashboardWidgetItem(
            id: createID(prefix: "widget"),
            type: type,
            title: resolvedTitle,
            size: resolvedSize,
            minimized: minimized,
            settings: resolvedSettings
        )
    }

    static func clone(view: DashboardViewItem, named name: String) -> DashboardViewItem {
        DashboardViewItem(
            id: createID(prefix: "view"),
            name: sanitizedTitle(name, fallback: "\(view.name) Copy"),
            widgets: view.widgets.map { widget in
                DashboardWidgetItem(
                    id: createID(prefix: "widget"),
                    type: widget.type,
                    title: widget.title,
                    size: widget.size,
                    minimized: widget.minimized,
                    settings: widget.settings
                )
            }
        )
    }

    static func normalizeViews(from raw: Any?) -> [DashboardViewItem] {
        guard let rawViews = raw as? [Any], !rawViews.isEmpty else {
            return [defaultView()]
        }

        let normalized = rawViews.enumerated().compactMap { normalizeView(from: $0.element, index: $0.offset) }
        return normalized.isEmpty ? [defaultView()] : normalized
    }

    static func profileContext(fromProfilesPayload payload: Any) -> DashboardProfileContext {
        let root = JSON.object(payload)
        let profiles = JSON.array(root["profiles"])

        guard let preferredProfile = preferredProfile(from: profiles) else {
            return .empty
        }

        let rawDashboardViews = preferredProfile["dashboardViews"] as? [Any]
        return DashboardProfileContext(
            profileId: FavoritesSupport.optionalProfileID(from: preferredProfile),
            views: normalizeViews(from: preferredProfile["dashboardViews"]),
            remoteViewCount: rawDashboardViews?.count
        )
    }

    static func views(fromDashboardViewsPayload payload: Any) -> [DashboardViewItem] {
        let root = JSON.object(payload)
        let data = JSON.object(root["data"])
        return normalizeViews(from: root["views"] ?? data["views"])
    }

    static func resolveSelectedViewID(profileId: String?, views: [DashboardViewItem], current: String? = nil) -> String {
        if let current, views.contains(where: { $0.id == current }) {
            return current
        }

        if let stored = defaultViewID(forProfileID: profileId), views.contains(where: { $0.id == stored }) {
            return stored
        }

        return views.first?.id ?? ""
    }

    static func defaultViewID(forProfileID profileId: String?) -> String? {
        let key = preferenceKey(forProfileID: profileId)
        let stored = defaults.string(forKey: key)?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let stored, !stored.isEmpty {
            return stored
        }
        return nil
    }

    static func setDefaultViewID(_ viewId: String?, forProfileID profileId: String?) {
        let key = preferenceKey(forProfileID: profileId)
        let trimmed = viewId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if trimmed.isEmpty {
            defaults.removeObject(forKey: key)
        } else {
            defaults.set(trimmed, forKey: key)
        }
    }

    static func saveViews(_ views: [DashboardViewItem], profileId: String, apiClient: APIClient) async throws -> [DashboardViewItem] {
        let payloadViews = views.map(\.payload)
        let response = try await apiClient.put("/api/profiles/\(profileId)/dashboard-views", body: ["views": payloadViews])
        return DashboardSupport.views(fromDashboardViewsPayload: response)
    }

    static func loadLocalViews(serverURL: String, profileId: String?) -> [DashboardViewItem]? {
        let key = localViewsKey(serverURL: serverURL, profileId: profileId)
        guard let data = defaults.data(forKey: key),
              let json = try? JSONSerialization.jsonObject(with: data, options: []),
              let array = json as? [Any] else {
            return nil
        }

        return normalizeViews(from: array)
    }

    static func storeLocalViews(_ views: [DashboardViewItem], serverURL: String, profileId: String?) {
        let key = localViewsKey(serverURL: serverURL, profileId: profileId)
        let payload = views.map(\.payload)
        if let data = try? JSONSerialization.data(withJSONObject: payload, options: []) {
            defaults.set(data, forKey: key)
        }
    }

    private static func preferenceKey(forProfileID profileId: String?) -> String {
        let suffix = (profileId?.isEmpty == false ? profileId! : "global")
        return "homebrain.ios.dashboard.default-view.\(suffix)"
    }

    private static func localViewsKey(serverURL: String, profileId: String?) -> String {
        let normalizedServer = serverURL
            .lowercased()
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "https://", with: "")
            .replacingOccurrences(of: "http://", with: "")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: ":", with: "_")
        let suffix = (profileId?.isEmpty == false ? profileId! : "global")
        return "homebrain.ios.dashboard.views.\(normalizedServer).\(suffix)"
    }

    private static func normalizeStringArray(_ values: [String]?) -> [String]? {
        guard let values else {
            return nil
        }

        var seen = Set<String>()
        var normalized: [String] = []
        normalized.reserveCapacity(values.count)

        for value in values {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, !seen.contains(trimmed) else {
                continue
            }

            seen.insert(trimmed)
            normalized.append(trimmed)
        }

        return normalized
    }

    private static func stringArray(from rawValue: Any?) -> [String]? {
        guard let rawArray = rawValue as? [Any] else {
            return nil
        }

        let values = rawArray.compactMap { value -> String? in
            guard let stringValue = value as? String else {
                return nil
            }
            return stringValue
        }

        return normalizeStringArray(values)
    }

    private static func normalizeView(from raw: Any, index: Int) -> DashboardViewItem? {
        let object = JSON.object(raw)
        guard !object.isEmpty else {
            return nil
        }

        let fallback = defaultView(name: index == 0 ? "Main Dashboard" : "Dashboard \(index + 1)")
        let rawWidgets = object["widgets"] as? [Any]
        let normalizedWidgets = (rawWidgets ?? []).enumerated().compactMap { normalizeWidget(from: $0.element, index: $0.offset) }
        let resolvedWidgets = rawWidgets == nil ? fallback.widgets : normalizedWidgets

        return DashboardViewItem(
            id: sanitizedTitle(FavoritesSupport.optionalProfileID(from: object) ?? JSON.string(object, "id"), fallback: fallback.id),
            name: sanitizedTitle(JSON.string(object, "name"), fallback: index == 0 ? "Main Dashboard" : "Dashboard \(index + 1)"),
            widgets: resolvedWidgets
        )
    }

    private static func normalizeWidget(from raw: Any, index: Int) -> DashboardWidgetItem? {
        let object = JSON.object(raw)
        guard !object.isEmpty else {
            return nil
        }

        let typeRaw = JSON.string(object, "type")
        guard let type = DashboardWidgetType(rawValue: typeRaw) else {
            return nil
        }

        let size = DashboardWidgetSize(rawValue: JSON.string(object, "size")) ?? defaultWidgetDescriptors.first(where: { $0.0 == type })?.2 ?? .medium
        let settingsObject = JSON.object(object["settings"])
        let deviceId = JSON.optionalString(settingsObject, "deviceId")
        let deviceIds = stringArray(from: settingsObject["deviceIds"]) ?? []
        let weatherLocationMode = DashboardWeatherLocationMode(rawValue: JSON.string(settingsObject, "weatherLocationMode")) ?? .saved
        let weatherLocationQuery = JSON.optionalString(settingsObject, "weatherLocationQuery")?.trimmingCharacters(in: .whitespacesAndNewlines)
        let favoriteDeviceSizes = JSON.object(settingsObject["favoriteDeviceSizes"]).reduce(into: [String: DashboardFavoriteDeviceCardSize]()) { accumulator, entry in
            let deviceId = entry.key.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !deviceId.isEmpty,
                  let value = entry.value as? String,
                  let size = DashboardFavoriteDeviceCardSize(rawValue: value.trimmingCharacters(in: .whitespacesAndNewlines)) else {
                return
            }

            accumulator[deviceId] = size
        }

        if type == .device && (deviceId == nil || deviceId?.isEmpty == true) {
            return nil
        }

        if type == .devices && deviceIds.isEmpty {
            return nil
        }

        return DashboardWidgetItem(
            id: sanitizedTitle(JSON.string(object, "id"), fallback: createID(prefix: "widget-\(index + 1)")),
            type: type,
            title: sanitizedTitle(JSON.string(object, "title"), fallback: defaultWidgetDescriptors.first(where: { $0.0 == type })?.1 ?? type.title),
            size: size,
            minimized: JSON.bool(object, "minimized"),
            settings: DashboardWidgetSettings(
                deviceId: deviceId,
                deviceIds: deviceIds,
                favoriteDeviceSizes: favoriteDeviceSizes,
                weatherLocationMode: weatherLocationMode,
                weatherLocationQuery: weatherLocationMode == .custom ? weatherLocationQuery : nil
            )
        )
    }

    private static func preferredProfile(from rawProfiles: [Any]) -> [String: Any]? {
        let profiles = rawProfiles.map { JSON.object($0) }.filter { !$0.isEmpty }
        return profiles.first(where: { JSON.bool($0, "active", fallback: false) }) ?? profiles.first
    }

    private static func sanitizedTitle(_ value: String?, fallback: String) -> String {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? fallback : trimmed
    }
}
