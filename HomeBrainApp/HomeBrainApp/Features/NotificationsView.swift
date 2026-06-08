import SwiftUI

private enum NotificationChannelFilter: String, CaseIterable, Identifiable {
    case all
    case securityCritical
    case normal

    var id: String { rawValue }

    var title: String {
        switch self {
        case .all: return "All"
        case .securityCritical: return "Critical"
        case .normal: return "Normal"
        }
    }
}

private struct HomeBrainNotificationItem: Identifiable, Equatable {
    let id: String
    let channel: String
    let severity: String
    let category: String
    let title: String
    let message: String
    let occurredAt: Date?
    let clearedAt: Date?
    let resolvedAt: Date?
    let resolvedReason: String

    var isSecurityCritical: Bool {
        channel == "securityCritical"
    }

    var isCleared: Bool {
        clearedAt != nil
    }

    var isResolved: Bool {
        resolvedAt != nil
    }

    var isActive: Bool {
        !isCleared && !isResolved
    }

    static func from(_ object: [String: Any]) -> HomeBrainNotificationItem {
        HomeBrainNotificationItem(
            id: JSON.id(object),
            channel: JSON.string(object, "channel", fallback: "normal"),
            severity: JSON.string(object, "severity", fallback: "info"),
            category: JSON.string(object, "category", fallback: "system"),
            title: JSON.string(object, "title", fallback: "HomeBrain notification"),
            message: JSON.string(object, "message"),
            occurredAt: JSON.date(from: object["occurredAt"]),
            clearedAt: JSON.date(from: object["clearedAt"]),
            resolvedAt: JSON.date(from: object["resolvedAt"]),
            resolvedReason: JSON.string(object, "resolvedReason")
        )
    }
}

struct NotificationsView: View {
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var pushNotificationManager: PushNotificationManager

    @State private var selectedChannel: NotificationChannelFilter = .all
    @State private var notifications: [HomeBrainNotificationItem] = []
    @State private var isLoading = false
    @State private var isUpdatingPushSetting = false
    @State private var errorMessage: String?
    @State private var includeCleared = false

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            header

            pushControls

            Picker("Notification Type", selection: $selectedChannel) {
                ForEach(NotificationChannelFilter.allCases) { filter in
                    Text(filter.title).tag(filter)
                }
            }
            .pickerStyle(.segmented)

            Toggle("Show history", isOn: $includeCleared)
                .toggleStyle(.switch)

            if let errorMessage {
                Text(errorMessage)
                    .font(.callout)
                    .foregroundStyle(.red)
            }

            notificationList
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .task {
            await loadNotifications()
        }
        .onChange(of: selectedChannel) { _, _ in
            Task { await loadNotifications() }
        }
        .onChange(of: includeCleared) { _, _ in
            Task { await loadNotifications() }
        }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Notifications")
                    .font(.largeTitle.bold())
                Text("Security critical alerts and HomeBrain device notices.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            HStack(spacing: 10) {
                Button {
                    Task { await loadNotifications() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .disabled(isLoading)

                Button(role: .destructive) {
                    Task { await clearSelectedNotifications() }
                } label: {
                    Label(clearButtonTitle, systemImage: "checkmark.circle")
                }
                .buttonStyle(.borderedProminent)
                .disabled(notifications.filter(\.isActive).isEmpty || isLoading)
            }
        }
    }

    private var pushControls: some View {
        HStack(spacing: 14) {
            Image(systemName: "iphone.radiowaves.left.and.right")
                .font(.title3)
                .foregroundStyle(pushNotificationManager.securityCriticalPushEnabled ? .red : .secondary)
                .frame(width: 30, height: 30)

            VStack(alignment: .leading, spacing: 4) {
                Text("Critical Push")
                    .font(.headline)
                Text(pushStatusText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            Toggle("", isOn: Binding(
                get: { pushNotificationManager.securityCriticalPushEnabled },
                set: { enabled in
                    Task { await updateCriticalPush(enabled) }
                }
            ))
            .labelsHidden()
            .disabled(isUpdatingPushSetting)
        }
        .padding(16)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private var pushStatusText: String {
        if let error = pushNotificationManager.lastRegistrationError, !error.isEmpty {
            return error
        }
        if pushNotificationManager.securityCriticalPushEnabled {
            return pushNotificationManager.lastRegisteredAt.map { "Registered \($0.formatted(date: .omitted, time: .shortened))" } ?? "Enabled on this device"
        }
        return "Off on this device"
    }

    private var clearButtonTitle: String {
        switch selectedChannel {
        case .all:
            return "Clear All"
        case .securityCritical:
            return "Clear Critical"
        case .normal:
            return "Clear Normal"
        }
    }

    @ViewBuilder
    private var notificationList: some View {
        if isLoading && notifications.isEmpty {
            ProgressView()
                .frame(maxWidth: .infinity, minHeight: 220)
        } else if notifications.isEmpty {
            ContentUnavailableView(
                "No Notifications",
                systemImage: "bell.slash",
                description: Text("HomeBrain has no matching notifications.")
            )
            .frame(maxWidth: .infinity, minHeight: 260)
        } else {
            ScrollView {
                LazyVStack(spacing: 12) {
                    ForEach(notifications) { notification in
                        notificationRow(notification)
                    }
                }
                .padding(.vertical, 4)
            }
        }
    }

    private func notificationRow(_ notification: HomeBrainNotificationItem) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: notification.isSecurityCritical ? "shield.lefthalf.filled" : "bell.badge")
                .font(.title3)
                .foregroundStyle(notification.isSecurityCritical ? .red : .blue)
                .frame(width: 30, height: 30)

            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Text(notification.title)
                        .font(.headline)
                    if notification.isSecurityCritical {
                        Text("Critical")
                            .font(.caption.bold())
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(Color.red.opacity(0.15), in: Capsule())
                            .foregroundStyle(.red)
                    }
                    if notification.isResolved {
                        Text("Resolved")
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(Color.green.opacity(0.14), in: Capsule())
                            .foregroundStyle(.green)
                    }
                    if notification.isCleared {
                        Text("Cleared")
                            .font(.caption.bold())
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(Color.secondary.opacity(0.12), in: Capsule())
                            .foregroundStyle(.secondary)
                    }
                }

                Text(notification.message)
                    .font(.callout)
                    .foregroundStyle(.secondary)

                Text(formatDate(notification.occurredAt))
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }

            Spacer()

            if notification.isActive {
                Button {
                    Task { await clearNotification(notification) }
                } label: {
                    Image(systemName: "xmark.circle")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Clear notification")
            }
        }
        .padding(16)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private func loadNotifications() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            var query = [
                URLQueryItem(name: "limit", value: "100"),
                URLQueryItem(name: "includeCleared", value: includeCleared ? "true" : "false"),
                URLQueryItem(name: "includeResolved", value: includeCleared ? "true" : "false")
            ]
            if selectedChannel != .all {
                query.append(URLQueryItem(name: "channel", value: selectedChannel.rawValue))
            }

            let response = try await session.apiClient.get("/api/notifications", query: query)
            notifications = JSON.array(JSON.object(response)["notifications"])
                .map(HomeBrainNotificationItem.from)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func clearSelectedNotifications() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            var body: [String: Any] = [:]
            if selectedChannel != .all {
                body["channel"] = selectedChannel.rawValue
            }
            _ = try await session.apiClient.post("/api/notifications/clear", body: body)
            await loadNotifications()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func clearNotification(_ notification: HomeBrainNotificationItem) async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            _ = try await session.apiClient.delete("/api/notifications/\(notification.id)")
            await loadNotifications()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func updateCriticalPush(_ enabled: Bool) async {
        isUpdatingPushSetting = true
        defer { isUpdatingPushSetting = false }
        await pushNotificationManager.setSecurityCriticalPushEnabled(enabled)
    }

    private func formatDate(_ date: Date?) -> String {
        guard let date else { return "Unknown time" }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}
