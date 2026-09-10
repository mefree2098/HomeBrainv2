'use strict';

const { createHash } = require('node:crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS = {
  room: new Set(['turn_on', 'turn_off', 'set_brightness']),
  light: new Set(['turn_on', 'turn_off', 'set_brightness']),
  workflow: new Set(['run']),
  scene: new Set(['activate'])
};

function problem(status, message) {
  return Object.assign(new Error(message), { status });
}
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function id(value) { return String(value?._id || value?.id || ''); }
function account(user) {
  const userId = id(user);
  if (!userId) throw problem(401, 'Sign in to HomeBrain first.');
  return userId;
}
function normalizeCommand(user, input) {
  const userId = account(user);
  if (user.isReadOnly) throw problem(403, 'Read-only accounts cannot run Siri commands.');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw problem(400, 'Invalid Siri command.');
  if (input.accountId !== userId) throw problem(409, 'This shortcut belongs to a different HomeBrain account. Select its action again.');
  if (typeof input.requestId !== 'string' || !UUID.test(input.requestId)) throw problem(400, 'A UUID requestId is required.');
  if (!Object.hasOwn(ACTIONS, input.kind) || !ACTIONS[input.kind].has(input.action)) throw problem(400, 'Unsupported Siri action.');
  if (typeof input.targetId !== 'string' || !input.targetId.trim() || input.targetId.length > 512) throw problem(400, 'A valid targetId is required.');
  if (input.action === 'set_brightness' && (!Number.isInteger(input.brightness) || input.brightness < 0 || input.brightness > 100)) {
    throw problem(400, 'Brightness must be an integer from 0 to 100.');
  }
  return {
    accountId: userId, requestId: input.requestId.toLowerCase(), kind: input.kind,
    targetId: input.targetId, action: input.action,
    ...(input.action === 'set_brightness' ? { brightness: input.brightness } : {})
  };
}
function fingerprint(command) {
  return createHash('sha256').update(JSON.stringify(command)).digest('hex');
}

/** Pure orchestration; production adapters supply existing device/workflow engines and MongoDB. */
class SiriCommandService {
  constructor({ store, devices, workflows, scenes, now = () => Date.now(), heartbeatMs = 10_000 }) {
    Object.assign(this, { store, devices, workflows, scenes, now, heartbeatMs });
  }

  async catalog(user) {
    const accountId = account(user);
    const [lights, workflows, scenes] = await Promise.all([
      this.devices.list(), this.workflows.list(), this.scenes.list()
    ]);
    const targets = [];
    const rooms = new Set();
    for (const light of lights) {
      if (text(light.type).toLowerCase() !== 'light' || !id(light)) continue;
      const room = text(light.room);
      if (room) rooms.add(room);
      targets.push({ kind: 'light', id: id(light), name: text(light.name) || 'Unnamed light', room, aliases: [] });
    }
    for (const room of rooms) targets.push({ kind: 'room', id: room, name: `${room} lights`, room, aliases: [room] });
    for (const workflow of workflows) {
      if (workflow.enabled !== true || !id(workflow)) continue;
      targets.push({ kind: 'workflow', id: id(workflow), name: text(workflow.name), room: '',
        aliases: Array.isArray(workflow.voiceAliases) ? workflow.voiceAliases.filter((v) => typeof v === 'string').map((v) => v.trim()).filter(Boolean).slice(0, 30) : [] });
    }
    for (const scene of scenes) {
      if (id(scene)) targets.push({ kind: 'scene', id: id(scene), name: text(scene.name), room: '', aliases: [] });
    }
    targets.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return { success: true, accountId, canExecute: !user.isReadOnly, targets };
  }

  result(record) {
    // Never re-run a command whose worker stopped reporting; its physical effects are uncertain.
    const stale = record.state === 'running' && this.now() - new Date(record.heartbeatAt).getTime() > 60_000;
    return {
      success: record.state !== 'failed' && !stale,
      requestId: record.requestId,
      state: stale ? 'unknown' : record.state,
      message: stale ? 'HomeBrain cannot confirm the result. Check device state or workflow history before running it again.' : record.message,
      ...(record.results ? { results: record.results } : {})
    };
  }

  async get(user, requestId) {
    if (typeof requestId !== 'string' || !UUID.test(requestId)) throw problem(400, 'Invalid requestId.');
    const record = await this.store.get(account(user), requestId.toLowerCase());
    if (!record) throw problem(404, 'Siri command not found for this account.');
    return this.result(record);
  }

  async start(user, input) {
    const command = normalizeCommand(user, input);
    const hash = fingerprint(command);
    const existing = await this.store.get(command.accountId, command.requestId);
    if (existing) {
      if (existing.fingerprint !== hash) throw problem(409, 'This requestId was already used for another command.');
      return this.result(existing);
    }
    const catalog = await this.catalog(user);
    const target = catalog.targets.find((entry) => entry.kind === command.kind && entry.id === command.targetId);
    if (!target) throw problem(404, 'The selected target is unavailable, removed, or disabled. Update the shortcut in Shortcuts.');
    const record = {
      userId: command.accountId, requestId: command.requestId, fingerprint: hash,
      state: 'running', message: `Started ${target.name}. Check HomeBrain for completion.`,
      heartbeatAt: new Date(this.now()), expiresAt: new Date(this.now() + 7 * 86_400_000)
    };
    try {
      // Atomic unique index prevents two devices/retries from starting the same invocation twice.
      await this.store.create(record);
    } catch (error) {
      if (error.code !== 11000) throw error;
      const winner = await this.store.get(command.accountId, command.requestId);
      if (!winner || winner.fingerprint !== hash) throw problem(409, 'This requestId was already used for another command.');
      return this.result(winner);
    }
    // Do not hold Siri's HTTP request open for workflow delays. Persist completion/failure and
    // expose a separately authenticated polling endpoint. No automatic mutation retries.
    void this.run(command, target).catch(() => {
      // Persistence failure leaves the retained invocation unknown rather than re-executing it.
      console.error('Siri command result could not be persisted. Check workflow history.');
    });
    return this.result(record);
  }

  async run(command, target) {
    const update = (fields) => this.store.update(command.accountId, command.requestId, fields);
    const heartbeat = setInterval(() => {
      void update({ heartbeatAt: new Date(this.now()) }).catch(() => {});
    }, this.heartbeatMs);
    heartbeat.unref?.();
    try {
      const result = await this.execute(command, target);
      await update({ ...result, heartbeatAt: new Date(this.now()) });
    } catch (_error) {
      await update({ state: 'failed', message: `HomeBrain could not complete ${target.name}. Check device connectivity or workflow history.`, heartbeatAt: new Date(this.now()) });
    } finally {
      clearInterval(heartbeat);
    }
  }

  async execute(command, target) {
    const context = { source: 'siri', actor: command.accountId, reason: `Siri: ${command.action} ${target.name}` };
    if (command.kind === 'workflow') {
      const execution = await this.workflows.run(target.id, {
        triggerType: 'manual', triggerSource: 'siri',
        context: { siriRequestId: command.requestId, commandContext: context }
      });
      const succeeded = execution?.success === true;
      return { state: succeeded ? 'completed' : 'failed', message: succeeded ? `Finished ${target.name}.` : `${target.name} did not complete successfully. Check its workflow history.` };
    }
    if (command.kind === 'scene') {
      const execution = await this.scenes.run(target.id, { waitForCompletion: true, command: context });
      const failed = execution?.status !== 'success' || execution?.success === false
        || execution?.actionResults?.some((entry) => entry.success === false || entry.status === 'failed');
      return { state: failed ? 'failed' : 'completed', message: failed ? `${target.name} did not complete successfully. Check the scene in HomeBrain.` : `Activated ${target.name}.` };
    }
    const lights = (await this.devices.list()).filter((device) => text(device.type).toLowerCase() === 'light'
      && (command.kind === 'light' ? id(device) === target.id : text(device.room) === target.id));
    if (lights.length === 0) throw problem(404, 'No lights remain in the selected target.');
    const results = new Array(lights.length);
    let next = 0;
    // A bounded worker pool keeps rooms responsive without flooding physical integrations.
    await Promise.all(Array.from({ length: Math.min(4, lights.length) }, async () => {
      while (next < lights.length) {
        const index = next++;
        const light = lights[index];
        try {
          await this.devices.control(id(light), command.action, command.brightness, { command: context });
          results[index] = { deviceId: id(light), success: true };
        } catch (_error) {
          results[index] = { deviceId: id(light), success: false };
        }
      }
    }));
    const count = results.filter((entry) => entry.success).length;
    const succeeded = count === results.length;
    const verb = command.action === 'turn_on' ? 'Turned on' : command.action === 'turn_off' ? 'Turned off' : `Set brightness to ${command.brightness} percent for`;
    return { state: succeeded ? 'completed' : 'failed', results,
      message: succeeded ? `${verb} ${target.name}.` : `Only ${count} of ${results.length} lights responded for ${target.name}. Check the remaining lights in HomeBrain.` };
  }
}

module.exports = { SiriCommandService, normalizeCommand, fingerprint, problem };
