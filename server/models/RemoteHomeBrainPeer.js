const mongoose = require('mongoose');

const RemoteHomeBrainPeerSchema = new mongoose.Schema({
  direction: {
    type: String,
    enum: ['inbound', 'outbound'],
    required: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 120
  },
  enabled: {
    type: Boolean,
    default: true,
    index: true
  },
  remoteUrl: {
    type: String,
    trim: true,
    maxlength: 500,
    default: ''
  },
  tokenHash: {
    type: String,
    select: false
  },
  outboundToken: {
    type: String,
    select: false
  },
  tokenPreview: {
    type: String,
    trim: true,
    default: ''
  },
  sourceInstanceName: {
    type: String,
    trim: true,
    maxlength: 160,
    default: ''
  },
  sourceInstanceUrl: {
    type: String,
    trim: true,
    maxlength: 500,
    default: ''
  },
  lastHandshakeAt: {
    type: Date
  },
  lastReceivedAt: {
    type: Date
  },
  lastForwardedAt: {
    type: Date
  },
  lastDeliveryAt: {
    type: Date
  },
  lastDeliveryStatus: {
    type: String,
    enum: ['never', 'ok', 'failed'],
    default: 'never'
  },
  lastDeliveryMessage: {
    type: String,
    trim: true,
    maxlength: 500,
    default: ''
  },
  lastAlertEventType: {
    type: String,
    trim: true,
    maxlength: 160,
    default: ''
  },
  lastAlertTitle: {
    type: String,
    trim: true,
    maxlength: 200,
    default: ''
  }
}, {
  timestamps: true,
  versionKey: false
});

RemoteHomeBrainPeerSchema.index({ direction: 1, name: 1 });
RemoteHomeBrainPeerSchema.index({ direction: 1, enabled: 1 });
RemoteHomeBrainPeerSchema.index({ tokenHash: 1 }, {
  unique: true,
  sparse: true
});

module.exports = mongoose.model('RemoteHomeBrainPeer', RemoteHomeBrainPeerSchema);
