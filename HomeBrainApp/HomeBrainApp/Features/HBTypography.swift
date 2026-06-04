import CoreText
import SwiftUI

enum HBFontWeight {
    case regular
    case medium
    case semibold
    case bold
    case extraBold

    var spaceGroteskName: String {
        switch self {
        case .regular: return "SpaceGrotesk-Regular"
        case .medium, .semibold: return "SpaceGrotesk-Medium"
        case .bold, .extraBold: return "SpaceGrotesk-Bold"
        }
    }

    var orbitronName: String {
        switch self {
        case .regular: return "Orbitron-Regular"
        case .medium: return "Orbitron-Medium"
        case .semibold: return "Orbitron-SemiBold"
        case .bold: return "Orbitron-Bold"
        case .extraBold: return "Orbitron-ExtraBold"
        }
    }
}

enum HBTypography {
    private static var hasRegisteredFonts = false
    private static let fontResourceNames = ["SpaceGrotesk", "Orbitron"]
    private static let fontSubdirectories: [String?] = ["Fonts", "Resources/Fonts", nil]

    static func registerFonts(bundle: Bundle = .main) {
        guard !hasRegisteredFonts else { return }
        hasRegisteredFonts = true

        for url in fontURLs(in: bundle) {
            var error: Unmanaged<CFError>?
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error)
        }
    }

    static func body(_ style: Font.TextStyle = .body, weight: HBFontWeight = .regular) -> Font {
        Font.custom(weight.spaceGroteskName, size: pointSize(for: style), relativeTo: style)
    }

    static func body(size: CGFloat, weight: HBFontWeight = .regular) -> Font {
        Font.custom(weight.spaceGroteskName, size: size)
    }

    static func display(_ style: Font.TextStyle = .title2, weight: HBFontWeight = .semibold) -> Font {
        Font.custom(weight.orbitronName, size: pointSize(for: style), relativeTo: style)
    }

    static func display(size: CGFloat, weight: HBFontWeight = .semibold) -> Font {
        Font.custom(weight.orbitronName, size: size)
    }

    private static func fontURLs(in bundle: Bundle) -> [URL] {
        var urls: [URL] = []
        var seen = Set<URL>()

        for resourceName in fontResourceNames {
            for subdirectory in fontSubdirectories {
                guard let url = bundle.url(forResource: resourceName, withExtension: "ttf", subdirectory: subdirectory),
                      !seen.contains(url) else {
                    continue
                }

                urls.append(url)
                seen.insert(url)
            }
        }

        return urls
    }

    private static func pointSize(for style: Font.TextStyle) -> CGFloat {
        switch style {
        case .largeTitle: return 34
        case .title: return 28
        case .title2: return 22
        case .title3: return 20
        case .headline: return 17
        case .body: return 17
        case .callout: return 16
        case .subheadline: return 15
        case .footnote: return 13
        case .caption: return 12
        case .caption2: return 11
        @unknown default: return 17
        }
    }
}
