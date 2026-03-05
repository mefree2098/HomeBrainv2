import SwiftUI
import Combine

@MainActor
final class UIPreviewStore: ObservableObject {
    @Published var isEnabled: Bool {
        didSet { defaults.set(isEnabled, forKey: enabledKey) }
    }

    @Published var selectedSectionRaw: String {
        didSet { defaults.set(selectedSectionRaw, forKey: sectionKey) }
    }

    private let defaults = UserDefaults.standard
    private let enabledKey = "homebrain.ios.ui-preview.enabled"
    private let sectionKey = "homebrain.ios.ui-preview.section"

    init() {
        let forcedSection = Self.previewSectionFromLaunch()
        let forcedEnabled = Self.previewEnabledFromLaunch() || forcedSection != nil

        isEnabled = forcedEnabled || defaults.bool(forKey: enabledKey)
        selectedSectionRaw = forcedSection
            ?? defaults.string(forKey: sectionKey)
            ?? AppShellView.AppSection.dashboard.rawValue
    }

    var selectedSection: AppShellView.AppSection {
        AppShellView.AppSection(rawValue: selectedSectionRaw) ?? .dashboard
    }

    func enter(section: AppShellView.AppSection) {
        selectedSectionRaw = section.rawValue
        isEnabled = true
    }

    func updateSection(_ section: AppShellView.AppSection) {
        selectedSectionRaw = section.rawValue
    }

    func exit() {
        isEnabled = false
    }

    private static func previewEnabledFromLaunch() -> Bool {
        let processInfo = ProcessInfo.processInfo
        if processInfo.arguments.contains("-ui-preview") {
            return true
        }

        if let environmentValue = processInfo.environment["UI_PREVIEW_ENABLED"] {
            return ["1", "true", "yes"].contains(environmentValue.lowercased())
        }

        return false
    }

    private static func previewSectionFromLaunch() -> String? {
        let processInfo = ProcessInfo.processInfo

        if let index = processInfo.arguments.firstIndex(of: "-ui-preview-section"),
           processInfo.arguments.indices.contains(index + 1) {
            return processInfo.arguments[index + 1]
        }

        return processInfo.environment["UI_PREVIEW_SECTION"]
    }
}

enum UIPreviewData {
    static let favoriteProfileId = "preview-profile"
    static let favoriteDeviceIds: Set<String> = ["preview-thermostat", "preview-patio", "preview-living-room"]

    static let devices: [DeviceItem] = [
        DeviceItem(
            id: "preview-thermostat",
            name: "Upstairs Climate Array",
            type: "thermostat",
            room: "Upper Hall",
            status: true,
            isOnline: true,
            brightness: 0,
            color: "#ffffff",
            temperature: 69,
            targetTemperature: 71,
            properties: [
                "hvacMode": "cool",
                "smartThingsThermostatMode": "cool",
                "smartThingsLastActiveThermostatMode": "cool"
            ],
            lastSeen: "Just now"
        ),
        DeviceItem(
            id: "preview-patio",
            name: "Patio Lights",
            type: "light",
            room: "Back Patio",
            status: true,
            isOnline: true,
            brightness: 68,
            color: "#8fdcff",
            temperature: nil,
            targetTemperature: nil,
            properties: [
                "supportsBrightness": true,
                "supportsColor": true
            ],
            lastSeen: "Just now"
        ),
        DeviceItem(
            id: "preview-living-room",
            name: "Living Room Lamp",
            type: "light",
            room: "Living Room",
            status: false,
            isOnline: true,
            brightness: 0,
            color: "#ffd391",
            temperature: nil,
            targetTemperature: nil,
            properties: [
                "supportsBrightness": true,
                "supportsColor": true
            ],
            lastSeen: "1m ago"
        ),
        DeviceItem(
            id: "preview-bedside",
            name: "Primary Bedside Light Strip",
            type: "light",
            room: "Main Bedroom",
            status: true,
            isOnline: true,
            brightness: 25,
            color: "#b1a4ff",
            temperature: nil,
            targetTemperature: nil,
            properties: [
                "supportsBrightness": true,
                "supportsColor": true
            ],
            lastSeen: "2m ago"
        ),
        DeviceItem(
            id: "preview-camera",
            name: "Back Porch Camera",
            type: "camera",
            room: "Exterior",
            status: true,
            isOnline: true,
            brightness: 0,
            color: "#ffffff",
            temperature: nil,
            targetTemperature: nil,
            properties: [:],
            lastSeen: "3m ago"
        ),
        DeviceItem(
            id: "preview-lock",
            name: "Front Door Lock",
            type: "lock",
            room: "Entry",
            status: true,
            isOnline: true,
            brightness: 0,
            color: "#ffffff",
            temperature: nil,
            targetTemperature: nil,
            properties: [:],
            lastSeen: "5m ago"
        ),
        DeviceItem(
            id: "preview-speaker",
            name: "Kitchen Speaker Cluster",
            type: "switch",
            room: "Kitchen",
            status: false,
            isOnline: true,
            brightness: 0,
            color: "#ffffff",
            temperature: nil,
            targetTemperature: nil,
            properties: [:],
            lastSeen: "8m ago"
        )
    ]

    static let scenes: [SceneItem] = [
        SceneItem(id: "scene-movie", name: "Movie Night", details: "Dim lights, close shades, activate surround sound", active: false, category: "entertainment", activationCount: 42),
        SceneItem(id: "scene-bedtime", name: "Bedtime Shutdown", details: "Secure doors, dim hallways, reduce climate", active: false, category: "comfort", activationCount: 31),
        SceneItem(id: "scene-focus", name: "Focus Mode", details: "Brighten office, mute distractions, start concentration soundtrack", active: true, category: "comfort", activationCount: 18)
    ]

    static let voiceDevices: [VoiceDeviceItem] = [
        VoiceDeviceItem(
            id: "voice-main",
            name: "Hallway Voice Hub",
            room: "Main Hall",
            deviceType: "speaker",
            status: "online",
            batteryLevel: nil,
            volume: 52,
            microphoneSensitivity: 61,
            firmwareVersion: "2.8.4",
            lastSeen: "Just now"
        )
    ]
}

struct UIPreviewModuleView: View {
    let section: AppShellView.AppSection

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HBSectionHeader(
                    title: section.title,
                    subtitle: "UI preview mode renders this module without authentication or live hub data.",
                    eyebrow: section.chromeKicker
                )

                HBPanel {
                    VStack(alignment: .leading, spacing: 14) {
                        HStack(spacing: 8) {
                            HBBadge(text: "UI Preview Mode")
                            HBBadge(text: section.chromeLabel)
                        }

                        Text("This module is currently shown with preview scaffolding so you can inspect spacing, color, hierarchy, and responsive behavior before connecting to live services.")
                            .font(.system(size: 15, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textSecondary)

                        if section == .settings {
                            HStack(spacing: 12) {
                                MetricCard(title: "Appearance", value: "Adaptive", subtitle: "Light and dark ready", tint: HBPalette.accentBlue)
                                MetricCard(title: "Voice", value: "Standby", subtitle: "Preview transport", tint: HBPalette.accentGreen)
                            }
                        } else {
                            HStack(spacing: 12) {
                                MetricCard(title: "Surface", value: "Ready", subtitle: "Glass shell rendered", tint: HBPalette.accentBlue)
                                MetricCard(title: "Data", value: "Preview", subtitle: "Mocked locally", tint: HBPalette.accentPurple)
                            }
                        }
                    }
                }

                HBPanel {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Inspection Notes")
                            .font(.system(size: 11, weight: .bold, design: .rounded))
                            .textCase(.uppercase)
                            .tracking(2.4)
                            .foregroundStyle(HBPalette.textMuted)

                        Text("Use the sidebar to jump between modules, or exit preview mode from the shell chrome to return to authentication.")
                            .font(.system(size: 15, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textSecondary)
                    }
                }
            }
            .padding(16)
            .padding(.bottom, 12)
        }
        .scrollIndicators(.hidden)
    }
}
