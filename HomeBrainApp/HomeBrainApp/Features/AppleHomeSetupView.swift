import SwiftUI
import HomeKit
import UIKit
import CoreImage.CIFilterBuiltins

struct AppleHomeSetupView: View {
    @StateObject private var store = AppleHomeStore.shared
    @State private var confirmingConnection = false
    @State private var confirmingDisable = false
    @State private var confirmingRestore = false
    @State private var restoreRequest: AppleHomeStore.RestoreRequest?
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        List {
            Section {
                Label("One home connection. No individual Shortcuts.", systemImage: "house.fill")
                    .font(.headline)
                Text("Pair HomeBrain with Apple Home once. HomeBrain discovers supported devices and creates rooms and named scenes for eligible workflows automatically.")
                Text("‘Siri, turn off Theater Cans.’\n‘Siri, turn on the master bedroom lights.’\n‘Siri, Stars Only.’")
                    .font(.subheadline)
            } header: { Text("Siri through Apple Home") }
            Section("Connection") {
                Text(store.message).accessibilityIdentifier("apple-home-status")
                    .textSelection(.enabled)
                if store.busy { ProgressView("Updating Apple Home…") }
                if let status = store.status {
                    LabeledContent("Backend", value: status.running ? "Bridge running" : status.enabled ? "Needs attention" : "Not enabled")
                    LabeledContent("Published by hub", value: String(status.targets.count))
                    if let matched = store.matchedAccessoryCount {
                        LabeledContent("Found in selected Apple Home", value: String(matched))
                    }
                    ForEach(status.bridges) { bridge in
                        LabeledContent(bridge.name, value: bridge.paired ? "Has a pairing" : "Not paired — setup required")
                    }
                    if status.running, !status.unpairedBridges.isEmpty {
                        Text("Pair the bridge once to add its devices to Apple's Home app. Choosing a home and tapping Synchronize do not complete pairing.")
                            .font(.footnote)
                    }
                    if status.canManage {
                        Button(store.hasConnected && status.enabled ? "Review Apple Home Connection" : "Connect HomeBrain to Apple Home") {
                            confirmingConnection = true
                        }
                        .accessibilityIdentifier("apple-home-connect")
                        .disabled(store.busy)
                        if status.running {
                            Button(status.unpairedBridges.isEmpty ? "Review Bridge Pairing" : "Set Up Bridge Pairing") {
                                Task { await store.loadPairing() }
                            }
                            .accessibilityIdentifier("apple-home-pairing")
                            .disabled(store.busy)
                        }
                    } else {
                        Text("A controlling HomeBrain administrator must enable and pair this bridge. People added to that Apple Home then use its devices and scenes through Siri.")
                            .font(.footnote)
                    }
                }
                Button("Refresh Connection & Synchronize") { Task { await store.refresh() } }.disabled(store.busy)
                if let request = store.restoreRequest {
                    Button("Restore HomeBrain Names & Rooms") {
                        restoreRequest = request
                        confirmingRestore = true
                    }
                    .accessibilityIdentifier("apple-home-restore")
                    .disabled(store.busy)
                    Text("Repair an existing import in one pass using HomeBrain's device names and assigned rooms. No re-pairing is needed.")
                        .font(.footnote)
                }
            }
            if store.homeAccessGranted {
                Section("Choose your Apple Home") {
                    Picker("Home", selection: Binding(get: { store.selectedHomeID }, set: { store.selectHome($0) })) {
                        Text("Choose a home").tag(Optional<UUID>.none)
                        ForEach(store.homes, id: \.uniqueIdentifier) { home in
                            Text(home.name).tag(Optional(home.uniqueIdentifier))
                        }
                    }.disabled(store.busy)
                    if store.homes.isEmpty {
                        Text("Create a home in Apple's Home app, then return here and refresh.").font(.footnote)
                    }
                }
            }
            if let pairing = store.pairing {
                Section("One-time bridge pairing") {
                    if store.selectedHomeID == nil {
                        Text("Choose your Apple Home above before pairing the bridge.").font(.footnote)
                    }
                    Text(pairing.pin).font(.system(.title, design: .monospaced)).textSelection(.enabled).privacySensitive()
                    Button("Copy Pairing Code") {
                        UIPasteboard.general.setItems([["public.utf8-plain-text": pairing.pin]], options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(120)])
                    }
                    Text("Tap Pair below. HomeBrain finds this bridge on your LAN; enter this code when Apple asks. HomeBrain then applies device names, assigned rooms, and workflow scenes. Apple may show an uncertified-accessory notice for this software bridge.")
                        .font(.footnote)
                    ForEach(pairing.bridges) { bridge in
                        let paired = store.status?.bridges.first(where: { $0.index == bridge.index })?.paired ?? bridge.paired
                        VStack(alignment: .leading, spacing: 12) {
                            Text(bridge.name).font(.headline)
                            Text(paired ? "This bridge has a pairing. Select the Apple Home used during pairing, then refresh to verify its accessories are present." : "Not paired. Tap Pair below to add this bridge and its devices to Apple Home.").font(.footnote)
                            if !paired {
                                Button("Pair \(bridge.name)") { Task { await store.pairBridge(bridge) } }
                                    .disabled(store.busy || store.selectedHomeID == nil)
                                DisclosureGroup("Pair using Apple's Home app instead") {
                                    Text("Apple's Home app runs its own setup for each accessory. Use Pair above to let HomeBrain organize the devices after pairing.").font(.footnote)
                                    if let image = qrImage(bridge.setupURI) {
                                        Image(uiImage: image).interpolation(.none).resizable().scaledToFit()
                                            .frame(width: 160, height: 160).padding(12).background(.white)
                                            .accessibilityLabel("HomeBrain bridge pairing QR code").privacySensitive()
                                    }
                                }
                            }
                        }.padding(.vertical, 6)
                    }
                    if pairing.bridges.count > 1 {
                        Text("Apple limits the number of accessories per bridge. Pair each listed bridge once; do not pair individual devices or create Shortcuts.").font(.footnote)
                    }
                    Button("Hide Pairing Code") { store.hidePairing() }
                }
            }
            if !store.issues.isEmpty {
                Section("Synchronization needs attention") {
                    ForEach(Array(store.issues.enumerated()), id: \.offset) { _, issue in
                        Text(issue).font(.footnote)
                    }
                }
            }
            if let status = store.status, !status.skipped.isEmpty {
                Section("Not exported to Apple Home") {
                    Text("Security devices and workflows with security, unresolved, or opaque actions are excluded from unrestricted Home switches. Existing HomeBrain controls are unchanged.").font(.footnote)
                    ForEach(status.skipped) { target in
                        VStack(alignment: .leading) {
                            Text(target.name)
                            Text(target.reason).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            Section("After connecting") {
                Text("Use Siri or Apple's Home app on iPhone, Apple Watch, and your home hub. There is no ‘in HomeBrain’ requirement for Apple Home device or scene names.")
                Text("Device changes publish automatically from the hub. Rooms and workflow scenes synchronize while this iPhone app is active and on its next opening. Existing customized Apple Home scenes are never overwritten.")
                Text("Pair on the same LAN as the hub. Remote Apple Home control needs an Apple TV or HomePod home hub. Never port-forward the HomeKit listener to the internet.")
                Text("Workflow switches trigger execution; they do not enable or disable workflows. Apple Home acknowledges the trigger. Check HomeBrain history for completion or failures of delayed workflows.")
                if store.status?.canManage == true, store.status?.enabled == true {
                    Button("Disable Apple Home Bridge", role: .destructive) { confirmingDisable = true }.disabled(store.busy)
                }
            }.font(.footnote)
        }
        .navigationTitle("Siri & Apple Home")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("apple-home-setup")
        .task { await store.refresh() }
        .onChange(of: scenePhase) { _, phase in if phase != .active { store.hidePairing() } }
        .onDisappear { store.hidePairing() }
        .alert("Share control with Apple Home?", isPresented: $confirmingConnection) {
            Button("Cancel", role: .cancel) {}
            Button("Connect") { Task { await store.connect() } }
        } message: {
            Text("Your Apple Home members and automations can control published devices and run eligible workflows using the bridge owner's HomeBrain permissions. HomeBrain will create and synchronize rooms and workflow scenes in the home you select. Security and unsupported actions remain excluded.")
        }
        .alert("Disable the Apple Home bridge?", isPresented: $confirmingDisable) {
            Button("Cancel", role: .cancel) {}
            Button("Disable", role: .destructive) { Task { await store.disable() } }
        } message: { Text("This stops Apple Home control for every member of the connected home. Your pairing identity is retained, so reconnecting does not require pairing again.") }
        .alert("Restore HomeBrain names and rooms?", isPresented: $confirmingRestore) {
            Button("Cancel", role: .cancel) {}
            Button("Restore") { Task { await store.restoreNamesAndRooms(restoreRequest) } }
        } message: {
            Text("This replaces names and assigned rooms for matched HomeBrain accessories in \(restoreRequest?.homeName ?? "the selected Apple Home"), including edits made in Apple Home. Accessories without a room in HomeBrain keep their current Apple Home room. Device state and customized scenes are unchanged.")
        }
    }
    private func qrImage(_ text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage,
              let image = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: image)
    }
}
