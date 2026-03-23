import SwiftUI

struct DashboardViewsView: View {
    @EnvironmentObject private var session: SessionStore

    @State private var isLoading = true
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var infoMessage: String?
    @State private var profileID: String?
    @State private var dashboardViews: [DashboardViewItem] = [DashboardSupport.defaultView()]
    @State private var defaultViewID = ""
    @State private var nameAction: ViewNameAction?
    @State private var pendingName = ""
    @State private var pendingDeleteView: DashboardViewItem?

    private enum ViewNameAction {
        case create
        case rename(String)
        case duplicate(String)
    }

    var body: some View {
        Group {
            if isLoading {
                LoadingView(title: "Loading dashboard views...")
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        if let errorMessage {
                            InlineErrorView(message: errorMessage) {
                                Task { await loadViews() }
                            }
                        }

                        if let infoMessage, !infoMessage.isEmpty {
                            HBBadge(
                                text: infoMessage,
                                foreground: HBPalette.textPrimary,
                                background: HBPalette.panelSoft.opacity(0.96),
                                stroke: HBPalette.panelStrokeStrong
                            )
                        }

                        HBPanel {
                            VStack(alignment: .leading, spacing: 14) {
                                HBSectionHeader(
                                    title: "Views Library",
                                    subtitle: "Create multiple dashboards for different rooms or iPads, then choose which one this device should launch by default.",
                                    eyebrow: "Per-Device Defaults"
                                )

                                HStack(spacing: 10) {
                                    Button {
                                        nameAction = .create
                                        pendingName = ""
                                    } label: {
                                        Label("Create View", systemImage: "plus")
                                    }
                                    .buttonStyle(HBPrimaryButtonStyle())
                                    .disabled(profileID == nil || isSaving)

                                    if let profileID {
                                        HBBadge(
                                            text: "Profile \(profileID)",
                                            foreground: HBPalette.textPrimary,
                                            background: HBPalette.panelSoft.opacity(0.92),
                                            stroke: HBPalette.panelStrokeStrong
                                        )
                                    }
                                }
                            }
                        }

                        if profileID == nil {
                            EmptyStateView(
                                title: "No active profile",
                                subtitle: "Activate a user profile before creating room-specific dashboard views."
                            )
                        } else {
                            ForEach(dashboardViews) { view in
                                dashboardViewCard(view)
                            }
                        }
                    }
                    .padding(16)
                    .padding(.bottom, 12)
                }
                .scrollIndicators(.hidden)
                .refreshable {
                    await loadViews()
                }
            }
        }
        .task {
            await loadViews()
        }
        .alert(alertTitle, isPresented: bindingForNameAction(), actions: {
            TextField("View name", text: $pendingName)
            Button("Cancel", role: .cancel) {
                nameAction = nil
            }
            Button("Save") {
                Task { await submitNameAction() }
            }
            .disabled(pendingName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSaving)
        }, message: {
            Text(alertMessage)
        })
        .confirmationDialog(
            "Delete dashboard view?",
            isPresented: Binding(
                get: { pendingDeleteView != nil },
                set: { if !$0 { pendingDeleteView = nil } }
            ),
            presenting: pendingDeleteView
        ) { view in
            Button("Delete \(view.name)", role: .destructive) {
                Task { await deleteView(view) }
            }
            Button("Cancel", role: .cancel) {
                pendingDeleteView = nil
            }
        } message: { view in
            Text("This removes the saved layout from the profile. If it is the current device default, another view will become the default on this iPad.")
        }
    }

    private func dashboardViewCard(_ view: DashboardViewItem) -> some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top, spacing: 10) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(view.name)
                            .font(.system(size: 22, weight: .bold, design: .rounded))
                            .foregroundStyle(HBPalette.textPrimary)

                        Text("\(view.widgets.count) widgets")
                            .font(.system(size: 13, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textSecondary)
                    }

                    Spacer()

                    if defaultViewID == view.id {
                        HBBadge(
                            text: "Default on this iPad",
                            foreground: Color.white,
                            background: HBPalette.accentBlue.opacity(0.96),
                            stroke: HBPalette.accentBlue
                        )
                    }
                }

                if view.widgets.isEmpty {
                    Text("This dashboard is empty. Open the Dashboard section and add the widgets you want.")
                        .font(.system(size: 14, weight: .medium, design: .rounded))
                        .foregroundStyle(HBPalette.textSecondary)
                } else {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(view.widgets) { widget in
                                HBBadge(
                                    text: widget.title,
                                    foreground: HBPalette.textPrimary,
                                    background: HBPalette.panelSoft.opacity(0.92),
                                    stroke: HBPalette.panelStrokeStrong
                                )
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }

                HStack(spacing: 10) {
                    Button {
                        DashboardSupport.setDefaultViewID(view.id, forProfileID: profileID)
                        defaultViewID = view.id
                        infoMessage = "\"\(view.name)\" will open by default on this iPad."
                    } label: {
                        Label(defaultViewID == view.id ? "Default Selected" : "Set as Default", systemImage: "ipad.landscape")
                    }
                    .buttonStyle(HBPrimaryButtonStyle())

                    Button {
                        nameAction = .duplicate(view.id)
                        pendingName = "\(view.name) Copy"
                    } label: {
                        Label("Duplicate", systemImage: "doc.on.doc")
                    }
                    .buttonStyle(HBSecondaryButtonStyle())

                    Button {
                        nameAction = .rename(view.id)
                        pendingName = view.name
                    } label: {
                        Label("Rename", systemImage: "pencil")
                    }
                    .buttonStyle(HBSecondaryButtonStyle())

                    Button {
                        pendingDeleteView = view
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                    .buttonStyle(HBGhostButtonStyle())
                    .disabled(dashboardViews.count <= 1)
                }
            }
        }
    }

    private var alertTitle: String {
        switch nameAction {
        case .create:
            return "Create Dashboard View"
        case .rename:
            return "Rename Dashboard View"
        case .duplicate:
            return "Duplicate Dashboard View"
        case nil:
            return "Dashboard View"
        }
    }

    private var alertMessage: String {
        switch nameAction {
        case .create:
            return "Create a new saved dashboard layout for another room or screen."
        case .rename:
            return "Rename this saved dashboard view."
        case .duplicate:
            return "Clone this dashboard so you can tailor it for another iPad."
        case nil:
            return ""
        }
    }

    private func bindingForNameAction() -> Binding<Bool> {
        Binding(
            get: { nameAction != nil },
            set: { if !$0 { nameAction = nil } }
        )
    }

    private func loadViews() async {
        isLoading = true
        errorMessage = nil
        infoMessage = nil

        defer {
            isLoading = false
        }

        do {
            let response = try await session.apiClient.get("/api/profiles")
            let context = DashboardSupport.profileContext(fromProfilesPayload: response)
            profileID = context.profileId
            dashboardViews = context.views
            defaultViewID = DashboardSupport.resolveSelectedViewID(profileId: context.profileId, views: context.views)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func submitNameAction() async {
        guard let profileID else {
            errorMessage = "Create or activate a user profile before managing dashboard views."
            return
        }

        let trimmedName = pendingName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else {
            return
        }

        switch nameAction {
        case .create:
            let nextView = DashboardSupport.defaultView(name: trimmedName)
            await persistViews(dashboardViews + [nextView], profileID: profileID, successMessage: "\"\(trimmedName)\" created.")
        case .rename(let viewID):
            let nextViews = dashboardViews.map { view in
                var mutable = view
                if view.id == viewID {
                    mutable.name = trimmedName
                }
                return mutable
            }
            await persistViews(nextViews, profileID: profileID, successMessage: "View renamed to \"\(trimmedName)\".")
        case .duplicate(let viewID):
            guard let source = dashboardViews.first(where: { $0.id == viewID }) else {
                return
            }
            let nextView = DashboardSupport.clone(view: source, named: trimmedName)
            await persistViews(dashboardViews + [nextView], profileID: profileID, successMessage: "\"\(trimmedName)\" duplicated.")
        case nil:
            break
        }

        nameAction = nil
    }

    private func deleteView(_ view: DashboardViewItem) async {
        guard let profileID else { return }

        let nextViews = dashboardViews.filter { $0.id != view.id }
        guard !nextViews.isEmpty else { return }

        await persistViews(nextViews, profileID: profileID, successMessage: "\"\(view.name)\" deleted.")
        pendingDeleteView = nil

        if defaultViewID == view.id {
            let nextDefault = DashboardSupport.resolveSelectedViewID(profileId: profileID, views: dashboardViews)
            DashboardSupport.setDefaultViewID(nextDefault, forProfileID: profileID)
            defaultViewID = nextDefault
        }
    }

    private func persistViews(_ nextViews: [DashboardViewItem], profileID: String, successMessage: String) async {
        isSaving = true
        defer { isSaving = false }

        do {
            let savedViews = try await DashboardSupport.saveViews(nextViews, profileId: profileID, apiClient: session.apiClient)
            dashboardViews = savedViews
            defaultViewID = DashboardSupport.resolveSelectedViewID(profileId: profileID, views: savedViews, current: defaultViewID)
            DashboardSupport.setDefaultViewID(defaultViewID, forProfileID: profileID)
            infoMessage = successMessage
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
