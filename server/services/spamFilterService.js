const Settings = require('../models/Settings');
const { sendLLMRequestWithFallbackDetailed } = require('./llmService');

const MAX_EMAIL_ADDRESS_LENGTH = 320;
const MAX_SUBJECT_LENGTH = 300;
const MAX_BODY_LENGTH = 12_000;
const MAX_SIGNAL_COUNT = 6;

const SPAM_FILTER_JSON_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    classification: {
      type: 'string',
      enum: ['spam', 'inbox', 'review']
    },
    confidence: {
      type: 'number'
    },
    recommendedAction: {
      type: 'string',
      enum: ['move_to_junk', 'keep_in_inbox', 'flag_for_review']
    },
    reason: {
      type: 'string'
    },
    signals: {
      type: 'array',
      items: { type: 'string' }
    }
  },
  required: ['classification', 'confidence', 'recommendedAction', 'reason', 'signals'],
  additionalProperties: true
});

function normalizeString(value, maxLength) {
  if (typeof value !== 'string') {
    return '';
  }

  const normalized = value.replace(/\0/g, '').trim();
  if (!normalized) {
    return '';
  }

  if (!Number.isFinite(maxLength) || maxLength <= 0) {
    return normalized;
  }

  return normalized.slice(0, maxLength);
}

function stripHtml(html = '') {
  if (typeof html !== 'string' || !html.trim()) {
    return '';
  }

  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function clampConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  if (numeric > 1 && numeric <= 100) {
    return Math.round((numeric / 100) * 1000) / 1000;
  }

  if (numeric <= 0) {
    return 0;
  }

  if (numeric >= 1) {
    return 1;
  }

  return Math.round(numeric * 1000) / 1000;
}

function parseJsonObject(rawResponse) {
  if (rawResponse && typeof rawResponse === 'object') {
    return rawResponse;
  }

  if (typeof rawResponse !== 'string' || !rawResponse.trim()) {
    throw new Error('Spam filter model returned an empty response');
  }

  const trimmed = rawResponse.trim();
  try {
    return JSON.parse(trimmed);
  } catch (_error) {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error('Spam filter model did not return valid JSON');
    }
    return JSON.parse(match[0]);
  }
}

function resolveSpamFilterLocalModel(settings) {
  const homebrainModel = normalizeString(settings?.homebrainLocalLlmModel, MAX_SUBJECT_LENGTH);
  if (homebrainModel) {
    return homebrainModel;
  }

  const spamModel = normalizeString(settings?.spamFilterLocalLlmModel, MAX_SUBJECT_LENGTH);
  if (spamModel) {
    return spamModel;
  }

  return normalizeString(settings?.localLlmModel, MAX_SUBJECT_LENGTH);
}

function normalizeEmailPayload(payload = {}) {
  const subject = normalizeString(payload.subject, MAX_SUBJECT_LENGTH);
  const from = normalizeString(payload.from, MAX_EMAIL_ADDRESS_LENGTH);
  const to = normalizeString(payload.to, MAX_EMAIL_ADDRESS_LENGTH);
  const text = normalizeString(payload.text, MAX_BODY_LENGTH);
  const htmlText = normalizeString(stripHtml(payload.html), MAX_BODY_LENGTH);
  const bodyText = text || htmlText;
  const bodySource = text ? 'text' : (htmlText ? 'html' : 'none');

  return {
    messageId: normalizeString(payload.messageId, 512),
    subject,
    from,
    to,
    bodyText,
    bodySource,
    bodyLength: bodyText.length
  };
}

function buildSpamFilterPrompt(email) {
  const subjectLine = email.subject || '(empty)';
  const fromLine = email.from || '(unknown)';
  const toLine = email.to || '(unknown)';
  const body = email.bodyText || '(no body text)';

  return [
    'Classify this incoming email for a HomeBrain-managed spam filter.',
    'Be conservative with legitimate receipts, shipping notices, account alerts, smart-home alerts, and messages from known humans.',
    'Mark obvious scams, phishing, spoofing, fake invoices, credential theft, malware lures, and unwanted bulk promotions as spam.',
    'Use "review" when the message is ambiguous or looks suspicious but not conclusive.',
    'Return the JSON object only.',
    '',
    `Subject: ${subjectLine}`,
    `From: ${fromLine}`,
    `To: ${toLine}`,
    `Body source: ${email.bodySource}`,
    'Body:',
    body
  ].join('\n');
}

function normalizeDecision(parsed) {
  const classification = normalizeString(parsed?.classification, 32).toLowerCase();
  const recommendedAction = normalizeString(parsed?.recommendedAction, 32).toLowerCase();

  if (!['spam', 'inbox', 'review'].includes(classification)) {
    throw new Error('Spam filter model returned an unsupported classification');
  }

  const expectedAction = classification === 'spam'
    ? 'move_to_junk'
    : classification === 'inbox'
      ? 'keep_in_inbox'
      : 'flag_for_review';

  const normalizedAction = ['move_to_junk', 'keep_in_inbox', 'flag_for_review'].includes(recommendedAction)
    ? recommendedAction
    : expectedAction;

  const rawSignals = Array.isArray(parsed?.signals) ? parsed.signals : [];
  const signals = rawSignals
    .map((item) => normalizeString(item, 160))
    .filter(Boolean)
    .slice(0, MAX_SIGNAL_COUNT);

  return {
    classification,
    isSpam: classification === 'spam',
    confidence: clampConfidence(parsed?.confidence),
    recommendedAction: normalizedAction,
    suggestedFolder: classification === 'spam' ? 'junk' : classification === 'inbox' ? 'inbox' : 'review',
    reason: normalizeString(parsed?.reason, 500) || 'No reason provided',
    signals
  };
}

class SpamFilterService {
  async classifyEmail(payload = {}) {
    const settings = await Settings.getSettings();
    const endpoint = normalizeString(settings?.localLlmEndpoint, 512);
    const model = resolveSpamFilterLocalModel(settings);

    if (!endpoint) {
      throw new Error('Local LLM endpoint is not configured for spam filtering');
    }

    if (!model) {
      throw new Error('Shared local Ollama model is not configured for spam filtering');
    }

    const email = normalizeEmailPayload(payload);

    if (!email.subject && !email.from && !email.bodyText) {
      throw new Error('Email subject, sender, or body is required for spam filtering');
    }

    const result = await sendLLMRequestWithFallbackDetailed(
      buildSpamFilterPrompt(email),
      ['local'],
      {
        localModelOverride: model,
        strictModel: true,
        preferActiveModel: false,
        timeoutMs: 15000,
        ollamaFormat: SPAM_FILTER_JSON_SCHEMA,
        ollamaOptions: {
          num_ctx: 2048,
          num_predict: 192,
          temperature: 0
        }
      }
    );

    const decision = normalizeDecision(parseJsonObject(result?.response));

    return {
      ...decision,
      model: result?.model || model,
      runtime: result?.runtime || null,
      emailSummary: {
        messageId: email.messageId || null,
        subject: email.subject || null,
        from: email.from || null,
        to: email.to || null,
        bodyLength: email.bodyLength
      }
    };
  }
}

module.exports = new SpamFilterService();
