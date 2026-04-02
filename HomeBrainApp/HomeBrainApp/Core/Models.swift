import Foundation

nonisolated struct AppUserPlatforms: Codable {
    let homebrain: Bool
    let axiom: Bool

    init(homebrain: Bool = true, axiom: Bool = false) {
        self.homebrain = homebrain
        self.axiom = axiom
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        homebrain = try container.decodeIfPresent(Bool.self, forKey: .homebrain) ?? true
        axiom = try container.decodeIfPresent(Bool.self, forKey: .axiom) ?? false
    }

    nonisolated static func from(_ object: [String: Any]) -> AppUserPlatforms {
        AppUserPlatforms(
            homebrain: JSON.bool(object, "homebrain", fallback: true),
            axiom: JSON.bool(object, "axiom", fallback: false)
        )
    }
}

nonisolated struct AppUser: Codable, Identifiable {
    let id: String
    let name: String
    let email: String
    let role: String
    let platforms: AppUserPlatforms

    var hasHomeBrainAccess: Bool {
        platforms.homebrain
    }

    nonisolated static func from(_ object: [String: Any]) -> AppUser? {
        let id = JSON.id(object)
        let email = JSON.string(object, "email")
        if email.isEmpty {
            return nil
        }

        return AppUser(
            id: id,
            name: JSON.string(object, "name", fallback: email),
            email: email,
            role: JSON.string(object, "role", fallback: "user"),
            platforms: AppUserPlatforms.from(JSON.object(object["platforms"]))
        )
    }
}

nonisolated struct DeviceItem: Identifiable {
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

    nonisolated static func from(_ object: [String: Any]) -> DeviceItem {
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

    private nonisolated static func optionalDouble(_ value: Any?) -> Double? {
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

    private nonisolated static func normalizedHexColor(_ value: Any?) -> String {
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

nonisolated struct SceneItem: Identifiable {
    let id: String
    var name: String
    var details: String
    var active: Bool
    var category: String
    var activationCount: Int

    nonisolated static func from(_ object: [String: Any]) -> SceneItem {
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

nonisolated struct AutomationItem: Identifiable {
    let id: String
    var name: String
    var details: String
    var enabled: Bool
    var category: String
    var priority: Int
    var executionCount: Int
    var lastRun: String

    nonisolated static func from(_ object: [String: Any]) -> AutomationItem {
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

nonisolated struct WorkflowItem: Identifiable {
    let id: String
    var name: String
    var details: String
    var enabled: Bool
    var category: String
    var priority: Int
    var executionCount: Int
    var lastRun: String
    var triggerType: String
    var actionCount: Int
    var voiceAliases: [String]
    var lastErrorMessage: String?

    nonisolated static func from(_ object: [String: Any]) -> WorkflowItem {
        let trigger = JSON.object(object["trigger"])
        let lastError = JSON.object(object["lastError"])
        return WorkflowItem(
            id: JSON.id(object),
            name: JSON.string(object, "name", fallback: "Untitled Workflow"),
            details: JSON.string(object, "description", fallback: "No description"),
            enabled: JSON.bool(object, "enabled", fallback: true),
            category: JSON.string(object, "category", fallback: "custom"),
            priority: JSON.int(object, "priority", fallback: 5),
            executionCount: JSON.int(object, "executionCount"),
            lastRun: JSON.displayDate(from: object["lastRun"]),
            triggerType: JSON.string(trigger, "type", fallback: "manual"),
            actionCount: JSON.array(object["actions"]).count,
            voiceAliases: (object["voiceAliases"] as? [String]) ?? [],
            lastErrorMessage: JSON.optionalString(lastError, "message")
        )
    }
}

nonisolated struct WorkflowRuntimeEventItem {
    let type: String
    let level: String
    let message: String
    let details: [String: Any]
    let createdAt: String?

    var createdAtDisplay: String {
        JSON.displayDate(from: createdAt)
    }

    nonisolated static func from(_ object: [String: Any]) -> WorkflowRuntimeEventItem {
        WorkflowRuntimeEventItem(
            type: JSON.string(object, "type", fallback: "automation.runtime"),
            level: JSON.string(object, "level", fallback: "info"),
            message: JSON.string(object, "message", fallback: "Automation runtime update"),
            details: JSON.object(object["details"]),
            createdAt: JSON.optionalString(object, "createdAt")
        )
    }
}

nonisolated struct WorkflowNextActionItem {
    let actionIndex: Int?
    let parentActionIndex: Int?
    let actionType: String
    let target: Any?
    let message: String

    nonisolated static func from(_ object: [String: Any]) -> WorkflowNextActionItem {
        WorkflowNextActionItem(
            actionIndex: object["actionIndex"] == nil ? nil : JSON.int(object, "actionIndex"),
            parentActionIndex: object["parentActionIndex"] == nil ? nil : JSON.int(object, "parentActionIndex"),
            actionType: JSON.string(object, "actionType", fallback: "unknown"),
            target: object["target"],
            message: JSON.string(object, "message", fallback: "Workflow completes")
        )
    }
}

nonisolated struct WorkflowActionTimerItem {
    let durationMs: Double?
    let endsAt: String?

    var endsAtDate: Date? {
        JSON.date(from: endsAt)
    }

    nonisolated static func from(_ object: [String: Any]) -> WorkflowActionTimerItem? {
        let durationValue = object["durationMs"] == nil ? nil : JSON.double(object, "durationMs")
        let endsAt = JSON.optionalString(object, "endsAt")
        if durationValue == nil && endsAt == nil {
            return nil
        }

        return WorkflowActionTimerItem(
            durationMs: durationValue,
            endsAt: endsAt
        )
    }
}

nonisolated struct WorkflowCurrentActionItem {
    let actionIndex: Int?
    let parentActionIndex: Int?
    let actionType: String
    let target: Any?
    let startedAt: String?
    let updatedAt: String?
    let message: String
    let timer: WorkflowActionTimerItem?
    let nextAction: WorkflowNextActionItem?

    var startedAtDate: Date? {
        JSON.date(from: startedAt)
    }

    nonisolated static func from(_ object: [String: Any]) -> WorkflowCurrentActionItem {
        WorkflowCurrentActionItem(
            actionIndex: object["actionIndex"] == nil ? nil : JSON.int(object, "actionIndex"),
            parentActionIndex: object["parentActionIndex"] == nil ? nil : JSON.int(object, "parentActionIndex"),
            actionType: JSON.string(object, "actionType", fallback: "unknown"),
            target: object["target"],
            startedAt: JSON.optionalString(object, "startedAt"),
            updatedAt: JSON.optionalString(object, "updatedAt"),
            message: JSON.string(object, "message", fallback: "Running action"),
            timer: WorkflowActionTimerItem.from(JSON.object(object["timer"])),
            nextAction: object["nextAction"] == nil ? nil : WorkflowNextActionItem.from(JSON.object(object["nextAction"]))
        )
    }
}

nonisolated struct WorkflowExecutionHistoryItem: Identifiable {
    let id: String
    let automationId: String
    let automationName: String
    let workflowId: String?
    let workflowName: String?
    let triggerType: String
    let triggerSource: String
    let correlationId: String?
    let status: String
    let startedAt: String?
    let completedAt: String?
    let durationMs: Double?
    let totalActions: Int
    let successfulActions: Int
    let failedActions: Int
    let triggerContext: [String: Any]
    let currentAction: WorkflowCurrentActionItem?
    let lastEvent: WorkflowRuntimeEventItem?
    let runtimeEvents: [WorkflowRuntimeEventItem]
    let actionResults: [Any]
    let errorDetails: [String: Any]
    let rawObject: [String: Any]

    var displayName: String {
        if let workflowName, !workflowName.isEmpty {
            return workflowName
        }
        return automationName.isEmpty ? "Workflow" : automationName
    }

    var startedAtDisplay: String {
        JSON.displayDate(from: startedAt)
    }

    var completedAtDisplay: String {
        JSON.displayDate(from: completedAt)
    }

    nonisolated static func from(_ object: [String: Any]) -> WorkflowExecutionHistoryItem {
        WorkflowExecutionHistoryItem(
            id: JSON.id(object),
            automationId: JSON.string(object, "automationId"),
            automationName: JSON.string(object, "automationName", fallback: "Workflow"),
            workflowId: JSON.optionalString(object, "workflowId"),
            workflowName: JSON.optionalString(object, "workflowName"),
            triggerType: JSON.string(object, "triggerType", fallback: "manual"),
            triggerSource: JSON.string(object, "triggerSource", fallback: "manual"),
            correlationId: JSON.optionalString(object, "correlationId"),
            status: JSON.string(object, "status", fallback: "running"),
            startedAt: JSON.optionalString(object, "startedAt"),
            completedAt: JSON.optionalString(object, "completedAt"),
            durationMs: object["durationMs"] == nil ? nil : JSON.double(object, "durationMs"),
            totalActions: JSON.int(object, "totalActions"),
            successfulActions: JSON.int(object, "successfulActions"),
            failedActions: JSON.int(object, "failedActions"),
            triggerContext: JSON.object(object["triggerContext"]),
            currentAction: object["currentAction"] == nil ? nil : WorkflowCurrentActionItem.from(JSON.object(object["currentAction"])),
            lastEvent: object["lastEvent"] == nil ? nil : WorkflowRuntimeEventItem.from(JSON.object(object["lastEvent"])),
            runtimeEvents: JSON.array(object["runtimeEvents"]).map(WorkflowRuntimeEventItem.from),
            actionResults: (object["actionResults"] as? [Any]) ?? [],
            errorDetails: JSON.object(object["error"]),
            rawObject: object
        )
    }
}

nonisolated struct WorkflowRuntimePaginationItem {
    let page: Int
    let limit: Int
    let total: Int
    let totalPages: Int
    let hasPreviousPage: Bool
    let hasNextPage: Bool

    static let empty = WorkflowRuntimePaginationItem(
        page: 1,
        limit: 50,
        total: 0,
        totalPages: 1,
        hasPreviousPage: false,
        hasNextPage: false
    )

    nonisolated static func from(_ object: [String: Any]) -> WorkflowRuntimePaginationItem {
        WorkflowRuntimePaginationItem(
            page: JSON.int(object, "page", fallback: 1),
            limit: JSON.int(object, "limit", fallback: 50),
            total: JSON.int(object, "total"),
            totalPages: JSON.int(object, "totalPages", fallback: 1),
            hasPreviousPage: JSON.bool(object, "hasPreviousPage"),
            hasNextPage: JSON.bool(object, "hasNextPage")
        )
    }
}

nonisolated struct WorkflowRuntimeTelemetryItem {
    let runningNow: Int
    let executionCount: Int
    let successCount: Int
    let partialSuccessCount: Int
    let failedCount: Int
    let cancelledCount: Int
    let runningCountInRange: Int
    let totalActions: Int
    let successfulActions: Int
    let failedActions: Int
    let averageDurationMs: Double?
    let failureRatePct: Double
    let lastStartedAt: String?
    let lastCompletedAt: String?
    let timeRangeHours: Int?

    static let empty = WorkflowRuntimeTelemetryItem(
        runningNow: 0,
        executionCount: 0,
        successCount: 0,
        partialSuccessCount: 0,
        failedCount: 0,
        cancelledCount: 0,
        runningCountInRange: 0,
        totalActions: 0,
        successfulActions: 0,
        failedActions: 0,
        averageDurationMs: nil,
        failureRatePct: 0,
        lastStartedAt: nil,
        lastCompletedAt: nil,
        timeRangeHours: nil
    )

    nonisolated static func from(_ object: [String: Any]) -> WorkflowRuntimeTelemetryItem {
        let timeRange = JSON.object(object["timeRange"])
        return WorkflowRuntimeTelemetryItem(
            runningNow: JSON.int(object, "runningNow"),
            executionCount: JSON.int(object, "executionCount"),
            successCount: JSON.int(object, "successCount"),
            partialSuccessCount: JSON.int(object, "partialSuccessCount"),
            failedCount: JSON.int(object, "failedCount"),
            cancelledCount: JSON.int(object, "cancelledCount"),
            runningCountInRange: JSON.int(object, "runningCountInRange"),
            totalActions: JSON.int(object, "totalActions"),
            successfulActions: JSON.int(object, "successfulActions"),
            failedActions: JSON.int(object, "failedActions"),
            averageDurationMs: object["averageDurationMs"] == nil ? nil : JSON.double(object, "averageDurationMs"),
            failureRatePct: JSON.double(object, "failureRatePct"),
            lastStartedAt: JSON.optionalString(object, "lastStartedAt"),
            lastCompletedAt: JSON.optionalString(object, "lastCompletedAt"),
            timeRangeHours: timeRange["hours"] == nil ? nil : JSON.int(timeRange, "hours")
        )
    }
}

nonisolated struct VoiceDeviceItem: Identifiable {
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

    nonisolated static func from(_ object: [String: Any]) -> VoiceDeviceItem {
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

nonisolated struct UserProfileItem: Identifiable {
    let id: String
    var name: String
    var wakeWords: [String]
    var voiceId: String
    var voiceName: String
    var active: Bool
    var lastUsed: String

    nonisolated static func from(_ object: [String: Any]) -> UserProfileItem {
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

nonisolated struct VoiceOption: Identifiable {
    let id: String
    let name: String
    let category: String
    let previewURL: String

    nonisolated static func from(_ object: [String: Any]) -> VoiceOption {
        VoiceOption(
            id: JSON.optionalString(object, "voice_id") ?? JSON.optionalString(object, "id") ?? JSON.id(object),
            name: JSON.string(object, "name", fallback: "Unnamed Voice"),
            category: JSON.string(object, "category", fallback: "unknown"),
            previewURL: JSON.string(object, "preview_url")
        )
    }
}

nonisolated struct PlatformEventItem: Identifiable {
    let id: String
    let sequence: Int
    let type: String
    let source: String
    let category: String
    let severity: String
    let correlationId: String?
    let createdAt: String
    let payload: [String: Any]
    let payloadMessage: String?
    let payloadSummary: String

    nonisolated static func from(_ object: [String: Any]) -> PlatformEventItem {
        let payload = JSON.object(object["payload"])
        return PlatformEventItem(
            id: JSON.optionalString(object, "id") ?? String(JSON.int(object, "sequence")),
            sequence: JSON.int(object, "sequence"),
            type: JSON.string(object, "type", fallback: "unknown"),
            source: JSON.string(object, "source", fallback: "unknown"),
            category: JSON.string(object, "category", fallback: "general"),
            severity: JSON.string(object, "severity", fallback: "info"),
            correlationId: JSON.optionalString(object, "correlationId"),
            createdAt: JSON.displayDate(from: object["createdAt"]),
            payload: payload,
            payloadMessage: JSON.optionalString(payload, "message"),
            payloadSummary: JSON.prettyString(payload)
        )
    }
}

nonisolated struct SSLCertificateItem: Identifiable {
    let id: String
    let domain: String
    let status: String
    let provider: String
    let expiryDate: String

    nonisolated static func from(_ object: [String: Any]) -> SSLCertificateItem {
        SSLCertificateItem(
            id: JSON.id(object),
            domain: JSON.string(object, "domain", fallback: "Unknown domain"),
            status: JSON.string(object, "status", fallback: "inactive"),
            provider: JSON.string(object, "provider", fallback: "manual"),
            expiryDate: JSON.displayDate(from: object["expiryDate"])
        )
    }
}
