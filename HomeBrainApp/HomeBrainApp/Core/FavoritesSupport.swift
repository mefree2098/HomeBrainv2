import Foundation

struct FavoriteDeviceContext {
    var profileId: String?
    var favoriteDeviceIds: Set<String>

    static let empty = FavoriteDeviceContext(profileId: nil, favoriteDeviceIds: [])

    var hasProfile: Bool {
        profileId != nil
    }
}

enum FavoritesSupport {
    static func deviceContext(fromProfilesPayload payload: Any) -> FavoriteDeviceContext {
        let root = JSON.object(payload)
        let profiles = JSON.array(root["profiles"])

        guard let preferredProfile = preferredProfile(from: profiles) else {
            return .empty
        }

        return deviceContext(fromProfileObject: preferredProfile)
    }

    static func deviceContext(fromProfileObject profile: [String: Any]) -> FavoriteDeviceContext {
        let favorites = JSON.object(profile["favorites"])
        return FavoriteDeviceContext(
            profileId: optionalProfileID(from: profile),
            favoriteDeviceIds: idSet(from: favorites["devices"])
        )
    }

    static func optionalProfileID(from profile: [String: Any]) -> String? {
        let candidates = [
            profile["_id"] as? String,
            profile["id"] as? String
        ]

        for candidate in candidates {
            let trimmed = candidate?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !trimmed.isEmpty {
                return trimmed
            }
        }

        return nil
    }

    static func idSet(from raw: Any?) -> Set<String> {
        guard let rawArray = raw as? [Any] else {
            return []
        }

        var ids = Set<String>()
        ids.reserveCapacity(rawArray.count)

        for item in rawArray {
            if let id = normalizedIdentifier(from: item) {
                ids.insert(id)
            }
        }

        return ids
    }

    private static func preferredProfile(from profiles: [[String: Any]]) -> [String: Any]? {
        profiles.first(where: { JSON.bool($0, "active", fallback: false) }) ?? profiles.first
    }

    private static func normalizedIdentifier(from value: Any?) -> String? {
        if let stringValue = value as? String {
            let trimmed = stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }

        if let objectValue = value as? [String: Any] {
            return optionalProfileID(from: objectValue)
        }

        return nil
    }
}
