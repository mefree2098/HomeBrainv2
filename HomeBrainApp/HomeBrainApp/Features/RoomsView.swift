import SwiftUI

nonisolated private struct RoomItem: Identifiable, Equatable {
    let registryId: String?
    let name: String
    let normalizedName: String
    let registered: Bool
    let isDefault: Bool
    let deviceCount: Int
    let wallPanelCount: Int
    let voiceDeviceCount: Int
    let totalReferences: Int

    var id: String { normalizedName.isEmpty ? name : normalizedName }

    static func from(_ object: [String: Any]) -> RoomItem {
        RoomItem(
            registryId: JSON.optionalString(object, "id"),
            name: JSON.string(object, "name", fallback: "Unassigned"),
            normalizedName: JSON.string(object, "normalizedName", fallback: ""),
            registered: JSON.bool(object, "registered"),
            isDefault: JSON.bool(object, "isDefault"),
            deviceCount: JSON.int(object, "deviceCount"),
            wallPanelCount: JSON.int(object, "wallPanelCount"),
            voiceDeviceCount: JSON.int(object, "voiceDeviceCount"),
            totalReferences: JSON.int(object, "totalReferences")
        )
    }
}

struct RoomsView: View {
    @EnvironmentObject private var session: SessionStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    let previewMode: Bool

    @State private var rooms: [RoomItem] = []
    @State private var selectedRoomName = ""
    @State private var newRoomName = ""
    @State private var editRoomName = ""
    @State private var reassignRoomName = ""
    @State private var isLoading = true
    @State private var isSaving = false
    @State private var isRefreshing = false
    @State private var errorMessage: String?
    @State private var infoMessage: String?
    @State private var pendingDeleteRoom: RoomItem?

    private var usesCompactLayout: Bool {
        horizontalSizeClass == .compact
    }

    private var selectedRoom: RoomItem? {
        rooms.first { $0.name == selectedRoomName } ?? rooms.first
    }

    private var roomKeys: Set<String> {
        Set(rooms.map { roomKey($0.name) })
    }

    private var normalizedNewRoomName: String {
        normalizedRoomName(newRoomName)
    }

    private var normalizedEditRoomName: String {
        normalizedRoomName(editRoomName)
    }

    private var canCreateRoom: Bool {
        !normalizedNewRoomName.isEmpty
            && !roomKeys.contains(roomKey(normalizedNewRoomName))
            && !isSaving
    }

    private var canRenameRoom: Bool {
        guard let selectedRoom else { return false }
        return !selectedRoom.isDefault
            && !normalizedEditRoomName.isEmpty
            && roomKey(normalizedEditRoomName) != roomKey(selectedRoom.name)
            && !roomKeys.contains(roomKey(normalizedEditRoomName))
            && !isSaving
    }

    private var reassignmentOptions: [RoomItem] {
        guard let selectedRoom else { return rooms }
        let selectedKey = roomKey(selectedRoom.name)
        return rooms.filter { roomKey($0.name) != selectedKey }
    }

    var body: some View {
        Group {
            if isLoading {
                LoadingView(title: "Loading rooms...")
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 16) {
                        if let errorMessage {
                            InlineErrorView(message: errorMessage) {
                                Task { await loadRooms() }
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

                        headerPanel

                        if usesCompactLayout {
                            VStack(alignment: .leading, spacing: 14) {
                                roomListPanel
                                detailPanel
                            }
                        } else {
                            HStack(alignment: .top, spacing: 16) {
                                roomListPanel
                                    .frame(width: 320)
                                detailPanel
                                    .frame(maxWidth: .infinity)
                            }
                        }
                    }
                    .padding(16)
                    .padding(.bottom, 12)
                }
                .scrollIndicators(.hidden)
                .refreshable {
                    await loadRooms(silent: true)
                }
            }
        }
        .task {
            await loadRooms()
        }
        .onChange(of: selectedRoomName) { _, _ in
            syncDraftsFromSelectedRoom()
        }
        .confirmationDialog(
            "Delete room?",
            isPresented: Binding(
                get: { pendingDeleteRoom != nil },
                set: { if !$0 { pendingDeleteRoom = nil } }
            ),
            presenting: pendingDeleteRoom
        ) { room in
            Button("Delete \(room.name)", role: .destructive) {
                Task { await deleteRoom(room) }
            }
            .disabled(room.totalReferences > 0 && reassignRoomName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

            Button("Cancel", role: .cancel) {
                pendingDeleteRoom = nil
            }
        } message: { room in
            if room.totalReferences > 0 {
                Text("Assigned hardware will move to \(reassignRoomName).")
            } else {
                Text("This removes the empty room from the saved room list.")
            }
        }
    }

    private var headerPanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 14) {
                HBSectionHeader(
                    title: "Rooms",
                    subtitle: "Manage saved room names and assignments across HomeBrain.",
                    eyebrow: "Room Registry"
                )

                if usesCompactLayout {
                    VStack(alignment: .leading, spacing: 10) {
                        createRoomFields
                        refreshButton
                    }
                } else {
                    HStack(alignment: .bottom, spacing: 10) {
                        createRoomFields
                        refreshButton
                    }
                }
            }
        }
    }

    private var createRoomFields: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField("Vault", text: $newRoomName)
                .hbPanelTextField()
                .disabled(isSaving)

            Button {
                Task { await createRoom() }
            } label: {
                Label("Add", systemImage: "plus")
                    .labelStyle(.titleAndIcon)
            }
            .buttonStyle(HBPrimaryButtonStyle(compact: true))
            .disabled(!canCreateRoom)
        }
    }

    private var refreshButton: some View {
        Button {
            Task { await loadRooms(silent: true) }
        } label: {
            Label(isRefreshing ? "Refreshing" : "Refresh", systemImage: "arrow.clockwise")
        }
        .buttonStyle(HBSecondaryButtonStyle(compact: true))
        .disabled(isRefreshing)
    }

    private var roomListPanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 12) {
                Label("Current Rooms", systemImage: "map")
                    .font(HBTypography.display(size: 15, weight: .bold))
                    .foregroundStyle(HBPalette.textPrimary)

                ForEach(rooms) { room in
                    roomListButton(room)
                }
            }
        }
    }

    private func roomListButton(_ room: RoomItem) -> some View {
        Button {
            selectedRoomName = room.name
        } label: {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 10) {
                    Text(room.name)
                        .font(HBTypography.body(size: 15, weight: .semibold))
                        .foregroundStyle(HBPalette.textPrimary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)

                    Spacer()

                    Text("\(room.totalReferences)")
                        .font(HBTypography.display(size: 12, weight: .bold))
                        .foregroundStyle(HBPalette.textPrimary)
                        .padding(.horizontal, 9)
                        .padding(.vertical, 5)
                        .background(HBPalette.panelSoft.opacity(0.9), in: Capsule())
                }

                Text("\(room.deviceCount) devices · \(room.wallPanelCount) panels · \(room.voiceDeviceCount) voice")
                    .font(HBTypography.body(size: 12, weight: .medium))
                    .foregroundStyle(HBPalette.textSecondary)
                    .lineLimit(2)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                HBGlassBackground(
                    cornerRadius: 16,
                    variant: room.name == selectedRoom?.name ? .panelStrong : .panelSoft
                )
            )
        }
        .buttonStyle(.plain)
    }

    private var detailPanel: some View {
        HBPanel {
            if let selectedRoom {
                VStack(alignment: .leading, spacing: 16) {
                    HStack(alignment: .top, spacing: 12) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(selectedRoom.name)
                                .font(HBTypography.display(size: 24, weight: .bold))
                                .foregroundStyle(HBPalette.textPrimary)
                                .lineLimit(1)
                                .minimumScaleFactor(0.7)

                            referenceBadges(for: selectedRoom)
                        }
                        Spacer()
                    }

                    VStack(alignment: .leading, spacing: 10) {
                        Text("Name")
                            .font(HBTypography.body(size: 14, weight: .semibold))
                            .foregroundStyle(HBPalette.textSecondary)

                        HStack(alignment: .bottom, spacing: 10) {
                            TextField("Room name", text: $editRoomName)
                                .hbPanelTextField()
                                .disabled(selectedRoom.isDefault || isSaving)

                            Button {
                                Task { await renameSelectedRoom() }
                            } label: {
                                Label("Rename", systemImage: "square.and.pencil")
                            }
                            .buttonStyle(HBSecondaryButtonStyle(compact: true))
                            .disabled(!canRenameRoom)
                        }
                    }

                    deletePanel(for: selectedRoom)
                }
            } else {
                EmptyStateView(
                    title: "No rooms",
                    subtitle: "Create a room to make it available in HomeBrain."
                )
            }
        }
    }

    private func referenceBadges(for room: RoomItem) -> some View {
        LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 92), spacing: 8, alignment: .leading)],
            alignment: .leading,
            spacing: 8
        ) {
            HBBadge(text: "\(room.deviceCount) devices")
            HBBadge(text: "\(room.wallPanelCount) panels")
            HBBadge(text: "\(room.voiceDeviceCount) voice")
            HBBadge(
                text: room.registered ? "Saved" : "Derived",
                foreground: room.registered ? HBPalette.accentGreen : HBPalette.textSecondary,
                background: room.registered ? HBPalette.accentGreen.opacity(0.16) : HBPalette.panelSoft,
                stroke: room.registered ? HBPalette.accentGreen.opacity(0.7) : HBPalette.panelStrokeStrong
            )
        }
    }

    private func deletePanel(for room: RoomItem) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Delete Room", systemImage: "exclamationmark.triangle.fill")
                .font(HBTypography.display(size: 14, weight: .bold))
                .foregroundStyle(HBPalette.accentOrange)

            Text(room.totalReferences > 0 ? "Assigned hardware must move before this room can be removed." : "This room has no assigned hardware.")
                .font(HBTypography.body(.subheadline))
                .foregroundStyle(HBPalette.textSecondary)

            if room.totalReferences > 0 {
                HStack {
                    Text("Move to")
                        .font(HBTypography.body(size: 14, weight: .semibold))
                        .foregroundStyle(HBPalette.textSecondary)
                    Spacer()
                    Picker("Move to", selection: $reassignRoomName) {
                        Text("Choose").tag("")
                        ForEach(reassignmentOptions) { option in
                            Text(option.name).tag(option.name)
                        }
                    }
                    .pickerStyle(.menu)
                    .tint(HBPalette.accentBlue)
                }
            }

            Button {
                pendingDeleteRoom = room
            } label: {
                Label("Delete", systemImage: "trash")
            }
            .buttonStyle(HBDestructiveButtonStyle(compact: true))
            .disabled(room.isDefault || isSaving || (room.totalReferences > 0 && reassignRoomName.isEmpty))
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HBPalette.accentOrange.opacity(0.10), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(HBPalette.accentOrange.opacity(0.30), lineWidth: 1)
        )
    }

    private func loadRooms(silent: Bool = false) async {
        if previewMode {
            rooms = [
                RoomItem(registryId: nil, name: "Unassigned", normalizedName: "unassigned", registered: false, isDefault: true, deviceCount: 1, wallPanelCount: 0, voiceDeviceCount: 0, totalReferences: 1),
                RoomItem(registryId: "preview-room-vault", name: "Vault", normalizedName: "vault", registered: true, isDefault: false, deviceCount: 12, wallPanelCount: 1, voiceDeviceCount: 1, totalReferences: 14),
                RoomItem(registryId: "preview-room-upstairs", name: "Upstairs", normalizedName: "upstairs", registered: true, isDefault: false, deviceCount: 28, wallPanelCount: 2, voiceDeviceCount: 1, totalReferences: 31)
            ]
            selectedRoomName = selectedRoomName.isEmpty ? rooms[0].name : selectedRoomName
            editRoomName = selectedRoom?.name ?? ""
            isLoading = false
            return
        }

        if silent {
            isRefreshing = true
        } else {
            isLoading = true
        }
        errorMessage = nil

        defer {
            isLoading = false
            isRefreshing = false
        }

        do {
            let response = try await session.apiClient.get("/api/rooms")
            applyRoomsResponse(response)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func createRoom() async {
        let roomName = normalizedNewRoomName
        guard canCreateRoom else { return }

        if previewMode {
            rooms.append(RoomItem(registryId: UUID().uuidString, name: roomName, normalizedName: roomKey(roomName), registered: true, isDefault: false, deviceCount: 0, wallPanelCount: 0, voiceDeviceCount: 0, totalReferences: 0))
            rooms.sort { sortRooms($0, $1) }
            selectedRoomName = roomName
            newRoomName = ""
            infoMessage = "\(roomName) added."
            return
        }

        await performSave {
            let response = try await session.apiClient.post("/api/rooms", body: ["name": roomName])
            applyRoomsResponse(response, preferredName: roomName)
            newRoomName = ""
            infoMessage = "\(roomName) added."
        }
    }

    private func renameSelectedRoom() async {
        guard let selectedRoom, canRenameRoom else { return }
        let nextName = normalizedEditRoomName

        if previewMode {
            rooms = rooms.map { room in
                guard room.id == selectedRoom.id else { return room }
                return RoomItem(
                    registryId: room.registryId,
                    name: nextName,
                    normalizedName: roomKey(nextName),
                    registered: true,
                    isDefault: false,
                    deviceCount: room.deviceCount,
                    wallPanelCount: room.wallPanelCount,
                    voiceDeviceCount: room.voiceDeviceCount,
                    totalReferences: room.totalReferences
                )
            }.sorted(by: sortRooms)
            selectedRoomName = nextName
            infoMessage = "\(selectedRoom.name) renamed."
            return
        }

        await performSave {
            let encoded = encodedPathSegment(selectedRoom.name)
            let response = try await session.apiClient.put("/api/rooms/\(encoded)", body: ["name": nextName])
            applyRoomsResponse(response, preferredName: nextName)
            infoMessage = "\(selectedRoom.name) renamed."
        }
    }

    private func deleteRoom(_ room: RoomItem) async {
        if previewMode {
            if room.totalReferences > 0, !reassignRoomName.isEmpty {
                rooms = rooms.map { current in
                    guard current.name == reassignRoomName else { return current }
                    return RoomItem(
                        registryId: current.registryId,
                        name: current.name,
                        normalizedName: current.normalizedName,
                        registered: current.registered,
                        isDefault: current.isDefault,
                        deviceCount: current.deviceCount + room.deviceCount,
                        wallPanelCount: current.wallPanelCount + room.wallPanelCount,
                        voiceDeviceCount: current.voiceDeviceCount + room.voiceDeviceCount,
                        totalReferences: current.totalReferences + room.totalReferences
                    )
                }
            }
            rooms.removeAll { $0.id == room.id }
            selectedRoomName = rooms.first?.name ?? ""
            pendingDeleteRoom = nil
            infoMessage = "\(room.name) deleted."
            return
        }

        await performSave {
            let encoded = encodedPathSegment(room.name)
            let reassignQuery = room.totalReferences > 0 && !reassignRoomName.isEmpty
                ? "?reassignTo=\(encodedQueryValue(reassignRoomName))"
                : ""
            let response = try await session.apiClient.delete("/api/rooms/\(encoded)\(reassignQuery)")
            applyRoomsResponse(response)
            pendingDeleteRoom = nil
            infoMessage = "\(room.name) deleted."
        }
    }

    private func performSave(_ operation: () async throws -> Void) async {
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }

        do {
            try await operation()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func applyRoomsResponse(_ response: Any, preferredName: String? = nil) {
        let object = JSON.object(response)
        let data = JSON.object(object["data"])
        let nextRooms = JSON.array(data["rooms"]).map(RoomItem.from).sorted(by: sortRooms)
        rooms = nextRooms

        if let preferredName, nextRooms.contains(where: { $0.name == preferredName }) {
            selectedRoomName = preferredName
        } else if !nextRooms.contains(where: { $0.name == selectedRoomName }) {
            selectedRoomName = nextRooms.first?.name ?? ""
        }

        syncDraftsFromSelectedRoom()
    }

    private func syncDraftsFromSelectedRoom() {
        editRoomName = selectedRoom?.name ?? ""
        reassignRoomName = ""
    }

    private func normalizedRoomName(_ value: String) -> String {
        value
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func roomKey(_ value: String) -> String {
        normalizedRoomName(value).lowercased()
    }

    private func sortRooms(_ left: RoomItem, _ right: RoomItem) -> Bool {
        if left.isDefault { return true }
        if right.isDefault { return false }
        return left.name.localizedCaseInsensitiveCompare(right.name) == .orderedAscending
    }

    private func encodedPathSegment(_ value: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/?#")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    private func encodedQueryValue(_ value: String) -> String {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&=+?#")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}
