import SwiftUI

/// Shared device surfaces, with native controls layered above them.
struct HBDevicePanel<Content: View>: View {
    var bare = false
    var inset: CGFloat = 18
    @ViewBuilder let content: Content
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        content
            .padding(bare ? 0 : inset)
            .background {
                if !bare {
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .fill(colorScheme == .dark ? Color(red: 0.043, green: 0.094, blue: 0.165) : Color.white.opacity(0.88))
                        .overlay {
                            RoundedRectangle(cornerRadius: 22, style: .continuous)
                                .stroke(HBPalette.panelStrokeStrong.opacity(0.65), lineWidth: 1)
                        }
                }
            }
            .shadow(color: .black.opacity(bare ? 0 : (colorScheme == .dark ? 0.12 : 0.04)), radius: 12, y: 4)
    }
}

struct HBDashboardMetric: View {
    let title: String
    let value: String
    let detail: String
    let symbol: String
    let accent: Color

    var body: some View {
        HBDevicePanel(inset: 14) {
            HStack(spacing: 10) {
                Image(systemName: symbol)
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(accent)
                    .frame(width: 36, height: 40)
                    .background(accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(value)
                        .font(.system(.title2, design: .rounded, weight: .bold))
                        .monospacedDigit()
                        .foregroundStyle(HBPalette.textPrimary)
                    Text(title)
                        .font(HBTypography.body(.caption, weight: .medium))
                        .foregroundStyle(HBPalette.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title), \(value). \(detail)")
    }
}

struct HBDeviceTemperatureDial: View {
    let target: Int
    let current: Int?
    let mode: String
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var progress: CGFloat { CGFloat(min(max(Double(target - 55) / 35, 0), 1)) * 0.78 }

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                if !dynamicTypeSize.isAccessibilitySize {
                Circle().trim(from: 0, to: 0.78)
                    .stroke(HBPalette.textSecondary.opacity(0.12), style: StrokeStyle(lineWidth: 9, lineCap: .round))
                    .rotationEffect(.degrees(130))
                Circle().trim(from: 0, to: progress)
                    .stroke(HBPalette.accentBlue.opacity(mode == "off" ? 0.35 : 1), style: StrokeStyle(lineWidth: 9, lineCap: .round))
                    .rotationEffect(.degrees(130))
                }
                VStack(spacing: 2) {
                    Text("\(target)°")
                        .font(.system(.largeTitle, design: .rounded, weight: .bold))
                        .monospacedDigit()
                        .foregroundStyle(HBPalette.textPrimary)
                    Text("Target · °F")
                        .font(HBTypography.body(.caption))
                        .foregroundStyle(HBPalette.textSecondary)
                }
            }
            .frame(width: dynamicTypeSize.isAccessibilitySize ? nil : 150, height: dynamicTypeSize.isAccessibilitySize ? nil : 150)
            Text("Current \(current.map { "\($0)°F" } ?? "unavailable") · \(mode.capitalized)")
                .font(HBTypography.body(.caption))
                .foregroundStyle(HBPalette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Target \(target) degrees Fahrenheit, current \(current.map(String.init) ?? "unavailable"), \(mode)")
    }
}

struct HBDashboardWelcomeTitle: View {
    @Environment(\.colorScheme) private var colorScheme
    var body: some View {
        Text("Welcome \(Text("home.").foregroundColor(colorScheme == .dark ? Color(red: 0.36, green: 0.87, blue: 0.96) : Color(red: 0.05, green: 0.43, blue: 0.57)))")
            .foregroundStyle(HBPalette.textPrimary)
            .font(.system(.largeTitle, design: .rounded, weight: .bold))
            .tracking(-1.4)
            .fixedSize(horizontal: false, vertical: true)
    }
}

struct HBDeviceSymbol: View {
    let symbol: String
    let accent: Color
    let glowingLight: Bool
    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 23, weight: .medium))
            .foregroundStyle(glowingLight ? Color(red: 0.35, green: 0.2, blue: 0) : accent)
            .frame(width: 48, height: 48)
            .background {
                Circle().fill(glowingLight
                    ? LinearGradient(colors: [Color(red: 1, green: 0.88, blue: 0.54), Color(red: 0.96, green: 0.68, blue: 0.13)], startPoint: .topLeading, endPoint: .bottomTrailing)
                    : LinearGradient(colors: [accent.opacity(0.2), accent.opacity(0.1)], startPoint: .topLeading, endPoint: .bottomTrailing))
            }
            .shadow(color: accent.opacity(glowingLight ? 0.18 : 0.06), radius: 10)
            .accessibilityHidden(true)
    }
}

/// Semantic state colors shared by dashboard cards and device management.
enum HBDeviceAppearance {
    static func accent(for type: String) -> Color {
        switch type {
        case "light": HBPalette.accentOrange
        case "lock": HBPalette.accentGreen
        case "sensor", "speaker": HBPalette.accentPurple
        case "siren": HBPalette.accentOrange
        default: HBPalette.accentBlue
        }
    }
}

struct HBDeviceModeButton: View {
    let title: String
    let selected: Bool
    let disabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title.capitalized)
                .font(HBTypography.body(.subheadline, weight: .semibold))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, minHeight: 44)
                .foregroundStyle(HBPalette.textPrimary)
                .background(HBPalette.accentBlue.opacity(selected ? 0.2 : 0.05), in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(HBPalette.accentBlue.opacity(selected ? 0.5 : 0.14), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .disabled(disabled)
    }
}
