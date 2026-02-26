import { interpretVoiceCommand } from "@/api/voice";
import { getUserProfiles } from "@/api/profiles";
import { textToSpeechElevenLabs, playAudioBlob } from "@/api/elevenLabs";
import { getSettings } from "@/api/settings";

const DEFAULT_WAKE_WORDS = ["anna", "hey anna", "henry", "hey henry", "home brain", "computer"];
const WAIT_FOR_COMMAND_TIMEOUT_MS = 8000;

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

export interface BrowserVoiceStatus {
  supported: boolean;
  enabled: boolean;
  mode: BrowserVoiceMode;
  pendingWakeWord: string | null;
  lastWakeWord: string | null;
  lastTranscript: string | null;
  lastCommand: string | null;
  lastResponse: string | null;
  error: string | null;
}

type BrowserVoiceSubscriber = (status: BrowserVoiceStatus) => void;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

class BrowserVoiceAssistant {
  private static instance: BrowserVoiceAssistant;

  private subscribers = new Map<string, BrowserVoiceSubscriber>();
  private recognition: BrowserSpeechRecognition | null = null;
  private waitForCommandTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private isStopping = false;
  private resumeRecognitionAfterStop = false;
  private isProcessing = false;
  private awaitingCommand = false;
  private wakeWords = [...DEFAULT_WAKE_WORDS];
  private voiceProfiles: VoiceProfile[] = [];
  private defaultVoiceId = "";

  private status: BrowserVoiceStatus = {
    supported: false,
    enabled: false,
    mode: "unsupported",
    pendingWakeWord: null,
    lastWakeWord: null,
    lastTranscript: null,
    lastCommand: null,
    lastResponse: null,
    error: null
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
      error: null
    });

    this.isStopping = false;

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
      });
      throw new Error(message);
    }

    return this.status;
  }

  disable(): BrowserVoiceStatus {
    this.isStopping = true;
    this.awaitingCommand = false;
    this.isProcessing = false;
    this.resumeRecognitionAfterStop = false;
    this.clearWaitForCommandTimer();
    this.clearRestartTimer();

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
      pendingWakeWord: null,
      error: null
    });

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

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
    } catch (error) {
      const message = this.mapMicrophoneAccessError(error);
      throw new Error(message);
    }
  }

  private updateStatus(patch: Partial<BrowserVoiceStatus>): void {
    this.status = {
      ...this.status,
      ...patch
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
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      if (!this.status.enabled) {
        return;
      }
      if (this.isProcessing) {
        this.updateStatus({ mode: "processing" });
      } else if (this.awaitingCommand) {
        this.updateStatus({ mode: "waiting_command" });
      } else {
        this.updateStatus({ mode: "listening" });
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
  }

  private startRecognition(): void {
    if (!this.recognition) {
      return;
    }

    try {
      this.recognition.start();
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
            } catch (error) {
              const message = error instanceof Error ? error.message : "Voice listener restart failed.";
              this.updateStatus({
                mode: "error",
                error: message
              });
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
        } catch (error) {
          const message = error instanceof Error ? error.message : "Voice listener restart failed.";
          this.updateStatus({
            mode: "error",
            error: message
          });
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
      // Web Speech network hiccups are common; onend restart logic will recover.
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
      });
      return;
    }

    this.updateStatus({
      mode: "error",
      error: message
    });
  }

  private async handleRecognitionResult(event: BrowserSpeechRecognitionEvent): Promise<void> {
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

      if (!result?.isFinal) {
        continue;
      }

      const confidence = typeof bestAlternative?.confidence === "number"
        ? bestAlternative.confidence
        : null;

      await this.processTranscript(transcript, confidence);
    }
  }

  private async processTranscript(transcript: string, confidence: number | null): Promise<void> {
    if (!this.status.enabled || this.isProcessing) {
      return;
    }

    const wakeMatch = this.matchWakeWord(transcript);

    if (this.awaitingCommand) {
      if (wakeMatch?.commandText) {
        await this.executeCommand(wakeMatch.commandText, wakeMatch.wakeWord, confidence);
        return;
      }

      if (wakeMatch && !wakeMatch.commandText) {
        this.waitForCommand(wakeMatch.wakeWord);
        return;
      }

      await this.executeCommand(transcript, this.status.pendingWakeWord || "browser", confidence);
      return;
    }

    if (!wakeMatch) {
      return;
    }

    if (wakeMatch.commandText) {
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
    });

    this.waitForCommandTimer = setTimeout(() => {
      this.awaitingCommand = false;
      this.updateStatus({
        mode: this.status.enabled ? "listening" : "off",
        pendingWakeWord: null
      });
    }, WAIT_FOR_COMMAND_TIMEOUT_MS);
  }

  private async executeCommand(commandText: string, wakeWord: string, confidence: number | null): Promise<void> {
    const sanitizedCommand = commandText.replace(/^[\s,.:;-]+/, "").trim();
    if (!sanitizedCommand) {
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
    });

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
      });

      if (result?.responseText) {
        await this.playResponse(result.responseText, wakeWord);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to process voice command.";
      this.updateStatus({
        error: message
      });
    } finally {
      this.isProcessing = false;
      this.updateStatus({
        mode: this.status.enabled ? "listening" : "off"
      });
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
    await this.pauseRecognitionForPlayback();

    const voiceId = this.resolveVoiceId(wakeWord);
    try {
      if (voiceId) {
        try {
          const audioBlob = await textToSpeechElevenLabs({
            text,
            voiceId
          });
          await playAudioBlob(audioBlob);
          return;
        } catch (_error) {
          // Fall through to browser speech synthesis when ElevenLabs is unavailable.
        }
      }

      await this.playWithBrowserSpeech(text);
    } finally {
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
    if (!this.status.enabled || !this.recognition) {
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
    if (!this.status.enabled || !this.recognition) {
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
