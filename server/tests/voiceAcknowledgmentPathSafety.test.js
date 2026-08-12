const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const voiceAcknowledgmentService = require('../services/voiceAcknowledgmentService');

test('voice acknowledgment paths accept generated profile artifacts', () => {
  const profileId = '507f1f77bcf86cd799439011';
  const audioName = `${profileId}-0123456789abcdef.mp3`;

  assert.equal(path.basename(voiceAcknowledgmentService.getManifestPath(profileId)), `${profileId}.json`);
  assert.equal(path.basename(voiceAcknowledgmentService.getAudioPath(audioName)), audioName);
});

test('voice acknowledgment paths reject traversal and malformed identifiers', () => {
  assert.throws(
    () => voiceAcknowledgmentService.getManifestPath('../../outside'),
    /profile ID is invalid/
  );
  assert.throws(
    () => voiceAcknowledgmentService.getAudioPath('../../outside.mp3'),
    /file name is invalid/
  );
  assert.throws(
    () => voiceAcknowledgmentService.getAudioPath('507f1f77bcf86cd799439011-../../outside.mp3'),
    /file name is invalid/
  );
});
