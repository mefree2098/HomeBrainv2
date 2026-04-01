const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const AlexaLinkedAccount = require('../models/AlexaLinkedAccount');
const AlexaVoiceUser = require('../models/AlexaVoiceUser');
const Device = require('../models/Device');
const Scene = require('../models/Scene');
const UserProfile = require('../models/UserProfile');
const Workflow = require('../models/Workflow');
const alexaProjectionService = require('./alexaProjectionService');
const elevenLabsService = require('./elevenLabsService');
const sceneService = require('./sceneService');
const userProfileService = require('./userProfileService');
const voiceCommandService = require('./voiceCommandService');
const workflowService = require('./workflowService');
const { getConfiguredPublicOrigin } = require('../utils/publicOrigin');
const {
  ALEXA_CUSTOM_RESPONSE_MODES,
  ALEXA_CUSTOM_SKILL_INTENTS,
  buildLinkAccountResponse,
  buildResponse,
  escapeSsml,
  extractCustomSkillIdentity,
  getSlotSpokenValue,
  normalizeCustomSkillRequest,
  trimString
} = require('../../shared/alexa/customSkill');

const AUDIO_ROOT = path.join(__dirname, '..', 'data', 'alexa-custom-audio');
const MAX_AUDIO_TEXT_LENGTH = Math.max(120, Number(process.env.HOMEBRAIN_ALEXA_CUSTOM_AUDIO_TEXT_LIMIT || 320));
const AUDIO_TTL_SECONDS = Math.max(60, Number(process.env.HOMEBRAIN_ALEXA_CUSTOM_AUDIO_TTL_SECONDS || 900));

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function secureEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function buildExactNameRegex(value) {
  const normalized = trimString(value);
  if (!normalized) {
    return null;
  }
  return new RegExp(`^${escapeRegex(normalized)}$`, 'i');
}

function humanizeIdentifier(value, fallback) {
  const normalized = trimString(value);
  if (!normalized) {
    return fallback;
  }

  const suffix = normalized.slice(-8);
  return `${fallback} ${suffix}`;
}

class AlexaCustomSkillService {
  constructor() {
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) {
      return;
    }

    await fsp.mkdir(AUDIO_ROOT, { recursive: true });
    this.initialized = true;
  }

  getAudioPath(clipId) {
    return path.join(AUDIO_ROOT, `${clipId}.mp3`);
  }

  getSigningSecret() {
    return trimString(process.env.HOMEBRAIN_ALEXA_AUDIO_SIGNING_SECRET)
      || trimString(process.env.JWT_SECRET)
      || 'homebrain-alexa-custom-audio-secret';
  }

  buildAudioToken(clipId, expiresAtMs) {
    const expiresAt = Math.floor(expiresAtMs / 1000);
    const signature = crypto
      .createHmac('sha256', this.getSigningSecret())
      .update(`${clipId}:${expiresAt}`)
      .digest('hex');

    return `${expiresAt}.${signature}`;
  }

  verifyAudioToken(clipId, token) {
    const normalizedToken = trimString(token);
    const separatorIndex = normalizedToken.indexOf('.');
    if (separatorIndex <= 0) {
      return false;
    }

    const expiresAt = Number(normalizedToken.slice(0, separatorIndex));
    const signature = normalizedToken.slice(separatorIndex + 1);
    if (!Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
      return false;
    }

    const expected = this.buildAudioToken(clipId, expiresAt * 1000);
    const expectedSignature = expected.slice(expected.indexOf('.') + 1);
    return secureEqual(signature, expectedSignature);
  }

  buildClipId(profile, text) {
    return crypto
      .createHash('sha1')
      .update(`${profile?._id?.toString?.() || ''}|${trimString(profile?.voiceId)}|${trimString(text)}`)
      .digest('hex')
      .slice(0, 20);
  }

  async ensureAudioClip(profile, text) {
    await this.initialize();

    const publicOrigin = getConfiguredPublicOrigin();
    const normalizedText = trimString(text);
    if (!publicOrigin || !profile?._id || !trimString(profile.voiceId) || !normalizedText) {
      return null;
    }

    if (normalizedText.length > MAX_AUDIO_TEXT_LENGTH) {
      return null;
    }

    const clipId = this.buildClipId(profile, normalizedText);
    const filePath = this.getAudioPath(clipId);
    const exists = await fsp.access(filePath, fs.constants.R_OK)
      .then(() => true)
      .catch(() => false);

    if (!exists) {
      const audioBuffer = await elevenLabsService.textToSpeech(normalizedText, trimString(profile.voiceId));
      await fsp.writeFile(filePath, audioBuffer);
    }

    const expiresAtMs = Date.now() + (AUDIO_TTL_SECONDS * 1000);
    const token = this.buildAudioToken(clipId, expiresAtMs);

    return {
      clipId,
      expiresAt: new Date(expiresAtMs).toISOString(),
      url: `${publicOrigin}/api/alexa/custom/audio/${clipId}?token=${encodeURIComponent(token)}`
    };
  }

  async resolveAudioClip(clipId, token) {
    await this.initialize();

    const normalizedClipId = trimString(clipId);
    if (!normalizedClipId || !this.verifyAudioToken(normalizedClipId, token)) {
      const error = new Error('Alexa audio token is invalid or expired');
      error.status = 401;
      throw error;
    }

    const filePath = this.getAudioPath(normalizedClipId);
    const buffer = await fsp.readFile(filePath).catch(() => null);
    if (!buffer) {
      const error = new Error('Alexa audio clip could not be found');
      error.status = 404;
      throw error;
    }

    return {
      contentType: 'audio/mpeg',
      buffer
    };
  }

  async listVoiceUsers() {
    return AlexaVoiceUser.find()
      .populate('userProfileId', 'name voiceId active alexaPreferences')
      .sort({ lastSeenAt: -1, updatedAt: -1, createdAt: -1 })
      .lean();
  }

  async getStatusSummary() {
    const registration = await alexaProjectionService.ensureBrokerRegistration();
    const [voiceUsers, mappedUsers, activeProfiles] = await Promise.all([
      AlexaVoiceUser.countDocuments({ hubId: registration.hubId }),
      AlexaVoiceUser.countDocuments({ hubId: registration.hubId, status: 'mapped', userProfileId: { $ne: null } }),
      UserProfile.countDocuments({ active: true })
    ]);

    const publicOrigin = registration.publicOrigin || getConfiguredPublicOrigin();
    return {
      enabled: registration.status === 'paired',
      publicOrigin,
      customAudioAvailable: Boolean(publicOrigin && trimString(process.env.JWT_SECRET || process.env.HOMEBRAIN_ALEXA_AUDIO_SIGNING_SECRET)),
      activeProfiles,
      voiceUsers,
      mappedUsers,
      defaultResponseMode: ALEXA_CUSTOM_RESPONSE_MODES.AUTO,
      intents: Object.values(ALEXA_CUSTOM_SKILL_INTENTS)
    };
  }

  buildVoiceUserLabel(identity = {}) {
    if (trimString(identity.alexaPersonId)) {
      return humanizeIdentifier(identity.alexaPersonId, 'Recognized voice');
    }
    if (trimString(identity.alexaUserId)) {
      return humanizeIdentifier(identity.alexaUserId, 'Alexa user');
    }
    return 'Alexa speaker';
  }

  async resolveVoiceUser({ linkedAccount, identity, hubId }) {
    if (!linkedAccount?.brokerAccountId) {
      return null;
    }

    const query = {
      hubId,
      brokerAccountId: linkedAccount.brokerAccountId
    };

    let voiceUser = null;
    if (trimString(identity.alexaPersonId)) {
      voiceUser = await AlexaVoiceUser.findOne({
        ...query,
        alexaPersonId: trimString(identity.alexaPersonId)
      });
    }

    if (!voiceUser && trimString(identity.alexaUserId)) {
      voiceUser = await AlexaVoiceUser.findOne({
        ...query,
        alexaUserId: trimString(identity.alexaUserId)
      });
    }

    if (!voiceUser) {
      voiceUser = new AlexaVoiceUser({
        ...query,
        label: this.buildVoiceUserLabel(identity)
      });
    }

    if (voiceUser.status === 'mapped' && !voiceUser.userProfileId) {
      voiceUser.status = 'unmapped';
    }

    voiceUser.alexaUserId = trimString(identity.alexaUserId);
    voiceUser.alexaPersonId = trimString(identity.alexaPersonId);
    voiceUser.alexaDeviceId = trimString(identity.alexaDeviceId);
    voiceUser.alexaHouseholdId = trimString(linkedAccount.alexaHouseholdId);
    voiceUser.locale = trimString(identity.locale || linkedAccount.locale || voiceUser.locale || 'en-US') || 'en-US';
    voiceUser.lastSeenAt = new Date();
    voiceUser.metadata = {
      ...(voiceUser.metadata || {}),
      lastRequestId: trimString(identity.requestId),
      lastIntentName: trimString(identity.intentName),
      lastRequestType: trimString(identity.requestType)
    };

    await voiceUser.save();

    return AlexaVoiceUser.findById(voiceUser._id)
      .populate('userProfileId', 'name voiceId active alexaPreferences')
      .lean();
  }

  async resolveProfileForVoiceUser(voiceUser) {
    if (voiceUser?.status === 'mapped' && voiceUser?.userProfileId?._id && voiceUser.userProfileId.active !== false) {
      return voiceUser.userProfileId;
    }

    if (voiceUser?.status === 'mapped' && voiceUser?.userProfileId && voiceUser.userProfileId.active === false) {
      return null;
    }

    return UserProfile.findOne({ active: true })
      .sort({ lastUsed: -1, usageCount: -1, name: 1 })
      .lean();
  }

  resolveResponseMode(profile, voiceUser) {
    const voiceUserMode = trimString(voiceUser?.responseMode);
    if (voiceUserMode && voiceUserMode !== ALEXA_CUSTOM_RESPONSE_MODES.INHERIT) {
      return voiceUserMode;
    }

    const profileMode = trimString(profile?.alexaPreferences?.responseMode);
    if (profileMode) {
      return profileMode;
    }

    return ALEXA_CUSTOM_RESPONSE_MODES.AUTO;
  }

  async buildPersonalizedResponse(text, profile, voiceUser, options = {}) {
    const normalizedText = trimString(text) || 'Done.';
    const responseMode = this.resolveResponseMode(profile, voiceUser);
    const shouldEndSession = options.shouldEndSession !== false;
    const repromptText = trimString(options.repromptText);
    const includeFallbackText = profile?.alexaPreferences?.includeAudioFallbackText === true;

    if (responseMode === ALEXA_CUSTOM_RESPONSE_MODES.TEXT) {
      return buildResponse({
        text: normalizedText,
        shouldEndSession,
        repromptText
      });
    }

    if (responseMode === ALEXA_CUSTOM_RESPONSE_MODES.SSML) {
      return buildResponse({
        text: normalizedText,
        ssml: `<speak>${escapeSsml(normalizedText)}</speak>`,
        shouldEndSession,
        repromptText
      });
    }

    if (responseMode === ALEXA_CUSTOM_RESPONSE_MODES.AUDIO || responseMode === ALEXA_CUSTOM_RESPONSE_MODES.AUTO) {
      try {
        const clip = await this.ensureAudioClip(profile, normalizedText);
        if (clip?.url) {
          const fallback = includeFallbackText ? ` ${escapeSsml(normalizedText)}` : '';
          return buildResponse({
            text: normalizedText,
            ssml: `<speak><audio src="${clip.url}" />${fallback}</speak>`,
            shouldEndSession,
            repromptText
          });
        }
      } catch (error) {
        if (responseMode === ALEXA_CUSTOM_RESPONSE_MODES.AUDIO) {
          console.warn(`AlexaCustomSkillService: Falling back to SSML because audio generation failed: ${error.message}`);
        }
      }
    }

    return buildResponse({
      text: normalizedText,
      ssml: `<speak>${escapeSsml(normalizedText)}</speak>`,
      shouldEndSession,
      repromptText
    });
  }

  async handleLaunchRequest(context) {
    const { profile, voiceUser } = context;
    const name = trimString(profile?.name);
    const mapped = voiceUser?.status === 'mapped' && profile;
    const text = mapped
      ? `${name} is ready. You can ask me to run a workflow, activate a scene, or tell you who you are mapped as.`
      : 'HomeBrain is ready. You can ask me to run a workflow, activate a scene, check device status, or ask who you are.';

    return this.buildPersonalizedResponse(text, profile, voiceUser, {
      shouldEndSession: false,
      repromptText: 'Try saying run movie night or who am I.'
    });
  }

  async activateSceneByName(name) {
    const regex = buildExactNameRegex(name);
    if (!regex) {
      throw new Error('A scene name is required');
    }

    const scene = await Scene.findOne({ name: regex }).select('_id name');
    if (!scene) {
      throw new Error(`I could not find a scene named ${name}.`);
    }

    await sceneService.activateScene(scene._id);
    return scene.name;
  }

  async executeWorkflowByName(name) {
    const regex = buildExactNameRegex(name);
    if (!regex) {
      throw new Error('A workflow name is required');
    }

    const workflow = await Workflow.findOne({ name: regex, enabled: true }).select('_id name');
    if (!workflow) {
      throw new Error(`I could not find an enabled workflow named ${name}.`);
    }

    await workflowService.executeWorkflow(workflow._id, {
      triggerType: 'manual',
      triggerSource: 'alexa_custom_skill',
      context: {
        source: 'alexa_custom_skill'
      }
    });

    return workflow.name;
  }

  describeDeviceState(device) {
    const type = trimString(device?.type).toLowerCase();
    const isOn = Boolean(device?.status === true || device?.status === 'on' || device?.status === 'ON');

    if (type === 'light' || type === 'switch') {
      const brightness = Number(device?.brightness);
      if (isOn && Number.isFinite(brightness)) {
        return `${device.name} is on at ${Math.max(0, Math.min(100, Math.round(brightness)))} percent brightness.`;
      }
      return `${device.name} is ${isOn ? 'on' : 'off'}.`;
    }

    if (type === 'thermostat') {
      const current = Number(device?.currentTemperature);
      const target = Number(device?.targetTemperature);
      const segments = [];
      if (Number.isFinite(current)) {
        segments.push(`currently ${Math.round(current)} degrees`);
      }
      if (Number.isFinite(target)) {
        segments.push(`target ${Math.round(target)} degrees`);
      }
      return segments.length > 0
        ? `${device.name} is ${segments.join(', ')}.`
        : `${device.name} is available but does not have a temperature reading right now.`;
    }

    if (type === 'lock') {
      return `${device.name} is ${isOn ? 'locked' : 'unlocked'}.`;
    }

    return `${device.name} is ${isOn ? 'on' : 'off'}.`;
  }

  async getDeviceStatusByName(name) {
    const regex = buildExactNameRegex(name);
    if (!regex) {
      throw new Error('A device name is required');
    }

    const device = await Device.findOne({ name: regex }).lean();
    if (!device) {
      throw new Error(`I could not find a device named ${name}.`);
    }

    return this.describeDeviceState(device);
  }

  async handleIntentRequest(context) {
    const { envelope, identity, profile, voiceUser } = context;
    const intent = envelope?.request?.intent || {};
    const intentName = trimString(identity.intentName);

    if (intentName === 'AMAZON.HelpIntent') {
      return this.buildPersonalizedResponse(
        'You can ask me to run a workflow, activate a scene, check a device status, or ask who you are mapped as.',
        profile,
        voiceUser,
        {
          shouldEndSession: false,
          repromptText: 'Try saying run bedtime workflow.'
        }
      );
    }

    if (intentName === 'AMAZON.CancelIntent' || intentName === 'AMAZON.StopIntent') {
      return this.buildPersonalizedResponse('Okay.', profile, voiceUser);
    }

    if (intentName === ALEXA_CUSTOM_SKILL_INTENTS.WHO_AM_I) {
      if (voiceUser?.status === 'mapped' && profile?.name) {
        return this.buildPersonalizedResponse(`You are mapped to ${profile.name}.`, profile, voiceUser);
      }

      return this.buildPersonalizedResponse(
        'This Alexa voice is not mapped to a HomeBrain profile yet.',
        profile,
        voiceUser
      );
    }

    if (intentName === ALEXA_CUSTOM_SKILL_INTENTS.SCENE) {
      const sceneName = getSlotSpokenValue(intent, 'sceneName') || getSlotSpokenValue(intent, 'scene');
      const activated = await this.activateSceneByName(sceneName);
      return this.buildPersonalizedResponse(`Activated ${activated}.`, profile, voiceUser);
    }

    if (intentName === ALEXA_CUSTOM_SKILL_INTENTS.WORKFLOW) {
      const workflowName = getSlotSpokenValue(intent, 'workflowName') || getSlotSpokenValue(intent, 'workflow');
      const executed = await this.executeWorkflowByName(workflowName);
      return this.buildPersonalizedResponse(`Started workflow ${executed}.`, profile, voiceUser);
    }

    if (intentName === ALEXA_CUSTOM_SKILL_INTENTS.STATUS) {
      const target = getSlotSpokenValue(intent, 'target') || getSlotSpokenValue(intent, 'deviceName');
      const statusText = await this.getDeviceStatusByName(target);
      return this.buildPersonalizedResponse(statusText, profile, voiceUser);
    }

    if (intentName === ALEXA_CUSTOM_SKILL_INTENTS.COMMAND) {
      const command = getSlotSpokenValue(intent, 'command')
        || getSlotSpokenValue(intent, 'action')
        || getSlotSpokenValue(intent, 'query');

      if (!trimString(command)) {
        return this.buildPersonalizedResponse(
          'I did not catch the HomeBrain command. Try saying run bedtime workflow.',
          profile,
          voiceUser,
          {
            shouldEndSession: false,
            repromptText: 'What would you like HomeBrain to do?'
          }
        );
      }

      const result = await voiceCommandService.processCommand({
        commandText: command,
        room: 'Alexa',
        wakeWord: trimString(profile?.name) || 'Alexa',
        stt: {
          provider: 'alexa_custom_skill',
          model: 'custom-skill',
          language: identity.locale
        }
      });

      return this.buildPersonalizedResponse(
        trimString(result?.responseText) || 'Done.',
        profile,
        voiceUser,
        {
          shouldEndSession: trimString(result?.followUpQuestion) ? false : true,
          repromptText: trimString(result?.followUpQuestion)
        }
      );
    }

    return this.buildPersonalizedResponse(
      'That request is not supported yet in the HomeBrain custom skill.',
      profile,
      voiceUser
    );
  }

  summarizeVoiceUser(voiceUser) {
    if (!voiceUser) {
      return null;
    }

    return {
      voiceUserId: voiceUser._id?.toString?.() || voiceUser.id || null,
      label: trimString(voiceUser.label),
      status: trimString(voiceUser.status) || 'unmapped',
      responseMode: trimString(voiceUser.responseMode) || ALEXA_CUSTOM_RESPONSE_MODES.INHERIT,
      brokerAccountId: trimString(voiceUser.brokerAccountId),
      alexaUserId: trimString(voiceUser.alexaUserId),
      alexaPersonId: trimString(voiceUser.alexaPersonId),
      alexaHouseholdId: trimString(voiceUser.alexaHouseholdId),
      userProfileId: voiceUser.userProfileId?._id?.toString?.()
        || voiceUser.userProfileId?.toString?.()
        || null
    };
  }

  normalizeDispatchIntent(intentName = '') {
    const normalized = trimString(intentName);
    switch (normalized) {
      case ALEXA_CUSTOM_SKILL_INTENTS.WORKFLOW:
      case 'RunWorkflowIntent':
        return 'workflow';
      case ALEXA_CUSTOM_SKILL_INTENTS.SCENE:
      case 'ActivateSceneIntent':
        return 'scene';
      case ALEXA_CUSTOM_SKILL_INTENTS.STATUS:
      case 'GetStatusIntent':
        return 'status';
      case ALEXA_CUSTOM_SKILL_INTENTS.WHO_AM_I:
      case 'WhoAmIIntent':
        return 'who_am_i';
      case ALEXA_CUSTOM_SKILL_INTENTS.COMMAND:
      case 'HomeBrainControlIntent':
        return 'voice_command';
      default:
        return '';
    }
  }

  async dispatch(request = {}) {
    await this.initialize();

    const normalized = normalizeCustomSkillRequest(request);
    const linkedAccount = trimString(normalized.brokerAccountId)
      ? await AlexaLinkedAccount.findOne({ brokerAccountId: trimString(normalized.brokerAccountId) }).lean()
      : null;
    const identity = {
      requestType: normalized.requestType,
      requestId: normalized.requestId,
      intentName: normalized.intentName,
      locale: normalized.locale,
      alexaUserId: trimString(normalized.alexaUserId),
      alexaPersonId: trimString(normalized.person?.personId),
      alexaDeviceId: trimString(normalized.alexaDeviceId)
    };

    const voiceUser = linkedAccount
      ? await this.resolveVoiceUser({
        linkedAccount,
        identity,
        hubId: trimString(linkedAccount.hubId)
          || (await alexaProjectionService.ensureBrokerRegistration()).hubId
      })
      : null;
    const householdId = trimString(normalized.householdId || linkedAccount?.alexaHouseholdId);
    const profileMatch = await userProfileService.resolveAlexaProfile({
      personId: trimString(normalized.person?.personId),
      householdId,
      locale: normalized.locale
    });

    const mappedVoiceProfile = voiceUser?.status === 'mapped' && voiceUser?.userProfileId?.active !== false
      ? voiceUser.userProfileId
      : null;
    const profile = mappedVoiceProfile || profileMatch?.profile || null;
    const profileSummary = userProfileService.buildAlexaProfileSummary(profile);
    const matchType = mappedVoiceProfile ? 'voice_user' : (profileMatch?.matchType || 'none');

    let action = {
      type: 'unsupported',
      intentName: normalized.intentName || normalized.requestType || 'Unknown'
    };
    let resultText = '';
    let repromptText = '';
    let shouldEndSession = true;

    if (normalized.requestType === 'LaunchRequest') {
      action = { type: 'launch' };
      resultText = profileSummary?.name
        ? `${profileSummary.name} is ready. You can ask me to run a workflow, activate a scene, check device status, or ask who you are.`
        : 'HomeBrain is ready. You can ask me to run a workflow, activate a scene, check device status, or ask who you are.';
      repromptText = 'Try saying run movie night workflow.';
      shouldEndSession = false;
    } else if (normalized.requestType === 'IntentRequest') {
      const intentKind = this.normalizeDispatchIntent(normalized.intentName);

      if (intentKind === 'who_am_i') {
        action = { type: 'who_am_i' };
        resultText = profileSummary?.name
          ? `You are mapped to ${profileSummary.name}.`
          : 'This Alexa voice is not mapped to a HomeBrain profile yet.';
      } else if (intentKind === 'workflow') {
        const workflowName = getSlotSpokenValue({ slots: normalized.slots }, 'workflowName')
          || getSlotSpokenValue({ slots: normalized.slots }, 'workflow');
        const result = await workflowService.controlWorkflow({
          workflowName,
          operation: 'run'
        });
        action = {
          type: 'workflow',
          workflowName
        };
        resultText = trimString(result?.message) || `Workflow "${workflowName}" ran successfully`;
      } else if (intentKind === 'scene') {
        const sceneName = getSlotSpokenValue({ slots: normalized.slots }, 'sceneName')
          || getSlotSpokenValue({ slots: normalized.slots }, 'scene');
        const activatedScene = await this.activateSceneByName(sceneName);
        action = {
          type: 'scene',
          sceneName: activatedScene
        };
        resultText = `Activated ${activatedScene}.`;
      } else if (intentKind === 'status') {
        const target = getSlotSpokenValue({ slots: normalized.slots }, 'target')
          || getSlotSpokenValue({ slots: normalized.slots }, 'deviceName');
        action = {
          type: 'status',
          target
        };
        resultText = await this.getDeviceStatusByName(target);
      } else if (intentKind === 'voice_command' || trimString(normalized.utterance)) {
        const commandText = trimString(normalized.utterance)
          || getSlotSpokenValue({ slots: normalized.slots }, 'command')
          || getSlotSpokenValue({ slots: normalized.slots }, 'query')
          || getSlotSpokenValue({ slots: normalized.slots }, 'action');
        const result = await voiceCommandService.processCommand({
          commandText,
          room: 'Alexa',
          wakeWord: trimString(profileSummary?.name) || 'Alexa',
          stt: {
            provider: 'alexa_custom_skill',
            model: 'custom-skill',
            language: normalized.locale
          }
        });
        action = {
          type: 'voice_command',
          commandText
        };
        resultText = trimString(result?.responseText) || 'Done.';
        repromptText = trimString(result?.followUpQuestion);
        shouldEndSession = !repromptText;
      } else {
        resultText = 'That request is not supported yet in the HomeBrain custom skill.';
      }
    } else if (normalized.requestType === 'SessionEndedRequest') {
      action = { type: 'session_end' };
      resultText = '';
    } else {
      resultText = 'That Alexa request type is not supported yet.';
    }

    const cardTitle = profileSummary?.name ? `HomeBrain: ${profileSummary.name}` : 'HomeBrain';
    const alexaResponse = normalized.requestType === 'SessionEndedRequest'
      ? buildResponse({
        text: '',
        shouldEndSession: true
      })
      : await this.buildPersonalizedResponse(resultText || 'Done.', profile, voiceUser, {
        shouldEndSession,
        repromptText
      });

    return {
      success: true,
      requestType: normalized.requestType,
      intentName: normalized.intentName,
      profile: profileSummary,
      match: {
        matchType,
        personId: trimString(normalized.person?.personId),
        householdId,
        locale: normalized.locale
      },
      voiceUser: this.summarizeVoiceUser(voiceUser),
      action,
      resultText: resultText || '',
      spokenText: trimString(resultText) || 'Done.',
      repromptText,
      shouldEndSession,
      cardTitle,
      alexaResponse
    };
  }

  async updateVoiceUser(voiceUserId, updates = {}) {
    const voiceUser = await AlexaVoiceUser.findById(voiceUserId);
    if (!voiceUser) {
      throw new Error('Alexa voice user not found');
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'label')) {
      voiceUser.label = trimString(updates.label);
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'status')) {
      const nextStatus = trimString(updates.status);
      voiceUser.status = ['mapped', 'disabled', 'unmapped'].includes(nextStatus) ? nextStatus : voiceUser.status;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'responseMode')) {
      const nextMode = trimString(updates.responseMode);
      voiceUser.responseMode = ['inherit', 'text', 'ssml', 'audio'].includes(nextMode)
        ? nextMode
        : voiceUser.responseMode;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'userProfileId')) {
      voiceUser.userProfileId = trimString(updates.userProfileId) || null;
      if (voiceUser.userProfileId && voiceUser.status === 'unmapped') {
        voiceUser.status = 'mapped';
      }
      if (!voiceUser.userProfileId && voiceUser.status === 'mapped') {
        voiceUser.status = 'unmapped';
      }
    }

    await voiceUser.save();
    return AlexaVoiceUser.findById(voiceUser._id)
      .populate('userProfileId', 'name voiceId active alexaPreferences')
      .lean();
  }

  async deleteVoiceUser(voiceUserId) {
    const voiceUser = await AlexaVoiceUser.findById(voiceUserId);
    if (!voiceUser) {
      throw new Error('Alexa voice user not found');
    }

    await AlexaVoiceUser.findByIdAndDelete(voiceUserId);
    return {
      success: true,
      voiceUserId
    };
  }

  async resolveLinkedAccountForSkill(options = {}) {
    if (options.linkedAccount?.brokerAccountId) {
      return options.linkedAccount;
    }

    if (options.brokerAccountId) {
      return AlexaLinkedAccount.findOne({ brokerAccountId: trimString(options.brokerAccountId) }).lean();
    }

    return null;
  }

  async handleSkillRequest(envelope = {}, options = {}) {
    const identity = extractCustomSkillIdentity(envelope);

    if (!trimString(identity.accessToken) && identity.requestType !== 'SessionEndedRequest') {
      return buildLinkAccountResponse();
    }

    try {
      const dispatch = await this.dispatch({
        envelope,
        brokerAccountId: options.brokerAccountId || options.linkedAccount?.brokerAccountId,
        householdId: options.linkedAccount?.alexaHouseholdId,
        metadata: {
          source: 'broker_custom_skill'
        }
      });

      return dispatch.alexaResponse || buildResponse({
        text: dispatch.resultText || dispatch.spokenText || 'Done.',
        shouldEndSession: dispatch.shouldEndSession !== false,
        repromptText: dispatch.repromptText || ''
      });
    } catch (error) {
      console.warn(`AlexaCustomSkillService: ${error.message}`);
      return buildResponse({
        text: trimString(error.message) || 'The HomeBrain custom skill request failed.',
        shouldEndSession: true
      });
    }
  }
}

module.exports = new AlexaCustomSkillService();
module.exports.AlexaCustomSkillService = AlexaCustomSkillService;
