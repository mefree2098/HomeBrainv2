import SwiftUI
import UIKit

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

    var isSecurityCritical: Bool { channel == "securityCritical" }
    var isCleared: Bool { clearedAt != nil }
    var isResolved: Bool { resolvedAt != nil }
    var isActive: Bool { !isCleared && !isResolved }

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

private struct RemoteHomeBrainPeer: Identifiable, Equatable {
    let id: String
    let direction: String
    let name: String
    let enabled: Bool
    let remoteUrl: String
    let tokenPreview: String
    let lastHandshakeAt: Date?
    let lastReceivedAt: Date?
    let lastForwardedAt: Date?
    let lastDeliveryAt: Date?
    let lastDeliveryStatus: String
    let lastDeliveryMessage: String
    let lastAlertTitle: String

    static func from(_ object: [String: Any]) -> RemoteHomeBrainPeer {
        RemoteHomeBrainPeer(
            id: JSON.id(object),
            direction: JSON.string(object, "direction"),
            name: JSON.string(object, "name", fallback: "Remote HomeBrain"),
            enabled: JSON.bool(object, "enabled", fallback: true),
            remoteUrl: JSON.string(object, "remoteUrl"),
            tokenPreview: JSON.string(object, "tokenPreview"),
            lastHandshakeAt: JSON.date(from: object["lastHandshakeAt"]),
            lastReceivedAt: JSON.date(from: object["lastReceivedAt"]),
            lastForwardedAt: JSON.date(from: object["lastForwardedAt"]),
            lastDeliveryAt: JSON.date(from: object["lastDeliveryAt"]),
            lastDeliveryStatus: JSON.string(object, "lastDeliveryStatus", fallback: "never"),
            lastDeliveryMessage: JSON.string(object, "lastDeliveryMessage"),
            lastAlertTitle: JSON.string(object, "lastAlertTitle")
        )
    }
}

private struct GeneratedRemoteToken: Equatable {
    let name: String
    let token: String
}

struct NotificationsView: View {
    @EnvironmentObject var session: SessionStore
    @EnvironmentObject var pushNotificationManager: PushNotificationManager
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private let previewMode: Bool

    @State private var selectedChannel: NotificationChannelFilter = .all
    @State private var includeCleared = false
    @State private var notifications: [HomeBrainNotificationItem] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var isUpdatingPushSetting = false

    @State private var inboundRemotes: [RemoteHomeBrainPeer] = []
    @State private var outboundTargets: [RemoteHomeBrainPeer] = []
    @State private var remoteIsLoading = false
    @State private var remoteActionId: String?
    @State private var remoteErrorMessage: String?
    @State private var inboundName = ""
    @State private var outboundName = ""
    @State private var outboundURL = ""
    @State private var outboundToken = ""
    @State private var generatedToken: GeneratedRemoteToken?

    init(previewMode: Bool = false) {
        self.previewMode = previewMode

        if previewMode {
            _notifications = State(initialValue: [
                HomeBrainNotificationItem(
                    id: "preview-critical-alert",
                    channel: "securityCritical",
                    severity: "critical",
                    category: "security",
                    title: "Front door alert",
                    message: "A security event needs your attention.",
                    occurredAt: Date().addingTimeInterval(-300),
                    clearedAt: nil,
                    resolvedAt: nil,
                    resolvedReason: ""
                )
            ])
            _inboundRemotes = State(initialValue: [
                RemoteHomeBrainPeer(
                    id: "preview-selene",
                    direction: "inbound",
                    name: "Selene's Apartment",
                    enabled: true,
                    remoteUrl: "",
                    tokenPreview: "…DI8r64",
                    lastHandshakeAt: nil,
                    lastReceivedAt: Date().addingTimeInterval(-172_800),
                    lastForwardedAt: nil,
                    lastDeliveryAt: Date().addingTimeInterval(-172_800),
                    lastDeliveryStatus: "ok",
                    lastDeliveryMessage: "Security alert received",
                    lastAlertTitle: "Security alert"
                )
            ])
        }
    }

    private var isAdmin: Bool {
        previewMode || session.currentUser?.role == "admin"
    }

    private var usesCompactLayout: Bool {
        horizontalSizeClass == .compact
    }

    private var usesAccessibilityLayout: Bool {
        dynamicTypeSize.isAccessibilitySize
    }

    private var canAddInboundRemote: Bool {
        !inboundName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && remoteActionId != "add-inbound"
    }

    private var canEnableForwarding: Bool {
        !outboundName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !outboundURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !outboundToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && remoteActionId != "add-outbound"
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header
                pushControls
                if isAdmin {
                    remoteHomeBrainControls
                }
                filterControls

                if let errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }

                notificationList
            }
            .padding(usesCompactLayout ? 16 : 20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .task {
            guard !previewMode else { return }
            await loadNotifications()
            if isAdmin {
                await loadRemoteHomeBrains()
            }
        }
        .onChange(of: selectedChannel) { _, _ in
            Task { await loadNotifications() }
        }
        .onChange(of: includeCleared) { _, _ in
            Task { await loadNotifications() }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 16) {
            HBSectionHeader(
                title: "Notifications",
                subtitle: "Security-critical alerts and HomeBrain device notices.",
                eyebrow: "Alert Ledger"
            )

            notificationActions
        }
    }

    @ViewBuilder
    private var notificationActions: some View {
        if usesAccessibilityLayout {
            VStack(spacing: 10) {
                refreshNotificationsButton
                clearNotificationsButton
            }
        } else {
            HStack(spacing: 10) {
                refreshNotificationsButton
                clearNotificationsButton
            }
        }
    }

    private var refreshNotificationsButton: some View {
        Button {
            Task { await loadNotifications() }
        } label: {
            Label("Refresh", systemImage: "arrow.clockwise")
                .lineLimit(1)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
        .disabled(isLoading)
    }

    private var clearNotificationsButton: some View {
        Button(role: .destructive) {
            Task { await clearSelectedNotifications() }
        } label: {
            Label(clearButtonTitle, systemImage: "checkmark.circle")
                .lineLimit(1)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .tint(HBPalette.accentRed)
        .disabled(notifications.filter(\.isActive).isEmpty || isLoading)
    }

    private var pushControls: some View {
        Group {
            if usesAccessibilityLayout {
                VStack(alignment: .leading, spacing: 14) {
                    pushStatusBlock
                    criticalPushToggle(showsLabel: true)
                }
            } else {
                HStack(spacing: 14) {
                    pushStatusBlock
                    Spacer(minLength: 12)
                    criticalPushToggle(showsLabel: false)
                }
            }
        }
        .padding(16)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private var pushStatusBlock: some View {
        HStack(spacing: 14) {
            Image(systemName: "iphone.radiowaves.left.and.right")
                .font(.title2)
                .foregroundStyle(pushNotificationManager.securityCriticalPushEnabled ? .red : .secondary)
                .frame(width: 34)

            VStack(alignment: .leading, spacing: 4) {
                Text("Critical Push")
                    .font(.headline)
                Text(pushStatusText)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func criticalPushToggle(showsLabel: Bool) -> some View {
        let binding = Binding(
            get: { pushNotificationManager.securityCriticalPushEnabled },
            set: { enabled in
                Task { await updateCriticalPush(enabled) }
            }
        )

        if showsLabel {
            Toggle("Enabled", isOn: binding)
                .font(.subheadline.weight(.semibold))
                .disabled(isUpdatingPushSetting)
                .accessibilityLabel("Critical push notifications")
                .accessibilityValue(pushNotificationManager.securityCriticalPushEnabled ? "On" : "Off")
        } else {
            Toggle("Critical push notifications", isOn: binding)
                .labelsHidden()
                .disabled(isUpdatingPushSetting)
                .accessibilityLabel("Critical push notifications")
                .accessibilityValue(pushNotificationManager.securityCriticalPushEnabled ? "On" : "Off")
        }
    }

    private var remoteHomeBrainHeader: some View {
        Group {
            if usesCompactLayout || usesAccessibilityLayout {
                VStack(alignment: .leading, spacing: 10) {
                    Label("Remote HomeBrain Alerts", systemImage: "bell.badge")
                        .font(.headline)
                        .fixedSize(horizontal: false, vertical: true)
                    refreshRemoteHomeBrainsButton
                }
            } else {
                HStack {
                    Label("Remote HomeBrain Alerts", systemImage: "bell.badge")
                        .font(.headline)
                    Spacer()
                    refreshRemoteHomeBrainsButton
                }
            }
        }
    }

    private var refreshRemoteHomeBrainsButton: some View {
        Button {
            Task { await loadRemoteHomeBrains() }
        } label: {
            Label("Refresh remotes", systemImage: "arrow.clockwise")
                .lineLimit(1)
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .disabled(remoteIsLoading)
    }

    private var inboundNameField: some View {
        TextField(
            "Inbound remote HomeBrain name",
            text: $inboundName,
            prompt: Text("e.g. Selene's apartment").foregroundStyle(HBPalette.textMuted)
        )
        .textInputAutocapitalization(.words)
        .textFieldStyle(.plain)
        .hbPanelTextField()
    }

    private var addInboundRemoteButton: some View {
        Button {
            Task { await addInboundRemote() }
        } label: {
            Label("Add Remote", systemImage: "plus")
                .lineLimit(1)
                .frame(maxWidth: usesCompactLayout ? .infinity : nil)
        }
        .buttonStyle(HBPrimaryButtonStyle(compact: true))
        .opacity(canAddInboundRemote ? 1 : 0.44)
        .disabled(!canAddInboundRemote)
    }

    @ViewBuilder
    private var inboundRemoteForm: some View {
        if usesCompactLayout || usesAccessibilityLayout {
            VStack(spacing: 10) {
                inboundNameField
                addInboundRemoteButton
            }
        } else {
            HStack(spacing: 10) {
                inboundNameField
                addInboundRemoteButton
            }
        }
    }

    private var outboundNameField: some View {
        TextField(
            "Outbound remote HomeBrain name",
            text: $outboundName,
            prompt: Text("e.g. Freestone family").foregroundStyle(HBPalette.textMuted)
        )
        .textInputAutocapitalization(.words)
        .textFieldStyle(.plain)
        .hbPanelTextField()
    }

    private var outboundURLField: some View {
        TextField(
            "Outbound remote HomeBrain URL",
            text: $outboundURL,
            prompt: Text("https://example.com").foregroundStyle(HBPalette.textMuted)
        )
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .keyboardType(.URL)
        .textContentType(.URL)
        .textFieldStyle(.plain)
        .hbPanelTextField()
    }

    private var outboundTokenField: some View {
        SecureField(
            "Remote token",
            text: $outboundToken,
            prompt: Text("Remote token").foregroundStyle(HBPalette.textMuted)
        )
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .textFieldStyle(.plain)
        .hbPanelTextField()
    }

    private var enableForwardingButton: some View {
        Button {
            Task { await addOutboundTarget() }
        } label: {
            Label("Enable Forwarding", systemImage: "paperplane")
                .lineLimit(1)
                .frame(maxWidth: usesCompactLayout ? .infinity : nil)
        }
        .buttonStyle(HBPrimaryButtonStyle(compact: true))
        .frame(maxWidth: .infinity, alignment: .leading)
        .opacity(canEnableForwarding ? 1 : 0.44)
        .disabled(!canEnableForwarding)
    }

    private var remoteHomeBrainControls: some View {
        VStack(alignment: .leading, spacing: 14) {
            remoteHomeBrainHeader

            if let remoteErrorMessage {
                Text(remoteErrorMessage)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }

            if let generatedToken {
                VStack(alignment: .leading, spacing: 8) {
                    Text("\(generatedToken.name) token")
                        .font(.subheadline.weight(.semibold))
                    HStack {
                        Text(generatedToken.token)
                            .font(.caption.monospaced())
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer()
                        Button {
                            UIPasteboard.general.string = generatedToken.token
                        } label: {
                            Image(systemName: "doc.on.doc")
                        }
                        .buttonStyle(.bordered)
                    }
                }
                .padding(12)
                .background(Color.yellow.opacity(0.16), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }

            VStack(alignment: .leading, spacing: 12) {
                Label("Receive from Remote Homes", systemImage: "shield.checkered")
                    .font(.subheadline.weight(.semibold))

                inboundRemoteForm

                if inboundRemotes.isEmpty {
                    Text("No inbound remotes configured.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else {
                    VStack(spacing: 8) {
                        ForEach(inboundRemotes) { remote in
                            inboundRemoteRow(remote)
                        }
                    }
                }
            }

            Divider()

            VStack(alignment: .leading, spacing: 12) {
                Label("Forward Critical Alerts", systemImage: "antenna.radiowaves.left.and.right")
                    .font(.subheadline.weight(.semibold))

                VStack(spacing: 8) {
                    outboundNameField
                    outboundURLField
                    outboundTokenField
                    enableForwardingButton
                }

                if outboundTargets.isEmpty {
                    Text("No outbound targets configured.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else {
                    VStack(spacing: 8) {
                        ForEach(outboundTargets) { target in
                            outboundTargetRow(target)
                        }
                    }
                }
            }
        }
        .padding(16)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private var filterControls: some View {
        VStack(alignment: .leading, spacing: 12) {
            notificationChannelPicker

            Toggle("Show history", isOn: $includeCleared)
                .toggleStyle(.switch)
        }
    }

    @ViewBuilder
    private var notificationChannelPicker: some View {
        if usesAccessibilityLayout {
            Picker("Notification type", selection: $selectedChannel) {
                ForEach(NotificationChannelFilter.allCases) { filter in
                    Text(filter.title).tag(filter)
                }
            }
            .pickerStyle(.menu)
        } else {
            Picker("Notification type", selection: $selectedChannel) {
                ForEach(NotificationChannelFilter.allCases) { filter in
                    Text(filter.title).tag(filter)
                }
            }
            .pickerStyle(.segmented)
        }
    }

    private var clearButtonTitle: String {
        switch selectedChannel {
        case .securityCritical: return "Clear Critical"
        case .normal: return "Clear Normal"
        case .all: return "Clear All"
        }
    }

    private var pushStatusText: String {
        if let error = pushNotificationManager.lastRegistrationError, !error.isEmpty {
            return error
        }
        if pushNotificationManager.securityCriticalPushEnabled {
            if let registeredAt = pushNotificationManager.lastRegisteredAt {
                return "On since \(formatDate(registeredAt))"
            }
            return "On"
        }
        return "Off on this device"
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
                description: Text(includeCleared ? "No notification history is available." : "No active notifications.")
            )
            .frame(maxWidth: .infinity, minHeight: 260)
        } else {
            LazyVStack(spacing: 10) {
                ForEach(notifications) { notification in
                    notificationRow(notification)
                }
            }
            .padding(.vertical, 4)
        }
    }

    private func inboundRemoteRow(_ remote: RemoteHomeBrainPeer) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Group {
                if usesAccessibilityLayout {
                    VStack(alignment: .leading, spacing: 10) {
                        inboundRemoteSummary(remote)
                        inboundRemoteToggle(remote)
                    }
                } else {
                    HStack(alignment: .top, spacing: 12) {
                        inboundRemoteSummary(remote)
                        Spacer(minLength: 8)
                        inboundRemoteToggle(remote)
                    }
                }
            }

            Group {
                if usesAccessibilityLayout {
                    VStack(spacing: 8) {
                        inboundRotateButton(remote)
                        inboundRemoveButton(remote)
                    }
                } else {
                    HStack {
                        inboundRotateButton(remote)
                        inboundRemoveButton(remote)
                    }
                }
            }
            .font(.footnote)
        }
        .padding(12)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func inboundRemoteSummary(_ remote: RemoteHomeBrainPeer) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(remote.name)
                .font(.subheadline.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            Text("Token \(remote.tokenPreview.isEmpty ? "created" : remote.tokenPreview)")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text("Last received \(formatDate(remote.lastReceivedAt))")
                .font(.caption)
                .foregroundStyle(.secondary)
            if !remote.lastDeliveryMessage.isEmpty {
                Text(remote.lastDeliveryMessage)
                    .font(.caption)
                    .foregroundStyle(statusColor(remote.lastDeliveryStatus))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func inboundRemoteToggle(_ remote: RemoteHomeBrainPeer) -> some View {
        Toggle("Enable \(remote.name) inbound alerts", isOn: Binding(
            get: { remote.enabled },
            set: { enabled in Task { await setInboundRemote(remote, enabled: enabled) } }
        ))
        .labelsHidden()
        .accessibilityLabel("Enable \(remote.name) inbound alerts")
    }

    private func inboundRotateButton(_ remote: RemoteHomeBrainPeer) -> some View {
        Button {
            Task { await rotateInboundToken(remote) }
        } label: {
            Label("Rotate", systemImage: "key")
                .frame(maxWidth: usesAccessibilityLayout ? .infinity : nil)
        }
        .buttonStyle(.bordered)
        .tint(HBPalette.accentBlue)
    }

    private func inboundRemoveButton(_ remote: RemoteHomeBrainPeer) -> some View {
        Button(role: .destructive) {
            Task { await removeInboundRemote(remote) }
        } label: {
            Label("Remove", systemImage: "trash")
                .frame(maxWidth: usesAccessibilityLayout ? .infinity : nil)
        }
        .buttonStyle(.bordered)
        .tint(HBPalette.accentRed)
    }

    private func outboundTargetRow(_ target: RemoteHomeBrainPeer) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Group {
                if usesAccessibilityLayout {
                    VStack(alignment: .leading, spacing: 10) {
                        outboundTargetSummary(target)
                        outboundTargetToggle(target)
                    }
                } else {
                    HStack(alignment: .top, spacing: 12) {
                        outboundTargetSummary(target)
                        Spacer(minLength: 8)
                        outboundTargetToggle(target)
                    }
                }
            }

            Group {
                if usesAccessibilityLayout {
                    VStack(spacing: 8) {
                        outboundTestButton(target)
                        outboundRemoveButton(target)
                    }
                } else {
                    HStack {
                        outboundTestButton(target)
                        outboundRemoveButton(target)
                    }
                }
            }
            .font(.footnote)
        }
        .padding(12)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func outboundTargetSummary(_ target: RemoteHomeBrainPeer) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(target.name)
                .font(.subheadline.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            Text(target.remoteUrl)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            Text(target.lastDeliveryMessage.isEmpty ? "Not tested" : target.lastDeliveryMessage)
                .font(.caption)
                .foregroundStyle(statusColor(target.lastDeliveryStatus))
                .fixedSize(horizontal: false, vertical: true)
            Text("Last sent \(formatDate(target.lastForwardedAt))")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func outboundTargetToggle(_ target: RemoteHomeBrainPeer) -> some View {
        Toggle("Enable forwarding to \(target.name)", isOn: Binding(
            get: { target.enabled },
            set: { enabled in Task { await setOutboundTarget(target, enabled: enabled) } }
        ))
        .labelsHidden()
        .accessibilityLabel("Enable forwarding to \(target.name)")
    }

    private func outboundTestButton(_ target: RemoteHomeBrainPeer) -> some View {
        Button {
            Task { await testOutboundTarget(target) }
        } label: {
            Label("Test", systemImage: "antenna.radiowaves.left.and.right")
                .frame(maxWidth: usesAccessibilityLayout ? .infinity : nil)
        }
        .buttonStyle(.bordered)
        .tint(HBPalette.accentBlue)
    }

    private func outboundRemoveButton(_ target: RemoteHomeBrainPeer) -> some View {
        Button(role: .destructive) {
            Task { await removeOutboundTarget(target) }
        } label: {
            Label("Remove", systemImage: "trash")
                .frame(maxWidth: usesAccessibilityLayout ? .infinity : nil)
        }
        .buttonStyle(.bordered)
        .tint(HBPalette.accentRed)
    }

    private func notificationRow(_ notification: HomeBrainNotificationItem) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: notification.isSecurityCritical ? "shield.lefthalf.filled" : "bell.badge")
                .font(.title3)
                .foregroundStyle(notification.isSecurityCritical ? .red : .blue)
                .frame(width: 28)

            VStack(alignment: .leading, spacing: 6) {
                Text(notification.title)
                    .font(.headline)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 8) {
                    if notification.isSecurityCritical {
                        Text("Critical")
                            .font(.caption.bold())
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(Color.red.opacity(0.16), in: Capsule())
                            .foregroundStyle(.red)
                    }
                    if notification.isResolved {
                        Text("Resolved")
                            .font(.caption.bold())
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(Color.green.opacity(0.14), in: Capsule())
                            .foregroundStyle(.green)
                    } else if notification.isCleared {
                        Text("Cleared")
                            .font(.caption.bold())
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(Color.secondary.opacity(0.14), in: Capsule())
                            .foregroundStyle(.secondary)
                    }
                }

                Text(notification.message)
                    .font(.subheadline)
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
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func loadNotifications() async {
        guard !previewMode else { return }
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

    private func loadRemoteHomeBrains() async {
        guard !previewMode else { return }
        remoteIsLoading = true
        remoteErrorMessage = nil
        defer { remoteIsLoading = false }

        do {
            let response = try await session.apiClient.get("/api/notifications/remote-homebrains")
            let object = JSON.object(response)
            inboundRemotes = JSON.array(object["inboundRemotes"]).map(RemoteHomeBrainPeer.from)
            outboundTargets = JSON.array(object["outboundTargets"]).map(RemoteHomeBrainPeer.from)
        } catch {
            remoteErrorMessage = error.localizedDescription
        }
    }

    private func clearSelectedNotifications() async {
        guard !previewMode else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            var body: [String: Any] = [:]
            if selectedChannel != .all {
                body["channel"] = selectedChannel.rawValue
            }
            if includeCleared {
                body["includeHistory"] = true
            }
            _ = try await session.apiClient.post("/api/notifications/clear", body: body)
            await loadNotifications()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func clearNotification(_ notification: HomeBrainNotificationItem) async {
        guard !previewMode else { return }
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
        guard !previewMode else { return }
        isUpdatingPushSetting = true
        defer { isUpdatingPushSetting = false }
        await pushNotificationManager.setSecurityCriticalPushEnabled(enabled)
    }

    private func addInboundRemote() async {
        guard !previewMode else { return }
        let name = inboundName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        remoteActionId = "add-inbound"
        remoteErrorMessage = nil
        defer { remoteActionId = nil }

        do {
            let response = try await session.apiClient.post("/api/notifications/remote-homebrains/inbound", body: [
                "name": name,
                "enabled": true
            ])
            let object = JSON.object(response)
            if let token = object["token"] as? String, !token.isEmpty {
                generatedToken = GeneratedRemoteToken(name: name, token: token)
            }
            inboundName = ""
            await loadRemoteHomeBrains()
        } catch {
            remoteErrorMessage = error.localizedDescription
        }
    }

    private func rotateInboundToken(_ remote: RemoteHomeBrainPeer) async {
        guard !previewMode else { return }
        remoteActionId = "rotate-\(remote.id)"
        remoteErrorMessage = nil
        defer { remoteActionId = nil }

        do {
            let response = try await session.apiClient.post("/api/notifications/remote-homebrains/inbound/\(remote.id)/rotate-token", body: [:])
            let object = JSON.object(response)
            if let token = object["token"] as? String, !token.isEmpty {
                generatedToken = GeneratedRemoteToken(name: remote.name, token: token)
            }
            await loadRemoteHomeBrains()
        } catch {
            remoteErrorMessage = error.localizedDescription
        }
    }

    private func setInboundRemote(_ remote: RemoteHomeBrainPeer, enabled: Bool) async {
        guard !previewMode else { return }
        remoteActionId = "inbound-\(remote.id)"
        remoteErrorMessage = nil
        defer { remoteActionId = nil }

        do {
            _ = try await session.apiClient.patch("/api/notifications/remote-homebrains/inbound/\(remote.id)", body: [
                "enabled": enabled
            ])
            await loadRemoteHomeBrains()
        } catch {
            remoteErrorMessage = error.localizedDescription
        }
    }

    private func removeInboundRemote(_ remote: RemoteHomeBrainPeer) async {
        guard !previewMode else { return }
        remoteActionId = "delete-inbound-\(remote.id)"
        remoteErrorMessage = nil
        defer { remoteActionId = nil }

        do {
            _ = try await session.apiClient.delete("/api/notifications/remote-homebrains/inbound/\(remote.id)")
            await loadRemoteHomeBrains()
        } catch {
            remoteErrorMessage = error.localizedDescription
        }
    }

    private func addOutboundTarget() async {
        guard !previewMode else { return }
        let name = outboundName.trimmingCharacters(in: .whitespacesAndNewlines)
        let remoteUrl = outboundURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let token = outboundToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, !remoteUrl.isEmpty, !token.isEmpty else { return }
        remoteActionId = "add-outbound"
        remoteErrorMessage = nil
        defer { remoteActionId = nil }

        do {
            _ = try await session.apiClient.post("/api/notifications/remote-homebrains/outbound", body: [
                "name": name,
                "remoteUrl": remoteUrl,
                "token": token,
                "enabled": true
            ])
            outboundName = ""
            outboundURL = ""
            outboundToken = ""
            await loadRemoteHomeBrains()
        } catch {
            remoteErrorMessage = error.localizedDescription
        }
    }

    private func setOutboundTarget(_ target: RemoteHomeBrainPeer, enabled: Bool) async {
        guard !previewMode else { return }
        remoteActionId = "outbound-\(target.id)"
        remoteErrorMessage = nil
        defer { remoteActionId = nil }

        do {
            _ = try await session.apiClient.patch("/api/notifications/remote-homebrains/outbound/\(target.id)", body: [
                "enabled": enabled
            ])
            await loadRemoteHomeBrains()
        } catch {
            remoteErrorMessage = error.localizedDescription
        }
    }

    private func testOutboundTarget(_ target: RemoteHomeBrainPeer) async {
        guard !previewMode else { return }
        remoteActionId = "test-\(target.id)"
        remoteErrorMessage = nil
        defer { remoteActionId = nil }

        do {
            _ = try await session.apiClient.post("/api/notifications/remote-homebrains/outbound/\(target.id)/test", body: [:])
            await loadRemoteHomeBrains()
        } catch {
            remoteErrorMessage = error.localizedDescription
            await loadRemoteHomeBrains()
        }
    }

    private func removeOutboundTarget(_ target: RemoteHomeBrainPeer) async {
        guard !previewMode else { return }
        remoteActionId = "delete-outbound-\(target.id)"
        remoteErrorMessage = nil
        defer { remoteActionId = nil }

        do {
            _ = try await session.apiClient.delete("/api/notifications/remote-homebrains/outbound/\(target.id)")
            await loadRemoteHomeBrains()
        } catch {
            remoteErrorMessage = error.localizedDescription
        }
    }

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "ok": return .green
        case "failed": return .red
        default: return .secondary
        }
    }

    private func formatDate(_ date: Date?) -> String {
        guard let date else { return "Never" }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}
