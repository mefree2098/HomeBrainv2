import SwiftUI
import AVFoundation

struct UserProfilesView: View {
    @EnvironmentObject private var session: SessionStore

    @State private var profiles: [UserProfileItem] = []
    @State private var voices: [VoiceOption] = []

    @State private var isLoading = true
    @State private var errorMessage: String?

    @State private var showCreateSheet = false
    @State private var editingProfile: UserProfileItem?
    @State private var previewPlayer: AVPlayer?
    @State private var previewingVoiceId: String?

    @State private var name = ""
    @State private var wakeWords = ""
    @State private var selectedVoiceId = ""
    @State private var customVoiceId = ""
    @State private var systemPrompt = "You are a helpful HomeBrain assistant."
    @State private var personality = "friendly"

    private let personalities = ["friendly", "professional", "casual", "formal", "humorous", "neutral"]

    var body: some View {
        VStack(spacing: 12) {
            if isLoading {
                LoadingView(title: "Loading profiles...")
            } else {
                HBSectionHeader(
                    title: "User Profiles",
                    subtitle: "Wake words and voice personas",
                    buttonTitle: "New Profile",
                    buttonIcon: "plus"
                ) {
                    resetForm()
                    editingProfile = nil
                    showCreateSheet = true
                }

                if let errorMessage {
                    InlineErrorView(message: errorMessage) {
                        Task { await loadProfiles() }
                    }
                }

                if profiles.isEmpty {
                    EmptyStateView(title: "No user profiles", subtitle: "Create profiles for wake words and voice personas.")
                } else {
                    List {
                        ForEach(profiles) { profile in
                            HBCardRow {
                                profileRow(profile)
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
            profileSheet
        }
        .refreshable {
            await loadProfiles()
        }
        .task {
            await loadProfiles()
        }
    }

    private func profileRow(_ profile: UserProfileItem) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(profile.name)
                        .font(.system(size: 20, weight: .bold, design: .rounded))
                        .foregroundStyle(HBPalette.textPrimary)
                    Text("Wake words: \(profile.wakeWords.joined(separator: ", "))")
                        .font(.caption)
                        .foregroundStyle(HBPalette.textSecondary)
                    Text("Voice: \(profile.voiceName)")
                        .font(.caption2)
                        .foregroundStyle(HBPalette.textSecondary)
                }

                Spacer()

                Toggle("", isOn: Binding(
                    get: { profile.active },
                    set: { _ in
                        Task { await toggleProfile(profile) }
                    }
                ))
                .labelsHidden()
            }

            HStack {
                Button(previewingVoiceId == profile.voiceId ? "Playing..." : "Preview Voice") {
                    playVoicePreview(voiceId: profile.voiceId)
                }
                .buttonStyle(.bordered)
                .disabled(previewingVoiceId == profile.voiceId)

                Button("Edit") {
                    startEditing(profile)
                }
                .buttonStyle(.bordered)

                Button("Delete", role: .destructive) {
                    Task { await delete(profile) }
                }
                .buttonStyle(.bordered)
            }
        }
    }

    private var profileSheet: some View {
        NavigationStack {
            Form {
                TextField("Profile name", text: $name)
                TextField("Wake words (comma-separated)", text: $wakeWords)

                if voices.isEmpty {
                    TextField("Voice ID", text: $customVoiceId)
                } else {
                    Picker("Voice", selection: $selectedVoiceId) {
                        ForEach(voices) { voice in
                            Text("\(voice.name) (\(voice.category))").tag(voice.id)
                        }
                    }

                    TextField("Or enter custom voice ID", text: $customVoiceId)
                }

                Button(previewingVoiceId == selectedVoiceValue ? "Playing..." : "Preview Selected Voice") {
                    playVoicePreview(voiceId: selectedVoiceValue)
                }
                .buttonStyle(.bordered)
                .disabled(selectedVoiceValue.isEmpty || previewingVoiceId == selectedVoiceValue)

                Picker("Personality", selection: $personality) {
                    ForEach(personalities, id: \.self) { value in
                        Text(value.capitalized).tag(value)
                    }
                }

                Section("System prompt") {
                    TextEditor(text: $systemPrompt)
                        .frame(minHeight: 120)
                }
            }
            .hbFormStyle()
            .navigationTitle(editingProfile == nil ? "Create Profile" : "Edit Profile")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        showCreateSheet = false
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(editingProfile == nil ? "Create" : "Save") {
                        Task {
                            if let editingProfile {
                                await update(editingProfile)
                            } else {
                                await create()
                            }
                        }
                    }
                    .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || wakeWords.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || selectedVoiceValue.isEmpty)
                }
            }
        }
    }

    private var selectedVoiceValue: String {
        if !customVoiceId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return customVoiceId.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return selectedVoiceId
    }

    private func loadProfiles() async {
        isLoading = true
        errorMessage = nil

        do {
            async let profilesTask = session.apiClient.get("/api/profiles")
            let profilesResponse = try await profilesTask
            let profilesObject = JSON.object(profilesResponse)
            profiles = JSON.array(profilesObject["profiles"]).map(UserProfileItem.from)
                .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }

            if let voicesResponse = try? await session.apiClient.get("/api/profiles/voices") {
                let voicesObject = JSON.object(voicesResponse)
                voices = JSON.array(voicesObject["voices"]).map(VoiceOption.from)
                    .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
                if selectedVoiceId.isEmpty {
                    selectedVoiceId = voices.first?.id ?? ""
                }
            }
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    private func create() async {
        do {
            let payload: [String: Any] = [
                "name": name,
                "wakeWords": wakeWordsList,
                "voiceId": selectedVoiceValue,
                "voiceName": voiceName(for: selectedVoiceValue),
                "systemPrompt": systemPrompt,
                "personality": personality,
                "responseStyle": "conversational",
                "preferredLanguage": "en-US",
                "timezone": TimeZone.current.identifier
            ]

            let response = try await session.apiClient.post("/api/profiles", body: payload)
            let object = JSON.object(response)
            let created = UserProfileItem.from(JSON.object(object["profile"]))
            profiles.append(created)
            profiles.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }

            showCreateSheet = false
            resetForm()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func update(_ profile: UserProfileItem) async {
        do {
            let payload: [String: Any] = [
                "name": name,
                "wakeWords": wakeWordsList,
                "voiceId": selectedVoiceValue,
                "voiceName": voiceName(for: selectedVoiceValue),
                "systemPrompt": systemPrompt,
                "personality": personality
            ]

            let response = try await session.apiClient.put("/api/profiles/\(profile.id)", body: payload)
            let object = JSON.object(response)
            let updated = UserProfileItem.from(JSON.object(object["profile"]))

            if let index = profiles.firstIndex(where: { $0.id == updated.id }) {
                profiles[index] = updated
            }

            showCreateSheet = false
            editingProfile = nil
            resetForm()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func toggleProfile(_ profile: UserProfileItem) async {
        do {
            let response = try await session.apiClient.patch("/api/profiles/\(profile.id)/toggle")
            let object = JSON.object(response)
            let updated = UserProfileItem.from(JSON.object(object["profile"]))
            if let index = profiles.firstIndex(where: { $0.id == updated.id }) {
                profiles[index] = updated
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func delete(_ profile: UserProfileItem) async {
        do {
            _ = try await session.apiClient.delete("/api/profiles/\(profile.id)")
            profiles.removeAll { $0.id == profile.id }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func delete(at offsets: IndexSet) {
        let items = offsets.map { profiles[$0] }
        Task {
            for item in items {
                await delete(item)
            }
        }
    }

    private func startEditing(_ profile: UserProfileItem) {
        editingProfile = profile
        name = profile.name
        wakeWords = profile.wakeWords.joined(separator: ", ")
        selectedVoiceId = profile.voiceId
        customVoiceId = ""
        personality = "friendly"
        systemPrompt = "You are a helpful HomeBrain assistant."
        showCreateSheet = true
    }

    private func resetForm() {
        name = ""
        wakeWords = ""
        selectedVoiceId = voices.first?.id ?? ""
        customVoiceId = ""
        systemPrompt = "You are a helpful HomeBrain assistant."
        personality = "friendly"
    }

    private var wakeWordsList: [String] {
        wakeWords
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private func voiceName(for voiceId: String) -> String {
        voices.first(where: { $0.id == voiceId })?.name ?? "Custom Voice"
    }

    private func playVoicePreview(voiceId: String) {
        let trimmed = voiceId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            errorMessage = "Select a voice before playing a preview."
            return
        }

        guard let voice = voices.first(where: { $0.id == trimmed }) else {
            errorMessage = "Unable to find that voice in the available list."
            return
        }

        let preview = voice.previewURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !preview.isEmpty, let url = URL(string: preview) else {
            errorMessage = "No preview URL is available for \(voice.name)."
            return
        }

        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            // Keep going even if audio session configuration fails.
        }

        previewPlayer?.pause()
        previewPlayer = AVPlayer(url: url)
        previewPlayer?.play()
        previewingVoiceId = trimmed

        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 12_000_000_000)
            if previewingVoiceId == trimmed {
                previewingVoiceId = nil
            }
        }
    }
}
