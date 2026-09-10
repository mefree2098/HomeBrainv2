import SwiftUI

struct HomeBrainSiriSetupView: View {
    #if os(iOS)
    var body: some View { AppleHomeSetupView() }
    #else
    @State private var status: HBAppleHomeStatus?
    @State private var message = "Loading Apple Home connection…"
    @State private var loading = false
    var body: some View {
        List {
            Section("Siri & Apple Home") {
                Text("Connect once on iPhone")
                    .font(.headline)
                Text("In HomeBrain on iPhone, open Settings → Siri & Apple Home. Pair the bridge and select your Apple Home. Devices, rooms, and workflow scenes synchronize automatically—no individual Shortcuts.")
                Text("Then use Siri on your Watch: ‘Turn off Theater Cans’ or ‘Stars Only.’ Apple Home and its home hub handle the command, not a manually named Shortcut.")
            }
            Section("Backend connection") {
                Text(message)
                if let status {
                    Text("\(status.targets.count) published targets")
                    Text("\(status.bridges.filter(\.paired).count) of \(status.bridges.count) bridges paired")
                    if !status.skipped.isEmpty { Text("\(status.skipped.count) unsupported or security-sensitive targets excluded. Review details on iPhone.") }
                }
                Button("Refresh") { Task { await reload() } }.disabled(loading)
            }
            Section("Requirements") {
                Text("Use the same Apple Home on iPhone and Watch. Remote control requires an Apple TV or HomePod home hub. HomeBrain must stay running and reachable on your home network.")
                Text("The existing HomeBrain App Intents remain available as an optional fallback using ‘in HomeBrain.’ They are not required for Apple Home control.")
            }
        }
        .navigationTitle("Siri & Apple Home")
        .task { await reload() }
    }
    @MainActor private func reload() async {
        guard !loading else { return }
        loading = true; defer { loading = false }
        do {
            let (value, _) = try await HomeBrainSiriRuntime.client.appleHomeStatus()
            status = value
            message = !value.error.isEmpty ? value.error : value.running ? "HomeBrain bridge is running." : "Connect the bridge from your iPhone first."
        } catch { status = nil; message = error.localizedDescription }
    }
    #endif
}
