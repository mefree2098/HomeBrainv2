import SwiftUI

struct ScenesView: View {
    @EnvironmentObject private var session: SessionStore

    @State private var scenes: [SceneItem] = []
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var infoMessage: String?

    @State private var showCreateSheet = false
    @State private var showNaturalLanguageSheet = false
    @State private var editingScene: SceneItem?
    @State private var favoritesProfileId: String?
    @State private var favoriteSceneIds: Set<String> = []
    @State private var pendingFavoriteSceneIds: Set<String> = []

    @State private var createName = ""
    @State private var createDescription = ""
    @State private var createCategory = "custom"

    @State private var naturalLanguagePrompt = ""

    private let categories = ["comfort", "security", "entertainment", "energy", "custom"]

    var body: some View {
        VStack(spacing: 12) {
            if isLoading {
                LoadingView(title: "Loading scenes...")
            } else {
                HBSectionHeader(
                    title: "Scenes",
                    subtitle: "Create and activate scene presets",
                    buttonTitle: "New Scene",
                    buttonIcon: "plus"
                ) {
                    resetSceneEditor()
                    showCreateSheet = true
                }

                HStack {
                    Button("AI Scene") {
                        showNaturalLanguageSheet = true
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(HBPalette.accentBlue)

                    Spacer()
                }

                if favoritesProfileId == nil {
                    Text("Create or activate a user profile to favorite scenes.")
                        .font(.caption)
                        .foregroundStyle(HBPalette.textSecondary)
                }

                if let errorMessage {
                    InlineErrorView(message: errorMessage) {
                        Task { await loadScenes() }
                    }
                }

                if let infoMessage, !infoMessage.isEmpty {
                    Text(infoMessage)
                        .font(.caption)
                        .foregroundStyle(HBPalette.textSecondary)
                        .padding(.horizontal, 2)
                }

                if scenes.isEmpty {
                    EmptyStateView(title: "No scenes", subtitle: "Create a scene to start grouping device actions.")
                } else {
                    List {
                        ForEach(scenes) { scene in
                            HBCardRow {
                                sceneRow(scene)
                            }
                            .listRowSeparator(.hidden)
                            .listRowBackground(Color.clear)
                        }
                        .onDelete(perform: delete)
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                    .background(Color.clear)
                }
            }
        }
        .padding()
        .sheet(isPresented: $showCreateSheet) {
            createSceneSheet
        }
        .sheet(isPresented: $showNaturalLanguageSheet) {
            naturalLanguageSheet
        }
        .refreshable {
            await loadScenes()
        }
        .task {
            await loadScenes()
        }
    }

    private func sceneRow(_ scene: SceneItem) -> some View {
        let isFavorite = favoriteSceneIds.contains(scene.id)
        let isPendingFavorite = pendingFavoriteSceneIds.contains(scene.id)

        return HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(scene.name)
                        .font(.system(size: 20, weight: .bold, design: .rounded))
                        .foregroundStyle(HBPalette.textPrimary)
                    if isFavorite {
                        Image(systemName: "star.fill")
                            .font(.caption)
                            .foregroundStyle(Color.yellow)
                    }
                    if scene.active {
                        Text("ACTIVE")
                            .font(.caption2)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.green.opacity(0.2))
                            .clipShape(Capsule())
                    }
                }

                Text(scene.details)
                    .font(.caption)
                    .foregroundStyle(HBPalette.textSecondary)
                    .lineLimit(1)

                Text("\(scene.category.capitalized) · activated \(scene.activationCount)x")
                    .font(.caption2)
                    .foregroundStyle(HBPalette.textSecondary)
            }

            Spacer()

            VStack(spacing: 8) {
                Button("Activate") {
                    Task { await activate(scene) }
                }
                .buttonStyle(.borderedProminent)

                Button(isFavorite ? "Unfavorite" : "Favorite") {
                    Task { await toggleFavorite(scene) }
                }
                .buttonStyle(.bordered)
                .disabled(favoritesProfileId == nil || isPendingFavorite)

                Button("Edit") {
                    beginEditing(scene)
                }
                .buttonStyle(.bordered)
            }
        }
    }

    private var createSceneSheet: some View {
        NavigationStack {
            Form {
                TextField("Scene name", text: $createName)
                TextField("Description", text: $createDescription)

                Picker("Category", selection: $createCategory) {
                    ForEach(categories, id: \.self) { category in
                        Text(category.capitalized).tag(category)
                    }
                }
            }
            .hbFormStyle()
            .navigationTitle(editingScene == nil ? "Create Scene" : "Edit Scene")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        showCreateSheet = false
                        resetSceneEditor()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(editingScene == nil ? "Create" : "Save") {
                        Task { await createScene() }
                    }
                    .disabled(createName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private var naturalLanguageSheet: some View {
        NavigationStack {
            Form {
                Section("Describe your scene") {
                    TextEditor(text: $naturalLanguagePrompt)
                        .frame(minHeight: 140)
                }
            }
            .hbFormStyle()
            .navigationTitle("AI Scene Builder")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        showNaturalLanguageSheet = false
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Generate") {
                        Task { await createSceneFromText() }
                    }
                    .disabled(naturalLanguagePrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private func loadScenes() async {
        isLoading = true
        errorMessage = nil

        do {
            async let scenesTask = session.apiClient.get("/api/scenes")
            async let profilesTask = session.apiClient.get("/api/profiles")

            let response = try await scenesTask
            let object = JSON.object(response)
            scenes = JSON.array(object["scenes"]).map(SceneItem.from)
                .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }

            if let profilesPayload = try? await profilesTask {
                applyFavoriteContext(fromProfilesPayload: profilesPayload)
            }
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    private func activate(_ scene: SceneItem) async {
        do {
            _ = try await session.apiClient.post("/api/scenes/activate", body: ["sceneId": scene.id])
            for index in scenes.indices {
                scenes[index].active = scenes[index].id == scene.id
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func createScene() async {
        if let editingScene {
            await updateScene(editingScene)
            return
        }

        do {
            let payload: [String: Any] = [
                "name": createName,
                "description": createDescription,
                "category": createCategory,
                "devices": []
            ]
            let response = try await session.apiClient.post("/api/scenes", body: payload)
            let object = JSON.object(response)
            let createdScene = SceneItem.from(JSON.object(object["scene"]))
            scenes.append(createdScene)
            scenes.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }

            createName = ""
            createDescription = ""
            createCategory = "custom"
            showCreateSheet = false
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func updateScene(_ scene: SceneItem) async {
        do {
            let payload: [String: Any] = [
                "name": createName,
                "description": createDescription,
                "category": createCategory
            ]

            let response = try await session.apiClient.put("/api/scenes/\(scene.id)", body: payload)
            let object = JSON.object(response)
            let updated = SceneItem.from(JSON.object(object["scene"]))

            if let index = scenes.firstIndex(where: { $0.id == updated.id }) {
                scenes[index] = updated
            }
            scenes.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }

            showCreateSheet = false
            resetSceneEditor()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func createSceneFromText() async {
        do {
            let payload: [String: Any] = ["description": naturalLanguagePrompt]
            let response = try await session.apiClient.post("/api/scenes/natural-language", body: payload)
            let object = JSON.object(response)
            let createdScene = SceneItem.from(JSON.object(object["scene"]))
            scenes.append(createdScene)
            scenes.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }

            naturalLanguagePrompt = ""
            showNaturalLanguageSheet = false
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func delete(at offsets: IndexSet) {
        let items = offsets.map { scenes[$0] }

        Task {
            for item in items {
                do {
                    _ = try await session.apiClient.delete("/api/scenes/\(item.id)")
                    scenes.removeAll { $0.id == item.id }
                } catch {
                    errorMessage = error.localizedDescription
                }
            }
        }
    }

    private func beginEditing(_ scene: SceneItem) {
        editingScene = scene
        createName = scene.name
        createDescription = scene.details
        createCategory = scene.category
        showCreateSheet = true
    }

    private func resetSceneEditor() {
        editingScene = nil
        createName = ""
        createDescription = ""
        createCategory = "custom"
    }

    private func toggleFavorite(_ scene: SceneItem) async {
        guard let profileId = favoritesProfileId, !profileId.isEmpty else {
            errorMessage = "Create or activate a user profile to manage favorite scenes."
            return
        }

        if pendingFavoriteSceneIds.contains(scene.id) {
            return
        }

        let shouldFavorite = !favoriteSceneIds.contains(scene.id)
        pendingFavoriteSceneIds.insert(scene.id)

        defer {
            pendingFavoriteSceneIds.remove(scene.id)
        }

        do {
            if shouldFavorite {
                let response = try await session.apiClient.post(
                    "/api/profiles/\(profileId)/favorites/scenes",
                    body: ["sceneId": scene.id]
                )
                applyFavoriteContext(
                    fromToggleResponse: response,
                    fallbackProfileId: profileId,
                    sceneId: scene.id,
                    shouldFavorite: true
                )
                infoMessage = "\"\(scene.name)\" added to favorites."
            } else {
                let response = try await session.apiClient.delete(
                    "/api/profiles/\(profileId)/favorites/scenes/\(scene.id)"
                )
                applyFavoriteContext(
                    fromToggleResponse: response,
                    fallbackProfileId: profileId,
                    sceneId: scene.id,
                    shouldFavorite: false
                )
                infoMessage = "\"\(scene.name)\" removed from favorites."
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func applyFavoriteContext(fromProfilesPayload payload: Any) {
        let root = JSON.object(payload)
        let profiles = JSON.array(root["profiles"])
        guard let preferredProfile = profiles.first(where: { JSON.bool($0, "active", fallback: false) }) ?? profiles.first else {
            favoritesProfileId = nil
            favoriteSceneIds = []
            return
        }
        applyFavoriteContext(fromProfileObject: preferredProfile)
    }

    private func applyFavoriteContext(fromProfileObject profile: [String: Any]) {
        let favorites = JSON.object(profile["favorites"])
        favoritesProfileId = FavoritesSupport.optionalProfileID(from: profile)
        favoriteSceneIds = FavoritesSupport.idSet(from: favorites["scenes"])
    }

    private func applyFavoriteContext(
        fromToggleResponse response: Any,
        fallbackProfileId: String,
        sceneId: String,
        shouldFavorite: Bool
    ) {
        let root = JSON.object(response)
        let data = JSON.object(root["data"])
        let payloadProfile = JSON.object(data["profile"])
        let rootProfile = JSON.object(root["profile"])

        if !payloadProfile.isEmpty {
            applyFavoriteContext(fromProfileObject: payloadProfile)
            if favoritesProfileId == nil {
                favoritesProfileId = fallbackProfileId
            }
            return
        }

        if !rootProfile.isEmpty {
            applyFavoriteContext(fromProfileObject: rootProfile)
            if favoritesProfileId == nil {
                favoritesProfileId = fallbackProfileId
            }
            return
        }

        favoritesProfileId = fallbackProfileId
        if shouldFavorite {
            favoriteSceneIds.insert(sceneId)
        } else {
            favoriteSceneIds.remove(sceneId)
        }
    }
}
