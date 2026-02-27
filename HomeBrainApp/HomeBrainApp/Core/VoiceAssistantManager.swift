import AVFoundation
import Combine
import Foundation
import Speech

@MainActor
final class VoiceAssistantManager: ObservableObject {
    @Published private(set) var isEnabled = false
    @Published private(set) var isListening = false
    @Published private(set) var isProcessing = false
    @Published private(set) var statusText = "Voice Off"
    @Published private(set) var errorMessage: String?
    @Published private(set) var pendingWakeWord: String?
    @Published private(set) var lastWakeWord: String?
    @Published private(set) var lastCommand: String?
    @Published private(set) var lastTranscript: String?
    @Published private(set) var lastResponse: String?
    @Published private(set) var configuredWakeWords: [String] = VoiceAssistantManager.defaultWakeWords

    var wakeWordsSummary: String {
        let unique = Array(Set(configuredWakeWords)).sorted { $0.count > $1.count }
        if unique.isEmpty {
            return "No wake words configured."
        }

        if unique.count <= 2 {
            return unique.map { "\"\($0)\"" }.joined(separator: " or ")
        }

        let firstTwo = unique.prefix(2).map { "\"\($0)\"" }.joined(separator: ", ")
        return "\(firstTwo), +\(unique.count - 2) more"
    }

    private static let defaultWakeWords = [
        "anna",
        "hey anna",
        "henry",
        "hey henry",
        "home brain",
        "computer"
    ]
    private static let waitForCommandSeconds: TimeInterval = 8

    private weak var sessionStore: SessionStore?

    private let audioEngine = AVAudioEngine()
    private let speechSynth = AVSpeechSynthesizer()
    private var speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var waitTask: Task<Void, Never>?
    private var restartTask: Task<Void, Never>?

    private var suppressTranscriptUntil: Date = .distantPast
    private var awaitingCommand = false
    private var lastHandledTranscript = ""
    private var lastHandledTranscriptAt = Date.distantPast
    private var lastCommandSignature = ""
    private var lastCommandSentAt = Date.distantPast

    func bind(sessionStore: SessionStore) {
        self.sessionStore = sessionStore
    }

    func toggle() async {
        if isEnabled {
            stop()
        } else {
            await start()
        }
    }

    func stop() {
        isEnabled = false
        isListening = false
        isProcessing = false
        awaitingCommand = false
        pendingWakeWord = nil
        statusText = "Voice Off"
        errorMessage = nil

        waitTask?.cancel()
        waitTask = nil

        restartTask?.cancel()
        restartTask = nil

        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest?.endAudio()
        recognitionRequest = nil

        audioEngine.inputNode.removeTap(onBus: 0)
        if audioEngine.isRunning {
            audioEngine.stop()
        }

        Task.detached {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    func start() async {
        guard !isEnabled else { return }
        guard let sessionStore else {
            errorMessage = "Voice cannot start because session context is unavailable."
            return
        }
        guard sessionStore.isAuthenticated else {
            errorMessage = "Sign in before enabling voice commands."
            return
        }

        errorMessage = nil
        statusText = "Starting voice listener..."

        do {
            try await requestPermissions()
            await refreshWakeWords()

            isEnabled = true
            statusText = "Listening for wake word..."
            await startRecognition(reason: "initial start")
        } catch {
            isEnabled = false
            isListening = false
            statusText = "Voice Off"
            errorMessage = error.localizedDescription
        }
    }

    private func requestPermissions() async throws {
        let speechAuth = await requestSpeechAuthorization()
        guard speechAuth == .authorized else {
            throw NSError(
                domain: "VoiceAssistant",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Speech recognition permission is required."]
            )
        }

        let microphoneGranted = await requestMicrophonePermission()
        guard microphoneGranted else {
            throw NSError(
                domain: "VoiceAssistant",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Microphone permission is required."]
            )
        }
    }

    private func requestSpeechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }
    }

    private func requestMicrophonePermission() async -> Bool {
        await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
    }

    private func refreshWakeWords() async {
        guard let sessionStore else { return }

        do {
            let response = try await sessionStore.apiClient.get("/api/profiles")
            let object = JSON.object(response)
            let profiles = JSON.array(object["profiles"])

            var wakeWordSet = Set(Self.defaultWakeWords)
            for profile in profiles {
                guard JSON.bool(profile, "active", fallback: true) else {
                    continue
                }

                if let words = profile["wakeWords"] as? [String] {
                    for word in words {
                        let normalized = normalizePhrase(word)
                        if !normalized.isEmpty {
                            wakeWordSet.insert(normalized)
                        }
                    }
                }
            }

            configuredWakeWords = Array(wakeWordSet).sorted { $0.count > $1.count }
        } catch {
            configuredWakeWords = Self.defaultWakeWords
        }
    }

    private func startRecognition(reason: String) async {
        guard isEnabled else { return }
        guard let recognizer = speechRecognizer else {
            errorMessage = "Speech recognition is not available on this device."
            statusText = "Voice unavailable"
            return
        }
        guard recognizer.isAvailable else {
            errorMessage = "Speech recognizer is temporarily unavailable."
            statusText = "Voice unavailable"
            scheduleRestart(after: 1.5, reason: "recognizer unavailable")
            return
        }

        recognitionTask?.cancel()
        recognitionTask = nil

        recognitionRequest?.endAudio()
        recognitionRequest = nil

        audioEngine.inputNode.removeTap(onBus: 0)
        if audioEngine.isRunning {
            audioEngine.stop()
        }

        do {
            try configureAudioSession()

            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            request.taskHint = .unspecified
            recognitionRequest = request

            let inputNode = audioEngine.inputNode
            let format = inputNode.outputFormat(forBus: 0)
            inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
                self?.recognitionRequest?.append(buffer)
            }

            audioEngine.prepare()
            try audioEngine.start()

            isListening = true
            statusText = awaitingCommand ? "Wake word detected. Waiting for command..." : "Listening for wake word..."

            recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
                Task { @MainActor in
                    self?.handleRecognition(result: result, error: error)
                }
            }
        } catch {
            isListening = false
            statusText = "Voice listener failed"
            errorMessage = "Voice listener failed (\(reason)): \(error.localizedDescription)"
            scheduleRestart(after: 1.5, reason: "audio start error")
        }
    }

    private func configureAudioSession() throws {
        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(
            .playAndRecord,
            mode: .measurement,
            options: [.duckOthers, .defaultToSpeaker, .allowBluetoothHFP]
        )
        try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
    }

    private func handleRecognition(result: SFSpeechRecognitionResult?, error: Error?) {
        if let result {
            handleTranscript(result.bestTranscription.formattedString, isFinal: result.isFinal)

            if result.isFinal && isEnabled {
                scheduleRestart(after: 0.15, reason: "final result boundary")
            }
        }

        if let error {
            if isEnabled {
                isListening = false
                statusText = "Reconnecting voice listener..."
                scheduleRestart(after: 1.2, reason: "recognition error: \(error.localizedDescription)")
            }
        }
    }

    private func scheduleRestart(after seconds: TimeInterval, reason: String) {
        restartTask?.cancel()
        restartTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            } catch {
                return
            }
            guard !Task.isCancelled, self.isEnabled else { return }
            await self.startRecognition(reason: reason)
        }
    }

    private func handleTranscript(_ transcript: String, isFinal: Bool) {
        let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard Date() >= suppressTranscriptUntil else { return }

        lastTranscript = trimmed
        let normalized = normalizePhrase(trimmed)
        guard !normalized.isEmpty else { return }

        let now = Date()
        if normalized == lastHandledTranscript && now.timeIntervalSince(lastHandledTranscriptAt) < 0.7 {
            return
        }
        lastHandledTranscript = normalized
        lastHandledTranscriptAt = now

        if awaitingCommand, let pendingWakeWord {
            if let wakeMatch = matchWakeWord(in: normalized), !wakeMatch.command.isEmpty {
                Task { await processCommand(wakeMatch.command, wakeWord: wakeMatch.wakeWord, transcript: trimmed) }
                return
            }

            if normalized.count > 1 {
                Task { await processCommand(normalized, wakeWord: pendingWakeWord, transcript: trimmed) }
            }
            return
        }

        guard let wakeMatch = matchWakeWord(in: normalized) else {
            return
        }

        lastWakeWord = wakeMatch.wakeWord

        if wakeMatch.command.isEmpty {
            beginAwaitingCommand(for: wakeMatch.wakeWord)
        } else {
            Task { await processCommand(wakeMatch.command, wakeWord: wakeMatch.wakeWord, transcript: trimmed) }
        }

        if isFinal, awaitingCommand == false {
            statusText = "Listening for wake word..."
        }
    }

    private func beginAwaitingCommand(for wakeWord: String) {
        awaitingCommand = true
        pendingWakeWord = wakeWord
        statusText = "Wake word \"\(wakeWord)\" detected. Waiting for command..."
        errorMessage = nil

        waitTask?.cancel()
        waitTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await Task.sleep(nanoseconds: UInt64(Self.waitForCommandSeconds * 1_000_000_000))
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            self.awaitingCommand = false
            self.pendingWakeWord = nil
            if self.isEnabled {
                self.statusText = "Listening for wake word..."
            } else {
                self.statusText = "Voice Off"
            }
        }
    }

    private func processCommand(_ command: String, wakeWord: String, transcript: String) async {
        guard let sessionStore else { return }
        guard isEnabled else { return }

        let cleanedCommand = command
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: #"^[,\.\s:;-]+"#, with: "", options: .regularExpression)

        guard !cleanedCommand.isEmpty else {
            beginAwaitingCommand(for: wakeWord)
            return
        }

        let signature = "\(wakeWord)|\(cleanedCommand.lowercased())"
        let now = Date()
        if signature == lastCommandSignature && now.timeIntervalSince(lastCommandSentAt) < 2 {
            return
        }
        lastCommandSignature = signature
        lastCommandSentAt = now

        awaitingCommand = false
        pendingWakeWord = nil

        isProcessing = true
        statusText = "Processing \"\(cleanedCommand)\"..."
        errorMessage = nil
        lastCommand = cleanedCommand

        do {
            let payload: [String: Any] = [
                "commandText": cleanedCommand,
                "wakeWord": wakeWord,
                "stt": [
                    "provider": "ios-speech",
                    "model": "apple.sfspeechrecognizer",
                    "text": transcript
                ]
            ]

            let response = try await sessionStore.apiClient.post("/api/voice/commands/interpret", body: payload)
            let object = JSON.object(response)
            let responseText = JSON.string(object, "responseText", fallback: JSON.string(object, "message", fallback: "Command processed."))

            lastResponse = responseText
            statusText = "Voice command completed."

            if !responseText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                speak(responseText)
            }
        } catch {
            errorMessage = error.localizedDescription
            statusText = "Voice command failed."
        }

        isProcessing = false
    }

    private func matchWakeWord(in normalizedTranscript: String) -> (wakeWord: String, command: String)? {
        for wakeWord in configuredWakeWords {
            let normalizedWakeWord = normalizePhrase(wakeWord)
            guard !normalizedWakeWord.isEmpty else { continue }

            if let range = normalizedTranscript.range(of: normalizedWakeWord) {
                let commandStart = range.upperBound
                let trailing = String(normalizedTranscript[commandStart...])
                let command = trailing.trimmingCharacters(in: CharacterSet(charactersIn: " ,.:;-"))
                return (wakeWord: normalizedWakeWord, command: command)
            }
        }

        return nil
    }

    private func normalizePhrase(_ value: String) -> String {
        let lowercase = value.lowercased()
        let replaced = lowercase.replacingOccurrences(of: #"[^a-z0-9\s]"#, with: " ", options: .regularExpression)
        let compact = replaced.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        return compact.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func speak(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        suppressTranscriptUntil = Date().addingTimeInterval(min(4.0, max(1.8, Double(trimmed.count) / 14.0)))

        speechSynth.stopSpeaking(at: .immediate)

        let utterance = AVSpeechUtterance(string: trimmed)
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        utterance.rate = 0.5
        utterance.pitchMultiplier = 1.0
        speechSynth.speak(utterance)
    }
}
