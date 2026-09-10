const SiriCommand = require('../models/SiriCommand');
const Workflow = require('../models/Workflow');
const Scene = require('../models/Scene');
const deviceService = require('./deviceService');
const workflowService = require('./workflowService');
const sceneService = require('./sceneService');
const { SiriCommandService } = require('./siriCommandService');

let indexesReady;
function ensureCommandIndexes() {
  if (!indexesReady) {
    // Explicitly build both indexes even on deployments with mongoose autoIndex disabled.
    // No physical command may run unless the database enforces invocation uniqueness.
    indexesReady = Promise.all([
      SiriCommand.collection.createIndex({ userId: 1, requestId: 1 }, { unique: true }),
      SiriCommand.collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
    ]).catch((error) => { indexesReady = undefined; throw error; });
  }
  return indexesReady;
}

module.exports = new SiriCommandService({
  store: {
    async create(record) {
      // Commands must fail closed until their uniqueness index exists.
      await ensureCommandIndexes();
      return SiriCommand.create(record);
    },
    get: (userId, requestId) => SiriCommand.findOne({ userId, requestId }).lean(),
    update: (userId, requestId, fields) => SiriCommand.updateOne({ userId, requestId }, { $set: fields })
  },
  devices: {
    list: () => deviceService.getAllDevices({ type: 'light' }),
    control: (...args) => deviceService.controlDevice(...args)
  },
  workflows: {
    list: () => Workflow.find({ enabled: true }).select('_id name enabled voiceAliases').lean(),
    run: (...args) => workflowService.executeWorkflow(...args)
  },
  scenes: {
    list: () => Scene.find({}).select('_id name').lean(),
    run: (...args) => sceneService.activateScene(...args)
  }
});
