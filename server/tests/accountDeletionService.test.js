const test = require('node:test');
const assert = require('node:assert/strict');

const User = require('../models/User');
const UserSession = require('../models/UserSession');
const PushSubscription = require('../models/PushSubscription');
const HomeBrainNotification = require('../models/HomeBrainNotification');
const OIDCAuthorizationCode = require('../models/OIDCAuthorizationCode');
const VoiceCommand = require('../models/VoiceCommand');
const SecurityAlarm = require('../models/SecurityAlarm');
const CodexSkillIntegration = require('../models/CodexSkillIntegration');
const UserService = require('../services/userService');
const accountDeletionService = require('../services/accountDeletionService');
const reviewSandboxService = require('../services/reviewSandboxService');
const { generatePasswordHash } = require('../utils/password');

function executable(result = { acknowledged: true }) {
  return { exec: async () => result };
}

function installDeletionMocks(t, calls) {
  const originals = {
    userDeleteOne: User.deleteOne,
    sessionDeleteMany: UserSession.deleteMany,
    pushDeleteMany: PushSubscription.deleteMany,
    notificationDeleteMany: HomeBrainNotification.deleteMany,
    notificationUpdateMany: HomeBrainNotification.updateMany,
    oidcDeleteMany: OIDCAuthorizationCode.deleteMany,
    voiceDeleteMany: VoiceCommand.deleteMany,
    alarmUpdateMany: SecurityAlarm.updateMany,
    codexUpdateMany: CodexSkillIntegration.updateMany,
    reviewSandboxDeleteForUser: reviewSandboxService.deleteForUser
  };

  t.after(() => {
    User.deleteOne = originals.userDeleteOne;
    UserSession.deleteMany = originals.sessionDeleteMany;
    PushSubscription.deleteMany = originals.pushDeleteMany;
    HomeBrainNotification.deleteMany = originals.notificationDeleteMany;
    HomeBrainNotification.updateMany = originals.notificationUpdateMany;
    OIDCAuthorizationCode.deleteMany = originals.oidcDeleteMany;
    VoiceCommand.deleteMany = originals.voiceDeleteMany;
    SecurityAlarm.updateMany = originals.alarmUpdateMany;
    CodexSkillIntegration.updateMany = originals.codexUpdateMany;
    reviewSandboxService.deleteForUser = originals.reviewSandboxDeleteForUser;
  });

  UserSession.deleteMany = (query) => {
    calls.push(['sessions', query]);
    return executable();
  };
  PushSubscription.deleteMany = (query) => {
    calls.push(['push', query]);
    return executable();
  };
  HomeBrainNotification.deleteMany = (query) => {
    calls.push(['notifications', query]);
    return executable();
  };
  HomeBrainNotification.updateMany = (query, update) => {
    calls.push(['notificationReferences', query, update]);
    return executable();
  };
  OIDCAuthorizationCode.deleteMany = (query) => {
    calls.push(['oidcCodes', query]);
    return executable();
  };
  VoiceCommand.deleteMany = (query) => {
    calls.push(['voiceCommands', query]);
    return executable();
  };
  reviewSandboxService.deleteForUser = async (id) => {
    calls.push(['reviewSandbox', { userId: id }]);
    return { acknowledged: true, deletedCount: 1 };
  };
  SecurityAlarm.updateMany = (query, update) => {
    calls.push(['securityCodes', query, update]);
    return executable();
  };
  CodexSkillIntegration.updateMany = (query, update) => {
    calls.push(['codexToken', query, update]);
    return executable();
  };
  User.deleteOne = (query) => {
    calls.push(['user', query]);
    return executable({ acknowledged: true, deletedCount: 1 });
  };
}

test('deleteAccount removes the user and associated personal records', async (t) => {
  const originalGet = UserService.get;
  const calls = [];
  const userId = '507f1f77bcf86cd799439011';
  const password = 'DeleteMe123!';

  t.after(() => {
    UserService.get = originalGet;
  });
  installDeletionMocks(t, calls);

  UserService.get = async () => ({
    _id: userId,
    email: 'delete@example.com',
    password: await generatePasswordHash(password),
    role: 'user',
    isActive: true,
    platforms: { homebrain: true, axiom: false }
  });

  const result = await accountDeletionService.deleteAccount(userId, password);

  assert.deepEqual(result, { deleted: true, userId });
  assert.deepEqual(
    calls.map(([name]) => name).sort(),
    [
      'codexToken',
      'notificationReferences',
      'notifications',
      'oidcCodes',
      'push',
      'reviewSandbox',
      'securityCodes',
      'sessions',
      'user',
      'voiceCommands'
    ]
  );
  assert.equal(calls.at(-1)[0], 'user');
});

test('deleteAccount rejects an incorrect password before deleting data', async (t) => {
  const originalGet = UserService.get;
  const userId = '507f1f77bcf86cd799439012';

  t.after(() => {
    UserService.get = originalGet;
  });

  UserService.get = async () => ({
    _id: userId,
    password: await generatePasswordHash('CorrectPassword123!'),
    role: 'user',
    isActive: true,
    platforms: { homebrain: true, axiom: false }
  });

  await assert.rejects(
    () => accountDeletionService.deleteAccount(userId, 'WrongPassword123!'),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.message, 'Password is incorrect.');
      return true;
    }
  );
});

test('deleteAccount preserves the last active HomeBrain administrator', async (t) => {
  const originalGet = UserService.get;
  const originalCountActiveAdmins = UserService.countActiveAdmins;
  const userId = '507f1f77bcf86cd799439013';
  const password = 'LastAdmin123!';

  t.after(() => {
    UserService.get = originalGet;
    UserService.countActiveAdmins = originalCountActiveAdmins;
  });

  UserService.get = async () => ({
    _id: userId,
    password: await generatePasswordHash(password),
    role: 'admin',
    isActive: true,
    platforms: { homebrain: true, axiom: false }
  });
  UserService.countActiveAdmins = async () => 1;

  await assert.rejects(
    () => accountDeletionService.deleteAccount(userId, password),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /another active HomeBrain administrator/);
      return true;
    }
  );
});
