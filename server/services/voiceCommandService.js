const Device = require('../models/Device');
const Scene = require('../models/Scene');
const deviceService = require('./deviceService');
const sceneService = require('./sceneService');
const automationService = require('./automationService');
const workflowService = require('./workflowService');
const insteonService = require('./insteonService');
const { sendLLMRequestWithFallbackDetailed } = require('./llmService');

const ACTION_MAP = {
  turn_on: 'turnOn',
  turnoff: 'turnOff',
  turn_off: 'turnOff',
  turnon: 'turnOn',
  toggle: 'toggle',
  set_brightness: 'setBrightness',
  setbrightness: 'setBrightness',
  set_color: 'setColor',
  setcolor: 'setColor',
  set_temperature: 'setTemperature',
  settemperature: 'setTemperature',
  lock: 'lock',
  unlock: 'unlock',
  open: 'open',
  close: 'close'
};

class VoiceCommandService {
  constructor() {
    this.lastContextCache = { updatedAt: 0, data: null };
    this.CONTEXT_TTL_MS = 15_000;
  }

  getDeviceCapabilities(type, source = 'local') {
    const normalizedSource = (source || 'local').toLowerCase();
    if (normalizedSource === 'harmony') {
      return ['turn_on', 'turn_off', 'toggle'];
    }

    switch ((type || '').toLowerCase()) {
      case 'light':
        return ['turn_on', 'turn_off', 'set_brightness', 'set_color'];
      case 'switch':
        return ['turn_on', 'turn_off', 'toggle'];
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

  async getContext() {
    const now = Date.now();
    if (this.lastContextCache.data && now - this.lastContextCache.updatedAt < this.CONTEXT_TTL_MS) {
      return this.lastContextCache.data;
    }

    const [devices, scenes] = await Promise.all([
      Device.find().lean(),
      Scene.find().select('_id name room category').lean()
    ]);

    const deviceMap = new Map();
    const devicesWithMeta = devices.map((device) => {
      const normalized = {
        id: device._id.toString(),
        name: device.name,
        room: device.room,
        type: device.type,
        source: (device?.properties?.source || 'local').toString().toLowerCase(),
        capabilities: this.getDeviceCapabilities(device.type, (device?.properties?.source || 'local').toString()),
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

    const context = {
      devices: devicesWithMeta,
      scenes: scenesWithMeta,
      raw: {
        devices,
        scenes
      },
      deviceMap,
      sceneMap
    };

    this.lastContextCache = { updatedAt: now, data: context };
    return context;
  }

  buildPrompt(commandText, { room, wakeWord, devices, scenes }) {
    const primaryRoom = room || 'unknown';
    const wakeWordLabel = wakeWord || 'unknown';

    const sortedDevices = [...devices].sort((a, b) => {
      if (a.room === primaryRoom && b.room !== primaryRoom) return -1;
      if (b.room === primaryRoom && a.room !== primaryRoom) return 1;
      return a.name.localeCompare(b.name);
    }).slice(0, 40);

    const sortedScenes = [...scenes].slice(0, 20);

    const deviceLines = sortedDevices.map((device, index) => {
      return `${index + 1}. ID:${device.id} | Name:${device.name} | Room:${device.room} | Type:${device.type} | Source:${device.source} | Capabilities:${device.capabilities.join(',')}`;
    }).join('\n');

    const sceneLines = sortedScenes.map((scene, index) => {
      return `${index + 1}. ID:${scene.id} | Name:${scene.name} | Room:${scene.room} | Category:${scene.category}`;
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

USER COMMAND
"${commandText}"

OUTPUT FORMAT (must be valid JSON ONLY, no surrounding text):
{
  "intent": "<intent_type>",  // choose one: device_control, scene_activate, automation_create, workflow_create, workflow_control, query, system_control, unknown
  "confidence": 0.0-1.0,
  "normalizedCommand": "Short paraphrase of the user's request",
  "actions": [
    {
      "type": "<action_type>",  // choose one: device_control, scene_activate, automation_create, workflow_create, workflow_control, query
      "deviceId": "DEVICE_ID_FROM_LIST",
      "sceneId": "SCENE_ID_FROM_LIST",
      "workflowId": "WORKFLOW_ID_IF_KNOWN",
      "workflowName": "WORKFLOW_NAME_IF_REFERENCED",
      "operation": "run|enable|disable",
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
3. For brightness actions return percentages (0-100). For temperature, use whole-number Fahrenheit unless the user specifies another scale.
4. Use "workflow_create" when the user asks to create/schedule a routine or workflow. Use "workflow_control" when the user asks to run/enable/disable an existing workflow. Immediate commands like "turn on the vault light" must stay "device_control".
5. If the request is a general question or not about controlling devices, set intent to "query", leave "actions" empty, and provide the direct answer in "response". Only use "followUpQuestion" when clarification is required.
6. Never return empty "actions" for "device_control" intents.
7. Make the "response" friendly, short, and actionable (e.g., "Turning on the vault light.") or informative for queries.
8. If a selected device has Source:harmony, only use turn_on, turn_off, or toggle. Treat it as a Harmony Hub activity target (start/stop), not a dimmable light or thermostat.

Return ONLY the JSON object with no commentary.`; 
  }

  parseLlmResponse(rawResponse) {
    if (!rawResponse) {
      return null;
    }
    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return null;
    }
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (error) {
      console.warn('VoiceCommandService: Failed to parse LLM JSON response:', error.message);
      return null;
    }
  }

  findBestDevice(commandText, devices) {
    const text = commandText.toLowerCase();
    let best = null;
    let bestScore = 0;

    for (const device of devices) {
      const nameTokens = device.name.toLowerCase().split(/\s+/);
      let score = 0;
      for (const token of nameTokens) {
        if (token.length < 3) continue;
        if (text.includes(token)) {
          score += 1;
        }
      }

      if (device.room && text.includes(device.room.toLowerCase())) {
        score += 1.5;
      }

      if (score > bestScore) {
        best = device;
        bestScore = score;
      }
    }

    return best;
  }

  extractNumber(commandText) {
    const percentMatch = commandText.match(/(\d+)\s*%/);
    if (percentMatch) {
      return Number(percentMatch[1]);
    }
    const numberMatch = commandText.match(/(?:to|at|set|bright(?:ness)?|level|temperature|heat|cool)\s*(\d{1,3})/i);
    if (numberMatch) {
      return Number(numberMatch[1]);
    }
    return null;
  }

  fallbackInterpretation(commandText, context, room) {
    const text = commandText.toLowerCase();
    const actions = [];
    const device = this.findBestDevice(commandText, context.devices);

    if (!device) {
      return null;
    }

    const value = this.extractNumber(commandText);

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
    if (text.includes('dim') || text.includes('brightness') || text.includes('bright')) {
      actionCandidates.push('set_brightness');
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

    actions.push({
      type: 'device_control',
      deviceId: device.id,
      action: actionCandidates[0],
      value: value != null ? value : undefined,
      room: room || device.room
    });

    return {
      intent: 'device_control',
      confidence: 0.55,
      normalizedCommand: commandText,
      actions,
      response: `Okay, ${actionCandidates[0].replace('_', ' ')} ${device.name}.`,
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

    const directActionPattern = /\b(turn|switch)\s+(on|off)\b|\b(dim|brighten)\b|\bset\s+(?:the\s+)?(?:brightness|temperature)\b|\b(lock|unlock)\b|\b(open|close)\b|\bactivate\s+\w+/;

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
    if (name === 'set_color' || name === 'setcolor') {
      if (typeof action.value === 'string') {
        return action.value.trim();
      }
    }
    if (name === 'turn_on' && action.value != null && device?.type === 'light') {
      const numeric = Number(action.value);
      if (Number.isFinite(numeric)) {
        return Math.max(0, Math.min(100, Math.round(numeric)));
      }
    }
    return action.value;
  }

  async executeDeviceAction(action, context) {
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
    const source = (deviceRecord?.properties?.source || '').toLowerCase();

    try {
      if (source === 'insteon') {
        await this.executeInsteonAction(deviceRecord, normalizedAction, value);
      } else {
        const actionName = mappedAction || normalizedAction.replace(/[^a-z]/g, '');
        await deviceService.controlDevice(deviceRecord._id.toString(), actionName, value);
      }

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
      default:
        throw new Error(`Action "${normalizedAction}" not supported for Insteon devices`);
    }
  }

  async executeSceneAction(action) {
    const result = {
      type: 'scene_activate',
      sceneId: action.sceneId,
      success: false,
      message: ''
    };

    try {
      const activation = await sceneService.activateScene(action.sceneId);
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
        result.success = true;
        result.message = creation?.message || 'Automation created';
        result.automationId = creation?.automation?._id?.toString();
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
        result.success = true;
        result.message = creation?.message || 'Workflow created';
        result.workflowId = creation?.workflow?._id?.toString();
      }

      return result;
    } catch (error) {
      result.success = false;
      result.message = error.message || 'Failed to create workflow';
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

  async executeActions(actions, context, room) {
    const entities = { devices: [], scenes: [], actions: [] };
    const executionResults = [];

    for (const action of actions) {
      if (!action || typeof action !== 'object') continue;
      if (action.type === 'device_control' && action.deviceId) {
        const deviceResult = await this.executeDeviceAction(action, context);
        executionResults.push(deviceResult);
        if (deviceResult.deviceId) {
          entities.devices.push({
            name: deviceResult.deviceName,
            room: deviceResult.room,
            deviceId: deviceResult.deviceId
          });
        }
      } else if (action.type === 'scene_activate' && action.sceneId) {
        const sceneResult = await this.executeSceneAction(action);
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
      if (item.type === 'workflow_create' || item.type === 'workflow_control') {
        return item.message;
      }
      return item.message;
    }).filter(Boolean);

    return lines.join('. ') || 'Done.';
  }

  async interpretCommand(commandText, context, room, wakeWord) {
    const prompt = this.buildPrompt(commandText, {
      devices: context.devices,
      scenes: context.scenes,
      room,
      wakeWord
    });

    const startedAt = Date.now();
    try {
      const firstAttempt = await sendLLMRequestWithFallbackDetailed(prompt);
      let { response, provider, model } = firstAttempt;
      let parsed = this.parseLlmResponse(response);

      if (!parsed) {
        console.warn(`VoiceCommandService: First LLM (provider=${provider || 'unknown'}) failed to return valid JSON.`);
        const providerKey = (provider || '').toLowerCase();
        if (providerKey === 'local') {
          const cloudProviders = ['openai', 'anthropic'];
          try {
            const cloudAttempt = await sendLLMRequestWithFallbackDetailed(prompt, cloudProviders);
            response = cloudAttempt.response;
            provider = cloudAttempt.provider;
            model = cloudAttempt.model;
            parsed = this.parseLlmResponse(response);
            console.log(`VoiceCommandService: Second LLM attempt with ${provider || 'unknown'} ${parsed ? 'succeeded' : 'still failed'}.`);
          } catch (fallbackError) {
            console.warn('VoiceCommandService: Cloud fallback attempt failed:', fallbackError.message);
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
          prompt,
          rawResponse: response,
          processingTimeMs
        }
      };
    } catch (error) {
      console.warn('VoiceCommandService: LLM interpretation failed:', error.message);
      return {
        interpretation: null,
        llm: {
          provider: null,
          model: null,
          prompt,
          rawResponse: null,
          processingTimeMs: Date.now() - startedAt,
          error: error.message
        }
      };
    }
  }

  async processCommand(options) {
    const {
      commandText,
      room,
      wakeWord,
      deviceId,
      stt
    } = options;

    const context = await this.getContext();

    let interpretation = null;
    let llm = {
      provider: null,
      model: null,
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

    const likelyAutomation = this.isLikelyAutomationRequest(commandText);
    const hasAutomationLikeActions = Array.isArray(interpretation?.actions) &&
      interpretation.actions.some((action) => ['automation_create', 'workflow_create'].includes(action?.type));

    if (
      interpretation &&
      !likelyAutomation &&
      (['automation_create', 'workflow_create'].includes(interpretation.intent) || hasAutomationLikeActions)
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
          !['automation_create', 'workflow_create'].includes(action?.type)
        );
        if (filteredActions.length) {
          interpretation = {
            ...interpretation,
            actions: filteredActions,
            intent: ['automation_create', 'workflow_create'].includes(interpretation.intent)
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

    const hasActions = Array.isArray(interpretation?.actions) && interpretation.actions.length > 0;

    if (!interpretation || !hasActions) {
      interpretation = this.fallbackInterpretation(commandText, context, room);
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

    const execution = await this.executeActions(interpretation.actions || [], context, room);
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
