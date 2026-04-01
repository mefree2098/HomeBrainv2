function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

const ALEXA_CUSTOM_SKILL_INTENTS = Object.freeze({
  COMMAND: 'HomeBrainCommandIntent',
  SCENE: 'HomeBrainSceneIntent',
  WORKFLOW: 'HomeBrainWorkflowIntent',
  STATUS: 'HomeBrainStatusIntent',
  WHO_AM_I: 'HomeBrainWhoAmIIntent'
});
const CUSTOM_SKILL_INTENTS = ALEXA_CUSTOM_SKILL_INTENTS;

const ALEXA_CUSTOM_RESPONSE_MODES = Object.freeze({
  AUTO: 'auto',
  TEXT: 'text',
  SSML: 'ssml',
  AUDIO: 'audio',
  INHERIT: 'inherit'
});

function escapeSsml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function extractCustomSkillIdentity(envelope = {}) {
  const request = envelope.request || {};
  const context = envelope.context || {};
  const system = context.System || {};
  const session = envelope.session || {};
  const intent = request.intent || {};

  return {
    requestType: trimString(request.type),
    requestId: trimString(request.requestId),
    locale: trimString(request.locale || envelope.locale || 'en-US') || 'en-US',
    intentName: trimString(intent.name),
    alexaUserId: trimString(session.user?.userId || system.user?.userId),
    accessToken: trimString(session.user?.accessToken || system.user?.accessToken),
    alexaPersonId: trimString(system.person?.personId),
    alexaDeviceId: trimString(system.device?.deviceId),
    sessionId: trimString(session.sessionId)
  };
}

function getSlotSpokenValue(intent = {}, slotName) {
  const slot = intent?.slots?.[slotName];
  const directValue = trimString(slot?.value);
  if (directValue) {
    return directValue;
  }

  const resolutionAuthorities = Array.isArray(slot?.resolutions?.resolutionsPerAuthority)
    ? slot.resolutions.resolutionsPerAuthority
    : [];

  for (const authority of resolutionAuthorities) {
    const resolved = authority?.values?.[0]?.value?.name;
    const normalized = trimString(resolved);
    if (normalized) {
      return normalized;
    }
  }

  return '';
}

function extractSlotValue(slots = {}, names = []) {
  const candidates = Array.isArray(names) ? names : [names];
  for (const name of candidates) {
    const value = getSlotSpokenValue({ slots }, name);
    if (value) {
      return value;
    }
  }
  return '';
}

function buildResponse({
  text = '',
  ssml = '',
  repromptText = '',
  shouldEndSession = true,
  cardTitle = 'HomeBrain',
  linkAccount = false
} = {}) {
  const response = {
    shouldEndSession: shouldEndSession !== false
  };

  if (ssml) {
    response.outputSpeech = {
      type: 'SSML',
      ssml
    };
  } else {
    response.outputSpeech = {
      type: 'PlainText',
      text: String(text || '')
    };
  }

  if (text || ssml) {
    response.card = linkAccount
      ? { type: 'LinkAccount' }
      : {
        type: 'Simple',
        title: String(cardTitle || 'HomeBrain'),
        content: String(text || '').trim() || 'HomeBrain response'
      };
  } else if (linkAccount) {
    response.card = { type: 'LinkAccount' };
  }

  if (!shouldEndSession && trimString(repromptText)) {
    response.reprompt = {
      outputSpeech: {
        type: 'PlainText',
        text: trimString(repromptText)
      }
    };
  }

  return {
    version: '1.0',
    response
  };
}

function buildLinkAccountResponse(text = 'Please link your HomeBrain account in the Alexa app before using this skill.') {
  return buildResponse({
    text,
    shouldEndSession: true,
    linkAccount: true
  });
}

function normalizeCustomSkillRequest(payload = {}) {
  const envelope = payload.envelope && typeof payload.envelope === 'object'
    ? payload.envelope
    : payload;
  const request = envelope.request || payload.request || {};
  const intent = payload.intent || request.intent || {};
  const slots = intent?.slots && typeof intent.slots === 'object'
    ? intent.slots
    : payload.slots && typeof payload.slots === 'object'
      ? payload.slots
      : {};
  const identity = extractCustomSkillIdentity(envelope);
  const linkedAccount = payload.linkedAccount && typeof payload.linkedAccount === 'object'
    ? payload.linkedAccount
    : {};

  return {
    requestType: trimString(payload.requestType || request.type || 'IntentRequest') || 'IntentRequest',
    requestId: trimString(payload.requestId || request.requestId || identity.requestId),
    locale: trimString(payload.locale || request.locale || identity.locale || 'en-US') || 'en-US',
    intentName: trimString(payload.intentName || intent.name || identity.intentName),
    utterance: trimString(payload.utterance),
    householdId: trimString(payload.householdId || linkedAccount.alexaHouseholdId),
    brokerAccountId: trimString(payload.brokerAccountId || linkedAccount.brokerAccountId),
    linkedAccount,
    alexaUserId: trimString(payload.alexaUserId || identity.alexaUserId),
    alexaDeviceId: trimString(payload.alexaDeviceId || identity.alexaDeviceId),
    person: {
      personId: trimString(payload.person?.personId || payload.alexaPersonId || identity.alexaPersonId),
      userId: trimString(payload.person?.userId || payload.alexaUserId || identity.alexaUserId),
      deviceId: trimString(payload.person?.deviceId || payload.alexaDeviceId || identity.alexaDeviceId)
    },
    slots,
    metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}
  };
}

module.exports = {
  ALEXA_CUSTOM_RESPONSE_MODES,
  ALEXA_CUSTOM_SKILL_INTENTS,
  CUSTOM_SKILL_INTENTS,
  buildLinkAccountResponse,
  buildResponse,
  escapeSsml,
  extractCustomSkillIdentity,
  extractSlotValue,
  getSlotSpokenValue,
  normalizeCustomSkillRequest,
  trimString
};
