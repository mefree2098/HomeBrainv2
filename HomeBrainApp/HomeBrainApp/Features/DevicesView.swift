import SwiftUI

struct DevicesView: View {
    @EnvironmentObject private var session: SessionStore

    @State private var devices: [DeviceItem] = []
    @State private var isLoading = true
    @State private var errorMessage: String?

    @State private var searchText = ""
    @State private var typeFilter = "all"

    @State private var showCreateSheet = false
    @State private var newName = ""
    @State private var newType = "light"
    @State private var newRoom = ""

    private let availableTypes = ["all", "light", "lock", "thermostat", "garage", "sensor", "switch", "camera"]

    private var filteredDevices: [DeviceItem] {
        devices.filter { device in
            let matchesSearch = searchText.isEmpty || device.name.localizedCaseInsensitiveContains(searchText) || device.room.localizedCaseInsensitiveContains(searchText)
            let matchesType = typeFilter == "all" || device.type == typeFilter
            return matchesSearch && matchesType
        }
    }

    var body: some View {
        Group {
            if isLoading {
                LoadingView(title: "Loading devices...")
            } else {
                VStack(spacing: 12) {
                    if let errorMessage {
                        InlineErrorView(message: errorMessage) {
                            Task { await loadDevices() }
                        }
                    }

                    HStack {
                        TextField("Search devices", text: $searchText)
                            .textFieldStyle(.roundedBorder)

                        Picker("Type", selection: $typeFilter) {
                            ForEach(availableTypes, id: \.self) { type in
                                Text(type.capitalized).tag(type)
                            }
                        }
                        .pickerStyle(.menu)
                    }

                    if filteredDevices.isEmpty {
                        EmptyStateView(
                            title: "No devices match",
                            subtitle: "Adjust filters or create a new device."
                        )
                    } else {
                        List {
                            ForEach(filteredDevices) { device in
                                deviceRow(device)
                            }
                            .onDelete(perform: delete)
                        }
                        .listStyle(.plain)
                    }
                }
                .padding()
                .toolbar {
                    ToolbarItem(placement: .primaryAction) {
                        Button("Add Device") {
                            showCreateSheet = true
                        }
                    }
                }
                .sheet(isPresented: $showCreateSheet) {
                    createDeviceSheet
                }
                .refreshable {
                    await loadDevices()
                }
            }
        }
        .task {
            await loadDevices()
        }
    }

    private func deviceRow(_ device: DeviceItem) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(device.name)
                    .font(.headline)
                Text("\(device.room) · \(device.type)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(device.isOnline ? "Online" : "Offline")
                    .font(.caption2)
                    .foregroundStyle(device.isOnline ? .green : .red)
            }

            Spacer()

            Button(device.status ? "Off" : "On") {
                Task { await toggle(device) }
            }
            .buttonStyle(.borderedProminent)
            .tint(device.status ? .red : .green)
        }
    }

    private var createDeviceSheet: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $newName)
                TextField("Room", text: $newRoom)

                Picker("Type", selection: $newType) {
                    ForEach(availableTypes.filter { $0 != "all" }, id: \.self) { type in
                        Text(type.capitalized).tag(type)
                    }
                }
            }
            .navigationTitle("New Device")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        showCreateSheet = false
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        Task { await createDevice() }
                    }
                    .disabled(newName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || newRoom.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private func loadDevices() async {
        isLoading = true
        errorMessage = nil

        do {
            let response = try await session.apiClient.get("/api/devices")
            let object = JSON.object(response)
            let data = JSON.object(object["data"])
            let list = JSON.array(data["devices"]).map(DeviceItem.from)
            devices = list.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    private func toggle(_ device: DeviceItem) async {
        do {
            let action = device.status ? "turn_off" : "turn_on"
            let payload: [String: Any] = ["deviceId": device.id, "action": action]
            let response = try await session.apiClient.post("/api/devices/control", body: payload)
            let object = JSON.object(response)
            let data = JSON.object(object["data"])
            let updated = DeviceItem.from(JSON.object(data["device"]))

            if let index = devices.firstIndex(where: { $0.id == updated.id }) {
                devices[index] = updated
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func createDevice() async {
        do {
            let payload: [String: Any] = [
                "name": newName.trimmingCharacters(in: .whitespacesAndNewlines),
                "room": newRoom.trimmingCharacters(in: .whitespacesAndNewlines),
                "type": newType,
                "status": false,
                "isOnline": true
            ]

            let response = try await session.apiClient.post("/api/devices", body: payload)
            let object = JSON.object(response)
            let data = JSON.object(object["data"])
            let created = DeviceItem.from(JSON.object(data["device"]))
            devices.append(created)
            devices.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }

            showCreateSheet = false
            newName = ""
            newRoom = ""
            newType = "light"
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func delete(at offsets: IndexSet) {
        let items = offsets.map { filteredDevices[$0] }

        Task {
            for item in items {
                do {
                    _ = try await session.apiClient.delete("/api/devices/\(item.id)")
                    devices.removeAll { $0.id == item.id }
                } catch {
                    errorMessage = error.localizedDescription
                }
            }
        }
    }
}
