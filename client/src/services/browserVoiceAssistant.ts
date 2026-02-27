import { interpretVoiceCommand, transcribeBrowserAudio } from "@/api/voice";
import { getUserProfiles } from "@/api/profiles";
import { textToSpeechElevenLabs, playAudioBlob } from "@/api/elevenLabs";
import { getSettings } from "@/api/settings";

const DEFAULT_WAKE_WORDS = ["anna", "hey anna", "henry", "hey henry", "home brain", "computer"];
const WAIT_FOR_COMMAND_TIMEOUT_MS = 8000;
const NETWORK_ERROR_WINDOW_MS = 15000;
const NETWORK_ERROR_THRESHOLD = 6;
const FALLBACK_CAPTURE_INTERVAL_MS = 2500;
const FALLBACK_CAPTURE_DURATION_MS = 1600;
const MIN_FALLBACK_CLIP_BYTES = 64;
const MAX_AUDIO_B64_LENGTH = 500000;

type BrowserSpeechRecognitionEvent = {
  resultIndex?: number;
  results?: ArrayLike<{
    isFinal?: boolean;
    [index: number]: {
      transcript?: string;
      confidence?: number;
    };
  }>;
};

type BrowserSpeechRecognitionErrorEvent = {
  error?: string;
};

type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onstart: null | (() => void);
  onend: null | (() => void);
  onerror: null | ((event: BrowserSpeechRecognitionErrorEvent) => void);
  onresult: null | ((event: BrowserSpeechRecognitionEvent) => void);
  start: () => void;
  stop: () => void;
};

type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

type VoiceProfile = {
  wakeWords: string[];
  voiceId: string;
};

export type BrowserVoiceMode =
  | "off"
  | "starting"
  | "listening"
  | "waiting_command"
  | "processing"
  | "error"
  | "unsupported";

export type BrowserVoiceEngine = "browser_speech" | "server_stt_fallback";

export interface BrowserVoiceStatus {
  supported: boolean;
  enabled: boolean;
  mode: BrowserVoiceMode;
  engine: BrowserVoiceEngine;
  configuredWakeWords: string[];
  pendingWakeWord: string | null;
  lastWakeWord: string | null;
  lastTranscript: string | null;
  lastCommand: string | null;
  lastResponse: string | null;
  error: string | null;
  trace: string[];
}

type BrowserVoiceSubscriber = (status: BrowserVoiceStatus) => void;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

class BrowserVoiceAssistant {
  private static instance: BrowserVoiceAssistant;

  private subscribers = new Map<string, BrowserVoiceSubscriber>();
  private recognition: BrowserSpeechRecognition | null = null;
  private waitForCommandTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private fallbackLoopTimer: ReturnType<typeof setInterval> | null = null;
  private isStopping = false;
  private resumeRecognitionAfterStop = false;
  private isProcessing = false;
  private fallbackCaptureInFlight = false;
  private useServerSttFallback = false;
  private awaitingCommand = false;
  private wakeWords = [...DEFAULT_WAKE_WORDS];
  private voiceProfiles: VoiceProfile[] = [];
  private defaultVoiceId = "";
  private mediaStream: MediaStream | null = null;
  private recentNetworkErrors: number[] = [];
  private playbackMutedUntil = 0;
  private fallbackNoChunkCount = 0;
  private fallbackSmallClipCount = 0;
  private readonly maxTraceEntries = 80;

  private status: BrowserVoiceStatus = {
    supported: false,
    enabled: false,
    mode: "unsupported",
    engine: "browser_speech",
    configuredWakeWords: [...DEFAULT_WAKE_WORDS],
    pendingWakeWord: null,
    lastWakeWord: null,
    lastTranscript: null,
    lastCommand: null,
    lastResponse: null,
    error: null,
    trace: []
  };

  private constructor() {
    const supported = this.hasSpeechRecognitionSupport();
    this.status = {
      ...this.status,
      supported,
      mode: supported ? "off" : "unsupported"
    };
  }

  static getInstance(): BrowserVoiceAssistant {
    if (!BrowserVoiceAssistant.instance) {
      BrowserVoiceAssistant.instance = new BrowserVoiceAssistant();
    }
    return BrowserVoiceAssistant.instance;
  }

  subscribe(id: string, callback: BrowserVoiceSubscriber): void {
    this.subscribers.set(id, callback);
    callback(this.status);
  }

  unsubscribe(id: string): void {
    this.subscribers.delete(id);
  }

  getStatus(): BrowserVoiceStatus {
    return this.status;
  }

  async enable(): Promise<BrowserVoiceStatus> {
    if (!this.status.supported) {
      throw new Error("This browser does not support microphone speech recognition.");
    }

    if (this.status.enabled) {
      return this.status;
    }

    this.updateStatus({
      enabled: true,
      mode: "starting",
      engine: "browser_speech",
      error: null
    }, "enable requested");

    this.isStopping = false;
    this.useServerSttFallback = false;
    this.recentNetworkErrors = [];
    this.playbackMutedUntil = 0;
    this.stopFallbackLoop();

    try {
      await this.ensureMicrophoneAccess();
      await this.refreshVoiceConfiguration();
      this.ensureRecognition();
      this.startRecognition();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start browser voice listener.";
      this.updateStatus({
        enabled: false,
        mode: "error",
        pendingWakeWord: null,
        error: message
      }, `enable failed: ${message}`);
      throw new Error(message);
    }

    return this.status;
  }

  disable(): BrowserVoiceStatus {
    this.isStopping = true;
    this.awaitingCommand = false;
    this.isProcessing = false;
    this.resumeRecognitionAfterStop = false;
    this.useServerSttFallback = false;
    this.recentNetworkErrors = [];
    this.playbackMutedUntil = 0;
    this.clearWaitForCommandTimer();
    this.clearRestartTimer();
    this.stopFallbackLoop();
    this.stopMediaStream();

    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch (_error) {
        // Ignore stop errors during manual shutdown.
      }
    }

    this.updateStatus({
      enabled: false,
      mode: this.status.supported ? "off" : "unsupported",
      engine: "browser_speech",
      pendingWakeWord: null,
      error: null
    }, "disabled by user");

    return this.status;
  }

  private hasSpeechRecognitionSupport(): boolean {
    if (typeof window === "undefined") {
      return false;
    }

    const win = window as Window & {
      SpeechRecognition?: BrowserSpeechRecognitionConstructor;
      webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
    };

    return Boolean(win.SpeechRecognition || win.webkitSpeechRecognition);
  }

  private async ensureMicrophoneAccess(): Promise<void> {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      return;
    }

    if (this.mediaStream && this.mediaStream.active) {
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      this.mediaStream = stream;
      this.updateStatus({}, "microphone access verified");
    } catch (error) {
      const message = this.mapMicrophoneAccessError(error);
      this.updateStatus({}, `microphone access failed: ${message}`);
      throw new Error(message);
    }
  }

  private stopMediaStream(): void {
    if (!this.mediaStream) {
      return;
    }
    this.mediaStream.getTracks().forEach((track) => track.stop());
    this.mediaStream = null;
  }

  private updateStatus(patch: Partial<BrowserVoiceStatus>, traceMessage?: string): void {
    let nextTrace = this.status.trace;
    if (traceMessage && traceMessage.trim().length > 0) {
      const entry = `[${new Date().toLocaleTimeString()}] ${traceMessage.trim()}`;
      nextTrace = [...nextTrace, entry].slice(-this.maxTraceEntries);
    }

    this.status = {
      ...this.status,
      ...patch,
      trace: nextTrace
    };
    this.notifySubscribers();
  }

  private notifySubscribers(): void {
    this.subscribers.forEach((callback) => {
      callback(this.status);
    });
  }

  private async refreshVoiceConfiguration(): Promise<void> {
    const wakeWordSet = new Set<string>(DEFAULT_WAKE_WORDS);
    const profiles: VoiceProfile[] = [];

    try {
      const settingsResponse = await getSettings();
      const configuredVoiceId = settingsResponse?.settings?.elevenlabsDefaultVoiceId;
      this.defaultVoiceId = typeof configuredVoiceId === "string" ? configuredVoiceId.trim() : "";
    } catch (_error) {
      this.defaultVoiceId = "";
    }

    try {
      const profilesResponse = await getUserProfiles();
      const rawProfiles = Array.isArray(profilesResponse?.profiles) ? profilesResponse.profiles : [];

      for (const profile of rawProfiles) {
        if (!profile || profile.active === false) {
          continue;
        }

        const voiceId = typeof profile.voiceId === "string" ? profile.voiceId.trim() : "";
        const wakeWords = Array.isArray(profile.wakeWords)
          ? profile.wakeWords
              .map((wakeWord) => this.normalizeWakeWord(String(wakeWord)))
              .filter((wakeWord) => wakeWord.length > 0)
          : [];

        if (wakeWords.length === 0) {
          continue;
        }

        wakeWords.forEach((wakeWord) => wakeWordSet.add(wakeWord));
        profiles.push({
          wakeWords,
          voiceId
        });
      }
    } catch (_error) {
      // Keep defaults when profile fetch fails.
    }

    this.voiceProfiles = profiles;
    this.wakeWords = Array.from(wakeWordSet).sort((a, b) => b.length - a.length);
    this.updateStatus({
      configuredWakeWords: [...this.wakeWords]
    }, `configured wake words: ${this.wakeWords.join(", ")}`);
  }

  private ensureRecognition(): void {
    if (this.recognition) {
      return;
    }

    const win = window as Window & {
      SpeechRecognition?: BrowserSpeechRecognitionConstructor;
      webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
    };

    const RecognitionCtor = win.SpeechRecognition || win.webkitSpeechRecognition;
    if (!RecognitionCtor) {
      throw new Error("Speech recognition is unavailable in this browser.");
    }

    const recognition = new RecognitionCtor();
    // Edge/Chromium tends to produce more reliable final results with non-continuous sessions.
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      if (!this.status.enabled) {
        return;
      }
      if (this.isProcessing) {
        this.updateStatus({ mode: "processing" }, "recognition started (processing)");
      } else if (this.awaitingCommand) {
        this.updateStatus({ mode: "waiting_command" }, "recognition started (awaiting command)");
      } else {
        this.updateStatus({ mode: "listening" }, "recognition started (listening)");
      }
    };

    recognition.onend = () => {
      this.handleRecognitionEnded();
    };

    recognition.onerror = (event) => {
      this.handleRecognitionError(event);
    };

    recognition.onresult = (event) => {
      void this.handleRecognitionResult(event);
    };

    this.recognition = recognition;
    this.updateStatus({}, "speech recognition engine initialized");
  }

  private startRecognition(): void {
    if (!this.recognition) {
      return;
    }

    try {
      this.recognition.start();
      this.updateStatus({}, "recognition.start()");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to start speech recognition.";
      if (message.toLowerCase().includes("already started")) {
        return;
      }
      throw error;
    }
  }

  private handleRecognitionEnded(): void {
    this.clearRestartTimer();
    this.updateStatus({}, "recognition ended");

    if (this.useServerSttFallback) {
      this.isStopping = false;
      this.resumeRecognitionAfterStop = false;
      return;
    }

    if (this.status.enabled) {
      if (this.isStopping) {
        this.isStopping = false;

        if (this.resumeRecognitionAfterStop) {
          this.resumeRecognitionAfterStop = false;
          this.restartTimer = setTimeout(() => {
            if (!this.status.enabled) {
              return;
            }
            try {
              this.startRecognition();
              this.updateStatus({}, "recognition restart after playback");
            } catch (error) {
              const message = error instanceof Error ? error.message : "Voice listener restart failed.";
              this.updateStatus({
                mode: "error",
                error: message
              }, `restart failed after playback: ${message}`);
            }
          }, 200);
        }
        return;
      }

      this.restartTimer = setTimeout(() => {
        if (!this.status.enabled) {
          return;
        }
        try {
          this.startRecognition();
          this.updateStatus({}, "recognition auto-restart");
        } catch (error) {
          const message = error instanceof Error ? error.message : "Voice listener restart failed.";
          this.updateStatus({
            mode: "error",
            error: message
          }, `auto-restart failed: ${message}`);
        }
      }, 300);
      return;
    }

    this.isStopping = false;
    this.resumeRecognitionAfterStop = false;
    if (this.status.mode !== "error" && this.status.mode !== "unsupported") {
      this.updateStatus({
        mode: this.status.supported ? "off" : "unsupported"
      });
    }
  }

  private handleRecognitionError(event: BrowserSpeechRecognitionErrorEvent): void {
    const code = typeof event?.error === "string" ? event.error : "unknown";
    this.updateStatus({}, `recognition error: ${code}`);
    if (code === "no-speech") {
      return;
    }
    if (code === "aborted") {
      if (this.isStopping) {
        return;
      }
      // Chromium-based browsers can emit aborted during automatic restarts.
      return;
    }
    if (code === "network") {
      this.handleNetworkRecognitionError();
      return;
    }
    if (code === "not-allowed" && this.isStopping) {
      return;
    }

    const message = this.mapSpeechError(code);

    if (code === "not-allowed" || code === "service-not-allowed" || code === "audio-capture") {
      this.isStopping = true;
      this.resumeRecognitionAfterStop = false;
      this.awaitingCommand = false;
      this.isProcessing = false;
      this.clearWaitForCommandTimer();
      this.clearRestartTimer();
      this.updateStatus({
        enabled: false,
        mode: "error",
        pendingWakeWord: null,
        error: message
      }, `fatal recognition error: ${message}`);
      return;
    }

    this.updateStatus({
      mode: "error",
      error: message
    }, `recognition error: ${message}`);
  }

  private handleNetworkRecognitionError(): void {
    const now = Date.now();
    this.recentNetworkErrors = [...this.recentNetworkErrors, now]
      .filter((timestamp) => now - timestamp <= NETWORK_ERROR_WINDOW_MS);

    this.updateStatus({}, `network error burst count: ${this.recentNetworkErrors.length}`);

    if (
      !this.useServerSttFallback &&
      this.recentNetworkErrors.length >= NETWORK_ERROR_THRESHOLD
    ) {
      void this.activateServerSttFallback('persistent browser speech network errors');
    }
  }

  private async activateServerSttFallback(reason: string): Promise<void> {
    if (!this.status.enabled || this.useServerSttFallback) {
      return;
    }

    if (typeof window === "undefined" || typeof MediaRecorder === "undefined") {
      this.updateStatus({
        mode: "error",
        error: "Browser MediaRecorder is unavailable for STT fallback."
      }, "cannot activate server STT fallback: MediaRecorder unsupported");
      return;
    }

    try {
      await this.ensureMicrophoneAccess();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Microphone unavailable for STT fallback.";
      this.updateStatus({
        mode: "error",
        error: message
      }, `cannot activate server STT fallback: ${message}`);
      return;
    }

    this.useServerSttFallback = true;
    this.awaitingCommand = false;
    this.fallbackNoChunkCount = 0;
    this.fallbackSmallClipCount = 0;
    this.clearWaitForCommandTimer();
    this.clearRestartTimer();
    this.isStopping = true;
    this.resumeRecognitionAfterStop = false;

    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch (_error) {
        // Ignore stop failures here.
      }
    }

    this.updateStatus({
      engine: "server_stt_fallback",
      mode: "listening",
      error: null
    }, `switched to server STT fallback: ${reason}`);

    this.startFallbackLoop();
  }

  private startFallbackLoop(): void {
    if (this.fallbackLoopTimer) {
      return;
    }

    const runCapture = async () => {
      if (!this.status.enabled || !this.useServerSttFallback || this.fallbackCaptureInFlight) {
        return;
      }

      if (Date.now() < this.playbackMutedUntil) {
        return;
      }

      this.fallbackCaptureInFlight = true;
      try {
        const clip = await this.captureFallbackAudioClip(FALLBACK_CAPTURE_DURATION_MS);
        if (!clip) {
          this.fallbackNoChunkCount += 1;
          if (this.fallbackNoChunkCount === 1 || this.fallbackNoChunkCount % 5 === 0) {
            this.updateStatus({}, `fallback clip empty (no chunks) count=${this.fallbackNoChunkCount}`);
          }
          return;
        }

        this.fallbackNoChunkCount = 0;

        if (clip.size < MIN_FALLBACK_CLIP_BYTES) {
          this.fallbackSmallClipCount += 1;
          if (this.fallbackSmallClipCount === 1 || this.fallbackSmallClipCount % 5 === 0) {
            this.updateStatus({}, `fallback clip too small size=${clip.size}B count=${this.fallbackSmallClipCount}`);
          }
          return;
        }

        this.fallbackSmallClipCount = 0;
        this.updateStatus({}, `fallback clip captured size=${clip.size}B mime=${clip.type || "unknown"}`);

        const audioBase64 = await this.blobToBase64(clip);
        if (!audioBase64 || audioBase64.length > MAX_AUDIO_B64_LENGTH) {
          this.updateStatus({}, "fallback clip skipped (empty or too large)");
          return;
        }

        const stt = await transcribeBrowserAudio({
          audioBase64,
          mimeType: clip.type || "audio/webm",
          language: "en"
        });

        if (stt?.provider || stt?.model) {
          this.updateStatus(
            {},
            `server-stt result provider=${stt?.provider || "unknown"} model=${stt?.model || "unknown"}`
          );
        }

        const transcript = (stt?.text || "").trim();
        if (!transcript) {
          this.updateStatus({}, "server-stt returned empty transcript");
          return;
        }

        this.updateStatus({
          lastTranscript: transcript
        }, `server-stt transcript: "${transcript}"`);

        await this.processTranscript(
          transcript,
          typeof stt?.confidence === "number" ? stt.confidence : null
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Server STT fallback capture failed";
        this.updateStatus({}, `server-stt fallback error: ${message}`);
        if (
          message.includes('HTTP 404') ||
          message.toLowerCase().includes('page not found')
        ) {
          this.updateStatus({
            mode: "error",
            error: "Server route /api/voice/browser/transcribe is unavailable. Deploy/restart backend.",
          }, "server-stt endpoint missing on backend");
        }
      } finally {
        this.fallbackCaptureInFlight = false;
      }
    };

    void runCapture();
    this.fallbackLoopTimer = setInterval(() => {
      void runCapture();
    }, FALLBACK_CAPTURE_INTERVAL_MS);
  }

  private stopFallbackLoop(): void {
    if (!this.fallbackLoopTimer) {
      return;
    }
    clearInterval(this.fallbackLoopTimer);
    this.fallbackLoopTimer = null;
  }

  private async captureFallbackAudioClip(durationMs: number): Promise<Blob | null> {
    if (!this.mediaStream || !this.mediaStream.active) {
      await this.ensureMicrophoneAccess();
    }

    if (!this.mediaStream) {
      return null;
    }

    const preferredMimeTypes = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/mp4",
      "audio/m4a"
    ];

    const selectedMimeType = preferredMimeTypes.find((mimeType) => {
      try {
        return typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mimeType);
      } catch (_error) {
        return false;
      }
    }) || "";

    return await new Promise<Blob | null>((resolve, reject) => {
      const chunks: BlobPart[] = [];
      let recorder: MediaRecorder;

      try {
        recorder = selectedMimeType
          ? new MediaRecorder(this.mediaStream as MediaStream, { mimeType: selectedMimeType })
          : new MediaRecorder(this.mediaStream as MediaStream);
      } catch (error) {
        reject(error);
        return;
      }

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      recorder.onerror = (event: Event) => {
        reject(new Error(`MediaRecorder error: ${(event as unknown as { type?: string }).type || "unknown"}`));
      };

      recorder.onstop = () => {
        if (!chunks.length) {
          resolve(null);
          return;
        }
        resolve(new Blob(chunks, { type: recorder.mimeType || selectedMimeType || "audio/webm" }));
      };

      recorder.start(250);
      setTimeout(() => {
        if (recorder.state !== "inactive") {
          try {
            recorder.requestData();
          } catch (_error) {
            // Ignore requestData errors and proceed with stop.
          }
          recorder.stop();
        }
      }, durationMs);
    });
  }

  private async blobToBase64(blob: Blob): Promise<string> {
    const arrayBuffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  }

  private async handleRecognitionResult(event: BrowserSpeechRecognitionEvent): Promise<void> {
    if (this.useServerSttFallback) {
      return;
    }

    const results = event?.results;
    if (!results) {
      return;
    }

    const startIndex = typeof event.resultIndex === "number" ? event.resultIndex : 0;

    for (let index = startIndex; index < results.length; index += 1) {
      const result = results[index];
      const bestAlternative = result?.[0];
      const transcript = typeof bestAlternative?.transcript === "string"
        ? bestAlternative.transcript.trim()
        : "";

      if (!transcript) {
        continue;
      }

      this.updateStatus({
        lastTranscript: transcript
      });

      if (!result?.isFinal && !this.awaitingCommand) {
        const interimWakeMatch = this.matchWakeWord(transcript);
        if (interimWakeMatch) {
          this.updateStatus({}, `interim wake-word candidate: ${interimWakeMatch.wakeWord} | "${transcript}"`);
          this.waitForCommand(interimWakeMatch.wakeWord);
        }
      }

      if (!result?.isFinal) {
        continue;
      }

      const confidence = typeof bestAlternative?.confidence === "number"
        ? bestAlternative.confidence
        : null;

      this.updateStatus({}, `final transcript: "${transcript}"`);
      await this.processTranscript(transcript, confidence);
    }
  }

  private async processTranscript(transcript: string, confidence: number | null): Promise<void> {
    if (!this.status.enabled || this.isProcessing) {
      return;
    }

    const wakeMatch = this.matchWakeWord(transcript);
    if (!wakeMatch && !this.awaitingCommand) {
      this.updateStatus({}, `no wake word matched for: "${transcript}"`);
    }

    if (this.awaitingCommand) {
      if (wakeMatch?.commandText) {
        this.updateStatus({}, `wake + command in same utterance (${wakeMatch.wakeWord})`);
        await this.executeCommand(wakeMatch.commandText, wakeMatch.wakeWord, confidence);
        return;
      }

      if (wakeMatch && !wakeMatch.commandText) {
        this.updateStatus({}, `wake word repeated while awaiting command: ${wakeMatch.wakeWord}`);
        this.waitForCommand(wakeMatch.wakeWord);
        return;
      }

      this.updateStatus({}, `captured command after wake word: "${transcript}"`);
      await this.executeCommand(transcript, this.status.pendingWakeWord || "browser", confidence);
      return;
    }

    if (!wakeMatch) {
      return;
    }

    if (wakeMatch.commandText) {
      this.updateStatus({}, `wake + command detected: ${wakeMatch.wakeWord}`);
      await this.executeCommand(wakeMatch.commandText, wakeMatch.wakeWord, confidence);
      return;
    }

    this.waitForCommand(wakeMatch.wakeWord);
  }

  private waitForCommand(wakeWord: string): void {
    this.awaitingCommand = true;
    this.clearWaitForCommandTimer();

    this.updateStatus({
      mode: "waiting_command",
      pendingWakeWord: wakeWord,
      lastWakeWord: wakeWord,
      error: null
    }, `wake word detected: ${wakeWord}`);

    this.waitForCommandTimer = setTimeout(() => {
      this.awaitingCommand = false;
      this.updateStatus({
        mode: this.status.enabled ? "listening" : "off",
        pendingWakeWord: null
      }, "command wait timeout");
    }, WAIT_FOR_COMMAND_TIMEOUT_MS);
  }

  private async executeCommand(commandText: string, wakeWord: string, confidence: number | null): Promise<void> {
    const sanitizedCommand = commandText.replace(/^[\s,.:;-]+/, "").trim();
    if (!sanitizedCommand) {
      this.updateStatus({}, `empty command after wake word: ${wakeWord}`);
      this.waitForCommand(wakeWord);
      return;
    }

    this.awaitingCommand = false;
    this.clearWaitForCommandTimer();
    this.isProcessing = true;

    this.updateStatus({
      mode: "processing",
      pendingWakeWord: null,
      lastWakeWord: wakeWord,
      lastCommand: sanitizedCommand,
      error: null
    }, `processing command: "${sanitizedCommand}"`);

    try {
      const result = await interpretVoiceCommand({
        commandText: sanitizedCommand,
        room: null,
        wakeWord,
        deviceId: null,
        stt: {
          provider: "browser-web-speech",
          model: "WebSpeechRecognition",
          confidence
        }
      });

      this.updateStatus({
        lastResponse: result?.responseText || null
      }, "command processed by server");

      if (result?.responseText) {
        await this.playResponse(result.responseText, wakeWord);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to process voice command.";
      this.updateStatus({
        error: message
      }, `command failed: ${message}`);
    } finally {
      this.isProcessing = false;
      this.updateStatus({
        mode: this.status.enabled ? "listening" : "off"
      }, "processing complete");
    }
  }

  private matchWakeWord(transcript: string): { wakeWord: string; commandText: string } | null {
    for (const wakeWord of this.wakeWords) {
      const pattern = this.buildWakeWordPattern(wakeWord);
      const match = pattern.exec(transcript);
      if (!match || typeof match.index !== "number") {
        continue;
      }

      const commandText = transcript
        .slice(match.index + match[0].length)
        .replace(/^[\s,.:;-]+/, "")
        .trim();

      return {
        wakeWord,
        commandText
      };
    }

    return null;
  }

  private buildWakeWordPattern(wakeWord: string): RegExp {
    const fragments = wakeWord
      .split(/\s+/)
      .map((part) => escapeRegExp(part))
      .join("[\\s,!.?-]+");

    return new RegExp(`\\b${fragments}\\b`, "i");
  }

  private normalizeWakeWord(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private async playResponse(text: string, wakeWord: string): Promise<void> {
    this.playbackMutedUntil = Date.now() + 1400;
    await this.pauseRecognitionForPlayback();

    const voiceId = this.resolveVoiceId(wakeWord);
    try {
      if (voiceId) {
        try {
          this.updateStatus({}, `playing ElevenLabs response (voice=${voiceId})`);
          const audioBlob = await textToSpeechElevenLabs({
            text,
            voiceId
          });
          await playAudioBlob(audioBlob);
          this.updateStatus({}, "response playback completed (ElevenLabs)");
          return;
        } catch (_error) {
          // Fall through to browser speech synthesis when ElevenLabs is unavailable.
          this.updateStatus({}, "ElevenLabs playback failed, using browser speech synthesis");
        }
      }

      await this.playWithBrowserSpeech(text);
      this.updateStatus({}, "response playback completed (browser speech)");
    } finally {
      this.playbackMutedUntil = Date.now() + 700;
      this.resumeRecognitionAfterPlayback();
    }
  }

  private resolveVoiceId(wakeWord: string): string | null {
    const normalizedWakeWord = this.normalizeWakeWord(wakeWord);

    if (normalizedWakeWord) {
      for (const profile of this.voiceProfiles) {
        if (profile.voiceId && profile.wakeWords.includes(normalizedWakeWord)) {
          return profile.voiceId;
        }
      }
    }

    if (this.defaultVoiceId) {
      return this.defaultVoiceId;
    }

    const fallbackProfile = this.voiceProfiles.find((profile) => profile.voiceId);
    return fallbackProfile?.voiceId || null;
  }

  private async playWithBrowserSpeech(text: string): Promise<void> {
    if (typeof window === "undefined" || typeof window.speechSynthesis === "undefined") {
      return;
    }

    window.speechSynthesis.cancel();

    await new Promise<void>((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();
      window.speechSynthesis.speak(utterance);
    });
  }

  private mapSpeechError(code: string): string {
    switch (code) {
      case "not-allowed":
      case "service-not-allowed":
        return "Microphone permission is blocked. Allow microphone access in your browser settings.";
      case "audio-capture":
        return "No microphone was detected. Check your input device and browser permissions.";
      case "network":
        return "Speech recognition network service is unavailable right now. It should auto-retry.";
      case "aborted":
        return "Speech recognition was interrupted.";
      default:
        return "Browser speech recognition failed. Try toggling Voice Off/On again.";
    }
  }

  private mapMicrophoneAccessError(error: unknown): string {
    const name = typeof error === "object" && error !== null && "name" in error
      ? String((error as { name?: string }).name)
      : "";

    switch (name) {
      case "NotAllowedError":
      case "SecurityError":
        return "Microphone access is blocked. Allow microphone permission for this site and reload.";
      case "NotFoundError":
      case "DevicesNotFoundError":
        return "No microphone device is available in this browser session.";
      case "NotReadableError":
      case "TrackStartError":
        return "Microphone is busy or unavailable. Close other apps using the mic and try again.";
      default:
        return "Unable to access microphone. Check browser/device microphone settings and try again.";
    }
  }

  private async pauseRecognitionForPlayback(): Promise<void> {
    if (!this.status.enabled || !this.recognition || this.useServerSttFallback) {
      return;
    }

    this.isStopping = true;
    this.resumeRecognitionAfterStop = true;
    try {
      this.recognition.stop();
    } catch (_error) {
      this.isStopping = false;
      this.resumeRecognitionAfterStop = false;
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
  }

  private resumeRecognitionAfterPlayback(): void {
    if (!this.status.enabled || !this.recognition || this.useServerSttFallback) {
      return;
    }

    if (this.isStopping || this.resumeRecognitionAfterStop) {
      return;
    }

    try {
      this.startRecognition();
    } catch (_error) {
      // onend handler will attempt recovery when possible.
    }
  }

  private clearWaitForCommandTimer(): void {
    if (!this.waitForCommandTimer) {
      return;
    }
    clearTimeout(this.waitForCommandTimer);
    this.waitForCommandTimer = null;
  }

  private clearRestartTimer(): void {
    if (!this.restartTimer) {
      return;
    }
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }
}

export const browserVoiceAssistant = BrowserVoiceAssistant.getInstance();
