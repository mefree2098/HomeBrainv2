const mongoose = require('mongoose');

module.exports = mongoose.model('WorkflowCredential', new mongoose.Schema({
  encrypted: { type: String, required: true, select: false },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false }));
