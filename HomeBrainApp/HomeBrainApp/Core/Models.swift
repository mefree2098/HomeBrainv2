import Foundation

struct AppUser: Codable, Identifiable {
    let id: String
    let name: String
    let email: String
    let role: String

    static func from(_ object: [String: Any]) -> AppUser? {
        let id = JSON.id(object)
        let email = JSON.string(object, "email")
        if email.isEmpty {
            return nil
        }

        return AppUser(
            id: id,
            name: JSON.string(object, "name", fallback: email),
            email: email,
            role: JSON.string(object, "role", fallback: "user")
        )
    }
}

struct DeviceItem: Identifiable {
    let id: String
    var name: String
    var type: String
    var room: String
    var status: Bool
    var isOnline: Bool
    var brightness: Double
    var color: String
    var temperature: Double?
    var targetTemperature: Double?
    var properties: [String: Any]
    var lastSeen: String

    static func from(_ object: [String: Any]) -> DeviceItem {
        let properties = JSON.object(object["properties"])

        return DeviceItem(
            id: JSON.id(object),
            name: JSON.string(object, "name", fallback: "Unnamed Device"),
            type: JSON.string(object, "type", fallback: "unknown"),
            room: JSON.string(object, "room", fallback: "Unassigned"),
            status: JSON.bool(object, "status"),
            isOnline: JSON.bool(object, "isOnline", fallback: true),
            brightness: JSON.double(object, "brightness"),
            color: normalizedHexColor(object["color"]),
            temperature: optionalDouble(object["temperature"]),
            targetTemperature: optionalDouble(object["targetTemperature"]),
            properties: properties,
            lastSeen: JSON.displayDate(from: object["lastSeen"])
        )
    }

    private static func optionalDouble(_ value: Any?) -> Double? {
        if let raw = value as? Double {
            return raw
        }
        if let raw = value as? NSNumber {
            return raw.doubleValue
        }
        if let raw = value as? String, let parsed = Double(raw) {
            return parsed
        }
        return nil
    }

    private static func normalizedHexColor(_ value: Any?) -> String {
        guard let raw = value as? String else {
            return "#ffffff"
        }

        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let regex = try? NSRegularExpression(pattern: "^#[0-9a-fA-F]{6}$"),
              regex.firstMatch(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed)) != nil else {
            return "#ffffff"
        }

        return trimmed.lowercased()
    }
}

struct SceneItem: Identifiable {
    let id: String
    var name: String
    var details: String
    var active: Bool
    var category: String
    var activationCount: Int

    static func from(_ object: [String: Any]) -> SceneItem {
        SceneItem(
            id: JSON.id(object),
            name: JSON.string(object, "name", fallback: "Untitled Scene"),
            details: JSON.string(object, "description", fallback: "No description"),
            active: JSON.bool(object, "active"),
            category: JSON.string(object, "category", fallback: "custom"),
            activationCount: JSON.int(object, "activationCount")
        )
    }
}

struct AutomationItem: Identifiable {
    let id: String
    var name: String
    var details: String
    var enabled: Bool
    var category: String
    var priority: Int
    var executionCount: Int
    var lastRun: String

    static func from(_ object: [String: Any]) -> AutomationItem {
        AutomationItem(
            id: JSON.id(object),
            name: JSON.string(object, "name", fallback: "Untitled Automation"),
            details: JSON.string(object, "description", fallback: "No description"),
            enabled: JSON.bool(object, "enabled", fallback: true),
            category: JSON.string(object, "category", fallback: "custom"),
            priority: JSON.int(object, "priority", fallback: 5),
            executionCount: JSON.int(object, "executionCount"),
            lastRun: JSON.displayDate(from: object["lastRun"])
        )
    }
}

struct WorkflowItem: Identifiable {
    let id: String
    var name: String
    var details: String
    var enabled: Bool
    var category: String
    var priority: Int
    var executionCount: Int
    var lastRun: String

    static func from(_ object: [String: Any]) -> WorkflowItem {
        WorkflowItem(
            id: JSON.id(object),
            name: JSON.string(object, "name", fallback: "Untitled Workflow"),
            details: JSON.string(object, "description", fallback: "No description"),
            enabled: JSON.bool(object, "enabled", fallback: true),
            category: JSON.string(object, "category", fallback: "custom"),
            priority: JSON.int(object, "priority", fallback: 5),
            executionCount: JSON.int(object, "executionCount"),
            lastRun: JSON.displayDate(from: object["lastRun"])
        )
    }
}

struct VoiceDeviceItem: Identifiable {
    let id: String
    var name: String
    var room: String
    var deviceType: String
    var status: String
    var batteryLevel: Int?
    var volume: Int
    var microphoneSensitivity: Int
    var firmwareVersion: String
    var lastSeen: String

    static func from(_ object: [String: Any]) -> VoiceDeviceItem {
        let batteryRaw = object["batteryLevel"]
        let battery: Int?
        if let value = batteryRaw as? Int {
            battery = value
        } else if let value = batteryRaw as? NSNumber {
            battery = value.intValue
        } else {
            battery = nil
        }

        return VoiceDeviceItem(
            id: JSON.id(object),
            name: JSON.string(object, "name", fallback: "Unnamed Voice Device"),
            room: JSON.string(object, "room", fallback: "Unassigned"),
            deviceType: JSON.string(object, "deviceType", fallback: "speaker"),
            status: JSON.string(object, "status", fallback: "offline"),
            batteryLevel: battery,
            volume: JSON.int(object, "volume", fallback: 50),
            microphoneSensitivity: JSON.int(object, "microphoneSensitivity", fallback: 50),
            firmwareVersion: JSON.string(object, "firmwareVersion", fallback: "Unknown"),
            lastSeen: JSON.displayDate(from: object["lastSeen"])
        )
    }
}

struct UserProfileItem: Identifiable {
    let id: String
    var name: String
    var wakeWords: [String]
    var voiceId: String
    var voiceName: String
    var active: Bool
    var lastUsed: String

    static func from(_ object: [String: Any]) -> UserProfileItem {
        let wakeWords = (object["wakeWords"] as? [String]) ?? []
        return UserProfileItem(
            id: JSON.id(object),
            name: JSON.string(object, "name", fallback: "Unnamed Profile"),
            wakeWords: wakeWords,
            voiceId: JSON.string(object, "voiceId"),
            voiceName: JSON.string(object, "voiceName", fallback: "Unknown Voice"),
            active: JSON.bool(object, "active", fallback: true),
            lastUsed: JSON.displayDate(from: object["lastUsed"])
        )
    }
}

struct VoiceOption: Identifiable {
    let id: String
    let name: String
    let category: String
    let previewURL: String

    static func from(_ object: [String: Any]) -> VoiceOption {
        VoiceOption(
            id: JSON.optionalString(object, "voice_id") ?? JSON.optionalString(object, "id") ?? JSON.id(object),
            name: JSON.string(object, "name", fallback: "Unnamed Voice"),
            category: JSON.string(object, "category", fallback: "unknown"),
            previewURL: JSON.string(object, "preview_url")
        )
    }
}

struct PlatformEventItem: Identifiable {
    let id: String
    let sequence: Int
    let type: String
    let source: String
    let severity: String
    let createdAt: String
    let payloadSummary: String

    static func from(_ object: [String: Any]) -> PlatformEventItem {
        PlatformEventItem(
            id: JSON.optionalString(object, "id") ?? String(JSON.int(object, "sequence")),
            sequence: JSON.int(object, "sequence"),
            type: JSON.string(object, "type", fallback: "unknown"),
            source: JSON.string(object, "source", fallback: "unknown"),
            severity: JSON.string(object, "severity", fallback: "info"),
            createdAt: JSON.displayDate(from: object["createdAt"]),
            payloadSummary: JSON.prettyString(object["payload"])
        )
    }
}

struct SSLCertificateItem: Identifiable {
    let id: String
    let domain: String
    let status: String
    let provider: String
    let expiryDate: String

    static func from(_ object: [String: Any]) -> SSLCertificateItem {
        SSLCertificateItem(
            id: JSON.id(object),
            domain: JSON.string(object, "domain", fallback: "Unknown domain"),
            status: JSON.string(object, "status", fallback: "inactive"),
            provider: JSON.string(object, "provider", fallback: "manual"),
            expiryDate: JSON.displayDate(from: object["expiryDate"])
        )
    }
}
