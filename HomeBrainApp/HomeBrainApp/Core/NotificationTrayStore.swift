import Foundation
import Combine

struct NotificationTrayCounts: Equatable {
    var normal: Int = 0
    var securityCritical: Int = 0
    var total: Int { normal + securityCritical }
}

struct NotificationTrayItem: Identifiable, Equatable {
    let id: String
    let channel: String
    let title: String
    let message: String
    let occurredAt: Date?

    var isSecurityCritical: Bool {
        channel == "securityCritical"
    }

    static func from(_ object: [String: Any]) -> NotificationTrayItem {
        NotificationTrayItem(
            id: JSON.id(object),
            channel: JSON.string(object, "channel", fallback: "normal"),
            title: JSON.string(object, "title", fallback: "HomeBrain notification"),
            message: JSON.string(object, "message"),
            occurredAt: JSON.date(from: object["occurredAt"])
        )
    }
}

@MainActor
final class NotificationTrayStore: ObservableObject {
    @Published private(set) var counts = NotificationTrayCounts()
    @Published private(set) var recentItems: [NotificationTrayItem] = []
    @Published private(set) var errorMessage: String?

    private var latestRefreshID: UUID?
    private weak var sessionStore: SessionStore?

    func bind(sessionStore: SessionStore) {
        self.sessionStore = sessionStore
    }

    func clear() {
        latestRefreshID = nil
        counts = NotificationTrayCounts()
        recentItems = []
        errorMessage = nil
    }

    func refresh(limit: Int = 30) async {
        guard let sessionStore, sessionStore.isAuthenticated else {
            clear()
            return
        }

        let refreshID = UUID()
        latestRefreshID = refreshID

        do {
            let response = try await sessionStore.apiClient.get("/api/notifications", query: [
                URLQueryItem(name: "limit", value: "\(limit)")
            ])
            guard !Task.isCancelled, latestRefreshID == refreshID else { return }
            let object = JSON.object(response)
            let countsObject = JSON.object(object["counts"])
            let updatedCounts = NotificationTrayCounts(
                normal: JSON.int(countsObject, "normal", fallback: 0),
                securityCritical: JSON.int(countsObject, "securityCritical", fallback: 0)
            )
            let items = JSON.array(object["notifications"]).map(NotificationTrayItem.from)
            if counts != updatedCounts { counts = updatedCounts }
            if recentItems != items { recentItems = items }
            if errorMessage != nil { errorMessage = nil }
        } catch {
            guard !Task.isCancelled, latestRefreshID == refreshID else { return }
            errorMessage = error.localizedDescription
        }
    }
}
