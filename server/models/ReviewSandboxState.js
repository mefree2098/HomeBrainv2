const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
    index: true,
  },
  schemaVersion: {
    type: Number,
    default: 1,
  },
  state: {
    type: mongoose.Schema.Types.Mixed,
    required: true,
  },
}, {
  versionKey: false,
  timestamps: true,
});

module.exports = mongoose.model('ReviewSandboxState', schema);
