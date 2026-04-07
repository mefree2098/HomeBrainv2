const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const { ZipFile } = require('yazl');

const OpenClawIntegration = require('../models/OpenClawIntegration');

const MCP_SERVER_NAME = 'homebrain-admin';
const DEFAULT_TOKEN_PLACEHOLDER = '<PASTE_HOMEBRAIN_OPENCLAW_TOKEN>';
const SKILL_DIR = path.resolve(__dirname, '..', '..', 'openclaw', 'skills', 'homebrain-admin');
const SKILL_PATH = path.join(SKILL_DIR, 'SKILL.md');
const JETSON_GUIDE_PATH = path.resolve(__dirname, '..', '..', 'docs', 'openclaw', 'jetson-setup.md');
const JETSON_INSTALLER_PATH = path.resolve(__dirname, '..', '..', 'openclaw', 'jetson', 'install-jetson.sh');

function sanitizeBaseUrl(value) {
  return String(value || '')
    .trim()
    .replace(/\/+$/, '');
}

function quoteForShell(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function resolveRequestIp(req) {
  return String(
    req?.headers?.['x-forwarded-for']
      || req?.ip
      || req?.socket?.remoteAddress
      || ''
  )
    .split(',')[0]
    .trim();
}

function resolveProtocol(req) {
  const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();

  if (forwardedProto === 'https' || forwardedProto === 'http') {
    return forwardedProto;
  }

  if (req?.secure) {
    return 'https';
  }

  return req?.protocol === 'https' ? 'https' : 'http';
}

function resolveHost(req) {
  const forwardedHost = String(req?.headers?.['x-forwarded-host'] || '')
    .split(',')[0]
    .trim();
  if (forwardedHost) {
    return forwardedHost;
  }

  if (typeof req?.get === 'function') {
    return String(req.get('host') || '').trim();
  }

  return String(req?.headers?.host || '').trim();
}

function buildSkillChecksum(markdown) {
  return crypto.createHash('sha256').update(markdown).digest('hex');
}

function validatePublishedBaseUrl(value) {
  const normalized = sanitizeBaseUrl(value);
  if (!normalized) {
    return '';
  }

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch (_error) {
    throw new Error('Published HomeBrain URL must be a valid http:// or https:// URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Published HomeBrain URL must start with http:// or https://');
  }

  return sanitizeBaseUrl(parsed.toString());
}

class OpenClawIntegrationService {
  constructor() {
    this.mcpServerName = MCP_SERVER_NAME;
    this.skillPath = SKILL_PATH;
    this.jetsonGuidePath = JETSON_GUIDE_PATH;
    this.jetsonInstallerPath = JETSON_INSTALLER_PATH;
  }

  async getIntegration() {
    return OpenClawIntegration.getIntegration();
  }

  extractBearerToken(req) {
    const authorization = String(req?.headers?.authorization || '').trim();
    if (authorization.toLowerCase().startsWith('bearer ')) {
      const token = authorization.slice(7).trim();
      return token || null;
    }
    return null;
  }

  resolveBaseUrl(req, explicitBaseUrl = '', integration = null) {
    const requested = sanitizeBaseUrl(explicitBaseUrl);
    if (requested) {
      return requested;
    }

    const configured = sanitizeBaseUrl(integration?.publishedBaseUrl);
    if (configured) {
      return configured;
    }

    const host = resolveHost(req);
    if (!host) {
      return '';
    }

    return `${resolveProtocol(req)}://${host}`;
  }

  buildServerDefinition(baseUrl, token = DEFAULT_TOKEN_PLACEHOLDER) {
    const normalizedBaseUrl = sanitizeBaseUrl(baseUrl);
    const endpointUrl = `${normalizedBaseUrl}/api/openclaw/mcp`;

    return {
      url: endpointUrl,
      transport: 'streamable-http',
      headers: {
        Authorization: `Bearer ${token}`
      },
      connectionTimeoutMs: 10000
    };
  }

  buildCliCommand(serverDefinition) {
    return `openclaw mcp set ${this.mcpServerName} ${quoteForShell(JSON.stringify(serverDefinition))}`;
  }

  readTextFile(filePath) {
    return fs.promises.readFile(filePath, 'utf8');
  }

  async getSkillMarkdown() {
    return this.readTextFile(this.skillPath);
  }

  async getJetsonGuideMarkdown() {
    return this.readTextFile(this.jetsonGuidePath);
  }

  async getJetsonInstallerScript() {
    return this.readTextFile(this.jetsonInstallerPath);
  }

  async buildConnectionBundle(req, options = {}) {
    const integration = options.integration || await this.getIntegration();
    const baseUrl = this.resolveBaseUrl(req, options.baseUrl, integration);
    const skillMarkdown = await this.getSkillMarkdown();
    const jetsonGuide = await this.getJetsonGuideMarkdown();
    const jetsonInstaller = await this.getJetsonInstallerScript();
    const serverDefinition = this.buildServerDefinition(baseUrl, options.token || DEFAULT_TOKEN_PLACEHOLDER);
    const cliCommand = this.buildCliCommand(serverDefinition);

    return {
      serverName: this.mcpServerName,
      baseUrl,
      endpointUrl: serverDefinition.url,
      transport: 'streamable-http',
      serverDefinition,
      cliCommand,
      skill: {
        directory: 'homebrain-admin',
        fileName: 'SKILL.md',
        checksum: buildSkillChecksum(skillMarkdown),
        markdown: skillMarkdown
      },
      jetsonInstaller: {
        fileName: 'install-jetson.sh',
        shellScript: jetsonInstaller
      },
      jetsonGuide,
      placeholderToken: DEFAULT_TOKEN_PLACEHOLDER
    };
  }

  async getStatus(req, options = {}) {
    const integration = await this.getIntegration();
    const sanitized = integration.toSanitized();
    const bundle = await this.buildConnectionBundle(req, {
      ...options,
      integration
    });

    return {
      integration: sanitized,
      mcp: {
        serverName: bundle.serverName,
        baseUrl: bundle.baseUrl,
        endpointUrl: bundle.endpointUrl,
        transport: bundle.transport,
        serverDefinition: bundle.serverDefinition,
        cliCommand: bundle.cliCommand,
        placeholderToken: bundle.placeholderToken
      },
      skill: bundle.skill,
      jetsonGuide: bundle.jetsonGuide,
      jetsonInstaller: bundle.jetsonInstaller
    };
  }

  async updateIntegrationSettings(updates = {}, actor = 'unknown') {
    const integration = await this.getIntegration();

    if (typeof updates.enabled === 'boolean') {
      integration.enabled = updates.enabled;
    }

    if (typeof updates.displayName === 'string' && updates.displayName.trim()) {
      integration.displayName = updates.displayName.trim();
    }

    if (typeof updates.publishedBaseUrl === 'string') {
      integration.publishedBaseUrl = validatePublishedBaseUrl(updates.publishedBaseUrl);
    }

    if (typeof updates.notes === 'string') {
      integration.notes = updates.notes.trim();
    }

    integration.createdBy = actor || integration.createdBy || 'unknown';
    await integration.save();
    return integration.toSanitized();
  }

  async rotateToken({ actor = 'unknown' } = {}) {
    const integration = await this.getIntegration();
    const token = `hboc_live_${crypto.randomBytes(32).toString('base64url')}`;

    integration.tokenHash = await bcrypt.hash(token, 12);
    integration.tokenPrefix = token.slice(0, 18);
    integration.tokenCreatedAt = integration.tokenCreatedAt || new Date();
    integration.tokenRotatedAt = new Date();
    integration.createdBy = actor;

    await integration.save();

    return {
      token,
      integration: integration.toSanitized()
    };
  }

  async revokeToken({ actor = 'unknown' } = {}) {
    const integration = await this.getIntegration();
    integration.tokenHash = '';
    integration.tokenPrefix = '';
    integration.tokenRotatedAt = new Date();
    integration.createdBy = actor;
    await integration.save();
    return integration.toSanitized();
  }

  async verifyToken(rawToken, req = null) {
    const token = String(rawToken || '').trim();
    if (!token) {
      const error = new Error('OpenClaw integration token is required');
      error.status = 401;
      throw error;
    }

    const integration = await this.getIntegration();

    if (!integration.enabled) {
      const error = new Error('OpenClaw integration is disabled');
      error.status = 403;
      throw error;
    }

    if (!integration.tokenHash) {
      const error = new Error('OpenClaw integration token is not configured');
      error.status = 401;
      throw error;
    }

    const valid = await bcrypt.compare(token, integration.tokenHash);
    if (!valid) {
      const error = new Error('Invalid OpenClaw integration token');
      error.status = 401;
      throw error;
    }

    integration.lastUsedAt = new Date();
    integration.lastUsedIp = resolveRequestIp(req);
    integration.lastUserAgent = String(req?.headers?.['user-agent'] || '').slice(0, 500);
    await integration.save();

    return integration;
  }

  async currentTokenMatches(rawToken) {
    const token = String(rawToken || '').trim();
    if (!token) {
      return false;
    }

    const integration = await this.getIntegration();
    if (!integration.tokenHash) {
      return false;
    }

    return bcrypt.compare(token, integration.tokenHash);
  }

  async writeBundleToResponse(res, req, options = {}) {
    const bundle = await this.buildConnectionBundle(req, options);
    const zipfile = new ZipFile();

    zipfile.addBuffer(Buffer.from(`${bundle.skill.markdown}\n`, 'utf8'), 'homebrain-admin/SKILL.md');
    zipfile.addBuffer(
      Buffer.from(`${JSON.stringify(bundle.serverDefinition, null, 2)}\n`, 'utf8'),
      'openclaw-mcp-server.json'
    );
    zipfile.addBuffer(
      Buffer.from(`${bundle.cliCommand}\n`, 'utf8'),
      'openclaw-cli-command.txt'
    );
    zipfile.addFile(
      this.jetsonInstallerPath,
      bundle.jetsonInstaller.fileName,
      { mode: 0o755 }
    );
    zipfile.addBuffer(
      Buffer.from(`${bundle.jetsonGuide}\n`, 'utf8'),
      'JETSON-SETUP.md'
    );

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="homebrain-openclaw-bundle.zip"');

    return new Promise((resolve, reject) => {
      zipfile.outputStream.on('error', reject);
      zipfile.outputStream.on('end', resolve);
      zipfile.outputStream.pipe(res);
      zipfile.end();
    });
  }
}

module.exports = new OpenClawIntegrationService();
