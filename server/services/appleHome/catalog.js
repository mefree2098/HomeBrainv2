'use strict';
const { createHash } = require('node:crypto');

const id = (record) => String(record?._id || record?.id || '');
const text = (value) => typeof value === 'string' ? value.trim() : '';
const normal = (value) => text(value).normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
const digest = (value) => createHash('sha256').update(value).digest('hex');
// HAP names must start/end with a letter or number. Preserve real names, not raw control bytes.
function homeName(value) {
  const characters = [...text(value).slice(0, 512).normalize('NFKC').replace(/[^\p{L}\p{N} '\-]/gu, ' ').replace(/\s+/g, ' ')].slice(0, 64);
  let start = 0, end = characters.length;
  while (start < end && !/[\p{L}\p{N}]/u.test(characters[start])) start++;
  while (end > start && !/[\p{L}\p{N}]/u.test(characters[end - 1])) end--;
  return characters.slice(start, end).join('');
}
const DEVICE_TYPES = new Set(['light', 'switch', 'media_activity']);
const SAFE_ACTIONS = new Set(['turn_on', 'turn_off', 'turnon', 'turnoff', 'on', 'off', 'toggle',
  'set_brightness', 'setbrightness', 'set_color', 'setcolor', 'set_color_temperature',
  'setcolortemperature', 'harmony_command', 'harmonycommand', 'start_activity', 'stop_activity']);

/** Only publish workflows whose reachable actions are safe to expose as ordinary Home switches.
 * Security devices and opaque HTTP/ISY/robot actions must not bypass HomeKit's security UI.
 * This is a conservative discovery policy, not a substitute for the existing command engine.
 */
function createSafetyPolicy({ devices: visibleDevices, safetyDevices, workflows, scenes, groups = [] }) {
  const devices = safetyDevices || visibleDevices;
  const deviceMap = new Map(devices.map((d) => [id(d), d]));
  const workflowMap = new Map(workflows.map((w) => [id(w), w]));
  const sceneMap = new Map(scenes.map((s) => [id(s), s]));
  const groupMap = new Map(groups.map((g) => [id(g), g]));
  const safeDevice = (d) => DEVICE_TYPES.has(d?.type) && d?.properties?.isSecurityDevice !== true
    && d?.properties?.supportsAlarm !== true && d?.properties?.supportsSirenSound !== true
    && !d?.properties?.securityZoneId && !d?.properties?.securityZone
    && !normal(d?.properties?.source).includes('security');
  function groupSafe(groupId, seen = new Set()) {
    const group = groupMap.get(String(groupId));
    if (!group || seen.has(id(group)) || seen.size > 16) return false;
    const next = new Set([...seen, id(group)]);
    const members = devices.filter((d) => Array.isArray(d.groups) && d.groups.some((g) =>
      String(g) === id(group) || normal(String(g)) === normal(group.name)));
    const children = group.childGroupIds || [];
    return (members.length > 0 || children.length > 0) && members.every(safeDevice)
      && children.every((child) => groupSafe(String(child), next));
  }
  function targetSafe(target) {
    if (typeof target === 'string') return safeDevice(deviceMap.get(target));
    if (!target || typeof target !== 'object' || Array.isArray(target)) return false;
    if (target.kind === 'device_group' || target.kind === 'group') {
      const found = groups.find((g) => id(g) === String(target.groupId || '') || normal(g.name) === normal(target.group));
      return found ? groupSafe(id(found)) : false;
    }
    return safeDevice(deviceMap.get(String(target.deviceId || target.id || '')));
  }
  function sceneSafe(sceneId, seen = new Set()) {
    const scene = sceneMap.get(String(sceneId));
    if (!scene || scene.category === 'security') return false;
    const actions = [...(scene.deviceActions || []), ...(scene.groupActions || [])];
    return actions.length > 0 && actions.every((a) => SAFE_ACTIONS.has(a.action)
      && (a.groupId ? groupSafe(String(a.groupId)) : targetSafe(String(a.deviceId))));
  }
  function actionsSafe(actions, seen, depth = 0) {
    if (!Array.isArray(actions) || actions.length > 1000 || depth > 16) return false;
    return actions.every((a) => {
      const p = a?.parameters || {};
      switch (a?.type) {
        case 'device_control': return SAFE_ACTIONS.has(text(p.action || a.action).toLowerCase())
          && targetSafe(a.target || p.deviceId);
        case 'scene_activate': return sceneSafe(a.target || p.sceneId, seen);
        case 'workflow_control': {
          const operation = text(p.operation || p.action || 'run_if').toLowerCase();
          // Match executeWorkflowControl's explicit-ID precedence; do not guess by name/ISY marker.
          return ['run', 'run_if', 'if', 'run_then', 'then', 'run_else', 'else'].includes(operation)
            && workflowSafe(String(p.workflowId || p.targetWorkflowId || p.target || ''), seen);
        }
        case 'repeat': return actionsSafe(p.actions || [], seen, depth + 1);
        case 'condition': return ['onFalseActions', 'onTrueActions', 'thenActions', 'elseActions', 'actions']
          .every((key) => !p[key] || actionsSafe(p[key], seen, depth + 1));
        case 'notification': case 'delay': case 'alexa_speak': return true;
        default: return false;
      }
    });
  }
  function workflowSafe(workflowId, seen = new Set()) {
    const w = workflowMap.get(workflowId);
    if (!w || w.enabled !== true || w.category === 'security' || seen.has(workflowId) || seen.size >= 16) return false;
    return w.actions?.length > 0 && actionsSafe(w.actions, new Set([...seen, workflowId]));
  }
  return { safeDevice, sceneSafe, workflowSafe };
}

function catalog(input, namespace, supportsBrightness = (d) => d.type === 'light' || d.properties?.supportsBrightness === true) {
  const { devices, workflows, scenes } = input;
  const safety = createSafetyPolicy(input);
  const targets = [], skipped = [];
  function add(kind, record, extra = {}) {
    const key = `${kind}:${id(record)}`;
    const name = homeName(record.name);
    if (!id(record) || !name) { skipped.push({ id: key, name: text(record.name), reason: 'Missing usable name or ID.' }); return; }
    targets.push({ key, kind, id: id(record), name, room: homeName(record.room) || 'HomeBrain',
      serial: `HB${digest(namespace + ':' + key).slice(0, 30)}`, aliases: [], ...extra });
  }
  for (const device of devices) {
    if (safety.safeDevice(device)) add(device.type === 'light' ? 'light' : 'switch', device,
      { brightness: supportsBrightness(device), online: device.isOnline !== false });
    else skipped.push({ id: `device:${id(device)}`, name: text(device.name), reason: 'Device type is not exported by this bridge (security devices are excluded).' });
  }
  for (const workflow of workflows) {
    if (workflow.enabled !== true) continue;
    if (safety.workflowSafe(id(workflow))) add('workflow', workflow, {
      aliases: [...new Set((workflow.voiceAliases || []).filter((a) => typeof a === 'string').map(homeName).filter(Boolean))].slice(0, 30)
    });
    else skipped.push({ id: `workflow:${id(workflow)}`, name: text(workflow.name), reason: 'Workflow contains security, unresolved, or opaque actions; not safe to publish as an unrestricted Home trigger.' });
  }
  for (const scene of scenes) {
    if (safety.sceneSafe(id(scene))) add('scene', scene);
    else skipped.push({ id: `scene:${id(scene)}`, name: text(scene.name), reason: 'Scene contains security or unresolved device/group actions.' });
  }
  // Avoid ambiguous accessories without changing scene names. Scene-name conflicts are reported in iOS.
  const names = new Map();
  for (const target of targets) names.set(normal(target.name), (names.get(normal(target.name)) || 0) + 1);
  for (const target of targets) {
    target.sceneNames = ['workflow', 'scene'].includes(target.kind) ? [...new Set([target.name, ...target.aliases])] : [];
    if (names.get(normal(target.name)) > 1) target.name = `${target.name.slice(0, 50)} ${target.kind} ${digest(target.key).slice(0, 4)}`;
  }
  targets.sort((a, b) => a.key.localeCompare(b.key));
  return { targets, skipped };
}

/** Stable shard assignments: adding/removing an accessory never migrates an existing accessory. */
function assignBridges(targets, previous = {}, capacity = 149) {
  const assignments = {};
  const used = new Map();
  for (const target of targets) {
    const shard = previous[target.key];
    if (Number.isInteger(shard) && shard >= 0 && shard < 32 && (used.get(shard) || 0) < capacity) {
      assignments[target.key] = shard; used.set(shard, (used.get(shard) || 0) + 1);
    }
  }
  for (const target of targets) {
    if (Object.hasOwn(assignments, target.key)) continue;
    let shard = 0;
    while ((used.get(shard) || 0) >= capacity) shard++;
    if (shard >= 32) throw new Error('Apple Home bridge capacity exceeded.');
    assignments[target.key] = shard; used.set(shard, (used.get(shard) || 0) + 1);
  }
  return assignments;
}
module.exports = { catalog, assignBridges, createSafetyPolicy, id, normal, homeName, digest };
