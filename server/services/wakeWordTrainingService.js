const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const WakeWordModel = require('../models/WakeWordModel');
const UserProfile = require('../models/UserProfile');
const VoiceDevice = require('../models/VoiceDevice');
const { slugify, WAKE_WORD_ROOT } = require('../utils/wakeWordAssets');

class WakeWordTrainingService {
  constructor() {
    this.queue = Promise.resolve();
    this.pendingSlugs = new Set();
    this.voiceWebSocket = null;
    this.pythonExecutable = process.env.PYTHON_EXECUTABLE || process.env.WAKEWORD_TRAINING_PYTHON || 'python3';
    this.trainerScript = path.join(__dirname, '..', 'scripts', 'train_wake_word.py');
    this.defaultFormat = process.env.WAKEWORD_TRAINING_FORMAT || 'tflite';
    this.ensureDirectories().catch((error) => {
      console.error('Failed to prepare wake word directories:', error);
    });
  }

  async ensureDirectories() {
    await fsp.mkdir(WAKE_WORD_ROOT, { recursive: true });
    const tempDir = path.join(WAKE_WORD_ROOT, '..', '..', 'tmp', 'wake-word-training');
    await fsp.mkdir(tempDir, { recursive: true });
  }

  setVoiceWebSocket(voiceWebSocket) {
    this.voiceWebSocket = voiceWebSocket;
  }

  /**
   * Synchronise wake words for a profile, ensuring models exist and training is queued.
   * @param {mongoose.Document|Object} profile
   */
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
      if (!slug) {
        continue;
      }

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
          const fileExists = model.modelPath && fs.existsSync(model.modelPath);
          if (!fileExists) {
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

    // Detach profile from models that no longer reference these wake words
    await WakeWordModel.updateMany(
      { profiles: profileId, slug: { $nin: slugs } },
      { $pull: { profiles: profileId } }
    );

    return modelIds;
  }

  enqueueTraining(slug) {
    if (!slug || this.pendingSlugs.has(slug)) {
      return;
    }

    console.log(`Queueing wake word training for "${slug}"`);
    this.pendingSlugs.add(slug);
    this.queue = this.queue
      .then(() => this.executeTraining(slug))
      .catch((error) => {
        console.error(`Wake word training queue error for ${slug}:`, error);
      })
      .finally(() => {
        this.pendingSlugs.delete(slug);
      });
  }

  async executeTraining(slug) {
    let model = await WakeWordModel.findOne({ slug });
    if (!model) {
      console.warn(`No wake word model found for slug ${slug}; skipping training`);
      return;
    }

    if (model.status === 'ready' && model.modelPath && fs.existsSync(model.modelPath)) {
      return;
    }

    model.status = 'training';
    console.log(`Starting wake word training for "${model.phrase}" (${slug})`);
    model.error = undefined;
    model.updatedAt = Date.now();
    await model.save();

    const outputFile = path.join(WAKE_WORD_ROOT, `${slug}.${this.defaultFormat}`);

    try {
      await fsp.mkdir(path.dirname(outputFile), { recursive: true });

      const result = await this.runTrainer({
        slug,
        phrase: model.phrase,
        outputFile,
        format: this.defaultFormat
      });

      if (!result.success) {
        model.status = 'error';
        model.error = result.error || 'Training failed';
        await model.save();
        console.error(`Wake word training failed for ${slug}: ${model.error}`);
        return;
      }

      const checksum = await this.computeChecksum(outputFile);

      model.status = 'ready';
      model.modelPath = outputFile;
      model.checksum = checksum;
      model.engine = result.engine || 'openwakeword';
      model.format = result.format || this.defaultFormat;
      model.trainingMetadata = {
        samplesGenerated: result.samplesGenerated || null,
        generator: result.generator || result.voice || null,
        durationMs: result.durationMs || result.trainingDurationMs || null
      };
      model.lastTrainedAt = new Date();
      model.error = undefined;
      await model.save();

      console.log(`Wake word model trained for "${model.phrase}" (${model.format})`);

      await VoiceDevice.updateMany(
        { wakeWordSupport: true },
        { $addToSet: { supportedWakeWords: model.phrase } }
      );

      await this.notifyDevices(model);
    } catch (error) {
      console.error(`Error during wake word training for ${slug}:`, error);
      model.status = 'error';
      model.error = error.message;
      await model.save();
    }
  }

  async runTrainer({ slug, phrase, outputFile, format }) {
    if (!fs.existsSync(this.trainerScript)) {
      return {
        success: false,
        error: `Trainer script not found at ${this.trainerScript}`
      };
    }

    const args = [
      this.trainerScript,
      '--wake-word',
      phrase,
      '--slug',
      slug,
      '--output',
      outputFile,
      '--format',
      format
    ];

    if (process.env.WAKEWORD_TRAINING_VOICE) {
      args.push('--tts-voice', process.env.WAKEWORD_TRAINING_VOICE);
    }
    if (process.env.WAKEWORD_TRAINING_LANGUAGE) {
      args.push('--language', process.env.WAKEWORD_TRAINING_LANGUAGE);
    }
    if (process.env.WAKEWORD_TRAINING_SAMPLES) {
      args.push('--samples', process.env.WAKEWORD_TRAINING_SAMPLES);
    }

    return new Promise((resolve) => {
      const child = spawn(this.pythonExecutable, args, {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          let metadata = {};
          const trimmedOutput = stdout.trim();
          if (trimmedOutput) {
            try {
              metadata = JSON.parse(trimmedOutput);
            } catch (parseError) {
              console.warn('Trainer output was not valid JSON; continuing without metadata');
            }
          }

          resolve({
            success: true,
            ...metadata
          });
        } else {
          const errorMessage = stderr.trim() || stdout.trim() || `Trainer exited with code ${code}`;
          resolve({
            success: false,
            error: errorMessage
          });
        }
      });

      child.on('error', (error) => {
        resolve({
          success: false,
          error: error.message
        });
      });
    });
  }

  async computeChecksum(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', (error) => reject(error));
    });
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
          await model.save();
          this.enqueueTraining(model.slug);
        }
      } else if (model.status === 'pending' || model.status === 'error') {
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
}

module.exports = new WakeWordTrainingService();
