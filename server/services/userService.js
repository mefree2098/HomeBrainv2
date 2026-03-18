const User = require('../models/User.js');
const { generatePasswordHash, validatePassword } = require('../utils/password.js');
const { ALL_ROLES, ROLES } = require('../../shared/config/roles.js');

const normalizeEmail = (email) => {
  if (typeof email !== 'string') {
    return '';
  }

  return email.trim().toLowerCase();
};

const sanitizeName = (name) => {
  if (typeof name !== 'string') {
    return '';
  }

  return name.trim();
};

const ensureAllowedRole = (role) => {
  if (!ALL_ROLES.includes(role)) {
    throw new Error(`Role must be one of: ${ALL_ROLES.join(', ')}`);
  }
};

class UserService {
  static async list() {
    try {
      return User.find().sort({ createdAt: 1 }).exec();
    } catch (err) {
      throw new Error(`Database error while listing users: ${err}`);
    }
  }

  static async get(id) {
    try {
      return User.findOne({ _id: id }).exec();
    } catch (err) {
      throw new Error(`Database error while getting the user by their ID: ${err}`);
    }
  }

  static async getByEmail(email) {
    try {
      const normalizedEmail = normalizeEmail(email);
      return User.findOne({ email: normalizedEmail }).exec();
    } catch (err) {
      throw new Error(`Database error while getting the user by their email: ${err}`);
    }
  }

  static async countUsers() {
    try {
      return User.countDocuments().exec();
    } catch (err) {
      throw new Error(`Database error while counting users: ${err}`);
    }
  }

  static async countActiveAdmins() {
    try {
      return User.countDocuments({ role: ROLES.ADMIN, isActive: true }).exec();
    } catch (err) {
      throw new Error(`Database error while counting active admins: ${err}`);
    }
  }

  static async canPublicRegister() {
    const userCount = await UserService.countUsers();
    return userCount === 0;
  }

  static async update(id, data) {
    try {
      return User.findOneAndUpdate({ _id: id }, data, { returnDocument: 'after', upsert: false });
    } catch (err) {
      throw new Error(`Database error while updating user ${id}: ${err}`);
    }
  }

  static async delete(id) {
    try {
      const user = await User.findOne({ _id: id }).exec();
      if (!user) {
        return false;
      }

      if (user.role === ROLES.ADMIN && user.isActive) {
        const activeAdminCount = await UserService.countActiveAdmins();
        if (activeAdminCount <= 1) {
          throw new Error('At least one active admin account is required');
        }
      }

      const result = await User.deleteOne({ _id: id }).exec();
      return (result.deletedCount === 1);
    } catch (err) {
      throw new Error(`Database error while deleting user ${id}: ${err}`);
    }
  }

  static async authenticateWithPassword(email, password) {
    if (!email) throw new Error('Email is required');
    if (!password) throw new Error('Password is required');

    try {
      const normalizedEmail = normalizeEmail(email);
      const user = await User.findOne({ email: normalizedEmail }).exec();
      if (!user) return null;

      if (!user.isActive) {
        const error = new Error('User account is inactive');
        error.status = 403;
        throw error;
      }

      const passwordValid = await validatePassword(password, user.password);
      if (!passwordValid) return null;

      user.lastLoginAt = Date.now();
      const updatedUser = await user.save();
      return updatedUser;
    } catch (err) {
      throw new Error(`Database error while authenticating user ${email} with password: ${err}`);
    }
  }

  static async create({ email, password, name = '', role = ROLES.USER, isActive = true }) {
    if (!email) throw new Error('Email is required');
    if (!password) throw new Error('Password is required');

    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) {
      throw new Error('Email is required');
    }

    ensureAllowedRole(role);

    const existingUser = await UserService.getByEmail(normalizedEmail);
    if (existingUser) throw new Error('User with this email already exists');

    const hash = await generatePasswordHash(password);

    try {
      const user = new User({
        email: normalizedEmail,
        password: hash,
        name: sanitizeName(name),
        role,
        isActive: typeof isActive === 'boolean' ? isActive : true,
      });

      await user.save();
      return user;
    } catch (err) {
      throw new Error(`Database error while creating new user: ${err}`);
    }
  }

  static async setPassword(user, password) {
    if (!password) throw new Error('Password is required');
    user.password = await generatePasswordHash(password); // eslint-disable-line

    try {
      if (!user.isNew) {
        await user.save();
      }

      return user;
    } catch (err) {
      throw new Error(`Database error while setting user password: ${err}`);
    }
  }

  static async setPasswordById(id, password) {
    const user = await UserService.get(id);
    if (!user) {
      throw new Error('User not found');
    }

    return UserService.setPassword(user, password);
  }

  static async updateUserDetails(id, data = {}) {
    const user = await UserService.get(id);
    if (!user) {
      throw new Error('User not found');
    }

    const updates = {};

    if (Object.prototype.hasOwnProperty.call(data, 'name')) {
      updates.name = sanitizeName(data.name);
    }

    if (Object.prototype.hasOwnProperty.call(data, 'email')) {
      const normalizedEmail = normalizeEmail(data.email);
      if (!normalizedEmail) {
        throw new Error('Email is required');
      }

      const existingUser = await User.findOne({
        email: normalizedEmail,
        _id: { $ne: id }
      }).exec();

      if (existingUser) {
        throw new Error('User with this email already exists');
      }

      updates.email = normalizedEmail;
    }

    if (Object.prototype.hasOwnProperty.call(data, 'role')) {
      ensureAllowedRole(data.role);

      if (user.role === ROLES.ADMIN && data.role !== ROLES.ADMIN && user.isActive) {
        const activeAdminCount = await UserService.countActiveAdmins();
        if (activeAdminCount <= 1) {
          throw new Error('At least one active admin account is required');
        }
      }

      updates.role = data.role;
    }

    if (Object.prototype.hasOwnProperty.call(data, 'isActive')) {
      if (typeof data.isActive !== 'boolean') {
        throw new Error('isActive must be a boolean');
      }

      if (user.role === ROLES.ADMIN && user.isActive && data.isActive === false) {
        const activeAdminCount = await UserService.countActiveAdmins();
        if (activeAdminCount <= 1) {
          throw new Error('At least one active admin account is required');
        }
      }

      updates.isActive = data.isActive;
    }

    if (Object.keys(updates).length === 0) {
      return user;
    }

    Object.assign(user, updates);

    try {
      await user.save();
      return user;
    } catch (err) {
      if (err?.code === 11000) {
        throw new Error('User with this email already exists');
      }
      throw new Error(`Database error while updating user ${id}: ${err}`);
    }
  }
}

module.exports = UserService;
