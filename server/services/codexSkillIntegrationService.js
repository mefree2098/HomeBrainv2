const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const { ZipFile } = require('yazl');

const CodexSkillIntegration = require('../models/CodexSkillIntegration');
const UserService = require('./userService');
const { trimTrailingSlashes } = require('../utils/networkSafety');

const CODEX_TOKEN_PREFIX = 'hbcdx_live_';
const DEFAULT_TOKEN_PLACEHOLDER = '<PASTE_HOMEBRAIN_CODEX_TOKEN>';
const URL_ENV_VAR = 'HOMEBRAIN_CODEX_URL';
const TOKEN_ENV_VAR = 'HOMEBRAIN_CODEX_TOKEN';
const SKILL_DIR = path.resolve(__dirname, '..', '..', 'codex', 'skills', 'homebrain-live');
const SKILL_PATH = path.join(SKILL_DIR, 'SKILL.md');
const OPENAI_YAML_PATH = path.join(SKILL_DIR, 'agents', 'openai.yaml');
const HELPER_SCRIPT_PATH = path.join(SKILL_DIR, 'scripts', 'homebrain-live.js');

function sanitizeBaseUrl(value) {
  return trimTrailingSlashes(String(value || '').trim());
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

function buildSkillChecksum(markdown) {
  return crypto.createHash('sha256').update(markdown).digest('hex');
}

function buildEnvSnippet(baseUrl, token = DEFAULT_TOKEN_PLACEHOLDER) {
  return [
    `export ${URL_ENV_VAR}="${sanitizeBaseUrl(baseUrl)}"`,
    `export ${TOKEN_ENV_VAR}="${token}"`
  ].join('\n');
}

function buildInstallScript() {
  return `#!/usr/bin/env bash
set -euo pipefail

BUNDLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODEX_HOME_DIR="\${CODEX_HOME:-$HOME/.codex}"
TARGET_DIR="$CODEX_HOME_DIR/skills/homebrain-live"

mkdir -p "$CODEX_HOME_DIR/skills"
rm -rf "$TARGET_DIR"
cp -R "$BUNDLE_DIR/homebrain-live" "$TARGET_DIR"
chmod +x "$TARGET_DIR/scripts/homebrain-live.js"

printf 'Installed HomeBrain Codex skill to %s\\n' "$TARGET_DIR"
printf 'Load the generated HomeBrain connection vars with:\\n'
printf '  source "%s/codex-env.sh"\\n' "$BUNDLE_DIR"
`;
}

class CodexSkillIntegrationService {
  constructor() {
    this.skillDir = SKILL_DIR;
    this.skillPath = SKILL_PATH;
    this.skillOpenAiYamlPath = OPENAI_YAML_PATH;
    this.helperScriptPath = HELPER_SCRIPT_PATH;
    this.urlEnvVar = URL_ENV_VAR;
    this.tokenEnvVar = TOKEN_ENV_VAR;
    this.placeholderToken = DEFAULT_TOKEN_PLACEHOLDER;
  }

  async getIntegration() {
    return CodexSkillIntegration.getIntegration();
  }

  looksLikeCodexSkillToken(rawToken) {
    return String(rawToken || '').trim().startsWith(CODEX_TOKEN_PREFIX);
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

  readTextFile(filePath) {
    return fs.promises.readFile(filePath, 'utf8');
  }

  async getSkillMarkdown() {
    return this.readTextFile(this.skillPath);
  }

  async getSkillOpenAiYaml() {
    return this.readTextFile(this.skillOpenAiYamlPath);
  }

  async getHelperScriptSource() {
    return this.readTextFile(this.helperScriptPath);
  }

  async buildConnectionBundle(req, options = {}) {
    const integration = options.integration || await this.getIntegration();
    const baseUrl = this.resolveBaseUrl(req, options.baseUrl, integration);
    const [skillMarkdown, openAiYaml, helperScript] = await Promise.all([
      this.getSkillMarkdown(),
      this.getSkillOpenAiYaml(),
      this.getHelperScriptSource()
    ]);
    const exportSnippet = buildEnvSnippet(baseUrl, options.token || DEFAULT_TOKEN_PLACEHOLDER);

    return {
      baseUrl,
      exportSnippet,
      helperExamples: [
        'node scripts/homebrain-live.js overview',
        'node scripts/homebrain-live.js events-tail --category deploy',
        'node scripts/homebrain-live.js deploy-run --preset safe',
        'node scripts/homebrain-live.js request /api/devices'
      ],
      skill: {
        directory: 'homebrain-live',
        fileName: 'SKILL.md',
        checksum: buildSkillChecksum(skillMarkdown),
        markdown: skillMarkdown,
        openAiYaml
      },
      helper: {
        fileName: 'homebrain-live.js',
        relativePath: 'scripts/homebrain-live.js',
        source: helperScript
      },
      envVarNames: {
        baseUrl: this.urlEnvVar,
        token: this.tokenEnvVar
      },
      bundleFileName: 'homebrain-codex-skill-bundle.zip',
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
      setup: {
        baseUrl: bundle.baseUrl,
        exportSnippet: bundle.exportSnippet,
        helperExamples: bundle.helperExamples,
        envVarNames: bundle.envVarNames,
        placeholderToken: bundle.placeholderToken
      },
      skill: bundle.skill,
      helper: bundle.helper,
      bundle: {
        fileName: bundle.bundleFileName
      }
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

  async rotateToken({ actor = 'unknown', user = null } = {}) {
    const integration = await this.getIntegration();
    const token = `${CODEX_TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;

    integration.tokenHash = await bcrypt.hash(token, 12);
    integration.tokenPrefix = token.slice(0, 18);
    integration.tokenCreatedAt = integration.tokenCreatedAt || new Date();
    integration.tokenRotatedAt = new Date();
    integration.createdBy = actor;
    integration.issuedToUserId = user?._id || null;
    integration.issuedToEmail = user?.email || '';

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
    integration.issuedToUserId = null;
    integration.issuedToEmail = '';
    await integration.save();
    return integration.toSanitized();
  }

  async verifyToken(rawToken, req = null) {
    const token = String(rawToken || '').trim();
    if (!token) {
      const error = new Error('Codex skill token is required');
      error.status = 401;
      throw error;
    }

    const integration = await this.getIntegration();

    if (!integration.enabled) {
      const error = new Error('Codex skill integration is disabled');
      error.status = 403;
      throw error;
    }

    if (!integration.tokenHash) {
      const error = new Error('Codex skill integration token is not configured');
      error.status = 401;
      throw error;
    }

    const valid = await bcrypt.compare(token, integration.tokenHash);
    if (!valid) {
      const error = new Error('Invalid Codex skill token');
      error.status = 401;
      throw error;
    }

    integration.lastUsedAt = new Date();
    integration.lastUsedIp = resolveRequestIp(req);
    integration.lastUserAgent = String(req?.headers?.['user-agent'] || '').slice(0, 500);
    await integration.save();

    return integration;
  }

  async resolveAuthenticatedUser(rawToken, req = null) {
    const integration = await this.verifyToken(rawToken, req);
    const userId = integration?.issuedToUserId ? String(integration.issuedToUserId) : '';
    if (!userId) {
      const error = new Error('Codex skill token is not bound to a HomeBrain user');
      error.status = 401;
      throw error;
    }

    const user = await UserService.get(userId);
    if (!user) {
      const error = new Error('Codex skill user not found');
      error.status = 401;
      throw error;
    }

    return {
      integration,
      user
    };
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
    const installScript = buildInstallScript();

    zipfile.addBuffer(Buffer.from(`${bundle.skill.markdown}\n`, 'utf8'), 'homebrain-live/SKILL.md');
    zipfile.addBuffer(Buffer.from(`${bundle.skill.openAiYaml}\n`, 'utf8'), 'homebrain-live/agents/openai.yaml');
    zipfile.addBuffer(
      Buffer.from(`${bundle.helper.source}\n`, 'utf8'),
      `homebrain-live/${bundle.helper.relativePath}`,
      { mode: 0o755 }
    );
    zipfile.addBuffer(Buffer.from(`${bundle.exportSnippet}\n`, 'utf8'), 'codex-env.sh', { mode: 0o644 });
    zipfile.addBuffer(Buffer.from(`${installScript}\n`, 'utf8'), 'install-homebrain-codex-skill.sh', { mode: 0o755 });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${bundle.bundleFileName}"`);

    return new Promise((resolve, reject) => {
      zipfile.outputStream.on('error', reject);
      zipfile.outputStream.on('end', resolve);
      zipfile.outputStream.pipe(res);
      zipfile.end();
    });
  }
}

module.exports = new CodexSkillIntegrationService();
