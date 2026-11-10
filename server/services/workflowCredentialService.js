const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const WorkflowCredential = require('../models/WorkflowCredential');
const { PRIVATE_HTTP_FIELDS } = require('../utils/redactSecrets');

class WorkflowCredentialService {
  constructor(options = {}) {
    this.model = options.model || WorkflowCredential;
    this.keyPath = options.keyPath || path.resolve(__dirname, '../data/workflow-credentials/credentials.key');
  }

  async key(create = false) {
    if (create) {
      await fs.mkdir(path.dirname(this.keyPath), { recursive: true, mode: 0o700 });
      const temporary = `${this.keyPath}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 });
        // A completed file is linked atomically, including across processes.
        try { await fs.link(temporary, this.keyPath); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      } finally { await fs.rm(temporary, { force: true }); }
    }
    // A restore missing its original key must fail, never generate a new one.
    const key = await fs.readFile(this.keyPath);
    if (key.length !== 32) throw new Error('Workflow credential key is invalid; restore the original key');
    return key;
  }

  async store(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', await this.key(true), iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    const doc = await this.model.create({ encrypted: Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64') });
    return doc._id.toString();
  }

  async load(reference) {
    if (!/^[a-f\d]{24}$/i.test(String(reference))) throw new Error('Invalid workflow credential reference');
    const doc = await this.model.findById(reference).select('+encrypted').lean();
    if (!doc?.encrypted) throw new Error('Workflow credentials are unavailable; restore their database and key');
    const bytes = Buffer.from(doc.encrypted, 'base64');
    const cipher = crypto.createDecipheriv('aes-256-gcm', await this.key(), bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'));
  }

  async protect(value) {
    if (Array.isArray(value)) return Promise.all(value.map((entry) => this.protect(entry)));
    if (!value || typeof value !== 'object' || value instanceof Date || value._bsontype === 'ObjectId') return value;
    if (typeof value.toObject === 'function') value = value.toObject();
    const result = {};
    for (const [key, entry] of Object.entries(value)) result[key] = await this.protect(entry);
    if ((result.type === 'http_request' || result.actionType === 'http_request') && result.parameters) {
      const parameters = { ...result.parameters };
      const privateFields = {};
      for (const key of PRIVATE_HTTP_FIELDS) {
        if (Object.hasOwn(parameters, key)) {
          if (parameters[key] !== '[REDACTED]') privateFields[key] = parameters[key];
          delete parameters[key];
        }
      }
      if (Object.keys(privateFields).length) {
        const prior = parameters.credentialRef ? await this.load(parameters.credentialRef) : {};
        parameters.credentialRef = await this.store({ ...prior, ...privateFields });
      }
      result.parameters = parameters;
    }
    return result;
  }

  async resolveParameters(parameters = {}) {
    if (!parameters.credentialRef) return parameters;
    return { ...parameters, ...await this.load(parameters.credentialRef) };
  }

  async migrate() {
    let migrated = 0;
    for (const [name, query, fields] of [
      ['Workflow', {}, ['actions', 'graph']],
      ['Automation', {}, ['actions', 'workflowGraph']],
      ['AutomationHistory', { status: 'running' }, ['resumeState']]
    ]) {
      const Model = require(`../models/${name}`);
      for await (const doc of Model.find(query).cursor()) {
        const changes = {};
        for (const field of fields) {
          const before = doc[field]?.toObject?.() || doc[field];
          const after = await this.protect(before);
          if (JSON.stringify(before) !== JSON.stringify(after)) changes[field] = after;
        }
        if (Object.keys(changes).length) {
          await Model.updateOne({ _id: doc._id }, { $set: changes });
          migrated += 1;
        }
      }
    }
    return { migrated };
  }
}

module.exports = new WorkflowCredentialService();
module.exports.WorkflowCredentialService = WorkflowCredentialService;
