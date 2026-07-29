import Foundation

nonisolated struct HomeBrainInstance: Codable, Identifiable {
    let id: String
    let serverURL: String
    var user: AppUser
    let addedAt: Date
    var lastUsedAt: Date

    var displayName: String {
        guard let host = URL(string: serverURL)?.host, !host.isEmpty else {
            return serverURL
        }

        return host
    }

    var accountSummary: String {
        let trimmedName = user.name.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedName.isEmpty || trimmedName.caseInsensitiveCompare(user.email) == .orderedSame {
            return user.email
        }
        return "\(trimmedName) • \(user.email)"
    }
}
