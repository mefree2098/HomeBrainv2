const EventEmitter = require('events');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const piperVoiceService = require('./piperVoiceService');
const WakeWordModel = require('../models/WakeWordModel');
const UserProfile = require('../models/UserProfile');
const VoiceDevice = require('../models/VoiceDevice');
const { slugify, WAKE_WORD_ROOT } = require('../utils/wakeWordAssets');

const SERVER_ROOT = path.join(__dirname, '..');
const TMP_ROOT = path.join(SERVER_ROOT, '..', 'tmp', 'wake-word-training');
const DATA_ROOT = path.join(SERVER_ROOT, 'data', 'wake-word');
const DEFAULT_BACKGROUND_DIR = path.join(DATA_ROOT, 'backgrounds');
const DEFAULT_PROFILE_DIR = path.join(DATA_ROOT, 'profiles');

const DEFAULT_OPTIONS = {
  dataset: {
    clipDurationSeconds: 1.5,
    trainSplit: 0.85,
    augmentCopies: 2,
    positive: {
      syntheticSamples: 400,
      userRecordings: [],
      textVariations: [],
      tts: {
        executable: process.env.WAKEWORD_PIPER_EXEC || undefined,
        voices: []
      }
    },
    negative: {
      backgroundDirs: [],
      syntheticSpeech: {
        samples: 150,
        phrases: []
      },
      randomSilence: 200
    }
  },
  training: {
    epochs: 6,
    batchSize: 128,
    learningRate: 1e-4,
    targetFalseActivationsPerHour: 0.2
  },
  export: {
    onnx: true,
    tflite: true
  }
};

const STATUS_FOR_STAGE = {
  generating: 'generating',
  training: 'training',
  exporting: 'exporting',
  error: 'error'
};

const DEFAULT_PYTHON = process.env.PYTHON_EXECUTABLE
  || process.env.WAKEWORD_TRAINING_PYTHON
  || (process.platform === 'win32'
    ? path.join(SERVER_ROOT, '.wakeword-venv', 'Scripts', 'python.exe')
    : path.join(SERVER_ROOT, '.wakeword-venv', 'bin', 'python'));

class WakeWordTrainingService extends EventEmitter {
  constructor() {
    super();
    this.queue = Promise.resolve();
    this.pendingSlugs = new Set();
    this.trainingOptions = new Map();
    this.activeJobs = new Map();
    this.voiceWebSocket = null;
    this.pythonExecutable = DEFAULT_PYTHON;
    this.trainerScript = path.join(SERVER_ROOT, 'scripts', 'train_wake_word.py');
    this.defaultFormat = 'tflite';
    this.ensureDirectories().catch((error) => {
      console.error('Failed to prepare wake word directories:', error);
    });
    console.log(`[wakeword] Training service using Python executable: ${this.pythonExecutable}`);
  }

  async ensureDirectories() {
    await fsp.mkdir(WAKE_WORD_ROOT, { recursive: true });
    await fsp.mkdir(TMP_ROOT, { recursive: true });
    await fsp.mkdir(DEFAULT_BACKGROUND_DIR, { recursive: true });
    await fsp.mkdir(DEFAULT_PROFILE_DIR, { recursive: true });
  }

  setVoiceWebSocket(voiceWebSocket) {
    this.voiceWebSocket = voiceWebSocket;
  }

  async syncProfileWakeWords(profile) {
    if (!profile) return [];

    const profileId = profile._id?.toString();
    if (!profileId) {
      console.warn('syncProfileWakeWords called without a valid profile identifier');
      return [];
    }

    const wakeWords = Array.isArray(profile.wakeWords) ? profile.wakeWords : [];
    const uniquePhrases = [...new Set(wakeWords.map((phrase) => (phrase || '').trim()).filter(Boolean))];
    const slugs = uniquePhrases.map((phrase) => slugify(phrase));
    const modelIds = [];

    for (let index = 0; index < uniquePhrases.length; index += 1) {
      const phrase = uniquePhrases[index];
      const slug = slugs[index];
      if (!slug) continue;

      let model = await WakeWordModel.findOne({ slug });
      if (!model) {
        model = new WakeWordModel({
          phrase,
          slug,
          status: 'pending',
          engine: 'openwakeword',
          format: this.defaultFormat,
          profiles: [profileId]
        });
      } else {
        let dirty = false;
        if (model.phrase !== phrase) {
          model.phrase = phrase;
          dirty = true;
        }
        if (!model.profiles.some((id) => id.toString() === profileId)) {
          model.profiles.push(profileId);
          dirty = true;
        }
        if (model.status === 'ready') {
          const exists = model.modelPath && fs.existsSync(model.modelPath);
          if (!exists) {
            model.status = 'pending';
            model.modelPath = undefined;
            model.checksum = undefined;
            dirty = true;
          }
        }
        if (dirty) {
          model.updatedAt = Date.now();
        }
      }

      await model.save();
      modelIds.push(model._id);

      if (model.status !== 'ready') {
        this.enqueueTraining(model.slug);
      }
    }

    await UserProfile.findByIdAndUpdate(profileId, {
      wakeWordModels: modelIds
    });

    await WakeWordModel.updateMany(
      { profiles: profileId, slug: { $nin: slugs } },
      { $pull: { profiles: profileId } }
    );

    return modelIds;
  }

  async requestTraining({ phrase, slug, options = {}, profiles = [] }) {
    const normalisedPhrase = (phrase || '').trim();
    const resolvedSlug = slug || slugify(normalisedPhrase);
    if (!normalisedPhrase || !resolvedSlug) {
      throw new Error('Wake word phrase is required');
    }

    let model = await WakeWordModel.findOne({ slug: resolvedSlug });
    if (!model) {
      model = new WakeWordModel({
        phrase: normalisedPhrase,
        slug: resolvedSlug,
        status: 'pending',
        engine: 'openwakeword',
        format: this.defaultFormat,
        profiles
      });
    } else {
      model.phrase = normalisedPhrase;
      if (Array.isArray(profiles) && profiles.length) {
        const mergedProfiles = new Set([...model.profiles.map((id) => id.toString()), ...profiles.map(String)]);
        model.profiles = Array.from(mergedProfiles);
      }
    }

    model.metadata = model.metadata || {};
    model.metadata.pendingOptions = options || {};
    model.status = (model.status === 'ready' && model.modelPath && fs.existsSync(model.modelPath))
      ? 'ready'
      : 'pending';
    model.progress = model.status === 'ready' ? 1 : 0;
    model.statusMessage = 'Queued for training';
    model.updatedAt = Date.now();

    await model.save();

    await this.enqueueTraining(resolvedSlug, { options });

    return model;
  }

  async enqueueTraining(slug, { options = {} } = {}) {
    if (!slug) return;

    this.trainingOptions.set(slug, this.mergeOptions(options));

    if (this.pendingSlugs.has(slug)) {
      const job = this.activeJobs.get(slug);
      if (job) {
        job.options = this.trainingOptions.get(slug);
      }
      return;
    }

    await this.updateModelStatus(slug, {
      status: 'queued',
      progress: 0.01,
      message: 'Waiting for training slot'
    });
    console.log(`[wakeword] Enqueued training for ${slug}`);

    this.pendingSlugs.add(slug);
    this.queue = this.queue
      .then(() => this.executeTraining(slug))
      .catch((error) => {
        console.error(`Wake word training queue error for ${slug}:`, error);
      })
      .finally(() => {
        this.pendingSlugs.delete(slug);
        this.trainingOptions.delete(slug);
        this.activeJobs.delete(slug);
      });
  }

  async executeTraining(slug) {
    const model = await WakeWordModel.findOne({ slug });
    if (!model) {
      console.warn(`No wake word model found for slug ${slug}; skipping training`);
      return;
    }

    if (model.status === 'ready' && model.modelPath && fs.existsSync(model.modelPath)) {
      return;
    }

    await this.updateModelStatus(slug, {
      status: 'generating',
      progress: 0.05,
      message: 'Preparing training job',
      data: { piper: null }
    });

    const baseOptions = this.trainingOptions.get(slug) || this.mergeOptions({});
    const options = await this.enrichOptionsWithVoices(baseOptions);
    try {
      const positiveVoices = options?.dataset?.positive?.tts?.voices || [];
      const negativeVoices = options?.dataset?.negative?.syntheticSpeech?.voices || [];
      const piperExecLog = (
        options?.dataset?.positive?.tts?.executable
        || options?.dataset?.negative?.syntheticSpeech?.executable
        || '(none)'
      );
      console.log(
        `[wakeword] Training ${slug} using ${positiveVoices.length} positive voices, ${negativeVoices.length} negative voices, piper: ${piperExecLog}`
      );
      if (positiveVoices.length === 0) {
        console.log('[wakeword] Positive voice payload', JSON.stringify(options?.dataset?.positive?.tts || {}, null, 2));
      }
    } catch (debugError) {
      console.warn('[wakeword] Failed to log voice payloads', debugError);
    }
    const job = {
      slug,
      phrase: model.phrase,
      options,
      startedAt: Date.now()
    };
    console.log(`[wakeword] Starting trainer for ${slug}`);
    this.activeJobs.set(slug, job);

    const outputFile = path.join(WAKE_WORD_ROOT, `${slug}.${this.defaultFormat}`);

    try {
      await fsp.mkdir(path.dirname(outputFile), { recursive: true });
      const result = await this.runTrainer({
        slug,
        phrase: model.phrase,
        outputFile,
        options
      });

      if (!result.success) {
        await this.updateModelStatus(slug, {
          status: 'error',
          progress: 0,
          message: result.error || 'Training failed'
        });
        model.status = 'error';
        model.error = result.error || 'Training failed';
        await model.save();
        console.error(`Wake word training failed for ${slug}: ${model.error}`);
        return;
      }

      await this.applyTrainingResult(model, result);
      await this.notifyDevices(model);
    } catch (error) {
      console.error(`Error during wake word training for ${slug}:`, error);
      await this.updateModelStatus(slug, {
        status: 'error',
        progress: 0,
        message: error.message
      });
      model.status = 'error';
      model.error = error.message;
      await model.save();
    }
  }

  mergeOptions(options) {
    const merged = JSON.parse(JSON.stringify(DEFAULT_OPTIONS));

    const recursiveMerge = (target, source) => {
      const output = target;
      Object.entries(source || {}).forEach(([key, value]) => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          output[key] = recursiveMerge(output[key] || {}, value);
        } else {
          output[key] = value;
        }
      });
      return output;
    };

    const result = recursiveMerge(merged, options || {});

    const envBackgrounds = (process.env.WAKEWORD_BACKGROUND_DIRS || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);

    const defaultBackgrounds = [DEFAULT_BACKGROUND_DIR];
    const backgroundDirs = new Set([
      ...defaultBackgrounds,
      ...envBackgrounds,
      ...(result.dataset.negative.backgroundDirs || [])
    ].filter(Boolean));

    result.dataset.negative.backgroundDirs = Array.from(backgroundDirs);

    return result;
  }

  async enrichOptionsWithVoices(rawOptions) {
    const options = JSON.parse(JSON.stringify(rawOptions || {}));
    options.dataset = options.dataset || {};
    options.dataset.positive = options.dataset.positive || {};
    options.dataset.positive.tts = options.dataset.positive.tts || {};

    // Ensure Piper executable path is populated if available
    const resolvePiperExec = () => {
      const envPath = process.env.WAKEWORD_PIPER_EXEC;
      if (envPath && fs.existsSync(envPath)) return envPath;
      try {
        const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['piper'], { encoding: 'utf8' });
        if (which.status === 0) {
          const out = (which.stdout || '').split(/\r?\n/).find((line) => line.trim());
          if (out && fs.existsSync(out.trim())) return out.trim();
        }
      } catch (_) {}
      const candidates = process.platform === 'win32'
        ? [
            path.join(__dirname, '..', '.wakeword-venv', 'Scripts', 'piper.exe'),
            'C:/Program Files/piper/piper.exe',
            'C:/Program Files (x86)/piper/piper.exe'
          ]
        : [
            path.join(__dirname, '..', '.wakeword-venv', 'bin', 'piper'),
            path.join(__dirname, '..', 'server', '.wakeword-venv', 'bin', 'piper'),
            path.join(__dirname, '.wakeword-venv', 'bin', 'piper'),
            '/usr/bin/piper',
            '/usr/local/bin/piper',
            '/bin/piper'
          ];
      for (const cand of candidates) {
        try { if (fs.existsSync(cand)) return cand; } catch (_) {}
      }
      return null;
    };

    const piperExec = options.dataset?.positive?.tts?.executable || resolvePiperExec();
    if (piperExec) {
      let absExec = piperExec;
      if (!path.isAbsolute(absExec)) {
        // If it starts with ./server, resolve from project root; otherwise from SERVER_ROOT
        const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..');
        absExec = absExec.startsWith('./server') ? path.resolve(PROJECT_ROOT, absExec) : path.resolve(SERVER_ROOT, absExec);
      }
      options.dataset.positive.tts.executable = absExec;
    }

    const requestedVoices = Array.isArray(options.dataset.positive.tts.voices)
      ? options.dataset.positive.tts.voices
      : [];
    const normaliseSpeakerId = (value) => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
      return null;
    };

    const resolveVoice = (voice) => {
      const modelPath = voice.modelPath ? path.resolve(String(voice.modelPath)) : null;
      const configPath = voice.configPath ? path.resolve(String(voice.configPath)) : null;
      const hasExistingPaths =
        modelPath &&
        configPath &&
        fs.existsSync(modelPath) &&
        fs.existsSync(configPath);

      if (hasExistingPaths) {
        return {
          ...voice,
          modelPath,
          configPath,
          speakerId: normaliseSpeakerId(voice.speakerId)
        };
      }

      const fallback = installedMap.get(voice.id);
      if (!fallback) {
        return null;
      }
      return {
        ...fallback,
        ...voice,
        modelPath: fallback.modelPath,
        configPath: fallback.configPath,
        speakerId: normaliseSpeakerId(fallback.speakerId) ?? normaliseSpeakerId(voice.speakerId)
      };
    };

    const installedVoices = await piperVoiceService.getInstalledVoicesForTraining();
    const installedMap = new Map(installedVoices.map((voice) => [voice.id, voice]));

    // Prefer requested voices if provided and resolvable; otherwise, fall back to all installed voices
    let hydratedPositive = [];
    if (requestedVoices.length > 0) {
      hydratedPositive = requestedVoices.map(resolveVoice).filter(Boolean);
    }

    if (hydratedPositive.length > 0) {
      options.dataset.positive.tts.voices = hydratedPositive;
    } else if (installedVoices.length > 0) {
      options.dataset.positive.tts.voices = installedVoices.map((voice) => ({
        id: voice.id,
        name: voice.name,
        language: voice.language,
        speaker: voice.speaker,
        speakerId: typeof voice.speakerId === 'number' ? voice.speakerId : null,
        quality: voice.quality,
        modelPath: voice.modelPath,
        configPath: voice.configPath
      }));
    } else {
      delete options.dataset.positive.tts.voices;
    }

    options.dataset.negative = options.dataset.negative || {};
    options.dataset.negative.syntheticSpeech = options.dataset.negative.syntheticSpeech || {};
    if (!options.dataset.negative.syntheticSpeech.executable) {
      const negPiperExec = resolvePiperExec();
      if (negPiperExec) {
        let absNeg = negPiperExec;
        if (!path.isAbsolute(absNeg)) {
          const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..');
          absNeg = absNeg.startsWith('./server') ? path.resolve(PROJECT_ROOT, absNeg) : path.resolve(SERVER_ROOT, absNeg);
        }
        options.dataset.negative.syntheticSpeech.executable = absNeg;
      }
    } else if (options.dataset.negative.syntheticSpeech.executable) {
      const cur = options.dataset.negative.syntheticSpeech.executable;
      options.dataset.negative.syntheticSpeech.executable = path.isAbsolute(cur) ? cur : path.resolve(SERVER_ROOT, cur);
    }
    const requestedNegativeVoices = Array.isArray(options.dataset.negative.syntheticSpeech.voices)
      ? options.dataset.negative.syntheticSpeech.voices
      : [];

    let hydratedNegative = [];
    if (requestedNegativeVoices.length > 0) {
      hydratedNegative = requestedNegativeVoices.map(resolveVoice).filter(Boolean);
    }

    if (hydratedNegative.length > 0) {
      options.dataset.negative.syntheticSpeech.voices = hydratedNegative;
    } else if (installedVoices.length > 0) {
      options.dataset.negative.syntheticSpeech.voices = installedVoices.map((voice) => ({
        id: voice.id,
        name: voice.name,
        language: voice.language,
        speaker: voice.speaker,
        speakerId: typeof voice.speakerId === 'number' ? voice.speakerId : null,
        quality: voice.quality,
        modelPath: voice.modelPath,
        configPath: voice.configPath
      }));
    } else {
      delete options.dataset.negative.syntheticSpeech.voices;
    }

    return options;
  }

  async runTrainer({ slug, phrase, outputFile, options }) {
    if (!fs.existsSync(this.trainerScript)) {
      return {
        success: false,
        error: `Trainer script not found at ${this.trainerScript}`
      };
    }

    const tempDir = await fsp.mkdtemp(path.join(TMP_ROOT, `${slug}-`));
    const configPath = path.join(tempDir, 'config.json');
    const trainerArgs = [
      this.trainerScript,
      '--wake-word',
      phrase,
      '--slug',
      slug,
      '--output',
      outputFile,
      '--config',
      configPath
    ];

    if (options?.dataset?.positive?.tts?.voices?.length === 0) {
      delete options.dataset.positive.tts.voices;
    }

    await fsp.writeFile(configPath, JSON.stringify(options || {}, null, 2), 'utf8');

    console.log(`[wakeword] Trainer config written for ${slug}: ${configPath}`);

    // Compute Piper path to expose to the trainer via env as fallback
    const getPiperFromOptions = () =>
      options?.dataset?.positive?.tts?.executable
      || options?.dataset?.negative?.syntheticSpeech?.executable
      || null;

    let resolvedPiper = getPiperFromOptions() || (function() {
      try {
        const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['piper'], { encoding: 'utf8' });
        if (which.status === 0) {
          const out = (which.stdout || '').split(/\r?\n/).find((line) => line.trim());
          if (out && fs.existsSync(out.trim())) return out.trim();
        }
      } catch (_) {}
      return null;
    })();
    if (resolvedPiper && !path.isAbsolute(resolvedPiper)) {
      resolvedPiper = path.resolve(resolvedPiper);
    }

    return new Promise((resolve) => {
      const baseEnv = { ...process.env, ...(resolvedPiper ? { WAKEWORD_PIPER_EXEC: resolvedPiper } : {}) };
      // Ensure CUDA libs are discoverable on Jetson/Linux
      if (process.platform !== 'win32') {
        const jetsonLib = '/usr/lib/aarch64-linux-gnu';
        baseEnv.LD_LIBRARY_PATH = baseEnv.LD_LIBRARY_PATH
          ? `${baseEnv.LD_LIBRARY_PATH}:${jetsonLib}`
          : jetsonLib;
      }
      const child = spawn(this.pythonExecutable, trainerArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: baseEnv
      });

      console.log(`[wakeword] Spawned trainer PID ${child.pid} for ${slug} using python ${this.pythonExecutable} (piper=${resolvedPiper || '(none)'})`);

      let stdoutBuffer = '';
      let stderrBuffer = '';
      let finalResult = null;

      const flushBuffer = () => {
        let newlineIndex;
        while ((newlineIndex = stdoutBuffer.indexOf('\n')) >= 0) {
          const line = stdoutBuffer.slice(0, newlineIndex).trim();
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          if (!line) continue;
          try {
            const payload = JSON.parse(line);
            if (payload.type === 'progress') {
              this.handleTrainerProgress(slug, payload);
            } else if (payload.type === 'result') {
              finalResult = payload;
            }
          } catch (error) {
            // Ignore non-JSON lines, but keep a record in stderr buffer
            stderrBuffer += `${line}\n`;
          }
        }
      };

      child.stdout.on('data', (data) => {
        stdoutBuffer += data.toString();
        flushBuffer();
      });

      child.stderr.on('data', (data) => {
        stderrBuffer += data.toString();
      });

      child.on('close', (code) => {
        flushBuffer();
        console.log(`[wakeword] Trainer PID ${child.pid} for ${slug} exited with code ${code}`);
        if (finalResult && finalResult.type === 'result') {
          resolve({ success: true, ...finalResult });
        } else if (code === 0) {
          resolve({ success: false, error: stderrBuffer.trim() || 'Trainer did not return result payload' });
        } else {
          resolve({
            success: false,
            error: stderrBuffer.trim() || `Trainer exited with code ${code}`
          });
        }
        fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      });

      child.on('error', (error) => {
        resolve({
          success: false,
          error: error.message
        });
        fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      });
    });
  }

  async handleTrainerProgress(slug, payload) {
    const status = STATUS_FOR_STAGE[payload.stage] || 'training';
    const progressValue = typeof payload.progress === 'number'
      ? Math.max(0, Math.min(1, payload.progress))
      : null;
    const message = payload.message || '';
    await this.updateModelStatus(slug, {
      status,
      progress: progressValue,
      message,
      data: payload.data || null
    });
  }

  async updateModelStatus(slug, { status, progress, message, data = null }) {
    // Build update document. Use dot-notation to merge metadata fields without clobbering the whole object.
    const update = {};
    if (status) update.status = status;
    if (typeof progress === 'number') update.progress = Math.max(0, Math.min(1, progress));
    if (message) update.statusMessage = message;
    update.updatedAt = Date.now();

    if (data && typeof data === 'object') {
      // Persist Piper device info reported by the trainer so the UI can render it during generation.
      if (data.piper && typeof data.piper === 'object') {
        update['metadata.piper'] = data.piper;
      }
    }

    const model = await WakeWordModel.findOneAndUpdate({ slug }, update, { returnDocument: 'after' });
    if (model) {
      this.emit('status', {
        slug,
        status: model.status,
        progress: model.progress,
        message: model.statusMessage
      });
    }
    return model;
  }

  async applyTrainingResult(model, result) {
    const outputPath = result.metadata?.artifacts?.find((artifact) => artifact.format === 'tflite')
      || result.metadata?.artifacts?.find((artifact) => artifact.format === 'onnx')
      || null;

    const checksum = outputPath?.checksum || null;
    const modelPath = outputPath?.path || result.output;
    const format = outputPath?.format || result.format || this.defaultFormat;

    model.status = 'ready';
    model.progress = 1;
    model.statusMessage = 'Training complete';
    model.modelPath = modelPath;
    model.checksum = checksum;
    model.engine = result.engine || 'openwakeword';
    model.format = format;
    model.trainingMetadata = {
      samplesGenerated: result.samplesGenerated || null,
      durationMs: result.durationMs || null,
      generator: 'openwakeword-trainer'
    };
    model.metadata = result.metadata || {};
    model.error = undefined;
    model.lastTrainedAt = new Date();
    await model.save();

    await VoiceDevice.updateMany(
      { wakeWordSupport: true },
      { $addToSet: { supportedWakeWords: model.phrase } }
    );
  }

  async notifyDevices(model) {
    if (!this.voiceWebSocket || typeof this.voiceWebSocket.broadcastWakeWordUpdate !== 'function') {
      return;
    }
    try {
      await this.voiceWebSocket.broadcastWakeWordUpdate(model);
    } catch (error) {
      console.error('Failed to broadcast wake word update to devices:', error);
    }
  }

  async resumePendingTraining() {
    const models = await WakeWordModel.find({});
    for (const model of models) {
      if (model.status === 'ready') {
        const exists = model.modelPath && fs.existsSync(model.modelPath);
        if (!exists) {
          model.status = 'pending';
          model.modelPath = undefined;
          model.checksum = undefined;
          model.progress = 0;
          await model.save();
          this.enqueueTraining(model.slug);
        }
      } else if (model.status === 'pending' || model.status === 'error' || model.status === 'queued') {
        this.enqueueTraining(model.slug);
      }
    }
  }

  async unregisterProfile(profileId) {
    if (!profileId) return;
    await WakeWordModel.updateMany(
      { profiles: profileId },
      { $pull: { profiles: profileId } }
    );
  }

  async getQueueStatus() {
    const active = Array.from(this.activeJobs.values()).map((job) => ({
      slug: job.slug,
      phrase: job.phrase,
      startedAt: job.startedAt
    }));
    const pending = Array.from(this.pendingSlugs).filter((slug) => !this.activeJobs.has(slug));
    return { active, pending };
  }
}

module.exports = new WakeWordTrainingService();
