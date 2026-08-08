import Foundation

nonisolated enum AppReviewAccessConfiguration {
    static let publicEndpoint = "https://freestonefamily.com"

    private static let reviewerEmails: Set<String> = [
        "appstore-review-demo@freestonefamily.com",
        "apple-app-review-delete@freestonefamily.com"
    ]

    static func isReviewerEmail(_ value: String) -> Bool {
        reviewerEmails.contains(normalizedEmail(value))
    }

    static func resolvedEndpoint(forEmail email: String, requestedEndpoint: String) -> String {
        isReviewerEmail(email) ? publicEndpoint : requestedEndpoint
    }

    private static func normalizedEmail(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}
