import Foundation

enum WatchSection: String, Codable, CaseIterable, Identifiable {
    case security
    case lights
    case power
    case weather

    var id: String { rawValue }

    var title: String {
        switch self {
        case .security: return "Security"
        case .lights: return "Lights"
        case .power: return "Power"
        case .weather: return "Weather"
        }
    }

    var symbolName: String {
        switch self {
        case .security: return "shield.lefthalf.filled"
        case .lights: return "lightbulb.fill"
        case .power: return "bolt.fill"
        case .weather: return "cloud.sun.fill"
        }
    }
}

struct AuthTokens: Decodable {
    let accessToken: String?
    let refreshToken: String?
}

struct RefreshResponse: Decodable {
    let success: Bool?
    let data: AuthTokens?
    let accessToken: String?
    let refreshToken: String?

    var tokens: AuthTokens {
        AuthTokens(
            accessToken: data?.accessToken ?? accessToken,
            refreshToken: data?.refreshToken ?? refreshToken
        )
    }
}

struct APIErrorResponse: Decodable {
    let message: String?
    let error: String?
}

struct WatchConfig: Codable, Equatable {
    var sections: [WatchSection]
    var primaryRoom: String
    var lightDeviceIds: [String]
    var defaultLightBrightness: Int

    static let empty = WatchConfig(
        sections: [.security, .lights, .power, .weather],
        primaryRoom: "",
        lightDeviceIds: [],
        defaultLightBrightness: 70
    )

    enum CodingKeys: String, CodingKey {
        case sections
        case primaryRoom
        case lightDeviceIds
        case defaultLightBrightness
    }

    init(sections: [WatchSection], primaryRoom: String, lightDeviceIds: [String], defaultLightBrightness: Int) {
        self.sections = sections.isEmpty ? Self.empty.sections : sections
        self.primaryRoom = primaryRoom
        self.lightDeviceIds = lightDeviceIds
        self.defaultLightBrightness = max(1, min(100, defaultLightBrightness))
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let rawSections = try container.decodeIfPresent([String].self, forKey: .sections) ?? []
        let decodedSections = rawSections.compactMap(WatchSection.init(rawValue:))
        sections = decodedSections.isEmpty ? Self.empty.sections : decodedSections
        primaryRoom = try container.decodeIfPresent(String.self, forKey: .primaryRoom) ?? ""
        lightDeviceIds = try container.decodeIfPresent([String].self, forKey: .lightDeviceIds) ?? []
        let brightness = try container.decodeIfPresent(Int.self, forKey: .defaultLightBrightness) ?? Self.empty.defaultLightBrightness
        defaultLightBrightness = max(1, min(100, brightness))
    }
}

struct WatchUser: Codable, Equatable {
    let id: String
    let name: String
    let email: String
}

struct WatchRoomSummary: Codable, Identifiable, Equatable {
    var id: String { name }
    let name: String
    let lightCount: Int
    let onlineCount: Int
    let onCount: Int
    let dimmableCount: Int
}

struct WatchLightDevice: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    let room: String
    let type: String
    let isOn: Bool
    let isOnline: Bool
    let brightness: Int?
    let dimmable: Bool
}

struct WatchSecuritySection: Codable, Equatable {
    let available: Bool
    let alarmState: String?
    let stateLabel: String?
    let isArmed: Bool?
    let isTriggered: Bool?
    let isOnline: Bool?
    let sensorCount: Int?
    let activeSensorCount: Int?
    let attentionSensorCount: Int?
    let offlineSensorCount: Int?
    let lowBatterySensorCount: Int?
    let doorLockCount: Int?
    let unlockedDoorCount: Int?
    let error: String?
}

struct WatchLightsSection: Codable, Equatable {
    let available: Bool
    let room: String?
    let totalCount: Int?
    let onCount: Int?
    let onlineCount: Int?
    let dimmableCount: Int?
    let averageBrightness: Int?
    let defaultLightBrightness: Int?
    let devices: [WatchLightDevice]?
    let error: String?
}

struct WatchPowerDevice: Codable, Identifiable, Equatable {
    var id: String { name }
    let name: String
    let powerW: Double
    let sharePct: Double?
}

struct WatchPowerSection: Codable, Equatable {
    let available: Bool
    let monitorName: String?
    let observedAt: String?
    let powerW: Double?
    let solarW: Double?
    let netW: Double?
    let alwaysOnW: Double?
    let activeDeviceCount: Int?
    let currentCostUsdPerHour: Double?
    let dayKwh: Double?
    let projectedMonthUsd: Double?
    let activeDevices: [WatchPowerDevice]?
    let error: String?
}

struct WatchWeatherSection: Codable, Equatable {
    let available: Bool
    let fetchedAt: String?
    let locationName: String?
    let temperatureF: Double?
    let apparentTemperatureF: Double?
    let condition: String?
    let icon: String?
    let humidity: Double?
    let windSpeedMph: Double?
    let highF: Double?
    let lowF: Double?
    let precipitationChance: Double?
    let error: String?
}

struct WatchSections: Codable, Equatable {
    let security: WatchSecuritySection?
    let lights: WatchLightsSection?
    let power: WatchPowerSection?
    let weather: WatchWeatherSection?
}

struct WatchDashboard: Codable, Equatable {
    let generatedAt: String
    let user: WatchUser
    let config: WatchConfig
    let availableRooms: [WatchRoomSummary]
    let sections: WatchSections
}

struct WatchDashboardResponse: Decodable {
    let success: Bool
    let dashboard: WatchDashboard
}

struct WatchSecurityResponse: Decodable {
    let success: Bool
    let security: WatchSecuritySection
}

struct WatchLightsResponse: Decodable {
    let success: Bool
    let partialFailure: Bool?
    let lights: WatchLightsSection
}
