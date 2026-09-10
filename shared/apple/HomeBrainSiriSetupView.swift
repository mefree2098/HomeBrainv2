import SwiftUI

struct HomeBrainSiriSetupView: View {
    @State private var targets: [HBSiriTarget] = []
    @State private var status = "Loading Siri actions…"
    @State private var loading = false

    var body: some View {
        List {
            Section("Speak to Siri") {
                Text("Turn on Master Bedroom lights in HomeBrain")
                Text("Run Night TV in HomeBrain")
                Text("Siri can control individual lights, rooms, brightness, workflows, and scenes without opening the app. Names come from your signed-in HomeBrain.")
                    .font(.footnote)
            }
            Section("Your exact phrases") {
                Text("On iPhone, open Shortcuts, create a shortcut, and add a HomeBrain action.")
                Text("For lights, choose Turn On Lights → Master Bedroom lights. Name the shortcut ‘Turn on the master bedroom lights’.")
                Text("For Night TV, choose Run Workflow → Night TV. Name the shortcut ‘Turn on night tv’.")
                Text("Enable Show on Apple Watch in each shortcut’s Details. Then say ‘Hey Siri’ followed by its name on either device.")
                Text("Apple’s automatic App Shortcut phrases include ‘in HomeBrain’. Custom shortcut names provide shorter phrases. A conflicting Apple Home or system command may need a unique shortcut name.")
                    .font(.footnote)
                #if os(iOS)
                Link("Open Shortcuts", destination: URL(string: "shortcuts://")!)
                #endif
            }
            Section("Connection") {
                Text(status)
                Text("Sign in on iPhone and sync the watch session before first use. Both devices need network access to your hub. Siri cannot silently switch a saved shortcut to another home or account.")
                    .font(.footnote)
                Button("Refresh Siri Actions") { Task { await reload() } }
                    .disabled(loading)
            }
            ForEach(["room", "light", "workflow", "scene"], id: \.self) { kind in
                Section(kind.capitalized + " Actions") {
                    ForEach(targets.filter { $0.kind == kind }, id: \.id) { target in
                        VStack(alignment: .leading) {
                            Text(target.name)
                            if !target.aliases.isEmpty { Text(target.aliases.joined(separator: ", ")).font(.footnote).foregroundStyle(.secondary) }
                        }
                    }
                }
            }
        }
        .navigationTitle("Siri & Shortcuts")
        .task { await reload() }
    }
    @MainActor private func reload() async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let (catalog, _) = try await HomeBrainSiriRuntime.client.catalog()
            targets = catalog.targets
            status = catalog.canExecute ? "Connected. \(targets.count) targets are available to Siri." : "Connected with a read-only account. Commands are unavailable."
            HomeBrainSiriRuntime.refreshSuggestions()
        } catch {
            targets = []
            status = error.localizedDescription
        }
    }
}
