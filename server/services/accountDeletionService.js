const User = require('../models/User');
const UserSession = require('../models/UserSession');
const PushSubscription = require('../models/PushSubscription');
const HomeBrainNotification = require('../models/HomeBrainNotification');
const OIDCAuthorizationCode = require('../models/OIDCAuthorizationCode');
const VoiceCommand = require('../models/VoiceCommand');
const SecurityAlarm = require('../models/SecurityAlarm');
const CodexSkillIntegration = require('../models/CodexSkillIntegration');
const UserService = require('./userService');
const reviewSandboxService = require('./reviewSandboxService');
const { validatePassword } = require('../utils/password');
const { ROLES } = require('../../shared/config/roles');
const { USER_PLATFORMS, hasPlatformAccess } = require('../utils/userPlatforms');

function accountDeletionError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function deleteAccount(userId, password) {
  const normalizedPassword = typeof password === 'string' ? password : '';
  if (!normalizedPassword) {
    throw accountDeletionError('Password is required to delete your account.');
  }

  const user = await UserService.get(userId);
  if (!user) {
    throw accountDeletionError('User not found.', 404);
  }

  const passwordValid = await validatePassword(normalizedPassword, user.password);
  if (!passwordValid) {
    throw accountDeletionError('Password is incorrect.');
  }

  if (
    user.role === ROLES.ADMIN
    && user.isActive
    && hasPlatformAccess(user, USER_PLATFORMS.HOMEBRAIN)
  ) {
    const activeAdminCount = await UserService.countActiveAdmins(USER_PLATFORMS.HOMEBRAIN);
    if (activeAdminCount <= 1) {
      throw accountDeletionError(
        'Create another active HomeBrain administrator before deleting the last administrator account.',
        409
      );
    }
  }

  const identityQuery = { userId: user._id };
  await Promise.all([
    UserSession.deleteMany(identityQuery).exec(),
    PushSubscription.deleteMany(identityQuery).exec(),
    HomeBrainNotification.deleteMany(identityQuery).exec(),
    HomeBrainNotification.updateMany(
      { clearedBy: user._id },
      { $set: { clearedBy: null } }
    ).exec(),
    OIDCAuthorizationCode.deleteMany(identityQuery).exec(),
    VoiceCommand.deleteMany(identityQuery).exec(),
    reviewSandboxService.deleteForUser(user._id),
    SecurityAlarm.updateMany(
      {},
      { $pull: { userCodes: { userId: user._id } } }
    ).exec(),
    CodexSkillIntegration.updateMany(
      { issuedToUserId: user._id },
      {
        $set: {
          issuedToUserId: null,
          issuedToEmail: '',
          tokenHash: '',
          tokenPrefix: '',
          tokenCreatedAt: null,
          tokenRotatedAt: new Date()
        }
      }
    ).exec()
  ]);

  const deletion = await User.deleteOne({ _id: user._id }).exec();
  if (deletion.deletedCount !== 1) {
    throw accountDeletionError('Account could not be deleted.', 500);
  }

  return {
    deleted: true,
    userId: String(user._id)
  };
}

module.exports = {
  deleteAccount
};
