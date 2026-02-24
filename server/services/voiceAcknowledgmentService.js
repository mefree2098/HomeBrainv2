const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const UserProfile = require('../models/UserProfile');
const elevenLabsService = require('./elevenLabsService');

const ACK_ROOT = path.join(__dirname, '..', 'data', 'voice-acknowledgments');
const MANIFEST_VERSION = 1;

class VoiceAcknowledgmentService {
  constructor() {
    this.initialized = false;
    this.lookup = new Map();
    this.generationInFlight = new Set();
  }

  async initialize() {
    if (this.initialized) {
      return;
    }
    await fsp.mkdir(ACK_ROOT, { recursive: true });
    await this.rebuildLookup();
    this.initialized = true;
  }

  getManifestPath(profileId) {
    return path.join(ACK_ROOT, `${profileId}.json`);
  }

  getAudioPath(fileName) {
    return path.join(ACK_ROOT, fileName);
  }

  buildTemplates(profile) {
    const characterName = (profile?.name || 'Assistant').toString().trim() || 'Assistant';
    const lines = [
      `${characterName} here.`,
      `I heard you.`,
      `On it.`,
      `One moment.`,
      `Working on that now.`,
      `Right away.`,
      `Checking now.`
    ];

    return Array.from(
      new Set(
        lines
          .map((line) => line.trim())
          .filter(Boolean)
      )
    );
  }

  normalizeLookupKey(voiceId, text) {
    return `${(voiceId || '').toString().trim().toLowerCase()}::${(text || '').toString().trim().toLowerCase()}`;
  }

  makeAudioFileName(profileId, voiceId, text) {
    const hash = crypto
      .createHash('sha1')
      .update(`${profileId}|${voiceId}|${text}`)
      .digest('hex')
      .slice(0, 16);
    return `${profileId}-${hash}.mp3`;
  }

  async readManifest(profileId) {
    const filePath = this.getManifestPath(profileId);
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  }

  async writeManifest(manifest) {
    const filePath = this.getManifestPath(manifest.profileId);
    await fsp.writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  async rebuildLookup() {
    this.lookup.clear();

    const files = await fsp.readdir(ACK_ROOT).catch(() => []);
    const manifestFiles = files.filter((name) => name.endsWith('.json'));

    for (const manifestFile of manifestFiles) {
      const manifestPath = path.join(ACK_ROOT, manifestFile);
      let manifest;
      try {
        const raw = await fsp.readFile(manifestPath, 'utf8');
        manifest = JSON.parse(raw);
      } catch (error) {
        continue;
      }

      const voiceId = manifest?.voiceId;
      const entries = Array.isArray(manifest?.entries) ? manifest.entries : [];
      if (!voiceId) {
        continue;
      }

      for (const entry of entries) {
        if (!entry?.fileName || !entry?.text || entry.error) {
          continue;
        }
        const filePath = this.getAudioPath(entry.fileName);
        try {
          await fsp.access(filePath, fs.constants.R_OK);
          this.lookup.set(this.normalizeLookupKey(voiceId, entry.text), filePath);
        } catch (error) {
          // Ignore missing files; the next generation pass will repair.
        }
      }
    }
  }

  async generateForProfile(profile, options = {}) {
    await this.initialize();

    const profileId = profile?._id?.toString();
    const voiceId = profile?.voiceId?.toString()?.trim();

    if (!profileId || !voiceId) {
      return null;
    }

    const templates = this.buildTemplates(profile);
    if (templates.length === 0) {
      return null;
    }

    const existing = await this.readManifest(profileId).catch(() => null);
    const existingByText = new Map(
      (Array.isArray(existing?.entries) ? existing.entries : [])
        .filter((entry) => entry?.text)
        .map((entry) => [entry.text, entry])
    );

    const entries = [];
    const force = options.force === true;

    for (const text of templates) {
      const existingEntry = existingByText.get(text);
      const fileName = existingEntry?.fileName
        || this.makeAudioFileName(profileId, voiceId, text);
      const filePath = this.getAudioPath(fileName);

      if (
        !force
        && existingEntry
        && !existingEntry.error
        && existing?.voiceId === voiceId
      ) {
        const exists = await fsp.access(filePath, fs.constants.R_OK)
          .then(() => true)
          .catch(() => false);
        if (exists) {
          entries.push({
            text,
            fileName,
            generatedAt: existingEntry.generatedAt || new Date().toISOString()
          });
          continue;
        }
      }

      try {
        const audioBuffer = await elevenLabsService.textToSpeech(text, voiceId);
        await fsp.writeFile(filePath, audioBuffer);
        entries.push({
          text,
          fileName,
          generatedAt: new Date().toISOString()
        });
      } catch (error) {
        entries.push({
          text,
          fileName: null,
          generatedAt: new Date().toISOString(),
          error: error.message || 'Failed to generate'
        });
      }
    }

    const manifest = {
      version: MANIFEST_VERSION,
      profileId,
      profileName: profile.name || '',
      voiceId,
      generatedAt: new Date().toISOString(),
      entries
    };

    await this.writeManifest(manifest);
    await this.rebuildLookup();
    return manifest;
  }

  async queueAcknowledgmentGeneration(profile, options = {}) {
    await this.initialize();

    const profileId = profile?._id?.toString();
    if (!profileId || this.generationInFlight.has(profileId)) {
      return;
    }

    this.generationInFlight.add(profileId);
    void this.generateForProfile(profile, options)
      .catch((error) => {
        console.warn(`Failed to generate acknowledgments for profile ${profileId}:`, error.message);
      })
      .finally(() => {
        this.generationInFlight.delete(profileId);
      });
  }

  async removeForProfile(profileId) {
    await this.initialize();
    if (!profileId) return;

    const id = profileId.toString();
    const manifest = await this.readManifest(id).catch(() => null);
    if (manifest?.entries) {
      for (const entry of manifest.entries) {
        if (!entry?.fileName) continue;
        await fsp.rm(this.getAudioPath(entry.fileName), { force: true }).catch(() => {});
      }
    }

    await fsp.rm(this.getManifestPath(id), { force: true }).catch(() => {});
    await this.rebuildLookup();
  }

  async findCachedAudio(voiceId, text) {
    await this.initialize();
    if (!voiceId || !text) {
      return null;
    }
    const key = this.normalizeLookupKey(voiceId, text);
    const filePath = this.lookup.get(key);
    if (!filePath) {
      return null;
    }

    const exists = await fsp.access(filePath, fs.constants.R_OK)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      this.lookup.delete(key);
      return null;
    }

    return filePath;
  }

  async resolveProfileForWakeWord(wakeWord) {
    const phrase = (wakeWord || '').toString().trim();
    if (!phrase) {
      return null;
    }

    const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const normalized = phrase.toLowerCase();
    const candidates = new Set([normalized]);
    if (!normalized.startsWith('hey ')) {
      candidates.add(`hey ${normalized}`);
    }

    const patterns = [...candidates].map((candidate) => new RegExp(`^${escapeRegex(candidate)}$`, 'i'));
    return UserProfile.findOne({
      active: true,
      wakeWords: { $in: patterns }
    })
      .select('_id name voiceId wakeWords')
      .sort({ lastUsed: -1, usageCount: -1, name: 1 });
  }

  async getRandomAcknowledgment(wakeWord, fallbackVoiceId = 'default') {
    await this.initialize();

    let profile = null;
    try {
      profile = await this.resolveProfileForWakeWord(wakeWord);
    } catch (error) {
      console.warn('Failed to resolve wake word profile for acknowledgments:', error.message);
    }

    if (!profile) {
      const generic = ['I heard you.', 'On it.', 'Working on that now.', 'One moment.'];
      return {
        text: generic[Math.floor(Math.random() * generic.length)],
        voiceId: fallbackVoiceId || 'default',
        profileId: null
      };
    }

    const templates = this.buildTemplates(profile);
    const manifest = await this.readManifest(profile._id.toString()).catch(() => null);
    const generatedLines = Array.isArray(manifest?.entries)
      ? manifest.entries.filter((entry) => entry?.text && !entry?.error).map((entry) => entry.text)
      : [];
    const options = generatedLines.length > 0 ? generatedLines : templates;
    const text = options[Math.floor(Math.random() * options.length)] || templates[0] || 'On it.';

    await this.queueAcknowledgmentGeneration(profile);

    return {
      text,
      voiceId: profile.voiceId || fallbackVoiceId || 'default',
      profileId: profile._id.toString()
    };
  }

  async primeAllProfiles(limit = 25) {
    await this.initialize();
    const profiles = await UserProfile.find({ active: true })
      .select('_id name voiceId wakeWords')
      .sort({ updatedAt: -1 })
      .limit(limit);

    for (const profile of profiles) {
      await this.queueAcknowledgmentGeneration(profile);
    }
  }
}

module.exports = new VoiceAcknowledgmentService();
