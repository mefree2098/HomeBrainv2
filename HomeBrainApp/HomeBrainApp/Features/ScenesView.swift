import SwiftUI

struct ScenesView: View {
    @EnvironmentObject private var session: SessionStore

    @State private var scenes: [SceneItem] = []
    @State private var isLoading = true
    @State private var errorMessage: String?

    @State private var showCreateSheet = false
    @State private var showNaturalLanguageSheet = false

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

                if let errorMessage {
                    InlineErrorView(message: errorMessage) {
                        Task { await loadScenes() }
                    }
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
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(scene.name)
                        .font(.system(size: 20, weight: .bold, design: .rounded))
                        .foregroundStyle(HBPalette.textPrimary)
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

            Button("Activate") {
                Task { await activate(scene) }
            }
            .buttonStyle(.borderedProminent)
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
            .navigationTitle("Create Scene")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        showCreateSheet = false
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
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
            let response = try await session.apiClient.get("/api/scenes")
            let object = JSON.object(response)
            scenes = JSON.array(object["scenes"]).map(SceneItem.from)
                .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
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
}
