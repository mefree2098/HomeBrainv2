const Device = require('../models/Device');
const Room = require('../models/Room');
const VoiceDevice = require('../models/VoiceDevice');
const WallPanel = require('../models/WallPanel');
const deviceUpdateEmitter = require('./deviceUpdateEmitter');

const DEFAULT_ROOM_NAME = 'Unassigned';

const HARMONY_VISIBLE_DEVICE_QUERY = Object.freeze({
  $or: [
    { 'properties.harmonyExcludeFromHomeBrain': { $exists: false } },
    { 'properties.harmonyExcludeFromHomeBrain': { $ne: true } }
  ]
});
const RETIRED_SMARTTHINGS_MIGRATION_SOURCE_QUERY = Object.freeze({
  $or: [
    { 'properties.smartThingsMigration.retiredSource': { $exists: false } },
    { 'properties.smartThingsMigration.retiredSource': { $ne: true } },
    { 'properties.source': { $regex: '^homebrain-', $options: 'i' } }
  ]
});
const DIRECT_RADIO_VISIBLE_DEVICE_QUERY = Object.freeze({
  $and: [
    { 'properties.homebrainDirect.isControllerNode': { $ne: true } },
    {
      $nor: [
        {
          'properties.source': 'homebrain-zwave',
          'properties.homebrainDirect.nodeId': 1,
          $or: [
            { name: /^ZST39(?:\s|$)/i },
            { model: /^ZST39(?:\s|$)/i },
            { 'properties.homebrainDirect.productId': 1552 }
          ]
        }
      ]
    }
  ]
});

function sanitizeRoomName(value) {
  return Room.sanitizeRoomName(value);
}

function normalizeRoomName(value) {
  return Room.normalizeRoomName(value);
}

function serviceError(message, status = 400, details = {}) {
  const error = new Error(message);
  error.status = status;
  Object.assign(error, details);
  return error;
}

function mergeMongoQuery(baseQuery = {}, extraQuery = {}) {
  const queryParts = (query) => {
    const keys = Object.keys(query || {});
    return keys.length === 1 && Array.isArray(query.$and) ? query.$and : [query];
  };

  return {
    $and: [
      ...queryParts(baseQuery),
      ...queryParts(extraQuery)
    ]
  };
}

function buildVisibleDeviceQuery(filters = {}) {
  let query = { ...filters };
  query = mergeMongoQuery(query, HARMONY_VISIBLE_DEVICE_QUERY);
  query = mergeMongoQuery(query, RETIRED_SMARTTHINGS_MIGRATION_SOURCE_QUERY);
  return mergeMongoQuery(query, DIRECT_RADIO_VISIBLE_DEVICE_QUERY);
}

function escapeRegexLiteral(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function roomNameQuery(name) {
  return new RegExp(`^${escapeRegexLiteral(sanitizeRoomName(name))}$`, 'i');
}

function toIdString(value) {
  return String(value?._id?.toString?.() || value?.id || value || '').trim();
}

function createRoomSummary(name, registryRoom = null) {
  const normalizedName = normalizeRoomName(name);
  return {
    id: registryRoom ? toIdString(registryRoom._id) : null,
    name: sanitizeRoomName(registryRoom?.name || name) || DEFAULT_ROOM_NAME,
    normalizedName,
    registered: Boolean(registryRoom),
    isDefault: normalizedName === normalizeRoomName(DEFAULT_ROOM_NAME),
    deviceCount: 0,
    wallPanelCount: 0,
    voiceDeviceCount: 0,
    totalReferences: 0
  };
}

function addReference(summary, key) {
  summary[key] += 1;
  summary.totalReferences += 1;
}

function sortRoomSummaries(left, right) {
  if (left.isDefault) return -1;
  if (right.isDefault) return 1;
  return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
}

async function queryLean(query) {
  if (!query) {
    return [];
  }
  if (typeof query.lean === 'function') {
    return query.lean();
  }
  if (typeof query.then === 'function') {
    return query;
  }
  return query;
}

async function queryRoomDocuments() {
  const query = Room.find({}).sort({ normalizedName: 1 });
  return queryLean(query);
}

async function queryRoomReferences() {
  const [devices, wallPanels, voiceDevices] = await Promise.all([
    queryLean(Device.find(buildVisibleDeviceQuery()).select('name room type isOnline')),
    queryLean(WallPanel.find({}).select('name room status')),
    queryLean(VoiceDevice.find({}).select('name room status'))
  ]);

  return {
    devices: Array.isArray(devices) ? devices : [],
    wallPanels: Array.isArray(wallPanels) ? wallPanels : [],
    voiceDevices: Array.isArray(voiceDevices) ? voiceDevices : []
  };
}

async function buildRoomMap() {
  const [registeredRooms, references] = await Promise.all([
    queryRoomDocuments(),
    queryRoomReferences()
  ]);
  const rooms = new Map();

  const ensureRoom = (name, registryRoom = null) => {
    const roomName = sanitizeRoomName(name) || DEFAULT_ROOM_NAME;
    const key = normalizeRoomName(roomName);
    if (!rooms.has(key)) {
      rooms.set(key, createRoomSummary(roomName, registryRoom));
    } else if (registryRoom) {
      const existing = rooms.get(key);
      existing.id = toIdString(registryRoom._id);
      existing.name = sanitizeRoomName(registryRoom.name) || existing.name;
      existing.registered = true;
      existing.isDefault = key === normalizeRoomName(DEFAULT_ROOM_NAME);
    }
    return rooms.get(key);
  };

  ensureRoom(DEFAULT_ROOM_NAME);

  registeredRooms.forEach((room) => {
    ensureRoom(room.name, room);
  });

  references.devices.forEach((device) => {
    addReference(ensureRoom(device?.room), 'deviceCount');
  });
  references.wallPanels.forEach((panel) => {
    addReference(ensureRoom(panel?.room), 'wallPanelCount');
  });
  references.voiceDevices.forEach((voiceDevice) => {
    addReference(ensureRoom(voiceDevice?.room), 'voiceDeviceCount');
  });

  return rooms;
}

async function listRooms() {
  const rooms = await buildRoomMap();
  return Array.from(rooms.values()).sort(sortRoomSummaries);
}

async function findRoomSummary(name) {
  const key = normalizeRoomName(name);
  const rooms = await buildRoomMap();
  return rooms.get(key) || null;
}

async function assertRoomNameAvailable(name, currentName = null) {
  const key = normalizeRoomName(name);
  const currentKey = currentName ? normalizeRoomName(currentName) : '';
  if (!key) {
    throw serviceError('Room name is required');
  }
  if (key === normalizeRoomName(DEFAULT_ROOM_NAME)) {
    throw serviceError('Unassigned is a built-in room and cannot be created or renamed.');
  }
  if (currentKey && key === currentKey) {
    return;
  }

  const existing = await findRoomSummary(name);
  if (existing) {
    throw serviceError('A room with this name already exists.', 409);
  }
}

async function getDevicesInRoom(name) {
  return queryLean(Device.find({ room: roomNameQuery(name) }));
}

async function emitDeviceUpdates(deviceIds = []) {
  const ids = Array.from(new Set(deviceIds.map(String).filter(Boolean)));
  if (ids.length === 0) {
    return;
  }

  const updatedDevices = await queryLean(Device.find({ _id: { $in: ids } }));
  const payload = deviceUpdateEmitter.normalizeDevices(updatedDevices);
  if (payload.length > 0) {
    deviceUpdateEmitter.emit('devices:update', payload);
  }
}

async function moveReferences(fromName, toName) {
  const matcher = roomNameQuery(fromName);
  const devices = await getDevicesInRoom(fromName);
  const deviceIds = devices.map((device) => toIdString(device._id)).filter(Boolean);

  const [deviceResult, wallPanelResult, voiceDeviceResult] = await Promise.all([
    Device.updateMany({ room: matcher }, { $set: { room: toName } }),
    WallPanel.updateMany({ room: matcher }, { $set: { room: toName, updatedAt: new Date() } }),
    VoiceDevice.updateMany({ room: matcher }, { $set: { room: toName, updatedAt: new Date() } })
  ]);

  await emitDeviceUpdates(deviceIds);

  return {
    devicesUpdated: deviceResult?.modifiedCount || deviceResult?.nModified || 0,
    wallPanelsUpdated: wallPanelResult?.modifiedCount || wallPanelResult?.nModified || 0,
    voiceDevicesUpdated: voiceDeviceResult?.modifiedCount || voiceDeviceResult?.nModified || 0
  };
}

async function createRoom(name) {
  const roomName = sanitizeRoomName(name);
  await assertRoomNameAvailable(roomName);

  try {
    await Room.create({ name: roomName });
  } catch (error) {
    if (error?.code === 11000) {
      throw serviceError('A room with this name already exists.', 409);
    }
    throw error;
  }

  return listRooms();
}

async function renameRoom(fromName, toName) {
  const currentName = sanitizeRoomName(fromName);
  const nextName = sanitizeRoomName(toName);

  if (!currentName || !nextName) {
    throw serviceError('Current and new room names are required.');
  }
  if (normalizeRoomName(currentName) === normalizeRoomName(DEFAULT_ROOM_NAME)) {
    throw serviceError('Unassigned is a built-in room and cannot be renamed.');
  }

  const current = await findRoomSummary(currentName);
  if (!current) {
    throw serviceError('Room not found.', 404);
  }

  await assertRoomNameAvailable(nextName, currentName);

  const existingRoom = await Room.findOne({ normalizedName: normalizeRoomName(currentName) });
  if (existingRoom) {
    existingRoom.name = nextName;
    existingRoom.normalizedName = normalizeRoomName(nextName);
    await existingRoom.save();
  } else {
    await Room.create({ name: nextName });
  }

  const updates = await moveReferences(currentName, nextName);
  return {
    rooms: await listRooms(),
    updates
  };
}

async function deleteRoom(name, options = {}) {
  const roomName = sanitizeRoomName(name);
  const reassignTo = sanitizeRoomName(options.reassignTo);
  if (!roomName) {
    throw serviceError('Room name is required.');
  }
  if (normalizeRoomName(roomName) === normalizeRoomName(DEFAULT_ROOM_NAME)) {
    throw serviceError('Unassigned is a built-in room and cannot be deleted.');
  }

  const current = await findRoomSummary(roomName);
  if (!current) {
    throw serviceError('Room not found.', 404);
  }

  let updates = {
    devicesUpdated: 0,
    wallPanelsUpdated: 0,
    voiceDevicesUpdated: 0
  };

  if (current.totalReferences > 0) {
    if (!reassignTo) {
      throw serviceError('Room has assigned hardware. Choose another room to move those assignments before deleting.', 409, {
        room: current
      });
    }
    if (normalizeRoomName(roomName) === normalizeRoomName(reassignTo)) {
      throw serviceError('Choose a different room for reassignment.');
    }
    if (normalizeRoomName(reassignTo) !== normalizeRoomName(DEFAULT_ROOM_NAME)) {
      const target = await findRoomSummary(reassignTo);
      if (!target) {
        await Room.create({ name: reassignTo });
      }
    }
    updates = await moveReferences(roomName, reassignTo);
  }

  await Room.deleteOne({ normalizedName: normalizeRoomName(roomName) });

  return {
    rooms: await listRooms(),
    updates
  };
}

module.exports = {
  DEFAULT_ROOM_NAME,
  sanitizeRoomName,
  normalizeRoomName,
  listRooms,
  createRoom,
  renameRoom,
  deleteRoom
};
