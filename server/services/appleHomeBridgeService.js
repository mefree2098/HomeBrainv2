'use strict';
const path = require('node:path');
const { AppleHomeBridge } = require('./appleHome/bridge');
const { BridgeStorage } = require('./appleHome/storage');
const Device = require('../models/Device');
const Workflow = require('../models/Workflow');
const Scene = require('../models/Scene');
const DeviceGroup = require('../models/DeviceGroup');
const User = require('../models/User');
const deviceService = require('./deviceService');
const siriService = require('./siriService');
const events = require('./deviceUpdateEmitter');
const eventStreamService = require('./eventStreamService');

module.exports = new AppleHomeBridge({
  storage: new BridgeStorage(process.env.HOMEBRAIN_HOMEKIT_DATA_DIR || path.join(__dirname, '..', 'data', 'apple-home')),
  load: async () => {
    const [devices, workflows, scenes, groups] = await Promise.all([
      deviceService.getAllDevices(), Workflow.find({}).lean(), Scene.find({}).lean(), DeviceGroup.find({}).lean()
    ]);
    return { devices, workflows, scenes, groups };
  },
  getUser: (userId) => userId ? User.findById(userId).select('_id role isActive isReadOnly isReviewSandbox platforms').lean() : null,
  readDevice: (deviceId) => Device.findById(deviceId).lean(),
  controlDevice: (...args) => deviceService.controlDevice(...args),
  supportsBrightness: (device) => deviceService.supportsBrightnessControl(device),
  runTarget: (user, target, requestId) => siriService.start(user, { accountId: String(user._id), requestId,
    kind: target.kind, targetId: target.id, action: target.kind === 'workflow' ? 'run' : 'activate' }),
  commandStatus: (user, requestId) => siriService.get(user, requestId),
  events,
  audit: (record) => eventStreamService.publishSafe({ source: 'apple_home', category: 'integration', tags: ['apple_home'], ...record })
});
