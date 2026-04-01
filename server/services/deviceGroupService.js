const mongoose = require('mongoose');
const AlexaExposure = require('../models/AlexaExposure');
const Device = require('../models/Device');
const DeviceGroup = require('../models/DeviceGroup');
const Workflow = require('../models/Workflow');
const Automation = require('../models/Automation');
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

function escapeRegexLiteral(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

  async listGroups() {
    const devices = await Device.find().lean();
    await this.ensureRegistryHydrated(devices);

    const [groups, workflows, automations] = await Promise.all([
      DeviceGroup.find().sort({ name: 1 }).lean(),
      Workflow.find().select('_id name actions graph').lean(),
      Automation.find({ workflowId: null }).select('_id name actions workflowGraph').lean()
    ]);

    const memberMap = buildMemberMap(devices);
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

    return groups.map((group) => {
      const normalizedName = normalizeGroupName(group.normalizedName || group.name);
      const membership = memberMap.get(normalizedName);
      const members = Array.isArray(membership?.devices) ? membership.devices : [];
      const rooms = new Set();
      const types = new Set();
      const sources = new Set();

      members.forEach((device) => {
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

      const referencedWorkflows = workflowUsage.get(normalizedName) || [];
      const referencedAutomations = automationUsage.get(normalizedName) || [];

      return {
        _id: group._id.toString(),
        name: group.name,
        normalizedName,
        description: group.description || '',
        deviceCount: members.length,
        deviceIds: members
          .map((device) => device?._id?.toString?.() || String(device?._id || ''))
          .filter(Boolean),
        deviceNames: members
          .map((device) => sanitizeString(device?.name))
          .filter(Boolean),
        rooms: Array.from(rooms).sort((left, right) => left.localeCompare(right)),
        types: Array.from(types).sort((left, right) => left.localeCompare(right)),
        sources: Array.from(sources).sort((left, right) => left.localeCompare(right)),
        workflowUsageCount: referencedWorkflows.length,
        automationUsageCount: referencedAutomations.length,
        workflowNames: referencedWorkflows.map((workflow) => workflow.name),
        automationNames: referencedAutomations.map((automation) => automation.name),
        createdAt: group.createdAt,
        updatedAt: group.updatedAt
      };
    });
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

  async createGroup({ name, description = '', deviceIds = [] } = {}) {
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
      description: sanitizeString(description)
    });
    await group.save();

    if (Array.isArray(deviceIds) && deviceIds.length > 0) {
      await this.setGroupDevices(group._id.toString(), deviceIds);
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

  async setGroupDevices(id, deviceIds = []) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new Error('Invalid device group ID format');
    }

    const group = await DeviceGroup.findById(id);
    if (!group) {
      throw new Error('Device group not found');
    }

    const requestedIds = Array.isArray(deviceIds)
      ? Array.from(new Set(deviceIds.map((deviceId) => sanitizeString(deviceId)).filter(Boolean)))
      : [];
    const requestedIdSet = new Set(requestedIds);

    const devices = await Device.find().lean();
    const validDeviceIds = new Set(devices.map((device) => device?._id?.toString?.() || String(device?._id || '')));
    const invalidDeviceIds = requestedIds.filter((deviceId) => !validDeviceIds.has(deviceId));
    if (invalidDeviceIds.length > 0) {
      throw new Error(`Unknown device IDs: ${invalidDeviceIds.join(', ')}`);
    }

    const normalizedGroupName = normalizeGroupName(group.name);
    const bulkOps = [];
    const changedDeviceIds = [];

    devices.forEach((device) => {
      const deviceId = device?._id?.toString?.() || String(device?._id || '');
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

    if (bulkOps.length > 0) {
      await Device.bulkWrite(bulkOps, { ordered: false });
      await emitUpdatedDevices(changedDeviceIds);
    }

    return this.getGroupById(id);
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

    const group = await DeviceGroup.findById(id);
    if (!group) {
      throw new Error('Device group not found');
    }

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
}

module.exports = new DeviceGroupService();
