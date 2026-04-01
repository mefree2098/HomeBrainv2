const test = require('node:test');
const assert = require('node:assert/strict');

const AlexaLinkedAccount = require('../models/AlexaLinkedAccount');
const alexaCustomSkillService = require('../services/alexaCustomSkillService');
const userProfileService = require('../services/userProfileService');

test('dispatch resolves a mapped Alexa profile and returns a personalized who-am-i response', async (t) => {
  const originalFindOne = AlexaLinkedAccount.findOne;
  const originalResolveVoiceUser = alexaCustomSkillService.resolveVoiceUser;
  const originalResolveAlexaProfile = userProfileService.resolveAlexaProfile;
  const originalBuildPersonalizedResponse = alexaCustomSkillService.buildPersonalizedResponse;

  AlexaLinkedAccount.findOne = () => ({
    lean: async () => ({
      brokerAccountId: 'acct-1',
      hubId: 'hub-test',
      alexaHouseholdId: 'household-1'
    })
  });
  alexaCustomSkillService.resolveVoiceUser = async () => ({
    _id: 'voice-user-1',
    label: 'Matt Echo',
    status: 'mapped',
    responseMode: 'inherit',
    brokerAccountId: 'acct-1',
    alexaPersonId: 'person-1',
    alexaUserId: 'user-1',
    alexaHouseholdId: 'household-1',
    userProfileId: {
      _id: 'profile-1',
      name: 'Anna',
      voiceId: 'voice-anna',
      active: true,
      alexaPreferences: {
        responseMode: 'ssml'
      }
    }
  });
  userProfileService.resolveAlexaProfile = async () => ({
    profile: {
      _id: 'profile-1',
      name: 'Anna',
      voiceId: 'voice-anna',
      active: true,
      alexaPreferences: {
        responseMode: 'ssml'
      }
    },
    matchType: 'person'
  });
  alexaCustomSkillService.buildPersonalizedResponse = async (text) => ({
    version: '1.0',
    response: {
      outputSpeech: {
        type: 'PlainText',
        text
      },
      shouldEndSession: true
    }
  });

  t.after(() => {
    AlexaLinkedAccount.findOne = originalFindOne;
    alexaCustomSkillService.resolveVoiceUser = originalResolveVoiceUser;
    userProfileService.resolveAlexaProfile = originalResolveAlexaProfile;
    alexaCustomSkillService.buildPersonalizedResponse = originalBuildPersonalizedResponse;
  });

  const result = await alexaCustomSkillService.dispatch({
    brokerAccountId: 'acct-1',
    envelope: {
      session: {
        user: {
          userId: 'user-1',
          accessToken: 'token-1'
        }
      },
      context: {
        System: {
          person: {
            personId: 'person-1'
          }
        }
      },
      request: {
        type: 'IntentRequest',
        requestId: 'req-1',
        locale: 'en-US',
        intent: {
          name: 'HomeBrainWhoAmIIntent',
          slots: {}
        }
      }
    }
  });

  assert.equal(result.success, true);
  assert.equal(result.match.matchType, 'voice_user');
  assert.equal(result.profile.name, 'Anna');
  assert.equal(result.resultText, 'You are mapped to Anna.');
  assert.equal(result.alexaResponse.response.outputSpeech.text, 'You are mapped to Anna.');
});

test('resolveAudioClip validates signed tokens and returns stored mp3 data', async (t) => {
  const originalReadFile = require('fs').promises.readFile;
  const originalAccess = require('fs').promises.access;
  const clipId = 'clip-test';
  const token = alexaCustomSkillService.buildAudioToken(clipId, Date.now() + 60_000);

  require('fs').promises.access = async () => true;
  require('fs').promises.readFile = async () => Buffer.from('mp3-data');

  t.after(() => {
    require('fs').promises.readFile = originalReadFile;
    require('fs').promises.access = originalAccess;
  });

  const result = await alexaCustomSkillService.resolveAudioClip(clipId, token);

  assert.equal(result.contentType, 'audio/mpeg');
  assert.equal(Buffer.isBuffer(result.buffer), true);
});
