const mongoose = require('mongoose');

const reverseProxyAuditLogSchema = new mongoose.Schema({
  routeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ReverseProxyRoute',
    default: null
  },
  hostname: {
    type: String,
    trim: true,
    lowercase: true,
    default: ''
  },
  actor: {
    type: String,
    default: 'system'
  },
  action: {
    type: String,
    enum: [
      'route_created',
      'route_updated',
      'route_deleted',
      'settings_updated',
      'validation_run',
      'config_applied',
      'certificate_check'
    ],
    required: true
  },
  status: {
    type: String,
    enum: ['success', 'failed'],
    default: 'success'
  },
  details: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  error: {
    type: String,
    default: ''
  }
}, {
  timestamps: true
});

reverseProxyAuditLogSchema.index({ createdAt: -1 });
reverseProxyAuditLogSchema.index({ hostname: 1, createdAt: -1 });
reverseProxyAuditLogSchema.index({ routeId: 1, createdAt: -1 });

module.exports = mongoose.model('ReverseProxyAuditLog', reverseProxyAuditLogSchema);
