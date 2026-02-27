import SwiftUI

enum HBPalette {
    static let pageTop = Color(red: 0.09, green: 0.16, blue: 0.43)
    static let pageMid = Color(red: 0.14, green: 0.21, blue: 0.57)
    static let pageBottom = Color(red: 0.25, green: 0.11, blue: 0.51)

    static let chrome = Color(red: 0.03, green: 0.05, blue: 0.12)
    static let sidebar = Color(red: 0.02, green: 0.04, blue: 0.10)
    static let panel = Color(red: 0.09, green: 0.14, blue: 0.31).opacity(0.9)
    static let panelStroke = Color.white.opacity(0.12)
    static let textPrimary = Color.white.opacity(0.96)
    static let textSecondary = Color.white.opacity(0.72)

    static let accentBlue = Color(red: 0.21, green: 0.53, blue: 1.0)
    static let accentPurple = Color(red: 0.56, green: 0.27, blue: 1.0)
    static let accentGreen = Color(red: 0.08, green: 0.82, blue: 0.53)
    static let accentOrange = Color(red: 1.0, green: 0.53, blue: 0.13)
}

struct HBPageBackground: View {
    var body: some View {
        LinearGradient(
            colors: [HBPalette.pageTop, HBPalette.pageMid, HBPalette.pageBottom],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
        .overlay(
            LinearGradient(
                colors: [Color.black.opacity(0.15), Color.clear, Color.black.opacity(0.25)],
                startPoint: .top,
                endPoint: .bottom
            )
        )
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
            .padding(compactLandscape ? 12 : 16)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(HBPalette.panel)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(HBPalette.panelStroke, lineWidth: 1)
            )
    }
}

struct HBSectionHeader: View {
    let title: String
    let subtitle: String
    let buttonTitle: String?
    let buttonIcon: String?
    let buttonAction: (() -> Void)?
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    private var compactLandscape: Bool {
        horizontalSizeClass == .compact && verticalSizeClass == .compact
    }

    init(
        title: String,
        subtitle: String = "",
        buttonTitle: String? = nil,
        buttonIcon: String? = nil,
        buttonAction: (() -> Void)? = nil
    ) {
        self.title = title
        self.subtitle = subtitle
        self.buttonTitle = buttonTitle
        self.buttonIcon = buttonIcon
        self.buttonAction = buttonAction
    }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: compactLandscape ? 24 : 32, weight: .bold, design: .rounded))
                    .foregroundStyle(HBPalette.textPrimary)
                if !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.system(size: compactLandscape ? 14 : 16, weight: .medium, design: .rounded))
                        .foregroundStyle(HBPalette.textSecondary)
                }
            }

            Spacer()

            if let buttonTitle, let buttonAction {
                Button(action: buttonAction) {
                    Label(buttonTitle, systemImage: buttonIcon ?? "plus")
                        .font(.system(size: compactLandscape ? 13 : 15, weight: .semibold, design: .rounded))
                        .padding(.horizontal, compactLandscape ? 10 : 12)
                        .padding(.vertical, compactLandscape ? 7 : 8)
                        .background(
                            LinearGradient(
                                colors: [HBPalette.accentBlue, HBPalette.accentPurple],
                                startPoint: .leading,
                                endPoint: .trailing
                            ),
                            in: RoundedRectangle(cornerRadius: 9, style: .continuous)
                        )
                        .foregroundStyle(.white)
                }
                .buttonStyle(.plain)
            }
        }
    }
}

struct HBCardRow<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        content
            .padding()
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(HBPalette.panel.opacity(0.9))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(HBPalette.panelStroke, lineWidth: 1)
            )
    }
}

struct HBPanelGroupBoxStyle: GroupBoxStyle {
    func makeBody(configuration: Configuration) -> some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 10) {
                configuration.label
                    .font(.system(size: 20, weight: .bold, design: .rounded))
                    .foregroundStyle(HBPalette.textPrimary)
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
            .listRowBackground(Color.black.opacity(0.28))
    }
}

extension View {
    func hbFormStyle() -> some View {
        modifier(HBFormStyleModifier())
    }

    func hbPanelTextField() -> some View {
        self
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(Color.black.opacity(0.35), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .stroke(Color.white.opacity(0.16), lineWidth: 1)
            )
            .foregroundStyle(HBPalette.textPrimary)
    }
}

struct LoadingView: View {
    let title: String

    var body: some View {
        HStack(spacing: 12) {
            ProgressView()
                .tint(HBPalette.accentBlue)
            Text(title)
                .font(.subheadline)
                .foregroundStyle(HBPalette.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(HBPalette.panel)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(HBPalette.panelStroke, lineWidth: 1)
        )
    }
}

struct InlineErrorView: View {
    let message: String
    let retry: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(message)
                .font(.subheadline)
                .foregroundStyle(Color(red: 1.0, green: 0.63, blue: 0.63))

            if let retry {
                Button("Retry", action: retry)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.red.opacity(0.16))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color.red.opacity(0.35), lineWidth: 1)
        )
    }
}

struct MetricCard: View {
    let title: String
    let value: String
    let subtitle: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption)
                .foregroundStyle(HBPalette.textSecondary)
            Text(value)
                .font(.title3.weight(.semibold))
                .foregroundStyle(tint)
            Text(subtitle)
                .font(.caption2)
                .foregroundStyle(HBPalette.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(HBPalette.panel)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(tint.opacity(0.6), lineWidth: 1)
        )
    }
}

struct EmptyStateView: View {
    let title: String
    let subtitle: String

    var body: some View {
        VStack(spacing: 8) {
            Text(title)
                .font(.headline)
                .foregroundStyle(HBPalette.textPrimary)
            Text(subtitle)
                .font(.subheadline)
                .foregroundStyle(HBPalette.textSecondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 28)
        .padding(.horizontal, 12)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(HBPalette.panel.opacity(0.65))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(HBPalette.panelStroke, lineWidth: 1)
        )
    }
}
