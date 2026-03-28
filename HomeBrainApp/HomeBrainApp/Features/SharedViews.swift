import SwiftUI
import UIKit

enum HBThemeMode: String, CaseIterable, Identifiable {
    case system
    case light
    case dark

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: return "System"
        case .light: return "Light"
        case .dark: return "Dark"
        }
    }

    var symbol: String {
        switch self {
        case .system: return "circle.lefthalf.filled"
        case .light: return "sun.max"
        case .dark: return "moon.stars"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}

enum HBPalette {
    private static func dynamic(light: UIColor, dark: UIColor) -> Color {
        Color(
            uiColor: UIColor { traits in
                traits.userInterfaceStyle == .dark ? dark : light
            }
        )
    }

    private static func hex(_ value: UInt32, alpha: CGFloat = 1) -> UIColor {
        UIColor(
            red: CGFloat((value >> 16) & 0xFF) / 255,
            green: CGFloat((value >> 8) & 0xFF) / 255,
            blue: CGFloat(value & 0xFF) / 255,
            alpha: alpha
        )
    }

    static let pageTop = dynamic(light: hex(0xEEF5FF), dark: hex(0x061120))
    static let pageMid = dynamic(light: hex(0xDDE9FF), dark: hex(0x0B1831))
    static let pageBottom = dynamic(light: hex(0xC8D8F5), dark: hex(0x040A17))

    static let chrome = dynamic(light: hex(0xF7FAFF, alpha: 0.82), dark: hex(0x081324, alpha: 0.88))
    static let sidebar = dynamic(light: hex(0xF5F9FF, alpha: 0.78), dark: hex(0x081120, alpha: 0.94))
    static let panel = dynamic(light: hex(0xFFFFFF, alpha: 0.56), dark: hex(0x0A1730, alpha: 0.72))
    static let panelStrong = dynamic(light: hex(0xFFFFFF, alpha: 0.78), dark: hex(0x0A1730, alpha: 0.84))
    static let panelSoft = dynamic(light: hex(0xDDEBFF, alpha: 0.42), dark: hex(0x132442, alpha: 0.45))
    static let panelStroke = dynamic(light: hex(0xFFFFFF, alpha: 0.52), dark: hex(0x9CD4FF, alpha: 0.12))
    static let panelStrokeStrong = dynamic(light: hex(0x70AEFF, alpha: 0.28), dark: hex(0x50A7FF, alpha: 0.28))
    static let divider = dynamic(light: hex(0xD5E4FF, alpha: 0.78), dark: hex(0x224066, alpha: 0.55))

    static let textPrimary = dynamic(light: hex(0x16233A), dark: hex(0xF4F8FF))
    static let textSecondary = dynamic(light: hex(0x4D6387), dark: hex(0xB6C4DE))
    static let textMuted = dynamic(light: hex(0x7287A6), dark: hex(0x8CA0C2))

    static let accentBlue = dynamic(light: hex(0x46CFFF), dark: hex(0x4AE3FF))
    static let accentPurple = dynamic(light: hex(0x5A86FF), dark: hex(0x8F9BFF))
    static let accentGreen = dynamic(light: hex(0x22C98E), dark: hex(0x33E3AA))
    static let accentYellow = dynamic(light: hex(0xFFD84A), dark: hex(0xFFE46B))
    static let accentOrange = dynamic(light: hex(0xFFB547), dark: hex(0xFFC764))
    static let accentRed = dynamic(light: hex(0xFF6E61), dark: hex(0xFF8B7F))
    static let accentSlate = dynamic(light: hex(0x5C7396), dark: hex(0x8193B2))

    static let heroCore = dynamic(light: hex(0x21C8FF, alpha: 0.24), dark: hex(0x1CC6FF, alpha: 0.16))
    static let heroAccent = dynamic(light: hex(0x5586FF, alpha: 0.22), dark: hex(0x6572FF, alpha: 0.16))
    static let heroSun = dynamic(light: hex(0xFFC45C, alpha: 0.18), dark: hex(0x4EF0FF, alpha: 0.10))
    static let grid = dynamic(light: hex(0x3A69AF, alpha: 0.12), dark: hex(0x2C5CA8, alpha: 0.12))
    static let fieldFill = dynamic(light: hex(0xFFFFFF, alpha: 0.62), dark: hex(0x0A1730, alpha: 0.70))
    static let fieldStroke = dynamic(light: hex(0x7BB8FF, alpha: 0.24), dark: hex(0x6CB6FF, alpha: 0.18))
    static let fieldShadow = dynamic(light: hex(0x0D254E, alpha: 0.10), dark: hex(0x000000, alpha: 0.36))
    static let glow = dynamic(light: hex(0x0D254E, alpha: 0.14), dark: hex(0x020812, alpha: 0.42))
}

struct HBGridOverlay: View {
    var spacing: CGFloat = 28

    var body: some View {
        GeometryReader { proxy in
            Canvas { context, size in
                var path = Path()

                stride(from: CGFloat.zero, through: size.width, by: spacing).forEach { x in
                    path.move(to: CGPoint(x: x, y: 0))
                    path.addLine(to: CGPoint(x: x, y: size.height))
                }

                stride(from: CGFloat.zero, through: size.height, by: spacing).forEach { y in
                    path.move(to: CGPoint(x: 0, y: y))
                    path.addLine(to: CGPoint(x: size.width, y: y))
                }

                context.stroke(path, with: .color(HBPalette.grid), lineWidth: 0.6)
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
        }
        .allowsHitTesting(false)
    }
}

enum HBGlassVariant {
    case chrome
    case panel
    case panelStrong
    case panelSoft

    var fill: LinearGradient {
        switch self {
        case .chrome:
            return LinearGradient(
                colors: [HBPalette.chrome.opacity(0.96), HBPalette.panelSoft.opacity(0.34)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        case .panel:
            return LinearGradient(
                colors: [HBPalette.panelStrong.opacity(0.92), HBPalette.panel.opacity(0.86)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        case .panelStrong:
            return LinearGradient(
                colors: [HBPalette.panelStrong, HBPalette.panel],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        case .panelSoft:
            return LinearGradient(
                colors: [HBPalette.panelSoft.opacity(0.92), HBPalette.panel.opacity(0.72)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        }
    }

    var stroke: Color {
        switch self {
        case .chrome: return HBPalette.panelStrokeStrong.opacity(0.85)
        case .panel: return HBPalette.panelStroke
        case .panelStrong: return HBPalette.panelStrokeStrong
        case .panelSoft: return HBPalette.panelStroke.opacity(0.84)
        }
    }

    var lensFill: LinearGradient {
        switch self {
        case .chrome:
            return LinearGradient(
                colors: [Color.white.opacity(0.20), HBPalette.panelSoft.opacity(0.12)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        case .panel:
            return LinearGradient(
                colors: [Color.white.opacity(0.11), HBPalette.panelSoft.opacity(0.10)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        case .panelStrong:
            return LinearGradient(
                colors: [Color.white.opacity(0.14), HBPalette.panelSoft.opacity(0.11)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        case .panelSoft:
            return LinearGradient(
                colors: [Color.white.opacity(0.08), HBPalette.panelSoft.opacity(0.08)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        }
    }

    var usesLiveMaterial: Bool {
        self == .chrome
    }

    var shadowRadius: CGFloat {
        switch self {
        case .chrome: return 18
        case .panel: return 14
        case .panelStrong: return 18
        case .panelSoft: return 10
        }
    }

    var shadowYOffset: CGFloat {
        switch self {
        case .chrome: return 12
        case .panel: return 10
        case .panelStrong: return 12
        case .panelSoft: return 8
        }
    }

    var shadowOpacity: Double {
        switch self {
        case .chrome: return 0.78
        case .panel: return 0.48
        case .panelStrong: return 0.62
        case .panelSoft: return 0.34
        }
    }
}

struct HBGlassBackground: View {
    let cornerRadius: CGFloat
    let variant: HBGlassVariant

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)

        ZStack {
            shape
                .fill(variant.fill)

            if variant.usesLiveMaterial {
                shape
                    .fill(.thinMaterial)
                    .opacity(0.32)
            } else {
                shape
                    .fill(variant.lensFill)
            }

            shape
                .fill(
                    LinearGradient(
                        colors: [Color.white.opacity(0.22), Color.clear, Color.white.opacity(0.04)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )

            shape
                .stroke(variant.stroke, lineWidth: 1)

            shape
                .stroke(Color.white.opacity(0.06), lineWidth: 0.6)
        }
        .shadow(
            color: HBPalette.glow.opacity(variant.shadowOpacity),
            radius: variant.shadowRadius,
            x: 0,
            y: variant.shadowYOffset
        )
    }
}

struct HBDeckSurface<Content: View>: View {
    let content: Content
    var cornerRadius: CGFloat = 28

    init(cornerRadius: CGFloat = 28, @ViewBuilder content: () -> Content) {
        self.cornerRadius = cornerRadius
        self.content = content()
    }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)

        ZStack {
            HBGlassBackground(cornerRadius: cornerRadius, variant: .panelStrong)

            HBGridOverlay(spacing: 30)
                .opacity(0.38)
                .clipShape(shape)

            shape
                .fill(
                    LinearGradient(
                        colors: [Color.white.opacity(0.05), Color.clear, HBPalette.heroAccent.opacity(0.08)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )

            content
                .clipShape(shape)
        }
    }
}

struct HBPageBackground: View {
    var body: some View {
        GeometryReader { proxy in
            ZStack {
                LinearGradient(
                    colors: [HBPalette.pageTop, HBPalette.pageMid, HBPalette.pageBottom],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )

                Circle()
                    .fill(HBPalette.heroCore)
                    .frame(width: proxy.size.width * 0.42)
                    .blur(radius: 70)
                    .offset(x: -proxy.size.width * 0.28, y: -proxy.size.height * 0.28)

                Circle()
                    .fill(HBPalette.heroAccent)
                    .frame(width: proxy.size.width * 0.46)
                    .blur(radius: 82)
                    .offset(x: proxy.size.width * 0.26, y: -proxy.size.height * 0.22)

                Circle()
                    .fill(HBPalette.heroSun)
                    .frame(width: proxy.size.width * 0.34)
                    .blur(radius: 78)
                    .offset(x: 0, y: proxy.size.height * 0.42)

                HBGridOverlay(spacing: 72)
                    .opacity(0.28)

                LinearGradient(
                    colors: [Color.white.opacity(0.10), Color.clear, Color.black.opacity(0.16)],
                    startPoint: .top,
                    endPoint: .bottom
                )
            }
            .ignoresSafeArea()
        }
    }
}

struct HBThemeToggleMenu: View {
    @AppStorage("homebrain.ios.theme-mode") private var themeModeRaw = HBThemeMode.system.rawValue

    private var themeMode: HBThemeMode {
        HBThemeMode(rawValue: themeModeRaw) ?? .system
    }

    var body: some View {
        Menu {
            Picker("Appearance", selection: $themeModeRaw) {
                ForEach(HBThemeMode.allCases) { mode in
                    Label(mode.title, systemImage: mode.symbol)
                        .tag(mode.rawValue)
                }
            }
        } label: {
            Image(systemName: themeMode.symbol)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(HBPalette.textPrimary)
                .frame(width: 42, height: 42)
                .background(HBGlassBackground(cornerRadius: 14, variant: .panel))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Appearance")
    }
}

struct HBPrimaryButtonStyle: ButtonStyle {
    var compact: Bool = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: compact ? 14 : 15, weight: .semibold, design: .rounded))
            .foregroundStyle(Color.white)
            .padding(.horizontal, compact ? 14 : 16)
            .padding(.vertical, compact ? 10 : 12)
            .frame(minHeight: compact ? 38 : 42)
            .background(
                LinearGradient(
                    colors: [HBPalette.accentBlue, HBPalette.accentPurple],
                    startPoint: .leading,
                    endPoint: .trailing
                ),
                in: Capsule()
            )
            .shadow(color: HBPalette.accentBlue.opacity(0.24), radius: 18, x: 0, y: 12)
            .opacity(configuration.isPressed ? 0.92 : 1)
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
    }
}

struct HBDestructiveButtonStyle: ButtonStyle {
    var compact: Bool = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: compact ? 14 : 15, weight: .semibold, design: .rounded))
            .foregroundStyle(Color.white)
            .padding(.horizontal, compact ? 14 : 16)
            .padding(.vertical, compact ? 10 : 12)
            .frame(minHeight: compact ? 38 : 42)
            .background(
                LinearGradient(
                    colors: [HBPalette.accentRed, Color.red.opacity(0.94)],
                    startPoint: .leading,
                    endPoint: .trailing
                ),
                in: Capsule()
            )
            .overlay(
                Capsule()
                    .stroke(Color.white.opacity(0.18), lineWidth: 1)
            )
            .shadow(color: HBPalette.accentRed.opacity(0.34), radius: 18, x: 0, y: 12)
            .opacity(configuration.isPressed ? 0.92 : 1)
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
    }
}

struct HBSecondaryButtonStyle: ButtonStyle {
    var compact: Bool = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: compact ? 14 : 15, weight: .semibold, design: .rounded))
            .foregroundStyle(HBPalette.textPrimary)
            .padding(.horizontal, compact ? 14 : 16)
            .padding(.vertical, compact ? 10 : 12)
            .frame(minHeight: compact ? 38 : 42)
            .background(HBGlassBackground(cornerRadius: 999, variant: .panelSoft))
            .overlay(
                Capsule()
                    .stroke(HBPalette.panelStrokeStrong.opacity(0.72), lineWidth: 1)
            )
            .opacity(configuration.isPressed ? 0.92 : 1)
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
    }
}

struct HBGhostButtonStyle: ButtonStyle {
    var compact: Bool = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: compact ? 14 : 15, weight: .semibold, design: .rounded))
            .foregroundStyle(HBPalette.textSecondary)
            .padding(.horizontal, compact ? 12 : 14)
            .padding(.vertical, compact ? 9 : 10)
            .background(
                Capsule()
                    .fill(Color.white.opacity(configuration.isPressed ? 0.14 : 0.08))
            )
            .overlay(
                Capsule()
                    .stroke(HBPalette.panelStroke.opacity(0.45), lineWidth: 1)
            )
    }
}

struct HBBadge: View {
    let text: String
    var foreground: Color = HBPalette.textPrimary
    var background: Color = HBPalette.panelSoft
    var stroke: Color = HBPalette.panelStrokeStrong

    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .bold, design: .rounded))
            .textCase(.uppercase)
            .tracking(1.2)
            .foregroundStyle(foreground)
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(background, in: Capsule())
            .overlay(
                Capsule()
                    .stroke(stroke.opacity(0.9), lineWidth: 1)
            )
    }
}

struct HBSectionHeader: View {
    let title: String
    let subtitle: String
    let eyebrow: String?
    let showBrandIcon: Bool
    let buttonTitle: String?
    let buttonIcon: String?
    let buttonAction: (() -> Void)?
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    private var compactLandscape: Bool {
        horizontalSizeClass == .compact && verticalSizeClass == .compact
    }

    private var stackedLayout: Bool {
        horizontalSizeClass == .compact && verticalSizeClass != .compact
    }

    init(
        title: String,
        subtitle: String = "",
        eyebrow: String? = nil,
        showBrandIcon: Bool = false,
        buttonTitle: String? = nil,
        buttonIcon: String? = nil,
        buttonAction: (() -> Void)? = nil
    ) {
        self.title = title
        self.subtitle = subtitle
        self.eyebrow = eyebrow
        self.showBrandIcon = showBrandIcon
        self.buttonTitle = buttonTitle
        self.buttonIcon = buttonIcon
        self.buttonAction = buttonAction
    }

    private var titleBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(eyebrow ?? title)
                .font(.system(size: 11, weight: .bold, design: .rounded))
                .textCase(.uppercase)
                .tracking(3.0)
                .foregroundStyle(HBPalette.textMuted)

            HStack(spacing: 12) {
                if showBrandIcon {
                    Image("HomeBrainBrandIcon")
                        .resizable()
                        .scaledToFit()
                        .frame(width: compactLandscape ? 28 : 34, height: compactLandscape ? 28 : 34)
                        .padding(8)
                        .background(HBGlassBackground(cornerRadius: 14, variant: .panel))
                }

                Text(title)
                    .font(.system(size: stackedLayout ? 30 : (compactLandscape ? 26 : 38), weight: .bold, design: .rounded))
                    .foregroundStyle(
                        LinearGradient(
                            colors: [HBPalette.accentBlue, HBPalette.accentPurple],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                    .lineLimit(stackedLayout ? 2 : 3)
                    .minimumScaleFactor(0.76)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if !subtitle.isEmpty {
                Text(subtitle)
                    .font(.system(size: compactLandscape ? 14 : (stackedLayout ? 15 : 17), weight: .medium, design: .rounded))
                    .foregroundStyle(HBPalette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private var actionButtonView: some View {
        if let buttonTitle, let buttonAction {
            Button(action: buttonAction) {
                Label(buttonTitle, systemImage: buttonIcon ?? "plus")
                    .frame(maxWidth: stackedLayout ? .infinity : nil)
            }
            .buttonStyle(HBPrimaryButtonStyle(compact: compactLandscape || stackedLayout))
        }
    }

    private var inlineLayout: some View {
        HStack(alignment: .center, spacing: 14) {
            titleBlock
            Spacer(minLength: 12)
            actionButtonView
        }
    }

    private var stackedHeaderLayout: some View {
        VStack(alignment: .leading, spacing: 12) {
            titleBlock
            actionButtonView
        }
    }

    var body: some View {
        Group {
            if stackedLayout {
                stackedHeaderLayout
            } else {
                ViewThatFits(in: .horizontal) {
                    inlineLayout
                    stackedHeaderLayout
                }
            }
        }
    }
}

struct HBPanel<Content: View>: View {
    let content: Content
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    private var compactLandscape: Bool {
        horizontalSizeClass == .compact && verticalSizeClass == .compact
    }

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        content
            .padding(compactLandscape ? 14 : 18)
            .background(HBGlassBackground(cornerRadius: 22, variant: .panel))
    }
}

struct HBCardRow<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        content
            .padding(16)
            .background(HBGlassBackground(cornerRadius: 18, variant: .panelSoft))
    }
}

struct HBPanelGroupBoxStyle: GroupBoxStyle {
    func makeBody(configuration: Configuration) -> some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 12) {
                configuration.label
                    .font(.system(size: 12, weight: .bold, design: .rounded))
                    .textCase(.uppercase)
                    .tracking(2.4)
                    .foregroundStyle(HBPalette.textMuted)

                configuration.content
            }
        }
    }
}

struct HBFormStyleModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .scrollContentBackground(.hidden)
            .background(Color.clear)
            .listStyle(.insetGrouped)
    }
}

extension View {
    func hbFormStyle() -> some View {
        modifier(HBFormStyleModifier())
    }

    func hbPanelTextField() -> some View {
        self
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(HBPalette.fieldFill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(HBPalette.fieldStroke, lineWidth: 1)
            )
            .shadow(color: HBPalette.fieldShadow.opacity(0.6), radius: 14, x: 0, y: 10)
            .foregroundStyle(HBPalette.textPrimary)
            .tint(HBPalette.accentBlue)
    }

    func hbDeckInset() -> some View {
        padding(18)
            .background(HBDeckSurface { Color.clear })
    }
}

struct LoadingView: View {
    let title: String

    var body: some View {
        HBPanel {
            HStack(spacing: 14) {
                ProgressView()
                    .tint(HBPalette.accentBlue)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Initializing")
                        .font(.system(size: 11, weight: .bold, design: .rounded))
                        .textCase(.uppercase)
                        .tracking(2.4)
                        .foregroundStyle(HBPalette.textMuted)
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HBPalette.textSecondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct InlineErrorView: View {
    let message: String
    let retry: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Attention Required", systemImage: "exclamationmark.triangle.fill")
                .font(.system(size: 13, weight: .bold, design: .rounded))
                .foregroundStyle(HBPalette.accentRed)

            Text(message)
                .font(.subheadline)
                .foregroundStyle(HBPalette.textPrimary)

            if let retry {
                Button("Retry", action: retry)
                    .buttonStyle(HBSecondaryButtonStyle(compact: true))
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(HBPalette.accentRed.opacity(0.12))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(HBPalette.accentRed.opacity(0.28), lineWidth: 1)
        )
    }
}

struct MetricCard: View {
    let title: String
    let value: String
    let subtitle: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.system(size: 11, weight: .bold, design: .rounded))
                .textCase(.uppercase)
                .tracking(2.2)
                .foregroundStyle(HBPalette.textMuted)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)

            Text(value)
                .font(.title2.weight(.bold))
                .foregroundStyle(HBPalette.textPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)

            Text(subtitle)
                .font(.caption)
                .foregroundStyle(HBPalette.textSecondary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)

            Capsule()
                .fill(
                    LinearGradient(
                        colors: [tint.opacity(0.98), tint.opacity(0.28)],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                )
                .frame(width: 42, height: 4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(HBGlassBackground(cornerRadius: 18, variant: .panelSoft))
    }
}

struct EmptyStateView: View {
    let title: String
    let subtitle: String

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "sparkles.rectangle.stack")
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(HBPalette.textMuted)

            Text(title)
                .font(.headline)
                .foregroundStyle(HBPalette.textPrimary)

            Text(subtitle)
                .font(.subheadline)
                .foregroundStyle(HBPalette.textSecondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 30)
        .padding(.horizontal, 18)
        .background(HBGlassBackground(cornerRadius: 20, variant: .panelSoft))
    }
}
