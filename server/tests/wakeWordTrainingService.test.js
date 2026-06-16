const test = require('node:test');
const assert = require('node:assert/strict');

const WakeWordModel = require('../models/WakeWordModel');
const wakeWordTrainingService = require('../services/wakeWordTrainingService');

test('resumePendingTraining requeues interrupted wake-word training jobs', async (t) => {
  const originalFind = WakeWordModel.find;
  const originalFindExistingArtifact = wakeWordTrainingService.findExistingArtifact;
  const originalEnqueueTraining = wakeWordTrainingService.enqueueTraining;

  const queued = [];
  const model = {
    slug: 'anna',
    status: 'generating',
    progress: 0.42,
    statusMessage: 'Synthesizing positives 320/400',
    saveCount: 0,
    async save() {
      this.saveCount += 1;
      return this;
    }
  };

  t.after(() => {
    WakeWordModel.find = originalFind;
    wakeWordTrainingService.findExistingArtifact = originalFindExistingArtifact;
    wakeWordTrainingService.enqueueTraining = originalEnqueueTraining;
  });

  WakeWordModel.find = async () => [model];
  wakeWordTrainingService.findExistingArtifact = () => null;
  wakeWordTrainingService.enqueueTraining = (slug) => {
    queued.push(slug);
  };

  await wakeWordTrainingService.resumePendingTraining();

  assert.equal(model.status, 'pending');
  assert.equal(model.progress, 0);
  assert.match(model.statusMessage, /interrupted wake-word training job/i);
  assert.equal(model.saveCount, 1);
  assert.deepEqual(queued, ['anna']);
});
