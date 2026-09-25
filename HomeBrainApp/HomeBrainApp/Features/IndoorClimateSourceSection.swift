import SwiftUI

private struct IndoorClimateSourceOption: Identifiable {
    let id: String
    let label: String
}

struct IndoorClimateSourceSection: View {
    @EnvironmentObject private var session: SessionStore
    @State private var sources: [IndoorClimateSourceOption] = []
    @State private var selection = "__auto__"
    @State private var savedSelection = "__auto__"
    @State private var loaded = false
    @State private var busy = false
    @State private var errorMessage: String?
    @State private var didSave = false

    var body: some View {
        Section("Climate data source") {
            Picker("Indoor climate source", selection: $selection) {
                Text("Automatic (configured Govee monitor)").tag("__auto__")
                ForEach(sources) { source in
                    Text(source.label).tag(source.id)
                }
                if selection != "__auto__" && !sources.contains(where: { $0.id == selection }) {
                    Text("Saved source (currently unavailable)").tag(selection)
                }
            }
            .disabled(busy || !loaded)
            .accessibilityIdentifier("indoor-climate-source")

            Text("Choose the sensor for indoor dashboard readings and weather history. This setting is shared across the web app, iPhones, and iPads.")
                .font(.footnote)
                .foregroundStyle(.secondary)

            Button("Save source") { Task { await save() } }
                .disabled(busy || !loaded || selection == savedSelection)
            Button("Refresh sources") { Task { await load() } }
                .disabled(busy)
            if busy { ProgressView() }
            if let errorMessage {
                Text(errorMessage).font(.footnote).foregroundStyle(.red)
            }
            if didSave && selection == savedSelection {
                Text("Indoor climate source saved.").font(.footnote).foregroundStyle(.secondary)
            }
        }
        .task(id: session.sessionContextID) { await load() }
    }

    private func apply(_ response: Any) {
        let data = JSON.object(JSON.object(response)["data"])
        sources = JSON.array(data["resources"]).compactMap { value in
            let source = JSON.object(value)
            let module = JSON.string(source, "moduleId")
            let resource = JSON.string(source, "id")
            guard !module.isEmpty, !resource.isEmpty else { return nil }
            let room = JSON.string(source, "room")
            let offline = source["online"] as? Bool == false ? " (offline)" : ""
            return IndoorClimateSourceOption(
                id: "\(module)::\(resource)",
                label: JSON.string(source, "label") + (room.isEmpty ? "" : " · \(room)") + offline
            )
        }
        let preference = JSON.object(data["preference"])
        let module = JSON.string(preference, "moduleId")
        selection = JSON.string(preference, "mode") == "selected" && !module.isEmpty
            ? "\(module)::\(JSON.string(preference, "resourceId"))" : "__auto__"
        savedSelection = selection
        loaded = true
    }

    @MainActor private func load() async {
        busy = true
        loaded = false
        errorMessage = nil
        didSave = false
        defer { busy = false }
        do {
            let response = try await session.apiClient.get("/api/integrations/capabilities/indoor_climate/providers")
            guard !Task.isCancelled else { return }
            apply(response)
        } catch {
            guard !Task.isCancelled else { return }
            errorMessage = error.localizedDescription
        }
    }

    @MainActor private func save() async {
        busy = true
        errorMessage = nil
        didSave = false
        defer { busy = false }
        let parts = selection.components(separatedBy: "::")
        let automatic = selection == "__auto__"
        do {
            let response = try await session.apiClient.put("/api/integrations/capabilities/indoor_climate/preference", body: [
                "mode": automatic ? "auto" : "selected",
                "moduleId": automatic ? "" : parts[0],
                "resourceId": automatic || parts.count < 2 ? "" : parts[1]
            ])
            guard !Task.isCancelled else { return }
            apply(response)
            didSave = true
        } catch {
            guard !Task.isCancelled else { return }
            errorMessage = error.localizedDescription
        }
    }
}
