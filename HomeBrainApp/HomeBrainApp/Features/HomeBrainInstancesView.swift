import SwiftUI

struct HomeBrainInstanceSwitcherButton: View {
    @EnvironmentObject private var session: SessionStore

    let compact: Bool
    let onManage: () -> Void

    var body: some View {
        Menu {
            Section("HomeBrains") {
                ForEach(session.savedInstances) { instance in
                    Button {
                        session.switchInstance(to: instance.id)
                    } label: {
                        Label {
                            Text(instance.displayName)
                        } icon: {
                            Image(systemName: instance.id == session.activeInstanceID ? "checkmark.circle.fill" : "house")
                        }
                    }
                    .disabled(instance.id == session.activeInstanceID)
                }
            }

            Divider()

            Button {
                session.beginAddingInstance()
            } label: {
                Label("Add HomeBrain", systemImage: "plus.circle")
            }

            Button(action: onManage) {
                Label("Manage HomeBrains", systemImage: "slider.horizontal.3")
            }
        } label: {
            if compact {
                Image(systemName: "rectangle.2.swap")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(HBPalette.textPrimary)
                    .frame(width: 42, height: 42)
                    .background(HBGlassBackground(cornerRadius: 14, variant: .panel))
            } else {
                HStack(spacing: 8) {
                    Image(systemName: "rectangle.2.swap")
                        .foregroundStyle(HBPalette.accentBlue)

                    Text(session.activeInstance?.displayName ?? "HomeBrain")
                        .font(HBTypography.body(size: 13, weight: .semibold))
                        .foregroundStyle(HBPalette.textPrimary)
                        .lineLimit(1)

                    Image(systemName: "chevron.down")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(HBPalette.textMuted)
                }
                .padding(.horizontal, 12)
                .frame(minHeight: 40)
                .background(HBGlassBackground(cornerRadius: 14, variant: .panel))
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Switch HomeBrain")
        .accessibilityValue(session.activeInstance?.displayName ?? "No active HomeBrain")
        .accessibilityIdentifier("homebrain.instance.switcher")
    }
}

struct HomeBrainInstancesView: View {
    @EnvironmentObject private var session: SessionStore
    @Environment(\.dismiss) private var dismiss

    @State private var instancePendingRemoval: HomeBrainInstance?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(session.savedInstances) { instance in
                        instanceRow(instance)
                    }
                } header: {
                    Text("Saved HomeBrains")
                } footer: {
                    Text("Each platform keeps its own URL, account, and secure session. Only the selected HomeBrain is loaded into the app.")
                }

                Section {
                    Button {
                        dismiss()
                        session.beginAddingInstance()
                    } label: {
                        Label("Add Another HomeBrain", systemImage: "plus.circle.fill")
                    }
                }
            }
            .navigationTitle("HomeBrains")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog(
                removalTitle,
                isPresented: Binding(
                    get: { instancePendingRemoval != nil },
                    set: { if !$0 { instancePendingRemoval = nil } }
                ),
                titleVisibility: .visible
            ) {
                if let instancePendingRemoval {
                    Button("Sign Out and Remove", role: .destructive) {
                        session.removeInstance(instancePendingRemoval.id)
                        self.instancePendingRemoval = nil
                    }
                    Button("Cancel", role: .cancel) {
                        self.instancePendingRemoval = nil
                    }
                }
            } message: {
                Text("This removes the saved session only for this HomeBrain. Other platforms remain signed in.")
            }
        }
    }

    private func instanceRow(_ instance: HomeBrainInstance) -> some View {
        HStack(spacing: 12) {
            Button {
                session.switchInstance(to: instance.id)
                dismiss()
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: instance.id == session.activeInstanceID ? "house.circle.fill" : "house.circle")
                        .font(.system(size: 28))
                        .foregroundStyle(instance.id == session.activeInstanceID ? HBPalette.accentBlue : HBPalette.textSecondary)

                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Text(instance.displayName)
                                .font(HBTypography.body(.body, weight: .semibold))
                                .foregroundStyle(HBPalette.textPrimary)
                                .lineLimit(1)

                            if instance.id == session.activeInstanceID {
                                Text("ACTIVE")
                                    .font(HBTypography.display(size: 9, weight: .bold))
                                    .tracking(1.2)
                                    .foregroundStyle(HBPalette.accentBlue)
                            }
                        }

                        Text(instance.accountSummary)
                            .font(HBTypography.body(.caption, weight: .medium))
                            .foregroundStyle(HBPalette.textSecondary)
                            .lineLimit(1)
                    }

                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(instance.id == session.activeInstanceID)

            Button(role: .destructive) {
                instancePendingRemoval = instance
            } label: {
                Image(systemName: "trash")
                    .foregroundStyle(HBPalette.accentRed)
                    .frame(width: 36, height: 36)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove \(instance.displayName)")
        }
        .accessibilityElement(children: .contain)
    }

    private var removalTitle: String {
        guard let instancePendingRemoval else { return "Remove HomeBrain?" }
        return "Remove \(instancePendingRemoval.displayName)?"
    }
}
