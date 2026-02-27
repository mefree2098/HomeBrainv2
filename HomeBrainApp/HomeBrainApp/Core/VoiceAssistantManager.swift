import AVFoundation
import Combine
import Foundation
import Speech

@MainActor
final class VoiceAssistantManager: ObservableObject {
    private struct WakeMatch {
        enum MatchType {
            case exact
            case fuzzy
        }

        let wakeWord: String
        let command: String
        let type: MatchType
        let score: Double?
    }

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
    private static let waitForCommandSeconds: TimeInterval = 22
    private static let wakeWordFuzzyMinScore: Double = 0.72
    private static let wakeWordFuzzyMaxStartTokenIndex = 2
    private static let voiceBuildTag = "2026-02-27-ios-speech-v2"

    private weak var sessionStore: SessionStore?

    private let audioEngine = AVAudioEngine()
    private let speechSynth = AVSpeechSynthesizer()
    private var speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var wakeAcknowledgmentPlayer: AVAudioPlayer?
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
            let data = JSON.object(object["data"])
            let profiles = JSON.array(object["profiles"]) + JSON.array(data["profiles"])

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

        if wakeMatch.type == .fuzzy, let score = wakeMatch.score {
            statusText = "Wake word matched (\(Int((score * 100).rounded()))%). Listening..."
        }

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

        let wakeAcknowledgmentTask = Task { [weak self] in
            await self?.playWakeAcknowledgment(for: wakeWord)
        }

        do {
            let payload: [String: Any] = [
                "commandText": cleanedCommand,
                "wakeWord": wakeWord,
                "stt": [
                    "provider": "ios-web-speech",
                    "model": "SFSpeechRecognizer",
                    "text": transcript,
                    "locale": "en-US",
                    "captureMode": "live-stream",
                    "buildTag": Self.voiceBuildTag
                ]
            ]

            let response = try await sessionStore.apiClient.post("/api/voice/commands/interpret", body: payload)
            let object = JSON.object(response)
            let responseText = JSON.string(object, "responseText", fallback: JSON.string(object, "message", fallback: "Command processed."))

            await wakeAcknowledgmentTask.value

            lastResponse = responseText
            statusText = "Voice command completed."

            if !responseText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                speak(responseText)
            }
        } catch {
            await wakeAcknowledgmentTask.value
            errorMessage = error.localizedDescription
            statusText = "Voice command failed."
        }

        isProcessing = false
    }

    private func matchWakeWord(in normalizedTranscript: String) -> WakeMatch? {
        let transcriptTokens = normalizedTranscript.split(separator: " ").map(String.init)
        guard !transcriptTokens.isEmpty else { return nil }

        for wakeWord in configuredWakeWords {
            let normalizedWakeWord = normalizePhrase(wakeWord)
            guard !normalizedWakeWord.isEmpty else { continue }
            let wakeTokens = normalizedWakeWord.split(separator: " ").map(String.init)
            guard !wakeTokens.isEmpty, wakeTokens.count <= transcriptTokens.count else { continue }

            for startIndex in 0...(transcriptTokens.count - wakeTokens.count) {
                let candidate = Array(transcriptTokens[startIndex..<(startIndex + wakeTokens.count)])
                guard candidate == wakeTokens else { continue }

                let commandTokens = transcriptTokens.dropFirst(startIndex + wakeTokens.count)
                let command = commandTokens.joined(separator: " ")
                return WakeMatch(wakeWord: normalizedWakeWord, command: command, type: .exact, score: nil)
            }
        }

        var bestFuzzyMatch: (wakeWord: String, score: Double, startIndex: Int, tokenLength: Int)?

        for wakeWord in configuredWakeWords {
            let normalizedWakeWord = normalizePhrase(wakeWord)
            let wakeTokens = normalizedWakeWord.split(separator: " ").map(String.init)
            guard !wakeTokens.isEmpty else { continue }

            let candidateWindowSizes = Array(Set([
                max(1, wakeTokens.count - 1),
                wakeTokens.count,
                wakeTokens.count + 1
            ])).sorted()

            for windowSize in candidateWindowSizes {
                guard windowSize <= transcriptTokens.count else { continue }

                for startIndex in 0...(transcriptTokens.count - windowSize) {
                    if startIndex > Self.wakeWordFuzzyMaxStartTokenIndex {
                        break
                    }

                    let candidatePhrase = transcriptTokens[startIndex..<(startIndex + windowSize)].joined(separator: " ")
                    let score = similarity(normalizedWakeWord, candidatePhrase)
                    guard score >= Self.wakeWordFuzzyMinScore else { continue }

                    if bestFuzzyMatch == nil || score > (bestFuzzyMatch?.score ?? 0) {
                        bestFuzzyMatch = (
                            wakeWord: normalizedWakeWord,
                            score: score,
                            startIndex: startIndex,
                            tokenLength: windowSize
                        )
                    }
                }
            }
        }

        if let bestFuzzyMatch {
            let commandTokens = transcriptTokens.dropFirst(bestFuzzyMatch.startIndex + bestFuzzyMatch.tokenLength)
            let command = commandTokens.joined(separator: " ")
            return WakeMatch(
                wakeWord: bestFuzzyMatch.wakeWord,
                command: command,
                type: .fuzzy,
                score: bestFuzzyMatch.score
            )
        }

        return nil
    }

    private func normalizePhrase(_ value: String) -> String {
        let lowercase = value.lowercased()
        let replaced = lowercase.replacingOccurrences(of: #"[^a-z0-9\s]"#, with: " ", options: .regularExpression)
        let compact = replaced.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        return compact.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func similarity(_ a: String, _ b: String) -> Double {
        guard !a.isEmpty, !b.isEmpty else { return 0 }
        if a == b { return 1 }

        let distance = levenshteinDistance(a, b)
        let scale = max(a.count, b.count)
        guard scale > 0 else { return 0 }
        return max(0, 1 - (Double(distance) / Double(scale)))
    }

    private func levenshteinDistance(_ a: String, _ b: String) -> Int {
        let left = Array(a)
        let right = Array(b)

        let rows = left.count + 1
        let cols = right.count + 1
        var matrix = Array(repeating: Array(repeating: 0, count: cols), count: rows)

        for row in 0..<rows {
            matrix[row][0] = row
        }
        for col in 0..<cols {
            matrix[0][col] = col
        }

        if left.isEmpty { return right.count }
        if right.isEmpty { return left.count }

        for row in 1..<rows {
            for col in 1..<cols {
                let substitutionCost = left[row - 1] == right[col - 1] ? 0 : 1
                matrix[row][col] = min(
                    matrix[row - 1][col] + 1,
                    matrix[row][col - 1] + 1,
                    matrix[row - 1][col - 1] + substitutionCost
                )
            }
        }

        return matrix[rows - 1][cols - 1]
    }

    private func playWakeAcknowledgment(for wakeWord: String) async {
        let trimmedWakeWord = wakeWord.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedWakeWord.isEmpty else { return }
        guard let request = makeWakeAcknowledgmentRequest(wakeWord: trimmedWakeWord) else { return }

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else { return }

            if httpResponse.statusCode == 204 {
                return
            }

            guard (200..<300).contains(httpResponse.statusCode), !data.isEmpty else { return }

            let contentType = (httpResponse.value(forHTTPHeaderField: "Content-Type") ?? "").lowercased()
            guard contentType.contains("audio/") else { return }

            do {
                let player = try AVAudioPlayer(data: data)
                wakeAcknowledgmentPlayer = player
                player.prepareToPlay()
                if player.play() {
                    suppressTranscriptUntil = Date().addingTimeInterval(min(3.5, max(1.4, player.duration + 0.6)))
                    try? await Task.sleep(nanoseconds: UInt64(max(0.2, player.duration) * 1_000_000_000))
                }
                player.stop()
                wakeAcknowledgmentPlayer = nil
            } catch {
                wakeAcknowledgmentPlayer = nil
            }
        } catch {
            // Wake acknowledgment is optional; command flow should continue.
        }
    }

    private func makeWakeAcknowledgmentRequest(wakeWord: String) -> URLRequest? {
        guard let sessionStore else { return nil }
        let trimmedBase = sessionStore.serverURLString
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: "\(trimmedBase)/api/voice/browser/acknowledgment") else {
            return nil
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        if let accessToken = sessionStore.accessToken {
            request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        }

        let payload: [String: String] = ["wakeWord": wakeWord]
        request.httpBody = try? JSONSerialization.data(withJSONObject: payload, options: [])
        return request
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
