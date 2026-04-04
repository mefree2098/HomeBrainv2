const mongoose = require('mongoose');
const AlexaExposure = require('../models/AlexaExposure');
const Device = require('../models/Device');
const DeviceGroup = require('../models/DeviceGroup');
const Workflow = require('../models/Workflow');
const Automation = require('../models/Automation');
const insteonService = require('./insteonService');
const deviceUpdateEmitter = require('./deviceUpdateEmitter');

const DEVICE_GROUP_TARGET_KINDS = new Set(['device_group', 'group']);

function sanitizeString(value) {
  return typeof value === 'string' ? value.trim() : String(value || '').trim();
}

function normalizeGroupName(value) {
  return sanitizeString(value).toLowerCase();
}

function normalizeGroupList(groups) {
  const values = Array.isArray(groups)
    ? groups
    : typeof groups === 'string'
      ? groups.split(',')
      : [];

  const seen = new Set();
  const normalized = [];

  values.forEach((entry) => {
    const trimmed = sanitizeString(entry);
    if (!trimmed) {
      return;
    }

    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    normalized.push(trimmed);
  });

  return normalized;
}

function normalizeObjectIdList(values) {
  const entries = Array.isArray(values)
    ? values
    : typeof values === 'string'
      ? values.split(',')
      : [];

  const seen = new Set();
  const normalized = [];

  entries.forEach((entry) => {
    const value = sanitizeString(entry?._id?.toString?.() || entry?.toString?.() || entry);
    if (!value || seen.has(value)) {
      return;
    }

    seen.add(value);
    normalized.push(value);
  });

  return normalized;
}

function escapeRegexLiteral(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toIdString(value) {
  return sanitizeString(value?._id?.toString?.() || value?.toString?.() || value);
}

function buildMemberMap(devices = []) {
  const map = new Map();

  devices.forEach((device) => {
    normalizeGroupList(device?.groups).forEach((groupName) => {
      const key = groupName.toLowerCase();
      if (!map.has(key)) {
        map.set(key, {
          name: groupName,
          devices: []
        });
      }

      map.get(key).devices.push(device);
    });
  });

  return map;
}

function buildGroupRelationshipMaps(groups = []) {
  const groupsById = new Map();
  groups.forEach((group) => {
    const groupId = toIdString(group?._id);
    if (groupId) {
      groupsById.set(groupId, group);
    }
  });

  const childGroupIdsById = new Map();
  const parentGroupIdsById = new Map();

  groups.forEach((group) => {
    const groupId = toIdString(group?._id);
    if (!groupId) {
      return;
    }

    const childGroupIds = normalizeObjectIdList(group?.childGroupIds).filter((childId) => groupsById.has(childId));
    childGroupIdsById.set(groupId, childGroupIds);

    childGroupIds.forEach((childId) => {
      if (!parentGroupIdsById.has(childId)) {
        parentGroupIdsById.set(childId, []);
      }
      parentGroupIdsById.get(childId).push(groupId);
    });
  });

  return {
    groupsById,
    childGroupIdsById,
    parentGroupIdsById
  };
}

function buildDirectDeviceMap(groups = [], memberMap = new Map()) {
  const directDevicesByGroupId = new Map();

  groups.forEach((group) => {
    const groupId = toIdString(group?._id);
    if (!groupId) {
      return;
    }

    const normalizedName = normalizeGroupName(group?.normalizedName || group?.name);
    const membership = memberMap.get(normalizedName);
    directDevicesByGroupId.set(
      groupId,
      Array.isArray(membership?.devices) ? membership.devices.slice() : []
    );
  });

  return directDevicesByGroupId;
}

function deriveGroupKind({ directDeviceCount = 0, childGroupCount = 0 } = {}) {
  if (childGroupCount > 0 && directDeviceCount > 0) {
    return 'hybrid';
  }
  if (childGroupCount > 0) {
    return 'master';
  }
  return 'direct';
}

function buildDeviceFacetSummary(devices = []) {
  const rooms = new Set();
  const types = new Set();
  const sources = new Set();

  devices.forEach((device) => {
    if (device?.room) {
      rooms.add(device.room);
    }
    if (device?.type) {
      types.add(device.type);
    }

    const source = sanitizeString(device?.properties?.source || 'local').toLowerCase();
    if (source) {
      sources.add(source);
    }
  });

  return {
    rooms: Array.from(rooms).sort((left, right) => left.localeCompare(right)),
    types: Array.from(types).sort((left, right) => left.localeCompare(right)),
    sources: Array.from(sources).sort((left, right) => left.localeCompare(right))
  };
}

function resolveGroupDevicesRecursive(groupId, context, ancestry = []) {
  const {
    groupsById,
    childGroupIdsById,
    directDevicesByGroupId,
    resolvedDeviceCache
  } = context;

  if (resolvedDeviceCache.has(groupId)) {
    return resolvedDeviceCache.get(groupId);
  }

  const group = groupsById.get(groupId);
  const directDevices = Array.isArray(directDevicesByGroupId.get(groupId))
    ? directDevicesByGroupId.get(groupId).slice()
    : [];
  const childGroupIds = Array.isArray(childGroupIdsById.get(groupId))
    ? childGroupIdsById.get(groupId).slice()
    : [];

  if (!group) {
    const fallback = {
      directDevices,
      devices: directDevices,
      childGroupIds,
      descendantGroupIds: [],
      hasCycle: false
    };
    resolvedDeviceCache.set(groupId, fallback);
    return fallback;
  }

  if (ancestry.includes(groupId)) {
    return {
      directDevices,
      devices: directDevices,
      childGroupIds,
      descendantGroupIds: [],
      hasCycle: true
    };
  }

  const seenDeviceIds = new Set();
  const effectiveDevices = [];
  const descendantGroupIds = new Set();
  let hasCycle = false;

  const addDevice = (device) => {
    const deviceId = toIdString(device?._id);
    if (!deviceId || seenDeviceIds.has(deviceId)) {
      return;
    }

    seenDeviceIds.add(deviceId);
    effectiveDevices.push(device);
  };

  directDevices.forEach(addDevice);

  childGroupIds.forEach((childGroupId) => {
    descendantGroupIds.add(childGroupId);
    const resolvedChild = resolveGroupDevicesRecursive(childGroupId, context, [...ancestry, groupId]);
    if (resolvedChild.hasCycle) {
      hasCycle = true;
    }

    resolvedChild.descendantGroupIds.forEach((descendantId) => descendantGroupIds.add(descendantId));
    resolvedChild.devices.forEach(addDevice);
  });

  const resolved = {
    directDevices,
    devices: effectiveDevices,
    childGroupIds,
    descendantGroupIds: Array.from(descendantGroupIds),
    hasCycle
  };

  resolvedDeviceCache.set(groupId, resolved);
  return resolved;
}

function isDeviceGroupTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const kind = sanitizeString(value.kind || value.type).toLowerCase();
  return DEVICE_GROUP_TARGET_KINDS.has(kind) && Boolean(sanitizeString(value.group));
}

function collectGroupReferenceKeys(value, bucket = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectGroupReferenceKeys(entry, bucket));
    return bucket;
  }

  if (!value || typeof value !== 'object') {
    return bucket;
  }

  if (isDeviceGroupTarget(value)) {
    bucket.add(normalizeGroupName(value.group));
  }

  Object.values(value).forEach((entry) => collectGroupReferenceKeys(entry, bucket));
  return bucket;
}

function renameGroupReferences(value, currentNormalizedName, nextGroupName) {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const result = renameGroupReferences(entry, currentNormalizedName, nextGroupName);
      changed = changed || result.changed;
      return result.value;
    });

    return { value: changed ? next : value, changed };
  }

  if (!value || typeof value !== 'object') {
    return { value, changed: false };
  }

  if (isDeviceGroupTarget(value) && normalizeGroupName(value.group) === currentNormalizedName) {
    return {
      value: {
        ...value,
        kind: 'device_group',
        group: nextGroupName
      },
      changed: true
    };
  }

  let changed = false;
  const next = {};
  Object.entries(value).forEach(([key, entry]) => {
    const result = renameGroupReferences(entry, currentNormalizedName, nextGroupName);
    next[key] = result.value;
    changed = changed || result.changed;
  });

  return {
    value: changed ? next : value,
    changed
  };
}

async function emitUpdatedDevices(deviceIds = []) {
  if (!Array.isArray(deviceIds) || deviceIds.length === 0) {
    return;
  }

  const updatedDevices = await Device.find({ _id: { $in: deviceIds } });
  const payload = deviceUpdateEmitter.normalizeDevices(updatedDevices);
  if (payload.length > 0) {
    deviceUpdateEmitter.emit('devices:update', payload);
  }
}

class DeviceGroupService {
  async ensureRegistryHydrated(devices = null) {
    const allDevices = Array.isArray(devices) ? devices : await Device.find().lean();
    const memberMap = buildMemberMap(allDevices);
    if (memberMap.size === 0) {
      return [];
    }

    const existingGroups = await DeviceGroup.find().lean();
    const existingKeys = new Set(existingGroups.map((group) => normalizeGroupName(group.normalizedName || group.name)));
    const created = [];

    for (const [normalizedName, entry] of memberMap.entries()) {
      if (existingKeys.has(normalizedName)) {
        continue;
      }

      try {
        // eslint-disable-next-line no-await-in-loop
        const group = new DeviceGroup({
          name: entry.name,
          description: ''
        });
        // eslint-disable-next-line no-await-in-loop
        await group.save();
        created.push(group);
      } catch (error) {
        if (error?.code !== 11000) {
          throw error;
        }
      }
    }

    return created;
  }

  async _buildGroupContext({ devices = null, groups = null } = {}) {
    const allDevices = Array.isArray(devices) ? devices : await Device.find().lean();
    await this.ensureRegistryHydrated(allDevices);

    const allGroups = Array.isArray(groups)
      ? groups
      : await DeviceGroup.find().sort({ name: 1 }).lean();
    const memberMap = buildMemberMap(allDevices);
    const directDevicesByGroupId = buildDirectDeviceMap(allGroups, memberMap);
    const {
      groupsById,
      childGroupIdsById,
      parentGroupIdsById
    } = buildGroupRelationshipMaps(allGroups);

    return {
      devices: allDevices,
      groups: allGroups,
      memberMap,
      groupsById,
      childGroupIdsById,
      parentGroupIdsById,
      directDevicesByGroupId,
      resolvedDeviceCache: new Map()
    };
  }

  _buildGroupSummary(group, context, workflowUsage = new Map(), automationUsage = new Map()) {
    const groupId = toIdString(group?._id);
    const normalizedName = normalizeGroupName(group?.normalizedName || group?.name);
    const resolved = resolveGroupDevicesRecursive(groupId, context);
    const directDevices = Array.isArray(resolved.directDevices) ? resolved.directDevices : [];
    const members = Array.isArray(resolved.devices) ? resolved.devices : [];
    const childGroupIds = Array.isArray(context.childGroupIdsById.get(groupId))
      ? context.childGroupIdsById.get(groupId)
      : [];
    const parentGroupIds = Array.isArray(context.parentGroupIdsById.get(groupId))
      ? context.parentGroupIdsById.get(groupId)
      : [];
    const facets = buildDeviceFacetSummary(members);
    const referencedWorkflows = workflowUsage.get(normalizedName) || [];
    const referencedAutomations = automationUsage.get(normalizedName) || [];

    return {
      _id: groupId,
      name: group.name,
      normalizedName,
      description: group.description || '',
      groupKind: deriveGroupKind({
        directDeviceCount: directDevices.length,
        childGroupCount: childGroupIds.length
      }),
      containsNestedGroups: childGroupIds.length > 0,
      deviceCount: members.length,
      deviceIds: members
        .map((device) => toIdString(device?._id))
        .filter(Boolean),
      deviceNames: members
        .map((device) => sanitizeString(device?.name))
        .filter(Boolean),
      directDeviceCount: directDevices.length,
      directDeviceIds: directDevices
        .map((device) => toIdString(device?._id))
        .filter(Boolean),
      directDeviceNames: directDevices
        .map((device) => sanitizeString(device?.name))
        .filter(Boolean),
      childGroupIds,
      childGroups: childGroupIds
        .map((childId) => {
          const childGroup = context.groupsById.get(childId);
          if (!childGroup) {
            return null;
          }

          const childResolved = resolveGroupDevicesRecursive(childId, context);
          return {
            _id: childId,
            name: childGroup.name,
            normalizedName: normalizeGroupName(childGroup.normalizedName || childGroup.name),
            groupKind: deriveGroupKind({
              directDeviceCount: childResolved.directDevices.length,
              childGroupCount: childResolved.childGroupIds.length
            }),
            deviceCount: childResolved.devices.length
          };
        })
        .filter(Boolean),
      parentGroupIds,
      parentGroupNames: parentGroupIds
        .map((parentId) => context.groupsById.get(parentId)?.name)
        .filter(Boolean),
      rooms: facets.rooms,
      types: facets.types,
      sources: facets.sources,
      workflowUsageCount: referencedWorkflows.length,
      automationUsageCount: referencedAutomations.length,
      workflowNames: referencedWorkflows.map((workflow) => workflow.name),
      automationNames: referencedAutomations.map((automation) => automation.name),
      insteonPlmGroup: Number.isInteger(group.insteonPlmGroup) ? group.insteonPlmGroup : null,
      insteonLastSyncedAt: group.insteonLastSyncedAt || null,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt
    };
  }

  async listGroups() {
    const context = await this._buildGroupContext();
    const [workflows, automations] = await Promise.all([
      Workflow.find().select('_id name actions graph').lean(),
      Automation.find({ workflowId: null }).select('_id name actions workflowGraph').lean()
    ]);

    const workflowUsage = new Map();
    const automationUsage = new Map();

    workflows.forEach((workflow) => {
      const references = collectGroupReferenceKeys({
        actions: workflow.actions || [],
        graph: workflow.graph || null
      });

      references.forEach((reference) => {
        if (!workflowUsage.has(reference)) {
          workflowUsage.set(reference, []);
        }
        workflowUsage.get(reference).push({
          _id: workflow._id?.toString?.() || String(workflow._id),
          name: workflow.name
        });
      });
    });

    automations.forEach((automation) => {
      const references = collectGroupReferenceKeys({
        actions: automation.actions || [],
        workflowGraph: automation.workflowGraph || null
      });

      references.forEach((reference) => {
        if (!automationUsage.has(reference)) {
          automationUsage.set(reference, []);
        }
        automationUsage.get(reference).push({
          _id: automation._id?.toString?.() || String(automation._id),
          name: automation.name
        });
      });
    });

    return context.groups.map((group) => this._buildGroupSummary(group, context, workflowUsage, automationUsage));
  }

  async getGroupById(id) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new Error('Invalid device group ID format');
    }

    const groups = await this.listGroups();
    const group = groups.find((entry) => entry._id === id);
    if (!group) {
      throw new Error('Device group not found');
    }

    return group;
  }

  _assertGroupChildSelection({
    groupId,
    requestedChildGroupIds,
    groupsById,
    childGroupIdsById
  }) {
    if (!Array.isArray(requestedChildGroupIds)) {
      return;
    }

    const unknownChildGroupIds = requestedChildGroupIds.filter((childGroupId) => !groupsById.has(childGroupId));
    if (unknownChildGroupIds.length > 0) {
      throw new Error(`Unknown child group IDs: ${unknownChildGroupIds.join(', ')}`);
    }

    if (requestedChildGroupIds.includes(groupId)) {
      throw new Error('A device group cannot contain itself as a child group');
    }

    const visit = (candidateGroupId, ancestry = new Set()) => {
      if (candidateGroupId === groupId) {
        return true;
      }
      if (ancestry.has(candidateGroupId)) {
        return false;
      }

      ancestry.add(candidateGroupId);
      const nextChildGroupIds = candidateGroupId === groupId
        ? requestedChildGroupIds
        : (childGroupIdsById.get(candidateGroupId) || []);

      for (const childGroupId of nextChildGroupIds) {
        if (visit(childGroupId, ancestry)) {
          return true;
        }
      }

      ancestry.delete(candidateGroupId);
      return false;
    };

    const createsCycle = requestedChildGroupIds.some((childGroupId) => visit(childGroupId, new Set([groupId])));
    if (createsCycle) {
      throw new Error('Device groups cannot be nested in a cycle');
    }
  }

  async _reconcileManagedGroupState(group, { directDevices = null, childGroupIds = null, throwOnError = false } = {}) {
    if (!group || typeof group !== 'object') {
      return null;
    }

    const effectiveChildGroupIds = Array.isArray(childGroupIds)
      ? childGroupIds
      : normalizeObjectIdList(group.childGroupIds);
    const effectiveDirectDevices = Array.isArray(directDevices) ? directDevices : [];
    const shouldUsePlmManagedScene = effectiveChildGroupIds.length === 0;

    try {
      if (shouldUsePlmManagedScene) {
        return await insteonService.syncManagedDeviceGroupMembership(group, effectiveDirectDevices);
      }
      return await insteonService.clearManagedDeviceGroup(group);
    } catch (error) {
      console.warn(`DeviceGroupService: Unable to reconcile managed INSTEON group "${group.name}": ${error.message}`);
      if (throwOnError) {
        throw error;
      }
      return null;
    }
  }

  async createGroup({ name, description = '', deviceIds = [], childGroupIds = [] } = {}) {
    const trimmedName = sanitizeString(name);
    if (!trimmedName) {
      throw new Error('Device group name is required');
    }

    await this.ensureRegistryHydrated();

    const normalizedName = normalizeGroupName(trimmedName);
    const existingGroup = await DeviceGroup.findOne({ normalizedName });
    if (existingGroup) {
      throw new Error('A device group with this name already exists');
    }

    const group = new DeviceGroup({
      name: trimmedName,
      description: sanitizeString(description),
      childGroupIds: []
    });
    await group.save();

    try {
      if (
        (Array.isArray(deviceIds) && deviceIds.length > 0)
        || (Array.isArray(childGroupIds) && childGroupIds.length > 0)
      ) {
        await this.setGroupMembership(group._id.toString(), { deviceIds, childGroupIds });
      }
    } catch (error) {
      await DeviceGroup.deleteOne({ _id: group._id });
      throw error;
    }

    return this.getGroupById(group._id.toString());
  }

  async updateGroup(id, updates = {}) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new Error('Invalid device group ID format');
    }

    const group = await DeviceGroup.findById(id);
    if (!group) {
      throw new Error('Device group not found');
    }

    const nextName = Object.prototype.hasOwnProperty.call(updates, 'name')
      ? sanitizeString(updates.name)
      : group.name;
    const nextDescription = Object.prototype.hasOwnProperty.call(updates, 'description')
      ? sanitizeString(updates.description)
      : group.description || '';

    if (!nextName) {
      throw new Error('Device group name is required');
    }

    const currentNormalizedName = normalizeGroupName(group.normalizedName || group.name);
    const nextNormalizedName = normalizeGroupName(nextName);

    if (currentNormalizedName !== nextNormalizedName) {
      const duplicate = await DeviceGroup.findOne({
        _id: { $ne: group._id },
        normalizedName: nextNormalizedName
      });
      if (duplicate) {
        throw new Error('A device group with this name already exists');
      }

      await this.renameGroupEverywhere(currentNormalizedName, nextName);
    }

    group.name = nextName;
    group.description = nextDescription;
    await group.save();

    if (
      Object.prototype.hasOwnProperty.call(updates, 'deviceIds')
      || Object.prototype.hasOwnProperty.call(updates, 'childGroupIds')
    ) {
      await this.setGroupMembership(id, {
        ...(Object.prototype.hasOwnProperty.call(updates, 'deviceIds') ? { deviceIds: updates.deviceIds } : {}),
        ...(Object.prototype.hasOwnProperty.call(updates, 'childGroupIds') ? { childGroupIds: updates.childGroupIds } : {})
      });
    }

    return this.getGroupById(group._id.toString());
  }

  async renameGroupEverywhere(currentNormalizedName, nextGroupName) {
    const devices = await Device.find({
      groups: { $regex: new RegExp(`^${escapeRegexLiteral(currentNormalizedName)}$`, 'i') }
    }).lean();

    const deviceBulkOps = [];
    const changedDeviceIds = [];

    devices.forEach((device) => {
      const currentGroups = normalizeGroupList(device.groups);
      const nextGroups = normalizeGroupList(
        currentGroups.map((group) => (
          normalizeGroupName(group) === currentNormalizedName ? nextGroupName : group
        ))
      );

      const currentJson = JSON.stringify(currentGroups);
      const nextJson = JSON.stringify(nextGroups);
      if (currentJson === nextJson) {
        return;
      }

      deviceBulkOps.push({
        updateOne: {
          filter: { _id: device._id },
          update: { $set: { groups: nextGroups, updatedAt: new Date() } }
        }
      });
      changedDeviceIds.push(device._id);
    });

    if (deviceBulkOps.length > 0) {
      await Device.bulkWrite(deviceBulkOps, { ordered: false });
      await emitUpdatedDevices(changedDeviceIds);
    }

    const workflows = await Workflow.find().lean();
    for (const workflow of workflows) {
      const renamedActions = renameGroupReferences(workflow.actions || [], currentNormalizedName, nextGroupName);
      const renamedGraph = renameGroupReferences(workflow.graph || null, currentNormalizedName, nextGroupName);
      if (!renamedActions.changed && !renamedGraph.changed) {
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      await Workflow.findByIdAndUpdate(workflow._id, {
        actions: renamedActions.value,
        graph: renamedGraph.value,
        updatedAt: new Date()
      });
    }

    const automations = await Automation.find().lean();
    for (const automation of automations) {
      const renamedActions = renameGroupReferences(automation.actions || [], currentNormalizedName, nextGroupName);
      const renamedGraph = renameGroupReferences(automation.workflowGraph || null, currentNormalizedName, nextGroupName);
      if (!renamedActions.changed && !renamedGraph.changed) {
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      await Automation.findByIdAndUpdate(automation._id, {
        actions: renamedActions.value,
        workflowGraph: renamedGraph.value,
        updatedAt: new Date()
      });
    }
  }

  async setGroupMembership(id, updates = {}) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new Error('Invalid device group ID format');
    }

    const group = await DeviceGroup.findById(id);
    if (!group) {
      throw new Error('Device group not found');
    }

    const hasDeviceIds = Object.prototype.hasOwnProperty.call(updates, 'deviceIds');
    const hasChildGroupIds = Object.prototype.hasOwnProperty.call(updates, 'childGroupIds');
    if (!hasDeviceIds && !hasChildGroupIds) {
      return this.getGroupById(id);
    }

    const requestedDeviceIds = hasDeviceIds ? normalizeObjectIdList(updates.deviceIds) : null;
    const requestedChildGroupIds = hasChildGroupIds ? normalizeObjectIdList(updates.childGroupIds) : null;
    const [devices, groups] = await Promise.all([
      Device.find().lean(),
      DeviceGroup.find().sort({ name: 1 })
    ]);
    const validDeviceIds = new Set(devices.map((device) => toIdString(device?._id)).filter(Boolean));

    if (Array.isArray(requestedDeviceIds)) {
      const invalidDeviceIds = requestedDeviceIds.filter((deviceId) => !validDeviceIds.has(deviceId));
      if (invalidDeviceIds.length > 0) {
        throw new Error(`Unknown device IDs: ${invalidDeviceIds.join(', ')}`);
      }
    }

    const {
      groupsById,
      childGroupIdsById
    } = buildGroupRelationshipMaps(groups);

    if (Array.isArray(requestedChildGroupIds)) {
      this._assertGroupChildSelection({
        groupId: id,
        requestedChildGroupIds,
        groupsById,
        childGroupIdsById
      });
    }

    const normalizedGroupName = normalizeGroupName(group.name);
    const bulkOps = [];
    const changedDeviceIds = [];

    if (Array.isArray(requestedDeviceIds)) {
      const requestedIdSet = new Set(requestedDeviceIds);
      devices.forEach((device) => {
        const deviceId = toIdString(device?._id);
        const currentGroups = normalizeGroupList(device.groups);
        const hasGroup = currentGroups.some((entry) => normalizeGroupName(entry) === normalizedGroupName);
        const shouldHaveGroup = requestedIdSet.has(deviceId);

        if (hasGroup === shouldHaveGroup) {
          return;
        }

        const nextGroups = shouldHaveGroup
          ? normalizeGroupList([...currentGroups, group.name])
          : currentGroups.filter((entry) => normalizeGroupName(entry) !== normalizedGroupName);

        bulkOps.push({
          updateOne: {
            filter: { _id: device._id },
            update: {
              $set: {
                groups: nextGroups,
                updatedAt: new Date()
              }
            }
          }
        });
        changedDeviceIds.push(device._id);
      });
    }

    if (bulkOps.length > 0) {
      await Device.bulkWrite(bulkOps, { ordered: false });
      await emitUpdatedDevices(changedDeviceIds);
    }

    if (Array.isArray(requestedChildGroupIds)) {
      const currentChildGroupIds = normalizeObjectIdList(group.childGroupIds);
      const childGroupsChanged = JSON.stringify(currentChildGroupIds) !== JSON.stringify(requestedChildGroupIds);
      if (childGroupsChanged) {
        group.childGroupIds = requestedChildGroupIds;
        await group.save();
      }
    }

    const devicesById = new Map(devices.map((device) => [toIdString(device?._id), device]));
    const directDevices = Array.isArray(requestedDeviceIds)
      ? requestedDeviceIds.map((deviceId) => devicesById.get(deviceId)).filter(Boolean)
      : (buildMemberMap(devices).get(normalizedGroupName)?.devices || []);
    const childGroupIds = Array.isArray(requestedChildGroupIds)
      ? requestedChildGroupIds
      : normalizeObjectIdList(group.childGroupIds);

    await this._reconcileManagedGroupState(group, { directDevices, childGroupIds });
    return this.getGroupById(id);
  }

  async setGroupDevices(id, deviceIds = []) {
    return this.setGroupMembership(id, { deviceIds });
  }

  async setGroupChildGroups(id, childGroupIds = []) {
    return this.setGroupMembership(id, { childGroupIds });
  }

  async deleteGroup(id) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new Error('Invalid device group ID format');
    }

    const summary = await this.getGroupById(id);
    if (summary.workflowUsageCount > 0 || summary.automationUsageCount > 0) {
      throw new Error(
        `Cannot delete device group "${summary.name}" because it is used by ${summary.workflowUsageCount} workflow(s) and ${summary.automationUsageCount} standalone automation(s)`
      );
    }

    if (summary.parentGroupIds.length > 0) {
      throw new Error(
        `Cannot delete device group "${summary.name}" because it is nested inside ${summary.parentGroupIds.length} parent group(s): ${summary.parentGroupNames.join(', ')}`
      );
    }

    const group = await DeviceGroup.findById(id);
    if (!group) {
      throw new Error('Device group not found');
    }

    await this._reconcileManagedGroupState(group, {
      directDevices: [],
      childGroupIds: [],
      throwOnError: true
    });

    const normalizedGroupName = normalizeGroupName(group.name);
    const devices = await Device.find({
      groups: { $regex: new RegExp(`^${escapeRegexLiteral(normalizedGroupName)}$`, 'i') }
    }).lean();

    const bulkOps = [];
    const changedDeviceIds = [];
    devices.forEach((device) => {
      const nextGroups = normalizeGroupList(device.groups).filter((entry) => normalizeGroupName(entry) !== normalizedGroupName);
      bulkOps.push({
        updateOne: {
          filter: { _id: device._id },
          update: {
            $set: {
              groups: nextGroups,
              updatedAt: new Date()
            }
          }
        }
      });
      changedDeviceIds.push(device._id);
    });

    if (bulkOps.length > 0) {
      await Device.bulkWrite(bulkOps, { ordered: false });
      await emitUpdatedDevices(changedDeviceIds);
    }

    await DeviceGroup.deleteOne({ _id: group._id });
    await AlexaExposure.deleteOne({
      entityType: 'device_group',
      entityId: group._id.toString()
    });

    return {
      success: true,
      group: summary
    };
  }

  async resolveGroupExecutionPlanByName(name) {
    const trimmedName = sanitizeString(name);
    if (!trimmedName) {
      throw new Error('Device group target is required');
    }

    const devices = await Device.find()
      .sort({ room: 1, name: 1 })
      .lean();
    await this.ensureRegistryHydrated(devices);

    const groups = await DeviceGroup.find().sort({ name: 1 });
    const memberMap = buildMemberMap(devices);
    const directDevicesByGroupId = buildDirectDeviceMap(groups, memberMap);
    const {
      groupsById,
      childGroupIdsById
    } = buildGroupRelationshipMaps(groups);

    const rootGroup = mongoose.Types.ObjectId.isValid(trimmedName)
      ? groupsById.get(trimmedName) || groups.find((group) => normalizeGroupName(group?.normalizedName || group?.name) === normalizeGroupName(trimmedName))
      : groups.find((group) => normalizeGroupName(group?.normalizedName || group?.name) === normalizeGroupName(trimmedName));
    if (!rootGroup) {
      throw new Error('Device group not found');
    }

    const rootGroupId = toIdString(rootGroup._id);
    const claimedDeviceIds = new Set();
    const orderedDevices = [];
    const units = [];

    const visitGroup = (groupId, ancestry = []) => {
      if (ancestry.includes(groupId)) {
        return;
      }

      const groupRecord = groupsById.get(groupId);
      if (!groupRecord) {
        return;
      }

      const childGroupIds = childGroupIdsById.get(groupId) || [];
      childGroupIds.forEach((childGroupId) => visitGroup(childGroupId, [...ancestry, groupId]));

      const directDevices = (directDevicesByGroupId.get(groupId) || []).filter((device) => {
        const deviceId = toIdString(device?._id);
        if (!deviceId || claimedDeviceIds.has(deviceId)) {
          return false;
        }

        claimedDeviceIds.add(deviceId);
        orderedDevices.push(device);
        return true;
      });

      if (directDevices.length > 0) {
        units.push({
          groupId,
          groupName: groupRecord.name,
          groupRecord,
          devices: directDevices,
          containsNestedGroups: childGroupIds.length > 0,
          allowManagedInsteonGroup: childGroupIds.length === 0
        });
      }
    };

    visitGroup(rootGroupId);

    if (orderedDevices.length === 0) {
      throw new Error(`Device group "${trimmedName}" has no matching devices`);
    }

    return {
      rootGroup,
      devices: orderedDevices,
      units,
      containsNestedGroups: (childGroupIdsById.get(rootGroupId) || []).length > 0
    };
  }
}

module.exports = new DeviceGroupService();
