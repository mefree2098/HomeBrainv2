import { fetchBrowserWakeAcknowledgmentAudio, interpretVoiceCommand, transcribeBrowserAudio } from "@/api/voice";
import { getUserProfiles } from "@/api/profiles";
import { textToSpeechElevenLabs, playAudioBlob } from "@/api/elevenLabs";
import { getSettings } from "@/api/settings";

const DEFAULT_WAKE_WORDS = ["anna", "hey anna", "henry", "hey henry", "home brain", "computer"];
const WAIT_FOR_COMMAND_TIMEOUT_MS = 22000;
const NETWORK_ERROR_WINDOW_MS = 15000;
const NETWORK_ERROR_THRESHOLD = 6;
const FALLBACK_CAPTURE_INTERVAL_MS = 250;
const FALLBACK_CAPTURE_DURATION_MS = 1400;
const FALLBACK_COMMAND_CAPTURE_DURATION_MS = 1800;
const FALLBACK_IMMEDIATE_RETRY_DELAY_MS = 120;
const MIN_FALLBACK_CLIP_BYTES = 64;
const MAX_AUDIO_B64_LENGTH = 500000;
const WAKE_WORD_FUZZY_MIN_SCORE = 0.72;
const WAKE_WORD_FUZZY_MAX_START_TOKEN_INDEX = 2;
const FALLBACK_WAKE_STITCH_WINDOW_MS = 5200;
const FALLBACK_WAKE_STITCH_MAX_PARTS = 4;
const BROWSER_VOICE_BUILD_TAG = "2026-02-27-lowlatency-v2";

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
  processLocally?: boolean;
  onstart: null | (() => void);
  onend: null | (() => void);
  onerror: null | ((event: BrowserSpeechRecognitionErrorEvent) => void);
  onresult: null | ((event: BrowserSpeechRecognitionEvent) => void);
  start: () => void;
  stop: () => void;
};

type BrowserSpeechRecognitionAvailability = "available" | "unavailable" | "downloadable" | "downloading";

type BrowserSpeechRecognitionConstructor = {
  new (): BrowserSpeechRecognition;
  available?: (options: { langs: string[]; processLocally?: boolean }) => Promise<BrowserSpeechRecognitionAvailability>;
  install?: (options: { langs: string[]; processLocally?: boolean }) => Promise<boolean>;
};

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
  private fallbackImmediateCaptureTimer: ReturnType<typeof setTimeout> | null = null;
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
  private fallbackWakeTranscriptHistory: Array<{ text: string; timestamp: number }> = [];
  private onDeviceSpeechReady = false;
  private readonly recognitionLang = "en-US";
  private pendingResumeAfterProcessing = false;
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
    }, `enable requested (build=${BROWSER_VOICE_BUILD_TAG})`);

    this.isStopping = false;
    this.useServerSttFallback = false;
    this.recentNetworkErrors = [];
    this.playbackMutedUntil = 0;
    this.stopFallbackLoop();
    this.clearFallbackWakeTranscriptHistory();

    try {
      await this.ensureOnDeviceSpeechIfSupported();
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
    this.clearFallbackWakeTranscriptHistory();
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
    recognition.lang = this.recognitionLang;
    recognition.maxAlternatives = 1;

    if (this.onDeviceSpeechReady && "processLocally" in recognition) {
      recognition.processLocally = true;
      this.updateStatus({}, `speech recognition configured for on-device mode (${this.recognitionLang})`);
    }

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

  private async ensureOnDeviceSpeechIfSupported(): Promise<void> {
    this.onDeviceSpeechReady = false;

    if (typeof window === "undefined") {
      return;
    }

    const win = window as Window & {
      SpeechRecognition?: BrowserSpeechRecognitionConstructor;
      webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
    };

    const RecognitionCtor = win.SpeechRecognition || win.webkitSpeechRecognition;
    if (!RecognitionCtor) {
      return;
    }

    const hasOnDeviceStatics = typeof RecognitionCtor.available === "function"
      && typeof RecognitionCtor.install === "function";

    if (!hasOnDeviceStatics) {
      this.updateStatus({}, "on-device Web Speech API unavailable; cloud service may be required");
      return;
    }

    try {
      const availability = await RecognitionCtor.available?.({
        langs: [this.recognitionLang],
        processLocally: true
      });

      if (!availability || availability === "unavailable") {
        this.updateStatus({}, `on-device speech unavailable for ${this.recognitionLang}`);
        return;
      }

      if (availability === "available") {
        this.onDeviceSpeechReady = true;
        this.updateStatus({}, `on-device speech ready for ${this.recognitionLang}`);
        return;
      }

      this.updateStatus({}, `on-device speech pack ${availability}; installing ${this.recognitionLang}`);
      const installed = await RecognitionCtor.install?.({
        langs: [this.recognitionLang],
        processLocally: true
      });

      if (installed) {
        this.onDeviceSpeechReady = true;
        this.updateStatus({}, `on-device speech pack installed for ${this.recognitionLang}`);
        return;
      }

      this.updateStatus({}, `on-device speech pack install failed for ${this.recognitionLang}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      if (message.includes("Requires handling a user gesture")) {
        this.updateStatus(
          {},
          `on-device speech install needs a direct click gesture; continuing with default recognition path`
        );
        return;
      }
      this.updateStatus({}, `on-device speech init failed, using default recognition path: ${message}`);
    }
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
    this.clearFallbackWakeTranscriptHistory();
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

    void this.captureAndProcessFallbackClip(FALLBACK_CAPTURE_DURATION_MS);
    this.fallbackLoopTimer = setInterval(() => {
      void this.captureAndProcessFallbackClip(FALLBACK_CAPTURE_DURATION_MS);
    }, FALLBACK_CAPTURE_INTERVAL_MS);
  }

  private stopFallbackLoop(): void {
    if (!this.fallbackLoopTimer) {
      this.clearImmediateFallbackCapture();
      return;
    }
    clearInterval(this.fallbackLoopTimer);
    this.fallbackLoopTimer = null;
    this.clearImmediateFallbackCapture();
  }

  private clearImmediateFallbackCapture(): void {
    if (!this.fallbackImmediateCaptureTimer) {
      return;
    }
    clearTimeout(this.fallbackImmediateCaptureTimer);
    this.fallbackImmediateCaptureTimer = null;
  }

  private requestImmediateFallbackCapture(durationMs: number, reason: string, delayMs = 0): void {
    if (!this.status.enabled || !this.useServerSttFallback) {
      return;
    }

    this.clearImmediateFallbackCapture();
    this.fallbackImmediateCaptureTimer = setTimeout(() => {
      this.fallbackImmediateCaptureTimer = null;

      if (!this.status.enabled || !this.useServerSttFallback) {
        return;
      }

      if (this.fallbackCaptureInFlight) {
        this.requestImmediateFallbackCapture(
          durationMs,
          reason,
          FALLBACK_IMMEDIATE_RETRY_DELAY_MS
        );
        return;
      }

      this.updateStatus({}, `fallback immediate capture (${reason})`);
      void this.captureAndProcessFallbackClip(durationMs);
    }, Math.max(0, delayMs));
  }

  private async captureAndProcessFallbackClip(durationMs: number): Promise<void> {
    if (!this.status.enabled || !this.useServerSttFallback || this.fallbackCaptureInFlight) {
      return;
    }

    if (Date.now() < this.playbackMutedUntil) {
      return;
    }

    if (this.awaitingCommand) {
      this.refreshWaitForCommandTimeout("fallback capture start");
    }

    this.fallbackCaptureInFlight = true;
    try {
      const clip = await this.captureFallbackAudioClip(durationMs);
      if (!clip) {
        this.fallbackNoChunkCount += 1;
        if (this.fallbackNoChunkCount === 1 || this.fallbackNoChunkCount % 5 === 0) {
          this.updateStatus({}, `fallback clip empty (no chunks) count=${this.fallbackNoChunkCount}`);
        }
        if (this.awaitingCommand) {
          this.requestImmediateFallbackCapture(
            FALLBACK_COMMAND_CAPTURE_DURATION_MS,
            "awaiting command (no chunks)",
            FALLBACK_IMMEDIATE_RETRY_DELAY_MS
          );
        }
        return;
      }

      this.fallbackNoChunkCount = 0;

      if (clip.size < MIN_FALLBACK_CLIP_BYTES) {
        this.fallbackSmallClipCount += 1;
        if (this.fallbackSmallClipCount === 1 || this.fallbackSmallClipCount % 5 === 0) {
          this.updateStatus({}, `fallback clip too small size=${clip.size}B count=${this.fallbackSmallClipCount}`);
        }
        if (this.awaitingCommand) {
          this.requestImmediateFallbackCapture(
            FALLBACK_COMMAND_CAPTURE_DURATION_MS,
            "awaiting command (small clip)",
            FALLBACK_IMMEDIATE_RETRY_DELAY_MS
          );
        }
        return;
      }

      this.fallbackSmallClipCount = 0;
      this.updateStatus({}, `fallback clip captured size=${clip.size}B mime=${clip.type || "unknown"}`);

      const audioBase64 = await this.blobToBase64(clip);
      if (!audioBase64 || audioBase64.length > MAX_AUDIO_B64_LENGTH) {
        this.updateStatus({}, "fallback clip skipped (empty or too large)");
        if (this.awaitingCommand) {
          this.requestImmediateFallbackCapture(
            FALLBACK_COMMAND_CAPTURE_DURATION_MS,
            "awaiting command (clip skipped)",
            FALLBACK_IMMEDIATE_RETRY_DELAY_MS
          );
        }
        return;
      }

      const stt = await transcribeBrowserAudio({
        audioBase64,
        mimeType: clip.type || "audio/webm",
        language: "en",
        profile: "realtime"
      });

      if (this.awaitingCommand) {
        this.refreshWaitForCommandTimeout("fallback transcription result");
      }

      if (stt?.provider || stt?.model) {
        const timingLabel = typeof stt?.processingTimeMs === "number"
          ? ` tookMs=${Math.round(stt.processingTimeMs)}`
          : "";
        const runtimeLabel = stt?.device || stt?.computeType
          ? ` device=${stt?.device || "unknown"} compute=${stt?.computeType || "unknown"}`
          : "";
        const beamLabel = typeof stt?.beamSize === "number" ? ` beam=${stt.beamSize}` : "";
        this.updateStatus(
          {},
          `server-stt result provider=${stt?.provider || "unknown"} model=${stt?.model || "unknown"}${runtimeLabel}${beamLabel}${timingLabel}`
        );
      }

      const transcript = (stt?.text || "").trim();
      if (!transcript) {
        this.updateStatus({}, "server-stt returned empty transcript");
        if (this.awaitingCommand) {
          this.requestImmediateFallbackCapture(
            FALLBACK_COMMAND_CAPTURE_DURATION_MS,
            "awaiting command (empty transcript)",
            FALLBACK_IMMEDIATE_RETRY_DELAY_MS
          );
        }
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

    let wakeMatch = this.matchWakeWord(transcript);
    if (!wakeMatch && this.useServerSttFallback && !this.awaitingCommand) {
      const stitchedTranscript = this.getStitchedFallbackTranscript(transcript);
      if (stitchedTranscript && stitchedTranscript !== transcript) {
        const stitchedWakeMatch = this.matchWakeWord(stitchedTranscript);
        if (stitchedWakeMatch) {
          wakeMatch = stitchedWakeMatch;
          this.updateStatus(
            {},
            `stitched wake-word match (${stitchedWakeMatch.wakeWord}) from "${stitchedTranscript}"`
          );
        }
      }
    }

    if (wakeMatch?.matchType === "fuzzy") {
      this.updateStatus({}, `fuzzy wake match (${wakeMatch.wakeWord}) score=${(wakeMatch.score ?? 0).toFixed(2)}`);
    }

    if (!wakeMatch && !this.awaitingCommand) {
      if (this.useServerSttFallback) {
        const normalizedFallbackCommand = this.normalizeFallbackDirectCommand(transcript);
        if (this.isLikelyDirectCommand(normalizedFallbackCommand)) {
          const fallbackWakeWord = this.resolveFallbackWakeWord(transcript);
          if (normalizedFallbackCommand !== transcript.trim()) {
            this.updateStatus({}, `fallback normalized command: "${normalizedFallbackCommand}"`);
          }
          this.updateStatus(
            {},
            `fallback direct command heuristic matched: "${normalizedFallbackCommand}" (wake=${fallbackWakeWord})`
          );
          await this.executeCommand(normalizedFallbackCommand, fallbackWakeWord, confidence);
          return;
        }

        const normalizedFallbackQuery = this.normalizeFallbackDirectCommand(transcript);
        if (this.isLikelyDirectQuery(normalizedFallbackQuery)) {
          const fallbackWakeWord = this.resolveFallbackWakeWord(transcript);
          if (this.isLikelyIncompleteUtterance(normalizedFallbackQuery)) {
            this.updateStatus(
              {},
              `fallback query fragment detected; waiting for continuation: "${normalizedFallbackQuery}"`
            );
            this.waitForCommand(fallbackWakeWord);
            return;
          }
          this.updateStatus(
            {},
            `fallback direct query heuristic matched: "${normalizedFallbackQuery}" (wake=${fallbackWakeWord})`
          );
          await this.executeCommand(normalizedFallbackQuery, fallbackWakeWord, confidence);
          return;
        }
      }

      if (this.useServerSttFallback && this.isLikelyDirectCommand(transcript)) {
        const fallbackWakeWord = this.resolveFallbackWakeWord(transcript);
        this.updateStatus(
          {},
          `fallback direct command heuristic matched: "${transcript}" (wake=${fallbackWakeWord})`
        );
        await this.executeCommand(transcript, fallbackWakeWord, confidence);
        return;
      }
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

      const normalizedAwaitingTranscript = this.useServerSttFallback
        ? this.normalizeFallbackDirectCommand(transcript)
        : transcript;

      if (this.useServerSttFallback && this.isLikelyDiscardableFiller(normalizedAwaitingTranscript)) {
        this.updateStatus({}, `ignoring filler while awaiting command: "${normalizedAwaitingTranscript}"`);
        this.requestImmediateFallbackCapture(
          FALLBACK_COMMAND_CAPTURE_DURATION_MS,
          "awaiting command (ignored filler)",
          FALLBACK_IMMEDIATE_RETRY_DELAY_MS
        );
        return;
      }

      this.updateStatus({}, `captured command after wake word: "${normalizedAwaitingTranscript}"`);
      await this.executeCommand(
        normalizedAwaitingTranscript,
        this.status.pendingWakeWord || "browser",
        confidence
      );
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
    this.clearFallbackWakeTranscriptHistory();

    this.updateStatus({
      mode: "waiting_command",
      pendingWakeWord: wakeWord,
      lastWakeWord: wakeWord,
      error: null
    }, `wake word detected: ${wakeWord}`);

    this.refreshWaitForCommandTimeout("wake-word detected");

    if (this.useServerSttFallback) {
      this.requestImmediateFallbackCapture(
        FALLBACK_COMMAND_CAPTURE_DURATION_MS,
        "wake-word follow-up",
        20
      );
    }
  }

  private async executeCommand(commandText: string, wakeWord: string, confidence: number | null): Promise<void> {
    const sanitizedCommand = commandText.replace(/^[\s,.:;-]+/, "").trim();
    if (!sanitizedCommand) {
      this.updateStatus({}, `empty command after wake word: ${wakeWord}`);
      this.waitForCommand(wakeWord);
      return;
    }

    this.awaitingCommand = false;
    this.clearFallbackWakeTranscriptHistory();
    this.clearWaitForCommandTimer();
    this.isProcessing = true;
    this.pendingResumeAfterProcessing = false;

    this.updateStatus({
      mode: "processing",
      pendingWakeWord: null,
      lastWakeWord: wakeWord,
      lastCommand: sanitizedCommand,
      error: null
    }, `processing command: "${sanitizedCommand}"`);

    try {
      const wakeAckPlaybackPromise = this.playWakeAcknowledgment(wakeWord);
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

      const llmProvider = result?.llm?.provider || "unknown";
      const llmModel = result?.llm?.model || "unknown";
      const llmMs = typeof result?.llm?.processingTimeMs === "number"
        ? result.llm.processingTimeMs
        : null;
      const llmRuntime = result?.llm?.runtime?.processor || null;
      const llmRuntimeModel = result?.llm?.runtime?.model || null;
      const fallbackLabel = result?.usedFallback ? "yes" : "no";
      const llmTimingLabel = llmMs !== null ? ` llmMs=${llmMs}` : "";
      const llmRuntimeLabel = llmRuntime ? ` runtime=${llmRuntime}` : "";
      const llmRuntimeModelLabel = llmRuntimeModel ? ` runtimeModel=${llmRuntimeModel}` : "";

      this.updateStatus({
        lastResponse: result?.responseText || null
      }, `command processed by server provider=${llmProvider} model=${llmModel}${llmTimingLabel}${llmRuntimeLabel}${llmRuntimeModelLabel} fallback=${fallbackLabel}`);

      await wakeAckPlaybackPromise;

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
      if (this.pendingResumeAfterProcessing) {
        this.pendingResumeAfterProcessing = false;
        this.resumeRecognitionAfterPlayback();
      }
      this.updateStatus({
        mode: this.status.enabled ? "listening" : "off"
      }, "processing complete");
    }
  }

  private matchWakeWord(
    transcript: string
  ): { wakeWord: string; commandText: string; matchType: "exact" | "fuzzy"; score?: number } | null {
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
        commandText,
        matchType: "exact"
      };
    }

    const normalizedTranscript = this.normalizeWakeWord(transcript);
    const transcriptTokens = normalizedTranscript.split(/\s+/).filter(Boolean);
    if (!transcriptTokens.length) {
      return null;
    }

    let bestMatch:
      | { wakeWord: string; score: number; startIndex: number; tokenLength: number }
      | null = null;

    for (const wakeWord of this.wakeWords) {
      const wakeTokens = this.normalizeWakeWord(wakeWord).split(/\s+/).filter(Boolean);
      if (!wakeTokens.length) {
        continue;
      }

      const candidateWindowSizes = Array.from(new Set([
        Math.max(1, wakeTokens.length - 1),
        wakeTokens.length,
        wakeTokens.length + 1
      ]));

      for (const windowSize of candidateWindowSizes) {
        if (windowSize > transcriptTokens.length) {
          continue;
        }

        for (let startIndex = 0; startIndex <= transcriptTokens.length - windowSize; startIndex += 1) {
          if (startIndex > WAKE_WORD_FUZZY_MAX_START_TOKEN_INDEX) {
            break;
          }

          const candidatePhrase = transcriptTokens.slice(startIndex, startIndex + windowSize).join(" ");
          const score = this.calculateSimilarity(this.normalizeWakeWord(wakeWord), candidatePhrase);
          if (score < WAKE_WORD_FUZZY_MIN_SCORE) {
            continue;
          }

          if (!bestMatch || score > bestMatch.score) {
            bestMatch = {
              wakeWord,
              score,
              startIndex,
              tokenLength: windowSize
            };
          }
        }
      }
    }

    if (bestMatch) {
      const commandTokens = transcriptTokens.slice(bestMatch.startIndex + bestMatch.tokenLength);
      return {
        wakeWord: bestMatch.wakeWord,
        commandText: commandTokens.join(" ").trim(),
        matchType: "fuzzy",
        score: bestMatch.score
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

  private clearFallbackWakeTranscriptHistory(): void {
    this.fallbackWakeTranscriptHistory = [];
  }

  private getStitchedFallbackTranscript(transcript: string): string {
    const candidate = (transcript || "").trim();
    if (!candidate) {
      return "";
    }

    const now = Date.now();
    this.fallbackWakeTranscriptHistory = [
      ...this.fallbackWakeTranscriptHistory,
      { text: candidate, timestamp: now }
    ]
      .filter((item) => now - item.timestamp <= FALLBACK_WAKE_STITCH_WINDOW_MS)
      .slice(-FALLBACK_WAKE_STITCH_MAX_PARTS);

    return this.fallbackWakeTranscriptHistory
      .map((item) => item.text.trim())
      .filter((item) => item.length > 0)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private normalizeWakeWord(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private calculateSimilarity(a: string, b: string): number {
    if (!a || !b) {
      return 0;
    }
    if (a === b) {
      return 1;
    }

    const distance = this.levenshteinDistance(a, b);
    const scale = Math.max(a.length, b.length);
    if (scale === 0) {
      return 0;
    }
    return Math.max(0, 1 - (distance / scale));
  }

  private levenshteinDistance(a: string, b: string): number {
    const rows = a.length + 1;
    const cols = b.length + 1;
    const matrix: number[][] = Array.from({ length: rows }, () => Array<number>(cols).fill(0));

    for (let i = 0; i < rows; i += 1) {
      matrix[i][0] = i;
    }
    for (let j = 0; j < cols; j += 1) {
      matrix[0][j] = j;
    }

    for (let i = 1; i < rows; i += 1) {
      for (let j = 1; j < cols; j += 1) {
        const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1, // deletion
          matrix[i][j - 1] + 1, // insertion
          matrix[i - 1][j - 1] + substitutionCost // substitution
        );
      }
    }

    return matrix[rows - 1][cols - 1];
  }

  private isLikelyDirectCommand(transcript: string): boolean {
    const normalized = this.normalizeWakeWord(transcript);
    if (!normalized) {
      return false;
    }

    // In fallback mode only, allow direct imperative commands when wake-word STT is imperfect.
    const directPattern = /^(turn|switch|set|dim|brighten|open|close|lock|unlock|arm|disarm|activate|deactivate|run|start|stop|enable|disable)\b/;
    if (directPattern.test(normalized)) {
      return true;
    }

    // Handle clipped fallback phrases like "on vault light switch" / "off kitchen lights".
    const clippedOnOffPattern = /^(on|off)\b/;
    const hasDeviceLikeTarget = /\b(light|lights|switch|lamp|fan|scene|alarm|security|lock|door|garage|thermostat|vault|spotlight)\b/;
    if (clippedOnOffPattern.test(normalized) && hasDeviceLikeTarget.test(normalized)) {
      return true;
    }

    // Handle conversational preambles while still requiring an actionable command verb.
    const conversationalPattern = /^(please|can you|could you|would you|hey|anna|henry|computer)\b/;
    const hasActionVerb = /\b(turn on|turn off|set|dim|brighten|open|close|lock|unlock|arm|disarm|activate|run|start|stop|enable|disable|on|off)\b/.test(normalized);
    return conversationalPattern.test(normalized) && hasActionVerb;
  }

  private isLikelyDirectQuery(transcript: string): boolean {
    const normalized = this.normalizeWakeWord(transcript);
    if (!normalized) {
      return false;
    }

    if (/[?]/.test(transcript)) {
      return true;
    }

    const questionLeadPattern = /^(what|who|when|where|why|how|which)\b/;
    if (questionLeadPattern.test(normalized)) {
      return true;
    }

    const conversationalQuestionPattern = /^(what s|what is|who is|tell me|explain|define|summarize|can you tell me|do you know)\b/;
    return conversationalQuestionPattern.test(normalized);
  }

  private isLikelyIncompleteUtterance(transcript: string): boolean {
    const raw = (transcript || "").trim();
    if (!raw) {
      return true;
    }

    if (raw.endsWith("...")) {
      return true;
    }

    const normalized = this.normalizeWakeWord(raw);
    if (!normalized) {
      return true;
    }

    const trailingConnectorPattern = /\b(the|a|an|of|to|for|in|on|at|with|about|from|is|are|was|were|can|could|would|should|if|that|this)\b$/;
    return trailingConnectorPattern.test(normalized);
  }

  private isLikelyDiscardableFiller(transcript: string): boolean {
    const normalized = this.normalizeWakeWord(transcript);
    if (!normalized) {
      return true;
    }

    if (this.isLikelyDirectCommand(normalized) || this.isLikelyDirectQuery(normalized)) {
      return false;
    }

    const fillerPhrases = new Set([
      "thank you",
      "thanks",
      "thanks for watching",
      "thank you for watching",
      "ok",
      "okay",
      "alright",
      "all right",
      "got it",
      "never mind",
      "nevermind",
      "cancel",
      "stop"
    ]);
    if (fillerPhrases.has(normalized)) {
      return true;
    }

    if (/^thank(s| you)(\s+for\s+.*)?$/.test(normalized)) {
      return true;
    }

    if (/^(bye|goodbye|see you|of course|sure)$/.test(normalized)) {
      return true;
    }

    return /^(uh|um|hmm|mm)$/.test(normalized);
  }

  private normalizeFallbackDirectCommand(transcript: string): string {
    const original = (transcript || "").trim();
    if (!original) {
      return "";
    }

    const normalized = this.normalizeWakeWord(original);
    if (!normalized) {
      return original;
    }

    const strippedPrefix = normalized
      .replace(/^(please|can you|could you|would you|hey|anna|henry|computer)\s+/, "")
      .trim();

    if (!strippedPrefix) {
      return original;
    }

    if (/^(on|off)\b/.test(strippedPrefix)) {
      const hasDeviceLikeTarget = /\b(light|lights|switch|lamp|fan|scene|alarm|security|lock|door|garage|thermostat|vault|spotlight)\b/;
      if (hasDeviceLikeTarget.test(strippedPrefix)) {
        return `turn ${strippedPrefix}`.trim();
      }
    }

    return strippedPrefix;
  }

  private async playWakeAcknowledgment(wakeWord: string): Promise<void> {
    const resolvedWakeWord = (wakeWord || "").trim();
    if (!resolvedWakeWord || resolvedWakeWord === "browser-fallback") {
      return;
    }

    try {
      this.playbackMutedUntil = Date.now() + 1400;
      await this.pauseRecognitionForPlayback();
      this.updateStatus({}, `playing wake acknowledgment (wake=${resolvedWakeWord})`);

      const audioBlob = await fetchBrowserWakeAcknowledgmentAudio({
        wakeWord: resolvedWakeWord
      });

      if (!audioBlob || audioBlob.size === 0) {
        this.updateStatus({}, "wake acknowledgment unavailable");
        return;
      }

      await playAudioBlob(audioBlob);
      this.updateStatus({}, "wake acknowledgment playback completed");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Wake acknowledgment playback failed.";
      this.updateStatus({}, `wake acknowledgment skipped: ${message}`);
    } finally {
      this.playbackMutedUntil = Date.now() + 700;
      this.resumeRecognitionAfterPlayback();
    }
  }

  private resolveFallbackWakeWord(transcript: string): string {
    const match = this.matchWakeWord(transcript);
    if (match?.wakeWord) {
      return match.wakeWord;
    }

    const normalized = this.normalizeWakeWord(transcript);
    if (/\banna\b/.test(normalized)) {
      return "anna";
    }
    if (/\bhenry\b/.test(normalized)) {
      return "henry";
    }
    if (/\bhome brain\b/.test(normalized)) {
      return "home brain";
    }
    if (/\bcomputer\b/.test(normalized)) {
      return "computer";
    }

    if (typeof this.status.pendingWakeWord === "string" && this.status.pendingWakeWord.trim()) {
      return this.status.pendingWakeWord.trim();
    }

    // Prefer Anna as the default browser fallback voice persona when no wake-word can be recovered.
    if (this.wakeWords.includes("anna")) {
      return "anna";
    }
    if (this.wakeWords.includes("hey anna")) {
      return "hey anna";
    }
    if (this.wakeWords.includes("henry")) {
      return "henry";
    }
    if (this.wakeWords.includes("hey henry")) {
      return "hey henry";
    }

    return "browser-fallback";
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

    if (this.isProcessing) {
      this.pendingResumeAfterProcessing = true;
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

  private refreshWaitForCommandTimeout(reason?: string): void {
    if (!this.awaitingCommand) {
      return;
    }

    this.clearWaitForCommandTimer();
    this.waitForCommandTimer = setTimeout(() => {
      this.awaitingCommand = false;
      this.updateStatus({
        mode: this.status.enabled ? "listening" : "off",
        pendingWakeWord: null
      }, "command wait timeout");
    }, WAIT_FOR_COMMAND_TIMEOUT_MS);

    if (reason) {
      this.updateStatus({}, `command wait timeout refreshed (${reason})`);
    }
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
