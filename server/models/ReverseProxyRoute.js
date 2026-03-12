const mongoose = require('mongoose');

const validationSnapshotSchema = new mongoose.Schema({
  lastCheckedAt: {
    type: Date,
    default: null
  },
  hostnameValid: {
    type: Boolean,
    default: false
  },
  upstreamReachable: {
    type: Boolean,
    default: false
  },
  upstreamStatusCode: {
    type: Number,
    default: null
  },
  caddyAdminReachable: {
    type: Boolean,
    default: false
  },
  dnsReady: {
    type: Boolean,
    default: false
  },
  publicIpMatches: {
    type: Boolean,
    default: null
  },
  routerPortsReachable: {
    type: Boolean,
    default: null
  },
  resolvedAddresses: {
    type: [String],
    default: []
  },
  blockingErrors: {
    type: [String],
    default: []
  },
  warnings: {
    type: [String],
    default: []
  }
}, { _id: false });

const certificateStatusSchema = new mongoose.Schema({
  automaticTlsEligible: {
    type: Boolean,
    default: false
  },
  dnsReady: {
    type: Boolean,
    default: false
  },
  status: {
    type: String,
    enum: ['unknown', 'inactive', 'pending', 'issued', 'error'],
    default: 'unknown'
  },
  renewalState: {
    type: String,
    default: 'unknown'
  },
  lastError: {
    type: String,
    default: ''
  },
  ownershipVerified: {
    type: Boolean,
    default: false
  },
  adminApproved: {
    type: Boolean,
    default: false
  },
  servedIssuer: {
    type: String,
    default: ''
  },
  servedSubject: {
    type: String,
    default: ''
  },
  servedNotAfter: {
    type: Date,
    default: null
  },
  lastCheckedAt: {
    type: Date,
    default: null
  }
}, { _id: false });

const reverseProxyRouteSchema = new mongoose.Schema({
  hostname: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true
  },
  platformKey: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    default: 'custom'
  },
  displayName: {
    type: String,
    trim: true,
    default: ''
  },
  upstreamProtocol: {
    type: String,
    enum: ['http', 'https'],
    default: 'http'
  },
  upstreamHost: {
    type: String,
    required: true,
    trim: true,
    lowercase: true
  },
  upstreamPort: {
    type: Number,
    required: true,
    min: 1,
    max: 65535
  },
  enabled: {
    type: Boolean,
    default: false
  },
  tlsMode: {
    type: String,
    enum: ['automatic', 'internal', 'manual', 'on_demand'],
    default: 'automatic'
  },
  allowOnDemandTls: {
    type: Boolean,
    default: false
  },
  allowPublicUpstream: {
    type: Boolean,
    default: false
  },
  healthCheckPath: {
    type: String,
    trim: true,
    default: '/'
  },
  websocketSupport: {
    type: Boolean,
    default: true
  },
  stripPrefix: {
    type: String,
    trim: true,
    default: ''
  },
  createdBy: {
    type: String,
    default: 'system'
  },
  updatedBy: {
    type: String,
    default: 'system'
  },
  lastApplyStatus: {
    type: String,
    enum: ['never', 'pending', 'applied', 'failed'],
    default: 'never'
  },
  lastApplyError: {
    type: String,
    default: ''
  },
  validationStatus: {
    type: String,
    enum: ['unknown', 'valid', 'invalid'],
    default: 'unknown'
  },
  validation: {
    type: validationSnapshotSchema,
    default: () => ({})
  },
  certificateStatus: {
    type: certificateStatusSchema,
    default: () => ({})
  },
  notes: {
    type: String,
    default: ''
  }
}, {
  timestamps: true
});

reverseProxyRouteSchema.index({ platformKey: 1, enabled: 1 });
reverseProxyRouteSchema.index({ lastApplyStatus: 1, validationStatus: 1 });

module.exports = mongoose.model('ReverseProxyRoute', reverseProxyRouteSchema);
