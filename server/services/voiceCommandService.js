const Device = require('../models/Device');
const DeviceGroup = require('../models/DeviceGroup');
const Scene = require('../models/Scene');
const Workflow = require('../models/Workflow');
const deviceService = require('./deviceService');
const sceneService = require('./sceneService');
const automationService = require('./automationService');
const workflowService = require('./workflowService');
const insteonService = require('./insteonService');
const { sendLLMRequestWithFallbackDetailed } = require('./llmService');
const { ROLES } = require('../../shared/config/roles.js');
const reachyMiniService = require('./reachyMiniService');

const ACTION_MAP = {
  turn_on: 'turnOn',
  turnoff: 'turnOff',
  turn_off: 'turnOff',
  turnon: 'turnOn',
  toggle: 'toggle',
  set_brightness: 'setBrightness',
  setbrightness: 'setBrightness',
  fade: 'setBrightness',
  set_color: 'setColor',
  setcolor: 'setColor',
  set_colour: 'setColor',
  setcolour: 'setColor',
  color: 'setColor',
  colour: 'setColor',
  set_temperature: 'setTemperature',
  settemperature: 'setTemperature',
  lock: 'lock',
  unlock: 'unlock',
  open: 'open',
  close: 'close'
};

const COLOR_NAME_TO_HEX = Object.freeze({
  red: '#ff0000',
  blue: '#0000ff',
  green: '#00ff00',
  yellow: '#ffff00',
  orange: '#ffa500',
  purple: '#800080',
  pink: '#ff69b4',
  white: '#ffffff',
  'warm white': '#ffd6aa',
  'cool white': '#f5faff',
  'soft white': '#fff1d6',
  daylight: '#f8fbff',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  teal: '#008080',
  indigo: '#4b0082',
  violet: '#8f00ff',
  amber: '#ffbf00',
  gold: '#ffd700',
  gray: '#808080',
  grey: '#808080'
});

const COLOR_NAME_ENTRIES = Object.entries(COLOR_NAME_TO_HEX).sort((a, b) => b[0].length - a[0].length);
const LOCAL_FIRST_PROVIDER_PRIORITY = ['local'];
const VOICE_COMMAND_ALLOW_CLOUD_FALLBACK = process.env.VOICE_COMMAND_ALLOW_CLOUD_FALLBACK === 'true';
const VOICE_COMMAND_JSON_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    intent: { type: 'string' },
    confidence: { type: 'number' },
    normalizedCommand: { type: 'string' },
    actions: {
      type: 'array',
      items: { type: 'object' }
    },
    response: { type: 'string' },
    followUpQuestion: {
      anyOf: [
        { type: 'string' },
        { type: 'null' }
      ]
    }
  },
  required: ['intent', 'confidence', 'normalizedCommand', 'actions', 'response', 'followUpQuestion'],
  additionalProperties: true
});
const VOICE_QUERY_JSON_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    intent: { type: 'string', enum: ['query'] },
    confidence: { type: 'number' },
    normalizedCommand: { type: 'string' },
    actions: {
      type: 'array',
      maxItems: 0
    },
    response: { type: 'string' },
    followUpQuestion: {
      anyOf: [
        { type: 'string' },
        { type: 'null' }
      ]
    }
  },
  required: ['intent', 'confidence', 'normalizedCommand', 'actions', 'response', 'followUpQuestion'],
  additionalProperties: true
});
const VOICE_LLM_REQUEST_CONFIG = Object.freeze({
  // Keep voice interpretation fast and deterministic.
  timeoutMs: 7000,
  ollamaOptions: {
    num_ctx: 1024,
    num_predict: 128,
    temperature: 0
  }
});
const EXECUTABLE_INTENT_TYPES = new Set([
  'device_control',
  'scene_activate',
  'workflow_control',
  'automation_create',
  'workflow_create',
  'workflow_revise'
]);
const AUTOMATION_LIKE_INTENT_TYPES = new Set([
  'automation_create',
  'workflow_create',
  'workflow_revise'
]);
const ADMIN_ONLY_INTENT_TYPES = new Set([
  'automation_create',
  'workflow_create',
  'workflow_revise'
]);

class VoiceCommandService {
  constructor() {
    this.lastContextCache = { updatedAt: 0, data: null };
    this.CONTEXT_TTL_MS = 15_000;
  }

  normalizeSmartThingsValue(value) {
    if (!value) {
      return '';
    }

    if (typeof value === 'string') {
      return value.trim();
    }

    if (typeof value === 'object') {
      const candidate = value.id || value.capabilityId || value.name;
      if (typeof candidate === 'string') {
        return candidate.trim();
      }
    }

    return '';
  }

  getSmartThingsCapabilitySet(properties = {}) {
    const capabilities = [
      ...(Array.isArray(properties?.smartThingsCapabilities) ? properties.smartThingsCapabilities : []),
      ...(Array.isArray(properties?.smartthingsCapabilities) ? properties.smartthingsCapabilities : [])
    ]
      .map((entry) => this.normalizeSmartThingsValue(entry))
      .filter((entry) => entry.length > 0);

    return new Set(capabilities);
  }

  getSmartThingsCategorySet(properties = {}) {
    const categories = [
      ...(Array.isArray(properties?.smartThingsCategories) ? properties.smartThingsCategories : []),
      ...(Array.isArray(properties?.smartthingsCategories) ? properties.smartthingsCategories : [])
    ]
      .map((entry) => this.normalizeSmartThingsValue(entry))
      .filter((entry) => entry.length > 0)
      .map((entry) => entry.toLowerCase());

    return new Set(categories);
  }

  looksLikeSmartThingsDimmer(properties = {}) {
    const descriptor = [
      properties?.smartThingsDeviceTypeName,
      properties?.smartThingsPresentationId
    ]
      .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
      .join(' ')
      .toLowerCase();

    return /\bdimmer\b/.test(descriptor);
  }

  looksLikeInsteonFader(properties = {}, name = '') {
    const descriptor = [
      properties?.insteonType,
      properties?.productKey,
      name
    ]
      .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
      .join(' ')
      .toLowerCase();
    const category = Number(properties?.deviceCategory);

    if (category === 0x01 || properties?.supportsBrightness === true) {
      return true;
    }

    return /\b(?:dimmer|fader|fan)\b/.test(descriptor);
  }

  getDeviceCapabilities(type, source = 'local', properties = {}, deviceName = '') {
    const normalizedSource = (source || 'local').toLowerCase();
    const isSmartThings = normalizedSource === 'smartthings' || Boolean(properties?.smartThingsDeviceId);
    const smartThingsCapabilities = this.getSmartThingsCapabilitySet(properties);
    const smartThingsCategories = this.getSmartThingsCategorySet(properties);
    const supportsBrightness = isSmartThings
      ? (
        smartThingsCapabilities.has('switchLevel') ||
        smartThingsCapabilities.has('colorControl') ||
        smartThingsCategories.has('light') ||
        this.looksLikeSmartThingsDimmer(properties)
      )
      : normalizedSource === 'insteon'
        ? this.looksLikeInsteonFader(properties, deviceName)
        : Boolean(properties?.supportsBrightness)
          || (Array.isArray(properties?.directRadioFeatures) && properties.directRadioFeatures.includes('brightness'))
          || (Array.isArray(properties?.matterFeatures) && properties.matterFeatures.includes('brightness'));
    const supportsColor = isSmartThings
      ? smartThingsCapabilities.has('colorControl')
      : Boolean(properties?.supportsColor);

    if (normalizedSource === 'harmony') {
      return ['turn_on', 'turn_off', 'toggle'];
    }

    switch ((type || '').toLowerCase()) {
      case 'light': {
        const capabilities = ['turn_on', 'turn_off', 'set_brightness'];
        if (supportsColor || (!isSmartThings && normalizedSource !== 'insteon')) {
          capabilities.push('set_color');
        }
        return capabilities;
      }
      case 'switch': {
        const capabilities = ['turn_on', 'turn_off', 'toggle'];
        if (supportsBrightness) {
          capabilities.push('set_brightness');
        }
        if (supportsColor) {
          capabilities.push('set_color');
        }
        return capabilities;
      }
      case 'thermostat':
        return ['turn_on', 'turn_off', 'set_temperature'];
      case 'lock':
        return ['lock', 'unlock'];
      case 'garage':
        return ['open', 'close'];
      default:
        return ['turn_on', 'turn_off'];
    }
  }

  deviceSupportsBrightness(device = {}) {
    const source = device?.properties?.source || device?.source || 'local';
    return this.getDeviceCapabilities(device?.type, source, device?.properties || {}, device?.name || '')
      .includes('set_brightness');
  }

  async getContext({ forceRefresh = false } = {}) {
    const now = Date.now();
    if (!forceRefresh && this.lastContextCache.data && now - this.lastContextCache.updatedAt < this.CONTEXT_TTL_MS) {
      return this.lastContextCache.data;
    }

    const [devices, groups, scenes, workflows] = await Promise.all([
      Device.find().lean(),
      DeviceGroup.find().select('_id name normalizedName childGroupIds').lean(),
      Scene.find().select('_id name room category deviceActions groupActions').lean(),
      Workflow.find().select('_id name description enabled category trigger actions graph').lean()
    ]);

    const deviceMap = new Map();
    const devicesWithMeta = devices.map((device) => {
      const normalized = {
        id: device._id.toString(),
        name: device.name,
        room: device.room,
        type: device.type,
        source: (device?.properties?.source || 'local').toString().toLowerCase(),
        capabilities: this.getDeviceCapabilities(
          device.type,
          (device?.properties?.source || 'local').toString(),
          device?.properties || {},
          device?.name || ''
        ),
        properties: device.properties || {}
      };
      deviceMap.set(normalized.id, { ...device, normalized });
      return normalized;
    });

    const sceneMap = new Map();
    const scenesWithMeta = scenes.map((scene) => {
      const normalized = {
        id: scene._id.toString(),
        name: scene.name,
        room: scene.room || 'unknown',
        category: scene.category || 'custom'
      };
      sceneMap.set(normalized.id, { ...scene, normalized });
      return normalized;
    });

    const workflowMap = new Map();
    const workflowsWithMeta = workflows.map((workflow) => {
      const normalized = {
        id: workflow._id.toString(),
        name: workflow.name,
        description: workflow.description || '',
        enabled: workflow.enabled !== false,
        category: workflow.category || 'custom',
        triggerType: workflow?.trigger?.type || 'manual'
      };
      workflowMap.set(normalized.id, { ...workflow, normalized });
      return normalized;
    });

    const groupsById = new Map(groups.map((group) => [group._id.toString(), group]));
    const directDeviceIdsByGroupName = new Map();
    devices.forEach((device) => {
      (Array.isArray(device.groups) ? device.groups : []).forEach((groupName) => {
        const key = this.normalizeReachyPolicyToken(groupName);
        if (!key) return;
        if (!directDeviceIdsByGroupName.has(key)) directDeviceIdsByGroupName.set(key, new Set());
        directDeviceIdsByGroupName.get(key).add(device._id.toString());
      });
    });

    const resolvedGroups = new Map();
    const resolveGroup = (groupId, path = new Set()) => {
      if (resolvedGroups.has(groupId)) return resolvedGroups.get(groupId);
      const group = groupsById.get(groupId);
      if (!group || path.has(groupId)) {
        return { deviceIds: [], complete: false };
      }

      const nextPath = new Set(path);
      nextPath.add(groupId);
      const groupNameKey = this.normalizeReachyPolicyToken(group.normalizedName || group.name);
      const deviceIds = new Set(directDeviceIdsByGroupName.get(groupNameKey) || []);
      let complete = true;
      for (const childValue of Array.isArray(group.childGroupIds) ? group.childGroupIds : []) {
        const childId = childValue?._id?.toString?.() || childValue?.toString?.() || '';
        if (!childId || childId === '[object Object]') {
          complete = false;
          continue;
        }
        const child = resolveGroup(childId, nextPath);
        child.deviceIds.forEach((deviceId) => deviceIds.add(deviceId));
        complete = complete && child.complete;
      }

      const resolved = {
        ...group,
        deviceIds: Array.from(deviceIds),
        complete
      };
      resolvedGroups.set(groupId, resolved);
      return resolved;
    };

    const groupMap = new Map();
    groups.forEach((group) => {
      const groupId = group._id.toString();
      const resolved = resolveGroup(groupId);
      [groupId, group.name, group.normalizedName]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
        .forEach((key) => {
          groupMap.set(key, resolved);
          groupMap.set(this.normalizeReachyPolicyToken(key), resolved);
        });
    });

    const context = {
      devices: devicesWithMeta,
      scenes: scenesWithMeta,
      workflows: workflowsWithMeta,
      raw: {
        devices,
        groups,
        scenes,
        workflows
      },
      deviceMap,
      groupMap,
      sceneMap,
      workflowMap
    };

    this.lastContextCache = { updatedAt: now, data: context };
    return context;
  }

  extractPromptKeywords(text) {
    return Array.from(new Set(
      String(text || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length >= 3)
    ));
  }

  scoreWorkflowForPrompt(commandText, workflow) {
    const normalizedText = String(commandText || '').toLowerCase();
    const keywords = this.extractPromptKeywords(commandText);
    const name = String(workflow?.name || '').toLowerCase();
    const description = String(workflow?.description || '').toLowerCase();
    let score = 1;

    if (name && normalizedText.includes(name)) {
      score += 20;
    }

    keywords.forEach((keyword) => {
      if (name.includes(keyword)) {
        score += 4;
      }
      if (description.includes(keyword)) {
        score += 2;
      }
    });

    if (workflow?.enabled) {
      score += 0.25;
    }

    return score;
  }

  buildPrompt(commandText, { room, wakeWord, devices, scenes, workflows }) {
    const primaryRoom = room || 'unknown';
    const wakeWordLabel = wakeWord || 'unknown';

    const sortedDevices = [...devices].sort((a, b) => {
      if (a.room === primaryRoom && b.room !== primaryRoom) return -1;
      if (b.room === primaryRoom && a.room !== primaryRoom) return 1;
      return a.name.localeCompare(b.name);
    }).slice(0, 40);

    const sortedScenes = [...scenes].slice(0, 20);
    const sortedWorkflows = [...(workflows || [])]
      .sort((left, right) => {
        const scoreDelta = this.scoreWorkflowForPrompt(commandText, right) - this.scoreWorkflowForPrompt(commandText, left);
        if (scoreDelta !== 0) {
          return scoreDelta;
        }
        return left.name.localeCompare(right.name);
      })
      .slice(0, 30);

    const deviceLines = sortedDevices.map((device, index) => {
      return `${index + 1}. ID:${device.id} | Name:${device.name} | Room:${device.room} | Type:${device.type} | Source:${device.source} | Capabilities:${device.capabilities.join(',')}`;
    }).join('\n');

    const sceneLines = sortedScenes.map((scene, index) => {
      return `${index + 1}. ID:${scene.id} | Name:${scene.name} | Room:${scene.room} | Category:${scene.category}`;
    }).join('\n');

    const workflowLines = sortedWorkflows.map((workflow, index) => {
      return `${index + 1}. ID:${workflow.id} | Name:${workflow.name} | Enabled:${workflow.enabled ? 'yes' : 'no'} | Category:${workflow.category} | Trigger:${workflow.triggerType} | Description:${workflow.description || 'None'}`;
    }).join('\n');

    return `
You are HomeBrain, an intelligent smart-home orchestrator. Convert the spoken user command into a strict JSON plan that HomeBrain can execute immediately.

IMPORTANT CONTEXT
- Room where the command was heard: ${primaryRoom}
- Wake word that activated the assistant: ${wakeWordLabel}

AVAILABLE DEVICES
${deviceLines || 'None'}

AVAILABLE SCENES
${sceneLines || 'None'}

AVAILABLE WORKFLOWS
${workflowLines || 'None'}

USER COMMAND
"${commandText}"

OUTPUT FORMAT (must be valid JSON ONLY, no surrounding text):
{
  "intent": "<intent_type>",  // choose one: device_control, scene_activate, automation_create, workflow_create, workflow_control, workflow_revise, query, system_control, unknown
  "confidence": 0.0-1.0,
  "normalizedCommand": "Short paraphrase of the user's request",
  "actions": [
    {
      "type": "<action_type>",  // choose one: device_control, scene_activate, automation_create, workflow_create, workflow_control, workflow_revise, query
      "deviceId": "DEVICE_ID_FROM_LIST",
      "sceneId": "SCENE_ID_FROM_LIST",
      "workflowId": "WORKFLOW_ID_IF_KNOWN",
      "workflowName": "WORKFLOW_NAME_IF_REFERENCED",
      "operation": "run|enable|disable",
      "description": "Required for workflow_create/workflow_revise: what should be created or changed",
      "action": "<device_action>",  // e.g., turn_on, turn_off, toggle, set_brightness, set_color, set_temperature, lock, unlock, open, close
      "value": "optional numeric or string value",
      "room": "optional room for extra clarity"
    }
  ],
  "response": "Natural-language confirmation or answer the hub should speak back",
  "followUpQuestion": "Follow-up question string OR null"
}

DECISION RULES
1. ALWAYS return at least one action when the user wants something controlled. Map the request to the closest matching device using name + room context. Prefer devices in ${primaryRoom} unless the user clearly specifies another room.
2. ONLY use deviceId / sceneId values from the lists above. Do not invent IDs. If two devices match equally, pick the most specific (exact name match beats fuzzy match).
3. For brightness actions return percentages (0-100). For color actions return a hex color string (for example "#ff0000"). For temperature, use whole-number Fahrenheit unless the user specifies another scale.
4. Use "workflow_create" when the user asks to create/schedule a routine or workflow. Use "workflow_revise" when the user asks to edit, fix, update, revise, or change an existing workflow. Use "workflow_control" when the user asks to run/enable/disable an existing workflow. Immediate commands like "turn on the vault light" must stay "device_control".
5. For "workflow_revise", choose the best matching workflow from AVAILABLE WORKFLOWS. Use "workflowId" whenever possible, include the exact "workflowName", and include a concise "description" of the requested changes.
6. If the request is a general question or not about controlling devices, set intent to "query", leave "actions" empty, and provide the direct answer in "response". Only use "followUpQuestion" when clarification is required.
7. Never return empty "actions" for device_control, workflow_create, workflow_control, or workflow_revise intents.
8. Make the "response" friendly, short, and actionable (e.g., "Turning on the vault light.") or informative for queries.
9. If a selected device has Source:harmony, only use turn_on, turn_off, or toggle. Treat it as a Harmony Hub activity target (start/stop), not a dimmable light or thermostat.
10. Return JSON only. Do not use markdown code fences.
11. Put any conversational text only in the "response" field.

Return ONLY the JSON object with no commentary.`; 
  }

  buildQueryPrompt(commandText, { room, wakeWord }) {
    const primaryRoom = room || 'unknown';
    const wakeWordLabel = wakeWord || 'unknown';

    return `
You are HomeBrain's fast conversational voice assistant.

IMPORTANT CONTEXT
- Room where the command was heard: ${primaryRoom}
- Wake word that activated the assistant: ${wakeWordLabel}

USER REQUEST
"${commandText}"

OUTPUT FORMAT (must be valid JSON ONLY, no surrounding text):
{
  "intent": "query",
  "confidence": 0.0-1.0,
  "normalizedCommand": "Short paraphrase of the request",
  "actions": [],
  "response": "Short, spoken-style answer (1-2 sentences max)",
  "followUpQuestion": null
}

RULES
1. This request is conversational/informational. Do not produce control actions.
2. Keep the response concise and voice-friendly.
3. Put the spoken answer in the "response" field only.
4. Start output with "{" and end with "}".
5. Return ONLY one JSON object and nothing else.`;
  }

  parseLlmResponse(rawResponse) {
    if (!rawResponse) {
      return null;
    }
    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      const preview = typeof rawResponse === 'string' ? rawResponse.slice(0, 220).replace(/\s+/g, ' ') : '';
      if (preview) {
        console.warn(`VoiceCommandService: LLM response missing JSON object. Preview="${preview}"`);
      }
      return null;
    }
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (error) {
      const preview = typeof rawResponse === 'string' ? rawResponse.slice(0, 220).replace(/\s+/g, ' ') : '';
      console.warn(`VoiceCommandService: Failed to parse LLM JSON response: ${error.message}${preview ? ` | Preview="${preview}"` : ''}`);
      return null;
    }
  }

  parseLocalPlainTextQueryResponse(commandText, rawResponse, queryOnlyRequest) {
    if (!queryOnlyRequest || typeof rawResponse !== 'string') {
      return null;
    }

    let text = rawResponse.trim();
    if (!text) {
      return null;
    }

    // If the model wrapped the answer in markdown fences, strip them.
    text = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```$/i, '')
      .trim();

    if (!text) {
      return null;
    }

    return {
      intent: 'query',
      confidence: 0.55,
      normalizedCommand: commandText,
      actions: [],
      response: text,
      followUpQuestion: null,
      usedFallback: true
    };
  }

  shouldAttemptQueryRescue(errorMessage) {
    const text = String(errorMessage || '').toLowerCase();
    if (!text) {
      return true;
    }

    const hardFailurePatterns = [
      'timeout',
      'timed out',
      'econnrefused',
      'connection refused',
      'not running',
      'connection reset',
      'socket hang up'
    ];

    return !hardFailurePatterns.some((pattern) => text.includes(pattern));
  }

  buildQueryFallbackInterpretation(commandText) {
    const text = (commandText || '').toLowerCase().trim();
    if (!text) {
      return null;
    }

    if (/\b(joke|funny|riddle)\b/.test(text)) {
      return {
        intent: 'query',
        confidence: 0.45,
        normalizedCommand: commandText,
        actions: [],
        response: "Here's one: Why don't scientists trust atoms? Because they make up everything.",
        followUpQuestion: null,
        usedFallback: true
      };
    }

    return {
      intent: 'query',
      confidence: 0.35,
      normalizedCommand: commandText,
      actions: [],
      response: "I couldn't process that fast enough locally. Please try that again.",
      followUpQuestion: null,
      usedFallback: true
    };
  }

  normalizeVoiceSearchText(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/&apos;|&#39;/g, "'")
      .replace(/&amp;/g, 'and')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  extractDeviceTargetPhrase(commandText) {
    let target = this.normalizeVoiceSearchText(commandText);
    if (!target) {
      return '';
    }

    const actionPrefixes = [
      /^(?:please\s+)?(?:turn|switch|power)\s+(?:on|off)\s+(?:the\s+)?/,
      /^(?:please\s+)?(?:turn|switch)\s+(?:the\s+)?/,
      /^(?:please\s+)?(?:set|dim|brighten|fade|activate|deactivate|run|start|stop|toggle)\s+(?:the\s+)?/,
      /^(?:please\s+)?(?:open|close|lock|unlock)\s+(?:the\s+)?/
    ];

    for (const pattern of actionPrefixes) {
      target = target.replace(pattern, '').trim();
    }

    target = target
      .replace(/\b(?:to|at)\s+\d{1,3}\s*(?:percent|%)?\s*$/i, '')
      .replace(/\b(?:to|at)\s+\d{1,3}\s*(?:degrees?)?\s*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();

    return target;
  }

  getDeviceVoiceAliases(device = {}) {
    const aliases = new Set();
    const pushAlias = (value) => {
      const normalized = this.normalizeVoiceSearchText(value);
      if (normalized) {
        aliases.add(normalized);
      }
    };

    pushAlias(device.name);
    pushAlias(device.properties?.harmonyActivityLabel);
    pushAlias(device.properties?.harmonyDeviceLabel);

    const normalizedName = this.normalizeVoiceSearchText(device.name);
    const normalizedRoom = this.normalizeVoiceSearchText(device.room);
    if (normalizedName && normalizedRoom && normalizedName.startsWith(`${normalizedRoom} `)) {
      pushAlias(normalizedName.slice(normalizedRoom.length).replace(/^[-\s]+/, ''));
    }

    return [...aliases];
  }

  findBestDevice(commandText, devices) {
    const text = this.normalizeVoiceSearchText(commandText);
    const targetPhrase = this.extractDeviceTargetPhrase(commandText);
    let best = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    if (targetPhrase) {
      for (const device of devices) {
        const aliases = this.getDeviceVoiceAliases(device);
        if (aliases.some((alias) => alias === targetPhrase)) {
          return device;
        }
        if (aliases.some((alias) => alias === `${targetPhrase} light` || alias === `${targetPhrase} lights`)) {
          return device;
        }
      }
    }

    const targetTokens = (targetPhrase || text).split(/\s+/).filter((token) => token.length >= 3);

    for (const device of devices) {
      const aliases = this.getDeviceVoiceAliases(device);
      const nameTokens = aliases.join(' ').split(/\s+/);
      let score = 0;
      for (const token of targetTokens.length ? targetTokens : nameTokens) {
        if (token.length < 3) continue;
        if (aliases.some((alias) => alias.includes(token)) || text.includes(token)) {
          score += 2;
        }
      }

      if (targetPhrase && aliases.some((alias) => alias.includes(targetPhrase))) {
        score += 4;
      }

      if (device.room && text.includes(this.normalizeVoiceSearchText(device.room))) {
        score += 1.5;
      }

      if (
        device.source === 'harmony' ||
        device.properties?.source === 'harmony' ||
        device.properties?.harmonyEntityType
      ) {
        score -= 0.75;
      }

      score -= Math.max(0, nameTokens.length - targetTokens.length) * 0.1;

      if (score > bestScore) {
        best = device;
        bestScore = score;
      }
    }

    return bestScore > 0 ? best : null;
  }

  extractNumber(commandText) {
    const text = String(commandText || '').slice(0, 1024).toLowerCase();
    for (let percentIndex = text.indexOf('%'); percentIndex !== -1; percentIndex = text.indexOf('%', percentIndex + 1)) {
      let end = percentIndex;
      while (end > 0 && text[end - 1] === ' ') end -= 1;
      let start = end;
      while (start > 0 && text[start - 1] >= '0' && text[start - 1] <= '9') start -= 1;
      if (start < end) return Number(text.slice(start, end));
    }

    const tokens = [];
    let token = '';
    let tokenType = '';
    for (const character of text) {
      const nextType = character >= '0' && character <= '9'
        ? 'number'
        : (character >= 'a' && character <= 'z' ? 'word' : 'separator');
      if (nextType === 'separator') {
        if (token) tokens.push({ type: tokenType, value: token });
        token = '';
        tokenType = '';
      } else if (tokenType && tokenType !== nextType) {
        tokens.push({ type: tokenType, value: token });
        token = character;
        tokenType = nextType;
      } else {
        token += character;
        tokenType = nextType;
      }
    }
    if (token) tokens.push({ type: tokenType, value: token });

    const contexts = new Set(['to', 'at', 'set', 'bright', 'brightness', 'level', 'temperature', 'heat', 'cool']);
    for (let index = 0; index < tokens.length - 1; index += 1) {
      if (tokens[index].type === 'word'
        && contexts.has(tokens[index].value)
        && tokens[index + 1].type === 'number'
        && tokens[index + 1].value.length <= 3) {
        return Number(tokens[index + 1].value);
      }
    }
    return null;
  }

  normalizeHexColor(value) {
    if (typeof value !== 'string') {
      return '';
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return '';
    }

    const hex = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
    if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
      return hex.toLowerCase();
    }

    return '';
  }

  normalizeColorValue(value) {
    if (typeof value !== 'string') {
      return '';
    }

    const directHex = this.normalizeHexColor(value);
    if (directHex) {
      return directHex;
    }

    const normalizedName = value
      .trim()
      .toLowerCase()
      .replace(/[_-]/g, ' ')
      .replace(/\s+/g, ' ');

    if (!normalizedName) {
      return '';
    }

    if (COLOR_NAME_TO_HEX[normalizedName]) {
      return COLOR_NAME_TO_HEX[normalizedName];
    }

    return '';
  }

  extractColor(commandText) {
    if (!commandText || typeof commandText !== 'string') {
      return '';
    }

    const directHexMatch = commandText.match(/#([0-9a-fA-F]{6})\b/);
    if (directHexMatch) {
      return `#${directHexMatch[1].toLowerCase()}`;
    }

    const text = commandText.toLowerCase();
    for (const [colorName, hex] of COLOR_NAME_ENTRIES) {
      const pattern = new RegExp(`\\b${colorName.replace(/\s+/g, '\\s+')}\\b`, 'i');
      if (pattern.test(text)) {
        return hex;
      }
    }

    return '';
  }

  fallbackInterpretation(commandText, context, room) {
    const text = commandText.toLowerCase();
    const actions = [];
    const device = this.findBestDevice(commandText, context.devices);

    if (!device) {
      return null;
    }

    const value = this.extractNumber(commandText);
    const colorValue = this.extractColor(commandText);
    const capabilities = new Set(Array.isArray(device.capabilities) ? device.capabilities : []);

    const actionCandidates = [];
    if (text.includes('turn on') || text.includes('switch on') || text.includes('power on')) {
      actionCandidates.push('turn_on');
    }
    if (text.includes('turn off') || text.includes('switch off') || text.includes('power off')) {
      actionCandidates.push('turn_off');
    }
    if (text.includes('toggle')) {
      actionCandidates.push('toggle');
    }
    if (
      text.includes('dim') ||
      text.includes('brightness') ||
      text.includes('bright') ||
      text.includes('fade')
    ) {
      actionCandidates.push('set_brightness');
    }
    if (
      text.includes('color') ||
      text.includes('colour') ||
      text.includes('hue') ||
      text.includes('tint') ||
      text.includes('rgb') ||
      !!colorValue
    ) {
      actionCandidates.push('set_color');
    }
    if (text.includes('temperature') || text.includes('degrees') || text.includes('heat') || text.includes('cool')) {
      actionCandidates.push('set_temperature');
    }
    if (text.includes('lock')) {
      actionCandidates.push('lock');
    } else if (text.includes('unlock')) {
      actionCandidates.push('unlock');
    }
    if (text.includes('open')) {
      actionCandidates.push('open');
    }
    if (text.includes('close')) {
      actionCandidates.push('close');
    }

    if (!actionCandidates.length) {
      return null;
    }

    const selectedAction = actionCandidates.find((candidate) => capabilities.has(candidate));
    if (!selectedAction) {
      return null;
    }

    let resolvedValue = value != null ? value : undefined;
    if (selectedAction === 'set_brightness') {
      const loweredText = text;
      if (resolvedValue == null) {
        if (/\b(dim|dimmer|lower|fade\s*down|fade\s*out)\b/.test(loweredText)) {
          resolvedValue = 30;
        } else if (/\b(brighten|brighter|raise|fade\s*up|fade\s*in)\b/.test(loweredText)) {
          resolvedValue = 80;
        } else if (text.includes('turn on') || text.includes('switch on')) {
          resolvedValue = 100;
        }
      }

      if (resolvedValue != null) {
        resolvedValue = Math.max(0, Math.min(100, Math.round(Number(resolvedValue))));
      }
    }

    if (selectedAction === 'set_color') {
      const normalizedColor = this.normalizeColorValue(colorValue || String(commandText || ''));
      if (!normalizedColor) {
        return null;
      }
      resolvedValue = normalizedColor;
    }

    actions.push({
      type: 'device_control',
      deviceId: device.id,
      action: selectedAction,
      value: resolvedValue,
      room: room || device.room
    });

    return {
      intent: 'device_control',
      confidence: 0.55,
      normalizedCommand: commandText,
      actions,
      response: `Okay, ${selectedAction.replace('_', ' ')} ${device.name}.`,
      followUpQuestion: null,
      usedFallback: true
    };
  }

  isImmediateControlRequest(commandText) {
    const normalized = (commandText || '').toLowerCase().trim();
    if (!normalized) {
      return false;
    }

    const automationIndicators = [
      'automation',
      'automations',
      'routine',
      'routines',
      'schedule',
      'scheduled',
      'scheduling',
      'timer',
      'timers',
      'reminder',
      'reminders',
      'every ',
      'each ',
      'per day',
      'per night',
      'weekday',
      'weekend'
    ];

    if (automationIndicators.some((indicator) => normalized.includes(indicator))) {
      return false;
    }

    const schedulePatterns = [
      /\b(at|around)\s+\d{1,2}(:\d{2})?\s*(am|pm)?\b/,
      /\b\d{1,2}\s*(am|pm)\b/,
      /\b(in|after)\s+\d+\s+(minutes?|hours?|days?)\b/,
      /\bwhen\b\s+(?:the\s+)?/,
      /\bif\b\s+(?:the\s+)?/
    ];

    if (schedulePatterns.some((pattern) => pattern.test(normalized))) {
      return false;
    }

    const directActionPattern = /\b(turn|switch)\s+(on|off)\b|\b(dim|brighten|fade)\b|\bset\s+(?:the\s+)?(?:brightness|temperature|color|colour)\b|\b(color|colour)\b|\b(red|blue|green|yellow|orange|purple|pink|white|cyan|magenta|teal|amber|violet)\b|\b(lock|unlock)\b|\b(open|close)\b|\bactivate\s+\w+/;

    return directActionPattern.test(normalized);
  }

  isLikelyAutomationRequest(commandText) {
    const text = (commandText || '').toLowerCase().trim();
    if (!text) {
      return false;
    }

    const explicitAutomationPhrases = [
      'automation',
      'automations',
      'workflow',
      'workflows',
      'routine',
      'routines',
      'schedule',
      'scheduled',
      'scheduling',
      'timer',
      'timers',
      'reminder',
      'reminders',
      'set up an automation',
      'create an automation',
      'create a workflow',
      'build a workflow',
      'make an automation',
      'start a routine'
    ];

    if (explicitAutomationPhrases.some((phrase) => text.includes(phrase))) {
      return true;
    }

    const repeatingPatterns = [
      /\bevery\s+(day|night|morning|evening|weekday|weekend|hour|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/,
      /\beach\s+(day|night|morning|evening|hour)\b/,
      /\bweekly\b/,
      /\bdaily\b/
    ];

    if (repeatingPatterns.some((pattern) => pattern.test(text))) {
      return true;
    }

    const timePattern = /\b(at|around)\s+\d{1,2}(:\d{2})?\s*(am|pm)?\b/;
    if (timePattern.test(text)) {
      return true;
    }

    const conditionalTriggerPattern = /\bwhen\b.*\b(light|door|sensor|motion|temperature|humidity|garage|switch|lock|thermostat)\b/;
    if (conditionalTriggerPattern.test(text)) {
      return true;
    }

    return false;
  }

  isLikelyQuestionRequest(commandText) {
    const text = (commandText || '').toLowerCase().trim();
    if (!text) {
      return false;
    }

    if (/\?$/.test(text)) {
      return true;
    }

    if (/^(tell|give|say)\s+me\b/.test(text)) {
      return true;
    }

    if (/^me\s+/.test(text) && /\b(joke|riddle|story|fact)\b/.test(text)) {
      return true;
    }

    if (/\b(joke|riddle|story|fun fact|fact)\b/.test(text)) {
      return true;
    }

    return /^(what|who|when|where|why|how|which|is|are|can|could|would|do|does|did|tell me|explain|define|summarize)\b/.test(text);
  }

  isLikelyControlPhrase(commandText) {
    const text = (commandText || '').toLowerCase().trim();
    if (!text) {
      return false;
    }

    const directActionPattern = /\b(turn|switch|set|dim|brighten|open|close|lock|unlock|arm|disarm|activate|deactivate|run|start|stop|enable|disable|toggle)\b/;
    if (directActionPattern.test(text)) {
      return true;
    }

    const hasDeviceTarget = /\b(light|lights|switch|lamp|fan|scene|alarm|security|lock|door|garage|thermostat|vault|spotlight)\b/.test(text);
    const hasOnOffWord = /\b(on|off)\b/.test(text);
    if (hasDeviceTarget && hasOnOffWord) {
      return true;
    }

    const securityModePattern = /\b(arm away|arm stay|armed away|armed stay|disarm(ed)?)\b/;
    if (securityModePattern.test(text)) {
      return true;
    }

    const workflowEditPattern = /(\b(edit|update|fix|change|modify|revise)\b.*\b(workflow|routine|automation)\b)|(\b(workflow|routine|automation)\b.*\b(edit|update|fix|change|modify|revise)\b)/;
    if (workflowEditPattern.test(text)) {
      return true;
    }

    return false;
  }

  hasControlIntentActions(interpretation) {
    const intent = (interpretation?.intent || '').toLowerCase();
    if (EXECUTABLE_INTENT_TYPES.has(intent)) {
      return true;
    }

    const actions = Array.isArray(interpretation?.actions) ? interpretation.actions : [];
    return actions.some((action) => {
      const type = (action?.type || '').toLowerCase();
      return EXECUTABLE_INTENT_TYPES.has(type);
    });
  }

  enforceRolePermissions(interpretation, userRole = ROLES.USER) {
    if (!interpretation || userRole === ROLES.ADMIN) {
      return interpretation;
    }

    const actions = Array.isArray(interpretation.actions) ? interpretation.actions : [];
    let blocked = false;

    const allowedActions = actions.filter((action) => {
      const type = String(action?.type || '').toLowerCase();
      if (ADMIN_ONLY_INTENT_TYPES.has(type)) {
        blocked = true;
        return false;
      }

      if (type === 'workflow_control') {
        const operation = String(action?.operation || action?.command || 'run').toLowerCase();
        if (!['run', 'execute', 'start', 'trigger'].includes(operation)) {
          blocked = true;
          return false;
        }
      }

      return true;
    });

    if (!blocked) {
      return interpretation;
    }

    if (allowedActions.length > 0) {
      return {
        ...interpretation,
        actions: allowedActions,
        usedFallback: true,
        response: 'Running the parts of that request available to a standard user.'
      };
    }

    return {
      intent: 'query',
      confidence: typeof interpretation.confidence === 'number' ? interpretation.confidence : 0.5,
      normalizedCommand: interpretation.normalizedCommand || '',
      actions: [],
      response: 'That action requires an admin account. Standard users can control devices and run existing scenes or workflows.',
      followUpQuestion: null,
      usedFallback: true
    };
  }

  normalizeReachyPolicyToken(value) {
    return String(value ?? '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
  }

  toReachyPolicyId(value, preferredKeys = []) {
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value).trim();
    }
    if (!value || typeof value !== 'object') return '';

    const keys = [
      ...preferredKeys,
      'deviceId',
      'groupId',
      'sceneId',
      'workflowId',
      '_id',
      'id'
    ];
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const candidate = value[key];
      if (candidate === value) continue;
      const resolved = this.toReachyPolicyId(candidate);
      if (resolved) return resolved;
    }

    const rendered = value.toString?.();
    return rendered && rendered !== '[object Object]' ? String(rendered).trim() : '';
  }

  lookupReachyPolicyMap(map, value, preferredKeys = []) {
    if (!map?.get) return null;
    const id = this.toReachyPolicyId(value, preferredKeys);
    if (!id) return null;
    return map.get(id) || map.get(this.normalizeReachyPolicyToken(id)) || null;
  }

  getReachyPolicyActionToken(action = {}) {
    const candidates = [
      action.action,
      action.command,
      action.operation,
      action.parameters?.action,
      action.parameters?.command,
      action.parameters?.operation,
      action.parameters?.commandParameters?.command
    ];
    return this.normalizeReachyPolicyToken(candidates.find((value) => value != null && String(value).trim()) || '');
  }

  getReachyPolicyTarget(action = {}, context = {}) {
    const parameters = action?.parameters || {};
    const target = action?.target;
    const targetKind = this.normalizeReachyPolicyToken(
      target?.kind || target?.targetKind || parameters?.kind || parameters?.targetKind
    );
    const explicitGroup = action?.groupId
      || target?.groupId
      || target?.group
      || parameters?.groupId
      || parameters?.group;
    if (explicitGroup || ['group', 'devicegroup'].includes(targetKind)) {
      const value = explicitGroup || target;
      return { kind: 'group', id: this.toReachyPolicyId(value, ['groupId', 'group']), raw: value };
    }

    const explicitDevice = action?.deviceId
      || target?.deviceId
      || parameters?.deviceId
      || parameters?.target?.deviceId;
    if (explicitDevice) {
      return {
        kind: 'device',
        id: this.toReachyPolicyId(explicitDevice, ['deviceId']),
        raw: explicitDevice
      };
    }

    if (typeof target === 'string' || typeof target === 'number') {
      if (this.lookupReachyPolicyMap(context?.deviceMap, target)) {
        return { kind: 'device', id: this.toReachyPolicyId(target), raw: target };
      }
      if (this.lookupReachyPolicyMap(context?.groupMap, target)) {
        return { kind: 'group', id: this.toReachyPolicyId(target), raw: target };
      }
      return { kind: 'unknown', id: this.toReachyPolicyId(target), raw: target };
    }

    return { kind: 'unknown', id: '', raw: target || null };
  }

  isReachySensitiveDevice(device) {
    if (!device || typeof device !== 'object') return true;
    const normalizedType = this.normalizeReachyPolicyToken(device.type || device.normalized?.type);
    if (['lock', 'garage', 'siren', 'camera', 'securitysystem', 'accesscontrol'].includes(normalizedType)) {
      return true;
    }

    const properties = device.properties || device.normalized?.properties || {};
    if (
      properties.supportsAlarm === true
      || properties.supportsSirenSound === true
      || properties.supportsLock === true
      || properties.supportsGarageDoor === true
    ) {
      return true;
    }

    const descriptorValues = [
      device.name,
      device.model,
      properties.deviceClass,
      properties.category,
      properties.capability,
      properties.capabilityId,
      ...(Array.isArray(properties.capabilities) ? properties.capabilities : []),
      ...(Array.isArray(properties.smartThingsCapabilities) ? properties.smartThingsCapabilities : []),
      ...(Array.isArray(properties.smartthingsCapabilities) ? properties.smartthingsCapabilities : []),
      ...(Array.isArray(properties.smartThingsCategories) ? properties.smartThingsCategories : []),
      ...(Array.isArray(properties.directRadioFeatures) ? properties.directRadioFeatures : [])
    ];
    return descriptorValues.some((value) => {
      const token = this.normalizeReachyPolicyToken(
        value && typeof value === 'object'
          ? value.id || value.capabilityId || value.name || ''
          : value
      );
      return /(?:lock|garagedoor|garageopener|siren|alarm|securitysystem|camera|accesscontrol|doorcontroller|gatecontroller)/.test(token);
    });
  }

  isReachySensitivePropertyMutation(action = {}) {
    const actionToken = this.getReachyPolicyActionToken(action);
    const propertyMutation = /(?:set|update|write)(?:device)?(?:property|attribute|capability|state|status)/.test(actionToken);
    const sensitiveProperty = /(?:lock|garage|door|alarm|siren|security|armstate|access|gate|camera|privacy)/;
    const sensitiveValues = new Set([
      'lock', 'locked', 'unlock', 'unlocked', 'open', 'opened', 'close', 'closed',
      'arm', 'armed', 'disarm', 'disarmed', 'armaway', 'armstay', 'alarmon', 'alarmoff'
    ]);
    const descriptorKeys = new Set([
      'property', 'propertyname', 'attribute', 'attributename', 'capability', 'capabilityid',
      'field', 'fieldname', 'path', 'key', 'statename'
    ]);
    const valueKeys = new Set(['value', 'state', 'status', 'desiredvalue', 'newvalue']);
    const seen = new WeakSet();

    const inspect = (value, depth = 0) => {
      if (!value || typeof value !== 'object' || depth > 12) return false;
      if (seen.has(value)) return false;
      seen.add(value);
      for (const [rawKey, nested] of Object.entries(value)) {
        const key = this.normalizeReachyPolicyToken(rawKey);
        const scalar = nested == null || typeof nested === 'object'
          ? ''
          : this.normalizeReachyPolicyToken(nested);
        if (descriptorKeys.has(key) && sensitiveProperty.test(scalar)) return true;
        if (sensitiveProperty.test(key) && (nested != null || propertyMutation)) return true;
        if (propertyMutation && valueKeys.has(key) && sensitiveValues.has(scalar)) return true;
        if (nested && typeof nested === 'object' && inspect(nested, depth + 1)) return true;
      }
      return false;
    };

    return inspect(action);
  }

  isReachyHighRiskUtterance(commandText) {
    const text = this.normalizeVoiceSearchText(commandText);
    if (!text) return false;
    return /\b(?:un\s*)?lock(?:ed|ing|s)?\b/.test(text)
      || /\b(?:disarm|arm)(?:ed|ing)?\b/.test(text)
      || /\b(?:garage|siren)\b/.test(text)
      || /\b(?:security\s+alarm|alarm\s+system|admin(?:istrator)?|access\s+code|lock\s+code)\b/.test(text)
      || /\b(?:snapshot|photo|picture|camera|face\s+tracking|release\s+(?:the\s+)?(?:reachy|robot))\b/.test(text);
  }

  isReachyHighRiskDeviceAction(action, context) {
    const actionToken = this.getReachyPolicyActionToken(action);
    if (
      /^(?:un)?lock(?:ed)?$/.test(actionToken)
      || /^(?:dis)?arm(?:ed|away|stay)?$/.test(actionToken)
      || ['alarmon', 'alarmoff', 'turnonalarm', 'turnoffalarm', 'soundalarm', 'silencealarm'].includes(actionToken)
      || this.isReachySensitivePropertyMutation(action)
    ) {
      return true;
    }

    const target = this.getReachyPolicyTarget(action, context);
    if (target.kind === 'device') {
      const device = this.lookupReachyPolicyMap(context?.deviceMap, target.id)
        || (target.raw && typeof target.raw === 'object' ? target.raw : null);
      return !device || this.isReachySensitiveDevice(device);
    }

    if (target.kind === 'group') {
      const group = this.lookupReachyPolicyMap(context?.groupMap, target.id, ['groupId', 'group']);
      if (!group || group.complete !== true) return true;
      const members = Array.isArray(group.deviceIds)
        ? group.deviceIds
        : Array.isArray(group.devices)
          ? group.devices
          : Array.isArray(group.members)
            ? group.members
            : [];
      if (members.length === 0) return true;
      return members.some((member) => {
        const memberId = this.toReachyPolicyId(member, ['deviceId']);
        const device = this.lookupReachyPolicyMap(context?.deviceMap, memberId)
          || (member && typeof member === 'object' ? member : null);
        return !device || this.isReachySensitiveDevice(device);
      });
    }

    // Device-control actions with an unresolved target must never be treated as safe.
    return true;
  }

  isReachySensitiveScene(scene, context) {
    if (!scene) return true;
    if (this.normalizeReachyPolicyToken(scene.category) === 'security') return true;
    const deviceActions = Array.isArray(scene.deviceActions) ? scene.deviceActions : [];
    const groupActions = Array.isArray(scene.groupActions) ? scene.groupActions : [];
    return deviceActions.some((action) => this.isReachyHighRiskDeviceAction(action, context))
      || groupActions.some((action) => this.isReachyHighRiskDeviceAction({
        ...action,
        target: { kind: 'device_group', group: action.groupId }
      }, context));
  }

  isReachyPrivateRobotAction(action = {}) {
    const token = this.getReachyPolicyActionToken(action);
    return new Set([
      'snapshot',
      'takesnapshot',
      'startfacetracking',
      'enablecamera',
      'release',
      'releaseapp',
      'install',
      'installpackage',
      'update',
      'updatepackage',
      'rollback',
      'bootstrap'
    ]).has(token);
  }

  isReachySensitiveWorkflowAction(value, context, visited, seen = new WeakSet(), depth = 0) {
    if (depth > 32) return true;
    if (Array.isArray(value)) {
      return value.some((entry) => this.isReachySensitiveWorkflowAction(entry, context, visited, seen, depth + 1));
    }
    if (!value || typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);

    const type = this.normalizeReachyPolicyToken(value.type || value.actionType || value.kind);
    const payload = value.data && typeof value.data === 'object'
      ? { ...value, ...value.data, parameters: value.data.parameters || value.parameters }
      : value;

    if (['devicecontrol', 'deviceaction'].includes(type)) {
      if (this.isReachyHighRiskDeviceAction(payload, context)) return true;
    }
    if (['sceneactivate', 'sceneaction'].includes(type)) {
      const sceneId = this.toReachyPolicyId(
        payload.sceneId || payload.target || payload.parameters?.sceneId,
        ['sceneId']
      );
      const scene = this.lookupReachyPolicyMap(context?.sceneMap, sceneId, ['sceneId']);
      if (this.isReachySensitiveScene(scene, context)) return true;
    }
    if (['workflowcontrol', 'workflowaction'].includes(type)) {
      const workflowId = this.toReachyPolicyId(
        payload.workflowId || payload.target || payload.parameters?.workflowId,
        ['workflowId']
      );
      const workflow = this.lookupReachyPolicyMap(context?.workflowMap, workflowId, ['workflowId']);
      if (this.isReachySensitiveWorkflow(workflow, context, visited)) return true;
    }
    if (['httprequest', 'isynetworkresource'].includes(type)) return true;
    if (type === 'reachyaction' && this.isReachyPrivateRobotAction(payload)) return true;

    const hasImplicitDeviceTarget = Boolean(
      value.deviceId
      || value.groupId
      || value.target?.deviceId
      || value.target?.groupId
      || value.parameters?.deviceId
      || value.parameters?.groupId
    );
    const hasImplicitControl = Boolean(
      value.action
      || value.command
      || value.parameters?.action
      || value.parameters?.command
      || value.parameters?.property
      || value.parameters?.propertyName
      || value.parameters?.attribute
      || value.parameters?.capability
    );
    if (!type && hasImplicitDeviceTarget && hasImplicitControl) {
      if (this.isReachyHighRiskDeviceAction(value, context)) return true;
    }

    const nestedKeys = new Set([
      'actions', 'ontrueactions', 'onfalseactions', 'thenactions', 'elseactions',
      'steps', 'branches', 'children', 'parameters', 'data', 'graph', 'nodes'
    ]);
    for (const [rawKey, nested] of Object.entries(value)) {
      const key = this.normalizeReachyPolicyToken(rawKey);
      if (!nestedKeys.has(key) && !key.endsWith('actions')) continue;
      if (this.isReachySensitiveWorkflowAction(nested, context, visited, seen, depth + 1)) return true;
    }
    return false;
  }

  isReachySensitiveWorkflow(workflow, context, visited = new Set()) {
    if (!workflow) return true;
    const workflowId = this.toReachyPolicyId(workflow, ['workflowId']);
    if (workflowId && visited.has(workflowId)) return true;
    if (this.normalizeReachyPolicyToken(workflow.category) === 'security') return true;
    if (this.normalizeReachyPolicyToken(workflow.trigger?.type) === 'securityalarmstatus') return true;

    if (workflowId) visited.add(workflowId);
    try {
      const seen = new WeakSet();
      return this.isReachySensitiveWorkflowAction(workflow.actions || [], context, visited, seen)
        || this.isReachySensitiveWorkflowAction(workflow.graph || {}, context, visited, seen);
    } finally {
      if (workflowId) visited.delete(workflowId);
    }
  }

  enforceReachyOriginPolicy(commandText, interpretation, context) {
    if (!interpretation) return interpretation;
    let blocked = this.isReachyHighRiskUtterance(commandText);
    for (const action of Array.isArray(interpretation.actions) ? interpretation.actions : []) {
      const type = this.normalizeReachyPolicyToken(action?.type);
      if (this.isReachySensitiveWorkflowAction(action, context, new Set())) blocked = true;
      // Creating or revising automations from an unauthenticated room voice is
      // an administrative mutation and has no trusted confirmation channel.
      if (['automationcreate', 'workflowcreate', 'workflowrevise'].includes(type)) blocked = true;
    }
    if (!blocked) return interpretation;
    return {
      intent: 'reachy_high_risk_denied',
      confidence: 1,
      normalizedCommand: commandText,
      actions: [],
      response: 'That security-sensitive action is not available through Reachy voice control. Use the authenticated HomeBrain controls.',
      followUpQuestion: null,
      usedFallback: false
    };
  }

  shouldRejectUnsafeControlInterpretation(commandText, interpretation) {
    if (!this.hasControlIntentActions(interpretation)) {
      return false;
    }

    if (this.isLikelyControlPhrase(commandText)) {
      return false;
    }

    // Never execute device/scene/workflow actions for question-like or conversational
    // chatter when no explicit control language is present.
    return true;
  }

  normalizeActionValue(action, device) {
    const name = (action?.action || '').toLowerCase();
    if (name === 'set_brightness' || name === 'setbrightness') {
      if (action.value == null) return undefined;
      const numeric = Number(action.value);
      if (Number.isFinite(numeric)) {
        return Math.max(0, Math.min(100, Math.round(numeric)));
      }
    }
    if (name === 'set_temperature' || name === 'settemperature') {
      if (action.value == null) return undefined;
      const numeric = Number(action.value);
      if (Number.isFinite(numeric)) {
        return Math.round(numeric);
      }
    }
    if (name === 'set_color' || name === 'setcolor' || name === 'set_colour' || name === 'setcolour' || name === 'color' || name === 'colour') {
      if (typeof action.value === 'string') {
        const normalizedColor = this.normalizeColorValue(action.value);
        if (normalizedColor) {
          return normalizedColor;
        }
      }
      return undefined;
    }
    if (name === 'turn_on' && action.value != null && this.deviceSupportsBrightness(device)) {
      const numeric = Number(action.value);
      if (Number.isFinite(numeric)) {
        return Math.max(0, Math.min(100, Math.round(numeric)));
      }
    }
    return action.value;
  }

  async executeDeviceAction(action, context, commandContext = {}) {
    const { authorizeExecution: _authorizeExecution, ...safeCommandContext } = commandContext;
    const result = {
      type: 'device_control',
      deviceId: action.deviceId,
      deviceName: null,
      room: null,
      action: action.action,
      value: action.value,
      success: false,
      message: ''
    };

    const deviceRecord = context.deviceMap.get(action.deviceId);
    if (!deviceRecord) {
      result.message = 'Device not found';
      return result;
    }

    result.deviceName = deviceRecord.name;
    result.room = deviceRecord.room;

    const normalizedAction = (action.action || '').toLowerCase();
    const mappedAction = ACTION_MAP[normalizedAction] || ACTION_MAP[normalizedAction.replace(/[^a-z]/g, '')] || ACTION_MAP[normalizedAction.replace(/-/g, '_')] || null;
    const value = this.normalizeActionValue(action, deviceRecord);

    try {
      const actionName = mappedAction || normalizedAction.replace(/[^a-z]/g, '');
      await deviceService.controlDevice(deviceRecord._id.toString(), actionName, value, {
        command: {
          source: 'voice',
          triggerSource: 'voice',
          reason: commandContext.commandText
            ? `Voice command: ${commandContext.commandText}`
            : `Voice command for ${deviceRecord.name}`,
          actor: commandContext.wakeWord || commandContext.room || 'voice',
          ...safeCommandContext
        }
      });

      result.success = true;
      const valueText = value != null ? ` (${value})` : '';
      result.message = `Executed ${normalizedAction}${valueText} on ${deviceRecord.name}`;
      return result;
    } catch (error) {
      result.success = false;
      result.message = error.message || 'Failed to execute device action';
      return result;
    }
  }

  async executeInsteonAction(deviceRecord, normalizedAction, value) {
    switch (normalizedAction) {
      case 'turn_on':
      case 'turnon':
        await insteonService.turnOn(deviceRecord._id.toString(), value != null ? value : 100);
        break;
      case 'turn_off':
      case 'turnoff':
        await insteonService.turnOff(deviceRecord._id.toString());
        break;
      case 'set_brightness':
      case 'setbrightness': {
        const brightness = value != null ? value : 100;
        await insteonService.setBrightness(deviceRecord._id.toString(), brightness);
        break;
      }
      case 'fade': {
        const brightness = value != null ? value : 50;
        await insteonService.setBrightness(deviceRecord._id.toString(), brightness);
        break;
      }
      default:
        throw new Error(`Action "${normalizedAction}" not supported for Insteon devices`);
    }
  }

  async executeSceneAction(action, commandContext = {}) {
    const { authorizeExecution: _authorizeExecution, ...safeCommandContext } = commandContext;
    const result = {
      type: 'scene_activate',
      sceneId: action.sceneId,
      success: false,
      message: ''
    };

    try {
      const activation = await sceneService.activateScene(action.sceneId, {
        command: {
          source: 'voice',
          triggerSource: 'voice',
          reason: commandContext.commandText
            ? `Voice scene command: ${commandContext.commandText}`
            : 'Voice scene activation',
          actor: commandContext.wakeWord || commandContext.room || 'voice',
          ...safeCommandContext
        }
      });
      result.success = true;
      result.message = activation?.message || 'Scene activated';
      return result;
    } catch (error) {
      result.success = false;
      result.message = error.message || 'Failed to activate scene';
      return result;
    }
  }

  async executeAutomationAction(action, room) {
    const result = {
      type: 'automation_create',
      success: false,
      message: ''
    };

    try {
      const description = action.description || action.summary || action.details || action.text || '';
      if (!description) {
        throw new Error('Automation description missing');
      }
      const creation = await automationService.createAutomationFromText(description, room);
      if (creation?.handledDirectCommand) {
        result.type = 'device_control';
        result.success = true;
        result.message = creation?.message || 'Device command executed';
        result.deviceId = creation?.device?.id || null;
        result.deviceName = creation?.device?.name || null;
        result.deviceRoom = creation?.device?.room || null;
      } else {
        const createdAutomations = Array.isArray(creation?.automations) && creation.automations.length
          ? creation.automations
          : (creation?.automation ? [creation.automation] : []);
        result.success = true;
        result.message = creation?.message || (createdAutomations.length > 1
          ? `Created ${createdAutomations.length} automations`
          : 'Automation created');
        result.createdCount = createdAutomations.length || (creation?.automation ? 1 : 0);
        result.automationId = createdAutomations[0]?._id?.toString?.() || null;
        result.automationIds = createdAutomations
          .map((automation) => automation?._id?.toString?.() || null)
          .filter(Boolean);
      }
      return result;
    } catch (error) {
      result.success = false;
      result.message = error.message || 'Failed to create automation';
      return result;
    }
  }

  async executeWorkflowCreateAction(action, room) {
    const result = {
      type: 'workflow_create',
      success: false,
      message: ''
    };

    try {
      const description = action.description || action.summary || action.details || action.text || '';
      if (!description) {
        throw new Error('Workflow description missing');
      }

      const creation = await workflowService.createWorkflowFromText(description, room, 'voice');
      if (creation?.handledDirectCommand) {
        result.type = 'device_control';
        result.success = true;
        result.message = creation?.message || 'Device command executed';
        result.deviceId = creation?.device?.id || null;
        result.deviceName = creation?.device?.name || null;
        result.deviceRoom = creation?.device?.room || null;
      } else {
        const createdWorkflows = Array.isArray(creation?.workflows) && creation.workflows.length
          ? creation.workflows
          : (creation?.workflow ? [creation.workflow] : []);
        result.success = true;
        result.message = creation?.message || (createdWorkflows.length > 1
          ? `Created ${createdWorkflows.length} workflows`
          : 'Workflow created');
        result.createdCount = createdWorkflows.length || (creation?.workflow ? 1 : 0);
        result.workflowId = createdWorkflows[0]?._id?.toString?.() || null;
        result.workflowIds = createdWorkflows
          .map((workflow) => workflow?._id?.toString?.() || null)
          .filter(Boolean);
      }

      return result;
    } catch (error) {
      result.success = false;
      result.message = error.message || 'Failed to create workflow';
      return result;
    }
  }

  async executeWorkflowReviseAction(action, room) {
    const result = {
      type: 'workflow_revise',
      success: false,
      message: ''
    };

    try {
      const description = action.description || action.summary || action.details || action.text || '';
      if (!description) {
        throw new Error('Workflow revision description missing');
      }

      const workflow = await workflowService.findWorkflowForControl({
        workflowId: action.workflowId || null,
        workflowName: action.workflowName || action.name || null
      });

      const revision = await workflowService.reviseWorkflowFromText(
        workflow._id.toString(),
        description,
        room,
        'voice'
      );

      result.success = true;
      result.workflowId = revision?.workflow?._id?.toString() || workflow._id.toString();
      result.workflowName = revision?.workflow?.name || workflow.name;
      result.message = revision?.message || `Workflow "${result.workflowName}" updated`;
      return result;
    } catch (error) {
      result.success = false;
      result.message = error.message || 'Failed to revise workflow';
      return result;
    }
  }

  async executeWorkflowControlAction(action) {
    const result = {
      type: 'workflow_control',
      success: false,
      message: ''
    };

    try {
      const operation = action.operation || action.command || 'run';
      const control = await workflowService.controlWorkflow({
        workflowId: action.workflowId || null,
        workflowName: action.workflowName || action.name || null,
        operation
      });

      result.success = Boolean(control?.success);
      result.operation = control?.operation || operation;
      result.workflowId = control?.workflow?._id?.toString() || action.workflowId || null;
      result.workflowName = control?.workflow?.name || action.workflowName || action.name || null;
      result.message = control?.message || 'Workflow command executed';
      return result;
    } catch (error) {
      result.success = false;
      result.message = error.message || 'Failed to control workflow';
      return result;
    }
  }

  async executeActions(actions, context, room, commandContext = {}) {
    const entities = { devices: [], scenes: [], actions: [] };
    const executionResults = [];

    for (const action of actions) {
      if (!action || typeof action !== 'object') continue;
      if (
        typeof commandContext.authorizeExecution === 'function'
        && commandContext.authorizeExecution() !== true
      ) {
        executionResults.push({
          type: 'authorization',
          success: false,
          message: 'Voice device authorization was revoked before execution'
        });
        break;
      }
      if (action.type === 'device_control' && action.deviceId) {
        const deviceResult = await this.executeDeviceAction(action, context, commandContext);
        executionResults.push(deviceResult);
        if (deviceResult.deviceId) {
          entities.devices.push({
            name: deviceResult.deviceName,
            room: deviceResult.room,
            deviceId: deviceResult.deviceId
          });
        }
      } else if (action.type === 'scene_activate' && action.sceneId) {
        const sceneResult = await this.executeSceneAction(action, commandContext);
        executionResults.push(sceneResult);
        if (sceneResult.sceneId) {
          const scene = context.sceneMap.get(sceneResult.sceneId);
          entities.scenes.push({
            name: scene?.name,
            sceneId: sceneResult.sceneId
          });
        }
      } else if (action.type === 'automation_create') {
        const automationResult = await this.executeAutomationAction(action, room);
        executionResults.push(automationResult);
        if (automationResult.type === 'device_control' && automationResult.deviceId) {
          entities.devices.push({
            name: automationResult.deviceName || '',
            room: automationResult.deviceRoom || null,
            deviceId: automationResult.deviceId
          });
        }
      } else if (action.type === 'workflow_create') {
        const workflowResult = await this.executeWorkflowCreateAction(action, room);
        executionResults.push(workflowResult);
        if (workflowResult.type === 'device_control' && workflowResult.deviceId) {
          entities.devices.push({
            name: workflowResult.deviceName || '',
            room: workflowResult.deviceRoom || null,
            deviceId: workflowResult.deviceId
          });
        }
      } else if (action.type === 'workflow_revise') {
        const workflowRevisionResult = await this.executeWorkflowReviseAction(action, room);
        executionResults.push(workflowRevisionResult);
      } else if (action.type === 'workflow_control') {
        const workflowControlResult = await this.executeWorkflowControlAction(action);
        executionResults.push(workflowControlResult);
      } else if (action.type === 'query') {
        executionResults.push({
          type: 'query',
          success: true,
          message: action.response || 'Query handled locally'
        });
      }
    }

    const successCount = executionResults.filter((item) => item.success).length;
    const status = successCount === executionResults.length
      ? 'success'
      : successCount === 0
        ? 'failed'
        : 'partial_success';

    return {
      status,
      results: executionResults,
      entities
    };
  }

  buildResponseText(interpretation, execution) {
    if (interpretation?.response) {
      return interpretation.response;
    }

    if (!execution.results.length) {
      return "I'm not sure how to help with that yet.";
    }

    const successfulActions = execution.results.filter((item) => item.success);
    if (!successfulActions.length) {
      return "I couldn't complete that request.";
    }

    const lines = successfulActions.map((item) => {
      if (item.type === 'device_control' && item.deviceName) {
        return `${item.action?.replace(/_/g, ' ')} ${item.deviceName}`;
      }
      if (item.type === 'scene_activate') {
        return item.message || 'Scene activated';
      }
      if (item.type === 'workflow_create' || item.type === 'workflow_control' || item.type === 'workflow_revise') {
        return item.message;
      }
      return item.message;
    }).filter(Boolean);

    return lines.join('. ') || 'Done.';
  }

  async interpretCommand(commandText, context, room, wakeWord) {
    const queryOnlyRequest = this.isLikelyQuestionRequest(commandText)
      && !this.isLikelyControlPhrase(commandText)
      && !this.isLikelyAutomationRequest(commandText);

    const prompt = queryOnlyRequest
      ? this.buildQueryPrompt(commandText, { room, wakeWord })
      : this.buildPrompt(commandText, {
        devices: context.devices,
        scenes: context.scenes,
        workflows: context.workflows,
        room,
        wakeWord
      });

    const providerPriorityOverride = LOCAL_FIRST_PROVIDER_PRIORITY;
    const llmRequestConfig = {
      ...VOICE_LLM_REQUEST_CONFIG,
      ollamaFormat: queryOnlyRequest ? VOICE_QUERY_JSON_SCHEMA : VOICE_COMMAND_JSON_SCHEMA
    };

    const startedAt = Date.now();
    try {
      const firstAttempt = await sendLLMRequestWithFallbackDetailed(
        prompt,
        providerPriorityOverride,
        llmRequestConfig
      );
      let { response, provider, model, runtime = null } = firstAttempt;
      let parsed = this.parseLlmResponse(response);

      if (!parsed) {
        console.warn(`VoiceCommandService: First LLM (provider=${provider || 'unknown'}) failed to return valid JSON.`);
        const providerKey = (provider || '').toLowerCase();

        if (providerKey === 'local') {
          const localPlainTextInterpretation = this.parseLocalPlainTextQueryResponse(
            commandText,
            response,
            queryOnlyRequest
          );
          if (localPlainTextInterpretation) {
            parsed = localPlainTextInterpretation;
            console.log('VoiceCommandService: Accepted plain-text local query response without cloud fallback.');
          }
        }

        if (providerKey === 'local') {
          if (VOICE_COMMAND_ALLOW_CLOUD_FALLBACK && !parsed) {
            const cloudProviders = ['codex', 'openai', 'anthropic'];
            try {
              const cloudAttempt = await sendLLMRequestWithFallbackDetailed(prompt, cloudProviders);
              response = cloudAttempt.response;
              provider = cloudAttempt.provider;
              model = cloudAttempt.model;
              runtime = cloudAttempt.runtime || null;
              parsed = this.parseLlmResponse(response);
              console.log(`VoiceCommandService: Second LLM attempt with ${provider || 'unknown'} ${parsed ? 'succeeded' : 'still failed'}.`);
            } catch (fallbackError) {
              console.warn('VoiceCommandService: Cloud fallback attempt failed:', fallbackError.message);
            }
          } else if (!parsed) {
            console.log('VoiceCommandService: Cloud fallback disabled (VOICE_COMMAND_ALLOW_CLOUD_FALLBACK != true).');
          }
        }
      }

      const processingTimeMs = Date.now() - startedAt;

      if (!parsed) {
        return {
          interpretation: null,
          llm: {
            provider,
            model,
            runtime,
            prompt,
            rawResponse: response,
            processingTimeMs
          }
        };
      }

      return {
        interpretation: {
          ...parsed,
          usedFallback: false
        },
        llm: {
          provider,
          model,
          runtime,
          prompt,
          rawResponse: response,
          processingTimeMs
        }
      };
    } catch (error) {
      console.warn('VoiceCommandService: LLM interpretation failed:', error.message);
      const errorMessage = error?.message || '';

      if (queryOnlyRequest && this.shouldAttemptQueryRescue(errorMessage)) {
        try {
          const plainPrompt = `You are HomeBrain's local voice assistant. Answer the user request in one short spoken sentence with no JSON and no markdown.\n\nUser request: "${commandText}"`;
          const plainAttempt = await sendLLMRequestWithFallbackDetailed(
            plainPrompt,
            LOCAL_FIRST_PROVIDER_PRIORITY,
            {
              ...VOICE_LLM_REQUEST_CONFIG,
              // Do not require structured output in rescue mode.
              ollamaFormat: undefined
            }
          );
          const plainInterpretation = this.parseLocalPlainTextQueryResponse(
            commandText,
            plainAttempt?.response,
            true
          );

          if (plainInterpretation) {
            return {
              interpretation: plainInterpretation,
              llm: {
                provider: plainAttempt?.provider || 'local',
                model: plainAttempt?.model || null,
                runtime: plainAttempt?.runtime || null,
                prompt: plainPrompt,
                rawResponse: plainAttempt?.response || null,
                processingTimeMs: Date.now() - startedAt
              }
            };
          }
        } catch (queryRescueError) {
          console.warn('VoiceCommandService: Query rescue attempt failed:', queryRescueError.message);
        }
      }

      if (queryOnlyRequest) {
        const fallbackInterpretation = this.buildQueryFallbackInterpretation(commandText);
        if (fallbackInterpretation) {
          return {
            interpretation: fallbackInterpretation,
            llm: {
              provider: 'local',
              model: null,
              runtime: null,
              prompt,
              rawResponse: null,
              processingTimeMs: Date.now() - startedAt,
              error: errorMessage || 'local query fallback'
            }
          };
        }
      }

      return {
        interpretation: null,
        llm: {
          provider: null,
          model: null,
          runtime: null,
          prompt,
          rawResponse: null,
          processingTimeMs: Date.now() - startedAt,
          error: error.message
        }
      };
    }
  }

  async tryProcessExplicitReachyCommand(commandText, options = {}) {
    const original = typeof commandText === 'string' ? commandText.trim() : '';
    const text = original.toLowerCase().replace(/[^a-z0-9\s_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text || !/\breachy\b/.test(text)) {
      return null;
    }

    const denied = /\b(unlock|disarm|open\s+(?:the\s+)?garage|install|update|upgrade|package|credential|token|admin|privacy|enable\s+(?:the\s+)?camera|disable\s+(?:the\s+)?camera|snapshot|photo|picture|start\s+face\s+tracking|face\s+tracking|release)\b/.test(text);
    if (denied) {
      return {
        processedText: original,
        intent: { action: 'reachy_action_denied', confidence: 1, entities: { target: 'Reachy' } },
        execution: { status: 'failed', actions: [], errorMessage: 'This Reachy operation is not allowed by voice.' },
        responseText: 'That Reachy operation requires the authenticated HomeBrain controls.',
        llm: { provider: 'heuristic', model: 'reachy-safety-router', processingTimeMs: 0 },
        followUpQuestion: null,
        usedFallback: false
      };
    }

    let command = null;
    let parameters = {};
    const look = text.match(/\blook\s+(left|right|up|down|center|at\s+(?:the\s+)?speaker)\b/);
    const emotion = text.match(/\b(?:play|be|act)\s+(happy|sad|curious|listening|speaking|alert|neutral)\b/);
    const move = text.match(/\b(?:play\s+)?(nod|shake\s+(?:your\s+)?head|greet|celebrate|dance)\b/);
    if (look) {
      command = 'look';
      parameters = { direction: look[1].startsWith('at') ? 'speaker' : look[1] };
    } else if (/\b(?:go\s+to\s+sleep|sleep)\b/.test(text)) {
      command = 'sleep';
    } else if (/\bwake(?:\s+up)?\b/.test(text)) {
      command = 'wake';
    } else if (/\b(?:neutral|rest)\b/.test(text)) {
      command = 'neutral';
    } else if (/\bstart\s+face\s+tracking\b/.test(text)) {
      command = 'start_face_tracking';
    } else if (/\bstop\s+face\s+tracking\b/.test(text)) {
      command = 'stop_face_tracking';
    } else if (/\bstop\b/.test(text)) {
      command = 'stop';
    } else if (emotion) {
      command = 'play_emotion';
      parameters = { emotion: emotion[1] };
    } else if (move) {
      command = 'play_move';
      parameters = {
        move: move[1].startsWith('shake') ? 'shake_head' : move[1]
      };
    }

    if (!command) {
      return {
        processedText: original,
        intent: { action: 'reachy_action', confidence: 0.7, entities: { target: 'Reachy' } },
        execution: { status: 'failed', actions: [], errorMessage: 'Unsupported explicit Reachy voice command.' },
        responseText: 'I heard Reachy, but that robot command is not available by voice.',
        llm: { provider: 'heuristic', model: 'reachy-safety-router', processingTimeMs: 0 },
        followUpQuestion: null,
        usedFallback: false
      };
    }

    try {
      const robots = await reachyMiniService.getRobots();
      const candidates = robots.filter((robot) => robot.online);
      const roomMatch = candidates.find((robot) => options.room && robot.room?.toLowerCase() === String(options.room).toLowerCase());
      const robot = roomMatch || (candidates.length === 1 ? candidates[0] : null);
      if (!robot) {
        return {
          processedText: original,
          intent: { action: 'reachy_action', confidence: 0.9, entities: { target: 'Reachy' } },
          execution: { status: 'failed', actions: [], errorMessage: 'No unambiguous online Reachy target.' },
          responseText: candidates.length > 1
            ? 'More than one Reachy is online. Use its HomeBrain name or room in the dashboard.'
            : 'Reachy is not online right now.',
          llm: { provider: 'heuristic', model: 'reachy-safety-router', processingTimeMs: 0 },
          followUpQuestion: null,
          usedFallback: false
        };
      }
      if (typeof options.authorizeExecution === 'function' && options.authorizeExecution() !== true) {
        return this.buildRevokedVoiceResult(original);
      }
      const result = await reachyMiniService.dispatchCommand(robot.id, command, parameters, {
        source: 'voice',
        awaitTerminal: true,
        authorizeExecution: options.authorizeExecution
      });
      return {
        processedText: original,
        intent: { action: 'reachy_action', confidence: 1, entities: { target: robot.id, command } },
        execution: { status: 'success', actions: [{ type: 'reachy_action', command, commandId: result.commandId }] },
        responseText: `Reachy ${command.replace(/_/g, ' ')} completed.`,
        llm: { provider: 'heuristic', model: 'reachy-safety-router', processingTimeMs: 0 },
        followUpQuestion: null,
        usedFallback: false
      };
    } catch (error) {
      return {
        processedText: original,
        intent: { action: 'reachy_action', confidence: 1, entities: { target: 'Reachy', command } },
        execution: { status: 'failed', actions: [], errorMessage: error.message },
        responseText: `Reachy could not complete that command: ${error.message}`,
        llm: { provider: 'heuristic', model: 'reachy-safety-router', processingTimeMs: 0 },
        followUpQuestion: null,
        usedFallback: false
      };
    }
  }

  buildRevokedVoiceResult(commandText) {
    return {
      processedText: commandText,
      intent: { action: 'voice_authorization_revoked', confidence: 1, entities: {} },
      execution: { status: 'failed', actions: [], errorMessage: 'Voice device authorization was revoked' },
      responseText: '',
      llm: { provider: 'policy', model: 'connection-generation-guard', processingTimeMs: 0 },
      followUpQuestion: null,
      usedFallback: false
    };
  }

  async processCommand(options) {
    const {
      commandText,
      room,
      wakeWord,
      deviceId,
      stt,
      userRole = ROLES.USER,
      originDeviceType = null,
      authorizeExecution = null
    } = options;
    const executionAuthorized = () => (
      typeof authorizeExecution !== 'function' || authorizeExecution() === true
    );
    if (!executionAuthorized()) return { ...this.buildRevokedVoiceResult(commandText), stt };

    // allowHighRiskVoiceActions is intentionally reserved until HomeBrain has
    // a trusted per-user confirmation channel on Reachy. Today all high-risk
    // Reachy-origin commands are denied before interpretation or execution.
    if (originDeviceType === 'robot' && this.isReachyHighRiskUtterance(commandText)) {
      return {
        processedText: commandText,
        intent: { action: 'reachy_high_risk_denied', confidence: 1, entities: {} },
        execution: { status: 'failed', actions: [], errorMessage: 'Security-sensitive Reachy voice action denied' },
        responseText: 'That security-sensitive action is not available through Reachy voice control. Use the authenticated HomeBrain controls.',
        llm: { provider: 'policy', model: 'reachy-deny-by-default', processingTimeMs: 0 },
        followUpQuestion: null,
        usedFallback: false,
        stt
      };
    }

    const reachyIntent = await this.tryProcessExplicitReachyCommand(commandText, {
      room,
      userRole,
      authorizeExecution
    });
    if (reachyIntent) {
      return { ...reachyIntent, stt };
    }

    let context = await this.getContext();
    if (!executionAuthorized()) return { ...this.buildRevokedVoiceResult(commandText), stt };

    let interpretation = null;
    let llm = {
      provider: null,
      model: null,
      runtime: null,
      prompt: null,
      rawResponse: null,
      processingTimeMs: 0
    };

    if (this.isImmediateControlRequest(commandText)) {
      const heuristicInterpretation = this.fallbackInterpretation(commandText, context, room);
      if (heuristicInterpretation) {
        interpretation = {
          ...heuristicInterpretation,
          usedFallback: true
        };
        llm = {
          provider: 'heuristic',
          model: 'rule-based',
          runtime: null,
          prompt: null,
          rawResponse: null,
          processingTimeMs: 0
        };
      }
    }

    if (!interpretation) {
      const interpretationResult = await this.interpretCommand(commandText, context, room, wakeWord);
      interpretation = interpretationResult.interpretation;
      llm = interpretationResult.llm;
    }
    if (!executionAuthorized()) return { ...this.buildRevokedVoiceResult(commandText), stt };

    interpretation = this.enforceRolePermissions(interpretation, userRole);

    const likelyAutomation = this.isLikelyAutomationRequest(commandText);
    const hasAutomationLikeActions = Array.isArray(interpretation?.actions) &&
      interpretation.actions.some((action) => AUTOMATION_LIKE_INTENT_TYPES.has(action?.type));

    if (
      interpretation &&
      !likelyAutomation &&
      (AUTOMATION_LIKE_INTENT_TYPES.has(interpretation.intent) || hasAutomationLikeActions)
    ) {
      console.log('VoiceCommandService: Automation intent/actions detected but command appears immediate; applying device-control fallback.');
      const directFallback = this.fallbackInterpretation(commandText, context, room);
      if (directFallback) {
        interpretation = {
          ...directFallback,
          usedFallback: true
        };
      } else if (hasAutomationLikeActions) {
        const filteredActions = interpretation.actions.filter((action) =>
          !AUTOMATION_LIKE_INTENT_TYPES.has(action?.type)
        );
        if (filteredActions.length) {
          interpretation = {
            ...interpretation,
            actions: filteredActions,
            intent: AUTOMATION_LIKE_INTENT_TYPES.has(interpretation.intent)
              ? 'device_control'
              : interpretation.intent,
            usedFallback: true
          };
        } else {
          interpretation = null;
        }
      } else {
        interpretation = null;
      }
    }

    if (interpretation && this.shouldRejectUnsafeControlInterpretation(commandText, interpretation)) {
      const isQuestion = this.isLikelyQuestionRequest(commandText);
      console.log('VoiceCommandService: Rejected unsafe control interpretation for non-actionable utterance.');
      interpretation = {
        intent: isQuestion ? 'query' : 'unknown',
        confidence: 0.35,
        normalizedCommand: commandText,
        actions: [],
        response: isQuestion
          ? "I heard your question, but I need a bit more detail to answer it accurately."
          : "I heard that, but it did not sound like a home-control command. Try saying \"turn on Vault Light Switch\".",
        followUpQuestion: isQuestion ? null : 'What would you like me to control?',
        usedFallback: true
      };
    }

    const hasActions = Array.isArray(interpretation?.actions) && interpretation.actions.length > 0;
    const allowNoActionResponse = Boolean(
      interpretation
      && !hasActions
      && (
        (typeof interpretation.intent === 'string' && interpretation.intent.toLowerCase() === 'query')
        || (typeof interpretation.response === 'string' && interpretation.response.trim().length > 0)
        || (typeof interpretation.followUpQuestion === 'string' && interpretation.followUpQuestion.trim().length > 0)
      )
    );

    if (!interpretation || (!hasActions && !allowNoActionResponse)) {
      interpretation = this.fallbackInterpretation(commandText, context, room);
    }

    // This must run after every fallback has had its final say. A fallback can
    // synthesize a device action even when the LLM returned no interpretation.
    if (originDeviceType === 'robot') {
      // Scene/workflow/device records are mutable. Never authorize a robot
      // command against the ordinary 15-second voice prompt cache; refresh the
      // policy snapshot at the execution boundary and re-check authorization
      // after the database read.
      context = await this.getContext({ forceRefresh: true });
      if (!executionAuthorized()) return { ...this.buildRevokedVoiceResult(commandText), stt };
      interpretation = this.enforceReachyOriginPolicy(commandText, interpretation, context);
      if (interpretation?.intent === 'reachy_high_risk_denied') {
        return {
          processedText: interpretation.normalizedCommand || commandText,
          intent: { action: 'reachy_high_risk_denied', confidence: 1, entities: {} },
          execution: { status: 'failed', actions: [], errorMessage: 'Security-sensitive Reachy voice action denied' },
          responseText: interpretation.response,
          llm,
          followUpQuestion: null,
          usedFallback: false,
          stt
        };
      }
    }

    if (!interpretation) {
      return {
        processedText: commandText,
        intent: {
          action: 'unknown',
          confidence: 0.2,
          entities: {}
        },
        execution: {
          status: 'failed',
          actions: [],
          errorMessage: 'No actionable interpretation was produced'
        },
        responseText: "I'm not sure how to help with that yet.",
        llm,
        followUpQuestion: null,
        usedFallback: true,
        stt
      };
    }

    const hasExecutableActions = Array.isArray(interpretation.actions) && interpretation.actions.length > 0;
    const execution = hasExecutableActions
      ? await this.executeActions(interpretation.actions || [], context, room, {
        commandText,
        room,
        wakeWord,
        source: 'voice',
        triggerSource: 'voice',
        authorizeExecution
      })
      : {
        status: 'success',
        results: [],
        entities: {}
      };
    const responseText = this.buildResponseText(interpretation, execution);

    return {
      processedText: interpretation.normalizedCommand || commandText,
      intent: {
        action: interpretation.intent || 'device_control',
        confidence: typeof interpretation.confidence === 'number' ? interpretation.confidence : 0.7,
        entities: execution.entities
      },
      execution: {
        status: execution.status,
        actions: execution.results
      },
      responseText,
      llm,
      followUpQuestion: interpretation.followUpQuestion || null,
      usedFallback: interpretation.usedFallback || false,
      stt
    };
  }
}

module.exports = new VoiceCommandService();
