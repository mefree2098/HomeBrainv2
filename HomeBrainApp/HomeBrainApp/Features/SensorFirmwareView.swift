import SwiftUI

struct SensorFirmwareView: View {
    @EnvironmentObject private var session: SessionStore
    @Environment(\.scenePhase) private var scenePhase
    let nodeId: String
    @State private var snapshot: [String: Any] = [:]
    @State private var error: String?
    @State private var busy = false

    private var latest: [String: Any] { JSON.object(snapshot["latest"]) }
    private var update: [String: Any] { JSON.object(snapshot["update"]) }
    private var phase: String { JSON.string(update, "phase") }
    private var active: Bool { ["queued", "downloading", "installing", "rebooting"].contains(phase) }
    private var supported: Bool { snapshot["supported"] as? Bool == true }
    private var latestVersion: String { JSON.string(latest, "version") }
    private var available: Bool { snapshot["updateAvailable"] as? Bool == true }
    private var currentVersion: String { JSON.string(snapshot, "currentVersion") }
    private var canInstall: Bool { available || (!latestVersion.isEmpty && latestVersion == currentVersion) }
    private var progress: Double { (update["progress"] as? NSNumber)?.doubleValue ?? 0 }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Firmware updates", systemImage: "arrow.down.circle").font(.headline)
            if snapshot.isEmpty && error == nil {
                ProgressView("Checking firmware…")
            } else if !snapshot.isEmpty {
                Text("Installed: \(currentVersion)")
                    .font(.caption).foregroundStyle(.secondary)
                if !supported {
                    Text("A one-time USB installation is needed to enable wireless updates. Future updates will install over Wi-Fi.")
                        .font(.callout)
                } else {
                    if !latestVersion.isEmpty {
                        Text(available ? "Version \(latestVersion) is available" : "Firmware is up to date")
                        let notes = JSON.string(latest, "notes")
                        if !notes.isEmpty { Text(notes).font(.caption).foregroundStyle(.secondary) }
                    } else {
                        Text("No firmware release has been published yet.").font(.callout)
                    }
                    if !phase.isEmpty {
                        Text(statusText).font(.callout)
                            .foregroundStyle(phase == "failed" ? Color.orange : Color.primary)
                        if active && phase != "queued" { ProgressView(value: progress, total: 100) }
                    }
                    if canInstall && !active {
                        Button {
                            Task { await install() }
                        } label: {
                            Label(busy ? "Scheduling…" : available ? "Update to \(latestVersion)" : "Reinstall \(latestVersion)", systemImage: "arrow.down.circle")
                        }
                        .buttonStyle(HBSecondaryButtonStyle())
                        .disabled(busy || error != nil)
                    }
                    if active {
                        Text("The sensor updates over Wi-Fi. Keep it powered while the update finishes.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            if let error {
                Text(error).font(.caption).foregroundStyle(.orange)
                Button("Refresh") { Task { await refresh() } }.disabled(busy)
            }
        }
        .task(id: "\(session.sessionContextID):\(nodeId):\(scenePhase)") {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                await refresh()
                do { try await Task.sleep(for: .seconds(active ? 3 : 30)) }
                catch { return }
            }
        }
    }

    private var statusText: String {
        switch phase {
        case "queued": return "Waiting for the sensor’s next report. Sleeping sensors update when they wake."
        case "downloading": return "Downloading \(JSON.string(update, "version")) · \(Int(progress))%"
        case "installing": return "Verifying firmware…"
        case "rebooting": return "Restarting and checking that the sensor reports successfully…"
        case "succeeded": return "Version \(JSON.string(update, "version")) installed and verified."
        case "failed": return "Update failed: \(JSON.string(update, "error"))"
        default: return ""
        }
    }

    @MainActor private func refresh() async {
        do {
            let response = try await session.apiClient.get("/api/sensor-nodes/\(nodeId)/firmware")
            guard !Task.isCancelled else { return }
            snapshot = JSON.object(response)
            error = nil
        } catch {
            guard !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
    }

    @MainActor private func install() async {
        guard !busy, !active, supported else { return }
        busy = true
        defer { busy = false }
        do {
            let response = JSON.object(try await session.apiClient.post("/api/sensor-nodes/\(nodeId)/firmware",
                body: ["releaseId": JSON.string(latest, "id")]))
            snapshot["update"] = response["update"]
            error = nil
            await refresh()
        } catch { self.error = error.localizedDescription }
    }
}
