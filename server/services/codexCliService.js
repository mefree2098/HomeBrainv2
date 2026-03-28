const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let serverPackageVersion = '1.0.0';
try {
  serverPackageVersion = require('../package.json').version || serverPackageVersion;
} catch (error) {
  // Ignore package version lookup failures and keep a stable fallback.
}

const DEFAULT_CODEX_MODEL = process.env.CODEX_DEFAULT_MODEL || 'gpt-5.4';
const DEFAULT_CODEX_PATH = process.env.CODEX_PATH || 'codex';
const DEFAULT_AWS_VOLUME_ROOT = '/mnt/efs';
const DEFAULT_RPC_TIMEOUT_MS = Math.max(5_000, Number(process.env.CODEX_RPC_TIMEOUT_MS || 45_000));
const DEFAULT_TURN_TIMEOUT_MS = Math.max(DEFAULT_RPC_TIMEOUT_MS, Number(process.env.CODEX_TURN_TIMEOUT_MS || 180_000));
const DEFAULT_LOGIN_TTL_MS = Math.max(30_000, Number(process.env.CODEX_LOGIN_TTL_MS || 600_000));
const DEFAULT_LOGIN_COMPLETE_TIMEOUT_MS = Math.max(5_000, Number(process.env.CODEX_LOGIN_COMPLETE_TIMEOUT_MS || 30_000));
const DEFAULT_LOGIN_HTTP_WAIT_MS = Math.max(2_000, Number(process.env.CODEX_LOGIN_HTTP_WAIT_MS || 12_000));
const DEFAULT_CODEX_HOME_SLUG = 'homebrain';
const DEFAULT_TEMP_HOME_SLUG = 'homebrain-codex-home';
const LOGIN_CALLBACK_HINT = 'If login lands on localhost and fails, paste that full URL into Complete login.';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const DEFAULT_NOTIFICATION_OPTOUT = [
  'mcpServer/startupStatus/updated',
  'account/rateLimits/updated',
  'account/updated',
  'app/list/updated'
];
const VALID_CODEX_HOME_PROFILES = new Set(['auto', 'azure', 'aws', 'local', 'custom']);
const VALID_CODEX_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);
const TURN_RESULT_PHASE = 'final_answer';

const pendingCodexLogins = new Map();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeString(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
}

function normalizeCodexHomeProfile(value) {
  const normalized = sanitizeString(value).toLowerCase();
  if (!normalized || !VALID_CODEX_HOME_PROFILES.has(normalized)) {
    return 'auto';
  }
  return normalized;
}

function isAzureRuntime() {
  return Boolean(process.env.WEBSITE_SITE_NAME || process.env.WEBSITE_INSTANCE_ID);
}

function isAwsRuntime() {
  return Boolean(
    process.env.AWS_EXECUTION_ENV ||
    process.env.ECS_CONTAINER_METADATA_URI ||
    process.env.ECS_CONTAINER_METADATA_URI_V4 ||
    process.env.EKS_CLUSTER_NAME
  );
}

function resolveDraftCodexHome(profile, customHome = '', awsVolumeRoot = DEFAULT_AWS_VOLUME_ROOT, cwd = process.cwd()) {
  const normalizedProfile = normalizeCodexHomeProfile(profile);
  const trimmedCustomHome = sanitizeString(customHome);
  const trimmedAwsVolumeRoot = sanitizeString(awsVolumeRoot) || DEFAULT_AWS_VOLUME_ROOT;
  const projectHome = path.resolve(cwd, '.codex-home');

  switch (normalizedProfile) {
    case 'azure':
      return path.join('/home/site/.codex', DEFAULT_CODEX_HOME_SLUG);
    case 'aws':
      return path.join(trimmedAwsVolumeRoot, '.codex', DEFAULT_CODEX_HOME_SLUG);
    case 'local':
      return projectHome;
    case 'custom':
      return trimmedCustomHome || '';
    case 'auto':
    default:
      if (isAzureRuntime()) {
        return path.join('/home/site/.codex', DEFAULT_CODEX_HOME_SLUG);
      }
      if (isAwsRuntime()) {
        return path.join(trimmedAwsVolumeRoot, '.codex', DEFAULT_CODEX_HOME_SLUG);
      }
      return projectHome;
  }
}

function isJavaScriptEntrypoint(targetPath) {
  return /\.(cjs|mjs|js)$/i.test(targetPath);
}

function resolveBundledCodexEntrypoint() {
  try {
    return require.resolve('@openai/codex/bin/codex.js');
  } catch (error) {
    return null;
  }
}

function resolveCodexLaunchSpec(configuredPath = '') {
  const requestedPath = sanitizeString(configuredPath) || DEFAULT_CODEX_PATH;

  if (isJavaScriptEntrypoint(requestedPath)) {
    return {
      command: process.execPath,
      args: [requestedPath, 'app-server', '--listen', 'stdio://'],
      resolvedPath: requestedPath,
      source: 'script'
    };
  }

  if (!requestedPath || requestedPath === 'codex' || requestedPath === '@openai/codex') {
    const bundledEntrypoint = resolveBundledCodexEntrypoint();
    if (bundledEntrypoint) {
      return {
        command: process.execPath,
        args: [bundledEntrypoint, 'app-server', '--listen', 'stdio://'],
        resolvedPath: bundledEntrypoint,
        source: 'bundled'
      };
    }

    return {
      command: 'codex',
      args: ['app-server', '--listen', 'stdio://'],
      resolvedPath: 'codex',
      source: 'path'
    };
  }

  return {
    command: requestedPath,
    args: ['app-server', '--listen', 'stdio://'],
    resolvedPath: requestedPath,
    source: 'explicit'
  };
}

async function ensureWritableDirectory(candidatePath) {
  const resolvedPath = path.resolve(candidatePath);
  await fs.promises.mkdir(resolvedPath, { recursive: true });

  const probePath = path.join(
    resolvedPath,
    `.write-check-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );

  await fs.promises.writeFile(probePath, 'ok', 'utf8');
  await fs.promises.unlink(probePath).catch(() => {});

  return resolvedPath;
}

async function resolveCodexHomePath({
  requestedHome = '',
  profile = 'auto',
  awsVolumeRoot = DEFAULT_AWS_VOLUME_ROOT,
  cwd = process.cwd()
} = {}) {
  const normalizedProfile = normalizeCodexHomeProfile(profile);
  const trimmedRequestedHome = sanitizeString(requestedHome);
  const trimmedAwsVolumeRoot = sanitizeString(awsVolumeRoot) || DEFAULT_AWS_VOLUME_ROOT;
  const candidates = [];

  const addCandidate = (candidate) => {
    const normalizedCandidate = sanitizeString(candidate);
    if (!normalizedCandidate) {
      return;
    }

    const resolvedCandidate = path.resolve(normalizedCandidate);
    if (!candidates.includes(resolvedCandidate)) {
      candidates.push(resolvedCandidate);
    }
  };

  addCandidate(trimmedRequestedHome);
  addCandidate(resolveDraftCodexHome(normalizedProfile, trimmedRequestedHome, trimmedAwsVolumeRoot, cwd));
  addCandidate(process.env.CODEX_HOME);

  if (isAzureRuntime()) {
    addCandidate(path.join('/home/site/.codex', DEFAULT_CODEX_HOME_SLUG));
    addCandidate('/home/site/.codex');
  }

  addCandidate(path.resolve(cwd, '.codex-home'));
  addCandidate(path.join(os.tmpdir(), DEFAULT_TEMP_HOME_SLUG));

  let lastError = null;
  for (const candidate of candidates) {
    try {
      const writablePath = await ensureWritableDirectory(candidate);
      return {
        codexHome: writablePath,
        profile: normalizedProfile
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `Unable to resolve a writable Codex home directory${lastError ? `: ${lastError.message}` : ''}`
  );
}

async function readFileIfExists(filePath) {
  try {
    return await fs.promises.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

function upsertTomlSetting(content, key, value) {
  const nextLine = `${key} = "${value}"`;
  const keyPattern = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=.*$`, 'm');

  if (keyPattern.test(content)) {
    return content.replace(keyPattern, nextLine);
  }

  const normalizedContent = content.trimEnd();
  return normalizedContent ? `${normalizedContent}\n${nextLine}\n` : `${nextLine}\n`;
}

async function ensureFileBackedCodexConfig(codexHome) {
  await ensureWritableDirectory(codexHome);
  const configPath = path.join(codexHome, 'config.toml');
  let content = await readFileIfExists(configPath);
  content = upsertTomlSetting(content, 'cli_auth_credentials_store', 'file');
  content = upsertTomlSetting(content, 'mcp_oauth_credentials_store', 'file');
  await fs.promises.writeFile(configPath, content, 'utf8');
  return configPath;
}

function createMethodNotFoundError(method) {
  return {
    code: -32601,
    message: `Method not found: ${method}`
  };
}

function formatSpawnError(error) {
  if (error?.code === 'ENOENT') {
    return 'Codex CLI executable not found. Install @openai/codex in the server package or set CODEX_PATH to a working codex binary/script.';
  }

  return error?.message || 'Unable to start Codex CLI.';
}

function ensureLoopbackCallbackUrl(callbackUrl) {
  const normalized = sanitizeString(callbackUrl);
  if (!normalized) {
    throw new Error('Callback URL is required');
  }

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch (error) {
    throw new Error('Callback URL is invalid');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Callback URL must use http or https');
  }

  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error('Callback URL must target localhost or another loopback host');
  }

  if (!parsed.searchParams.get('code') || !parsed.searchParams.get('state')) {
    throw new Error('Callback URL must include both code and state');
  }

  return parsed.toString();
}

function pickCodexModel(preferredModel, models = []) {
  const trimmedPreferredModel = sanitizeString(preferredModel);
  if (!Array.isArray(models) || models.length === 0) {
    return trimmedPreferredModel || DEFAULT_CODEX_MODEL;
  }

  const matchingModel = models.find((model) => {
    const identifiers = [model?.id, model?.model].filter(Boolean).map((value) => String(value).trim());
    return trimmedPreferredModel && identifiers.some((identifier) => identifier === trimmedPreferredModel);
  });

  if (matchingModel) {
    return matchingModel.id || matchingModel.model || trimmedPreferredModel;
  }

  const defaultModel = models.find((model) => model?.isDefault) || models[0];
  return defaultModel?.id || defaultModel?.model || trimmedPreferredModel || DEFAULT_CODEX_MODEL;
}

function extractCodexTurnText(state = {}) {
  const finalAnswer = sanitizeString(state.finalAnswerText);
  if (finalAnswer) {
    return finalAnswer;
  }

  const lastCompletedMessage = sanitizeString(state.lastCompletedMessageText);
  if (lastCompletedMessage) {
    return lastCompletedMessage;
  }

  const deltaText = sanitizeString(state.deltaText);
  return deltaText;
}

function buildCodexOutputSchema(requestConfig = {}) {
  if (requestConfig?.codexOutputSchema && typeof requestConfig.codexOutputSchema === 'object') {
    return requestConfig.codexOutputSchema;
  }

  if (
    requestConfig?.ollamaFormat &&
    typeof requestConfig.ollamaFormat === 'object' &&
    !Array.isArray(requestConfig.ollamaFormat)
  ) {
    return requestConfig.ollamaFormat;
  }

  return null;
}

function createPendingLoginKey(ownerId, loginId) {
  return `${ownerId || 'unknown'}:${loginId || 'unknown'}`;
}

class CodexAppServerSession {
  constructor({
    codexPath = '',
    codexHome,
    rpcTimeoutMs = DEFAULT_RPC_TIMEOUT_MS,
    turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
    cwd = process.cwd()
  }) {
    this.requestedCodexPath = sanitizeString(codexPath);
    this.codexHome = codexHome;
    this.rpcTimeoutMs = rpcTimeoutMs;
    this.turnTimeoutMs = turnTimeoutMs;
    this.cwd = cwd;
    this.launchSpec = null;
    this.child = null;
    this.stdoutBuffer = '';
    this.pendingRequests = new Map();
    this.turnStates = new Map();
    this.loginWaiters = new Map();
    this.nextRequestId = 1;
    this.started = false;
    this.closed = false;
  }

  async start() {
    if (this.started) {
      return this;
    }

    await ensureFileBackedCodexConfig(this.codexHome);
    this.launchSpec = resolveCodexLaunchSpec(this.requestedCodexPath);

    await new Promise((resolve, reject) => {
      const child = spawn(this.launchSpec.command, this.launchSpec.args, {
        cwd: this.cwd,
        env: {
          ...process.env,
          CODEX_HOME: this.codexHome
        },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this.child = child;

      const cleanupListeners = () => {
        child.removeListener('error', handleError);
        child.removeListener('spawn', handleSpawn);
      };

      const handleError = (error) => {
        cleanupListeners();
        reject(new Error(formatSpawnError(error)));
      };

      const handleSpawn = () => {
        cleanupListeners();
        resolve();
      };

      child.once('error', handleError);
      child.once('spawn', handleSpawn);

      child.stdout.on('data', (chunk) => this.handleStdout(chunk));
      child.stderr.on('data', (chunk) => this.handleStderr(chunk));
      child.once('close', (code, signal) => this.handleClose(code, signal));
    });

    await this.request('initialize', {
      clientInfo: {
        name: 'homebrain-server',
        version: serverPackageVersion
      },
      capabilities: {
        experimentalApi: false,
        optOutNotificationMethods: DEFAULT_NOTIFICATION_OPTOUT
      }
    });
    this.notify('initialized', {});

    this.started = true;
    return this;
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk.toString();

    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      newlineIndex = this.stdoutBuffer.indexOf('\n');

      if (!line) {
        continue;
      }

      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        console.warn(`CodexCliService: Failed to parse Codex JSON-RPC message: ${error.message}`);
        continue;
      }

      this.routeMessage(message);
    }
  }

  handleStderr(chunk) {
    const text = chunk.toString().trim();
    if (text) {
      console.warn(`CodexCliService stderr: ${text}`);
    }
  }

  handleClose(code, signal) {
    const closeError = new Error(
      `Codex app-server exited${signal ? ` from signal ${signal}` : ''}${code !== null ? ` with code ${code}` : ''}`
    );

    this.closed = true;
    this.child = null;

    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(closeError);
    }
    this.pendingRequests.clear();

    for (const [, state] of this.turnStates) {
      clearTimeout(state.timeout);
      if (!state.completed && typeof state.reject === 'function') {
        state.reject(closeError);
      }
    }
    this.turnStates.clear();

    for (const [, waiters] of this.loginWaiters) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout);
        waiter.reject(closeError);
      }
    }
    this.loginWaiters.clear();
  }

  routeMessage(message) {
    if (message && Object.prototype.hasOwnProperty.call(message, 'id') && !message.method) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        return;
      }

      clearTimeout(pending.timeout);
      this.pendingRequests.delete(message.id);

      if (message.error) {
        pending.reject(new Error(message.error.message || 'Codex JSON-RPC request failed'));
        return;
      }

      pending.resolve(message.result);
      return;
    }

    if (message && Object.prototype.hasOwnProperty.call(message, 'id') && message.method) {
      this.handleServerRequest(message).catch((error) => {
        this.send({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32603,
            message: error.message || 'Unhandled Codex server request error'
          }
        });
      });
      return;
    }

    if (message?.method) {
      this.handleNotification(message);
    }
  }

  async handleServerRequest(message) {
    switch (message.method) {
      case 'item/commandExecution/requestApproval':
        this.send({ jsonrpc: '2.0', id: message.id, result: { decision: 'cancel' } });
        return;
      case 'item/fileChange/requestApproval':
        this.send({ jsonrpc: '2.0', id: message.id, result: { decision: 'cancel' } });
        return;
      case 'execCommandApproval':
        this.send({ jsonrpc: '2.0', id: message.id, result: { decision: 'abort' } });
        return;
      case 'applyPatchApproval':
        this.send({ jsonrpc: '2.0', id: message.id, result: { decision: 'abort' } });
        return;
      case 'item/tool/requestUserInput':
        this.send({ jsonrpc: '2.0', id: message.id, result: { answers: {} } });
        return;
      case 'item/tool/call':
        this.send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            contentItems: [
              {
                type: 'text',
                text: 'Tool calls are disabled in this integration.'
              }
            ],
            success: false
          }
        });
        return;
      case 'item/permissions/requestApproval':
        this.send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            permissions: {},
            scope: 'turn'
          }
        });
        return;
      case 'account/chatgptAuthTokens/refresh':
        this.send({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32603,
            message: 'ChatGPT token refresh is disabled in this integration.'
          }
        });
        return;
      default:
        this.send({
          jsonrpc: '2.0',
          id: message.id,
          error: createMethodNotFoundError(message.method)
        });
    }
  }

  ensureTurnState(turnId) {
    if (!this.turnStates.has(turnId)) {
      this.turnStates.set(turnId, {
        deltaText: '',
        finalAnswerText: '',
        lastCompletedMessageText: '',
        tokenUsage: null,
        completed: false,
        turn: null,
        resolve: null,
        reject: null,
        timeout: null
      });
    }

    return this.turnStates.get(turnId);
  }

  handleNotification(message) {
    const { method, params } = message;

    if (method === 'item/agentMessage/delta') {
      const state = this.ensureTurnState(params.turnId);
      state.deltaText += typeof params.delta === 'string' ? params.delta : '';
      return;
    }

    if (method === 'item/completed' && params?.turnId) {
      const state = this.ensureTurnState(params.turnId);
      const item = params.item;
      if (item?.type === 'agentMessage') {
        const text = sanitizeString(item.text);
        if (text) {
          state.lastCompletedMessageText = text;
          if (String(item.phase || '').toLowerCase() === TURN_RESULT_PHASE) {
            state.finalAnswerText = text;
          }
        }
      }
      return;
    }

    if (method === 'thread/tokenUsage/updated' && params?.turnId) {
      const state = this.ensureTurnState(params.turnId);
      state.tokenUsage = params.tokenUsage || null;
      return;
    }

    if (method === 'turn/completed' && params?.turn?.id) {
      const turnId = params.turn.id;
      const state = this.ensureTurnState(turnId);
      state.turn = params.turn;
      state.completed = true;

      if (typeof state.resolve === 'function') {
        clearTimeout(state.timeout);
        state.resolve({
          text: extractCodexTurnText(state),
          tokenUsage: state.tokenUsage,
          turn: params.turn
        });
        this.turnStates.delete(turnId);
      }
      return;
    }

    if (method === 'account/login/completed') {
      const waitKey = params?.loginId || '*';
      const candidateKeys = [waitKey];
      if (waitKey !== '*') {
        candidateKeys.push('*');
      }

      for (const candidateKey of candidateKeys) {
        const waiters = this.loginWaiters.get(candidateKey);
        if (!waiters || waiters.length === 0) {
          continue;
        }

        this.loginWaiters.delete(candidateKey);
        for (const waiter of waiters) {
          clearTimeout(waiter.timeout);
          waiter.resolve({
            loginId: params?.loginId || null,
            success: params?.success === true,
            error: params?.error || null
          });
        }
      }
    }
  }

  send(payload) {
    if (!this.child || this.closed) {
      throw new Error('Codex app-server is not running');
    }

    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  notify(method, params) {
    this.send({
      jsonrpc: '2.0',
      method,
      params
    });
  }

  request(method, params, timeoutMs = this.rpcTimeoutMs) {
    if (!this.child || this.closed) {
      return Promise.reject(new Error('Codex app-server is not running'));
    }

    return new Promise((resolve, reject) => {
      const requestId = this.nextRequestId++;
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Codex request timed out: ${method}`));
      }, timeoutMs);

      if (typeof timeout.unref === 'function') {
        timeout.unref();
      }

      this.pendingRequests.set(requestId, { resolve, reject, timeout });
      this.send({
        jsonrpc: '2.0',
        id: requestId,
        method,
        params
      });
    });
  }

  async getAccount({ refreshToken = true, retryAfterWarmup = true } = {}) {
    let accountResponse = await this.request('account/read', { refreshToken: Boolean(refreshToken) });

    if (!accountResponse?.account && accountResponse?.requiresOpenaiAuth && retryAfterWarmup) {
      await delay(250);
      accountResponse = await this.request('account/read', { refreshToken: Boolean(refreshToken) });
    }

    return accountResponse;
  }

  async listModels({ includeHidden = false } = {}) {
    const models = [];
    let cursor = null;

    do {
      const response = await this.request('model/list', {
        includeHidden: Boolean(includeHidden),
        cursor
      });

      if (Array.isArray(response?.data)) {
        models.push(...response.data);
      }
      cursor = response?.nextCursor || null;
    } while (cursor);

    return models;
  }

  waitForLoginCompletion(loginId, timeoutMs = DEFAULT_LOGIN_COMPLETE_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const key = sanitizeString(loginId) || '*';
      const timeout = setTimeout(() => {
        const waiters = this.loginWaiters.get(key) || [];
        this.loginWaiters.set(
          key,
          waiters.filter((waiter) => waiter.resolve !== resolve)
        );
        reject(new Error('Timed out waiting for Codex login completion'));
      }, timeoutMs);

      if (typeof timeout.unref === 'function') {
        timeout.unref();
      }

      const waiters = this.loginWaiters.get(key) || [];
      waiters.push({ resolve, reject, timeout });
      this.loginWaiters.set(key, waiters);
    });
  }

  waitForTurn(turnId, timeoutMs = this.turnTimeoutMs) {
    const state = this.ensureTurnState(turnId);
    if (state.completed && state.turn) {
      return Promise.resolve({
        text: extractCodexTurnText(state),
        tokenUsage: state.tokenUsage,
        turn: state.turn
      });
    }

    return new Promise((resolve, reject) => {
      state.resolve = resolve;
      state.reject = reject;
      state.timeout = setTimeout(() => {
        const timeoutText = extractCodexTurnText(state);
        this.turnStates.delete(turnId);

        if (timeoutText) {
          resolve({
            text: timeoutText,
            tokenUsage: state.tokenUsage,
            turn: state.turn || { id: turnId, status: 'inProgress', error: null }
          });
          return;
        }

        reject(new Error('Timed out waiting for Codex turn completion'));
      }, timeoutMs);

      if (typeof state.timeout.unref === 'function') {
        state.timeout.unref();
      }
    });
  }

  async runTurn({
    message,
    model = '',
    developerInstructions = '',
    outputSchema = null,
    effort = 'medium'
  }) {
    const resolvedEffort = VALID_CODEX_EFFORTS.has(sanitizeString(effort))
      ? sanitizeString(effort)
      : 'medium';

    const threadResponse = await this.request('thread/start', {
      cwd: this.cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      developerInstructions: sanitizeString(developerInstructions) || null,
      model: sanitizeString(model) || null,
      ephemeral: true,
      experimentalRawEvents: false,
      persistExtendedHistory: false
    });

    const turnResponse = await this.request('turn/start', {
      threadId: threadResponse.thread.id,
      input: [
        {
          type: 'text',
          text: message,
          text_elements: []
        }
      ],
      approvalPolicy: 'never',
      sandboxPolicy: {
        type: 'readOnly',
        access: { type: 'fullAccess' },
        networkAccess: false
      },
      effort: resolvedEffort,
      outputSchema: outputSchema || undefined
    });

    const turnResult = await this.waitForTurn(turnResponse.turn.id, this.turnTimeoutMs);
    return {
      threadId: threadResponse.thread.id,
      turnId: turnResponse.turn.id,
      model: threadResponse.model || sanitizeString(model) || DEFAULT_CODEX_MODEL,
      text: turnResult.text,
      tokenUsage: turnResult.tokenUsage,
      turn: turnResult.turn
    };
  }

  async close() {
    if (!this.child || this.closed) {
      return;
    }

    const child = this.child;
    this.closed = true;

    try {
      child.kill('SIGTERM');
    } catch (error) {
      return;
    }

    await new Promise((resolve) => {
      const killTimeout = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch (error) {
          // Ignore follow-up kill failures.
        }
        resolve();
      }, 1_500);

      if (typeof killTimeout.unref === 'function') {
        killTimeout.unref();
      }

      child.once('close', () => {
        clearTimeout(killTimeout);
        resolve();
      });
    });
  }
}

async function resolveSessionOptions({
  settings = null,
  overrides = {},
  cwd = process.cwd()
} = {}) {
  const effectiveSettings = settings || {};
  const resolvedProfile = normalizeCodexHomeProfile(overrides.codexHomeProfile || effectiveSettings.codexHomeProfile);
  const resolvedCodexHome = resolvedProfile === 'custom'
    ? (sanitizeString(overrides.codexHome) || sanitizeString(effectiveSettings.codexHome))
    : '';
  const merged = {
    codexPath: sanitizeString(overrides.codexPath) || sanitizeString(effectiveSettings.codexPath),
    codexHome: resolvedCodexHome,
    codexHomeProfile: resolvedProfile,
    codexAwsVolumeRoot: sanitizeString(overrides.codexAwsVolumeRoot) ||
      sanitizeString(effectiveSettings.codexAwsVolumeRoot) ||
      DEFAULT_AWS_VOLUME_ROOT,
    codexModel: sanitizeString(overrides.codexModel) || sanitizeString(effectiveSettings.codexModel) || DEFAULT_CODEX_MODEL
  };

  const resolvedHome = await resolveCodexHomePath({
    requestedHome: merged.codexHome,
    profile: merged.codexHomeProfile,
    awsVolumeRoot: merged.codexAwsVolumeRoot,
    cwd
  });

  return {
    ...merged,
    effectiveCodexHome: resolvedHome.codexHome,
    effectiveCodexPath: resolveCodexLaunchSpec(merged.codexPath).resolvedPath,
    cwd
  };
}

async function withCodexSession(options, work) {
  const sessionOptions = await resolveSessionOptions(options);
  const session = new CodexAppServerSession({
    codexPath: sessionOptions.codexPath,
    codexHome: sessionOptions.effectiveCodexHome,
    cwd: sessionOptions.cwd
  });

  try {
    await session.start();
    return await work(session, sessionOptions);
  } finally {
    await session.close();
  }
}

async function getCodexModels({
  settings = null,
  overrides = {},
  includeHidden = false,
  startLogin = false,
  ownerId = ''
} = {}) {
  if (startLogin) {
    return startCodexLogin({
      settings,
      overrides,
      ownerId,
      includeHidden
    });
  }

  return withCodexSession({ settings, overrides }, async (session, sessionOptions) => {
    const accountResponse = await session.getAccount({ refreshToken: true });

    if (!accountResponse?.account) {
      return {
        source: 'codex',
        includeHidden: Boolean(includeHidden),
        loginRequired: true,
        effectiveCodexPath: sessionOptions.effectiveCodexPath,
        effectiveCodexHome: sessionOptions.effectiveCodexHome,
        models: []
      };
    }

    const models = await session.listModels({ includeHidden });
    return {
      source: 'codex',
      includeHidden: Boolean(includeHidden),
      loginRequired: false,
      effectiveCodexPath: sessionOptions.effectiveCodexPath,
      effectiveCodexHome: sessionOptions.effectiveCodexHome,
      models
    };
  });
}

async function getCodexAuthHealth({
  settings = null,
  overrides = {},
  includeModelProbe = false
} = {}) {
  return withCodexSession({ settings, overrides }, async (session, sessionOptions) => {
    const accountResponse = await session.getAccount({ refreshToken: true });
    let models = [];

    if (includeModelProbe && accountResponse?.account) {
      try {
        models = await session.listModels({ includeHidden: false });
      } catch (error) {
        console.warn(`CodexCliService: Model probe failed during auth health check: ${error.message}`);
      }
    }

    const account = accountResponse?.account || null;
    return {
      source: 'codex',
      effectiveCodexPath: sessionOptions.effectiveCodexPath,
      effectiveCodexHome: sessionOptions.effectiveCodexHome,
      authenticated: Boolean(account),
      requiresOpenaiAuth: accountResponse?.requiresOpenaiAuth === true,
      loginRequired: !account,
      accountType: account?.type || null,
      accountEmail: account?.type === 'chatgpt' ? account.email : null,
      planType: account?.type === 'chatgpt' ? account.planType : null,
      modelCount: Array.isArray(models) ? models.length : 0,
      sampleModels: Array.isArray(models) ? models.slice(0, 5).map((model) => model.id || model.model) : [],
      pid: process.pid,
      hostname: os.hostname(),
      siteName: process.env.WEBSITE_SITE_NAME || null,
      instanceId: process.env.WEBSITE_INSTANCE_ID || null
    };
  });
}

async function clearPendingLoginsForOwner(ownerId) {
  const entries = Array.from(pendingCodexLogins.entries()).filter(([, pending]) => pending.ownerId === ownerId);
  for (const [key, pending] of entries) {
    clearTimeout(pending.timeout);
    pendingCodexLogins.delete(key);
    await pending.session.close().catch(() => {});
  }
}

async function startCodexLogin({
  settings = null,
  overrides = {},
  ownerId = '',
  includeHidden = false
} = {}) {
  const sessionOptions = await resolveSessionOptions({ settings, overrides });
  const session = new CodexAppServerSession({
    codexPath: sessionOptions.codexPath,
    codexHome: sessionOptions.effectiveCodexHome,
    cwd: sessionOptions.cwd
  });

  await clearPendingLoginsForOwner(ownerId);

  try {
    await session.start();
    const loginResponse = await session.request('account/login/start', { type: 'chatgpt' });
    const loginId = loginResponse?.loginId;

    if (!loginId || !loginResponse?.authUrl) {
      throw new Error('Codex login did not return a login id or auth URL');
    }

    const pendingKey = createPendingLoginKey(ownerId, loginId);
    const timeout = setTimeout(() => {
      const pending = pendingCodexLogins.get(pendingKey);
      if (!pending) {
        return;
      }
      pendingCodexLogins.delete(pendingKey);
      void pending.session.close();
    }, DEFAULT_LOGIN_TTL_MS);

    if (typeof timeout.unref === 'function') {
      timeout.unref();
    }

    pendingCodexLogins.set(pendingKey, {
      ownerId,
      loginId,
      session,
      timeout,
      createdAt: Date.now(),
      sessionOptions
    });

    return {
      source: 'codex',
      includeHidden: Boolean(includeHidden),
      loginRequired: true,
      authUrl: loginResponse.authUrl,
      pendingLoginId: loginId,
      callbackHint: LOGIN_CALLBACK_HINT,
      effectiveCodexPath: sessionOptions.effectiveCodexPath,
      effectiveCodexHome: sessionOptions.effectiveCodexHome,
      models: []
    };
  } catch (error) {
    await session.close().catch(() => {});
    throw error;
  }
}

async function completeCodexLogin({
  ownerId = '',
  loginId = '',
  callbackUrl = ''
} = {}) {
  const normalizedLoginId = sanitizeString(loginId);
  if (!normalizedLoginId) {
    throw new Error('loginId is required to complete a Codex login');
  }

  const pendingKey = createPendingLoginKey(ownerId, normalizedLoginId);
  const pending = pendingCodexLogins.get(pendingKey);
  if (!pending) {
    throw new Error('No pending Codex login session was found for this user');
  }

  const normalizedCallbackUrl = ensureLoopbackCallbackUrl(callbackUrl);

  let forwardResponse = null;
  try {
    forwardResponse = await axios.get(normalizedCallbackUrl, {
      maxRedirects: 5,
      timeout: DEFAULT_LOGIN_HTTP_WAIT_MS,
      validateStatus: () => true
    });
  } catch (error) {
    forwardResponse = {
      status: null,
      data: null,
      error: error.message
    };
  }

  try {
    const loginCompletion = await pending.session.waitForLoginCompletion(
      normalizedLoginId,
      DEFAULT_LOGIN_COMPLETE_TIMEOUT_MS
    );

    if (!loginCompletion.success) {
      throw new Error(loginCompletion.error || 'Codex login failed');
    }

    const accountResponse = await pending.session.getAccount({ refreshToken: true, retryAfterWarmup: false });

    clearTimeout(pending.timeout);
    pendingCodexLogins.delete(pendingKey);
    await pending.session.close().catch(() => {});

    return {
      success: true,
      mode: 'relay',
      authenticated: Boolean(accountResponse?.account),
      accountEmail: accountResponse?.account?.type === 'chatgpt' ? accountResponse.account.email : null,
      planType: accountResponse?.account?.type === 'chatgpt' ? accountResponse.account.planType : null,
      forwardStatus: forwardResponse?.status || null
    };
  } catch (error) {
    const accountResponse = await pending.session
      .getAccount({ refreshToken: true, retryAfterWarmup: false })
      .catch(() => null);

    if (accountResponse?.account) {
      clearTimeout(pending.timeout);
      pendingCodexLogins.delete(pendingKey);
      await pending.session.close().catch(() => {});

      return {
        success: true,
        mode: 'relay-timeout-authenticated',
        authenticated: true,
        accountEmail: accountResponse.account.type === 'chatgpt' ? accountResponse.account.email : null,
        planType: accountResponse.account.type === 'chatgpt' ? accountResponse.account.planType : null,
        forwardStatus: forwardResponse?.status || null
      };
    }

    return {
      success: false,
      mode: 'relay-timeout-pending',
      authenticated: false,
      forwardStatus: forwardResponse?.status || null,
      message: error.message
    };
  }
}

async function sendRequestToCodex(message, settings, requestConfig = {}) {
  const outputSchema = buildCodexOutputSchema(requestConfig);
  const codexTimeoutMs = Math.max(
    DEFAULT_RPC_TIMEOUT_MS,
    Number(requestConfig?.timeoutMs || process.env.CODEX_TIMEOUT_MS || process.env.OPENAI_TIMEOUT_MS || DEFAULT_TURN_TIMEOUT_MS)
  );

  return withCodexSession({
    settings,
    overrides: {
      codexPath: requestConfig?.codexPath,
      codexHome: requestConfig?.codexHome,
      codexHomeProfile: requestConfig?.codexHomeProfile,
      codexAwsVolumeRoot: requestConfig?.codexAwsVolumeRoot,
      codexModel: requestConfig?.codexModel
    }
  }, async (session, sessionOptions) => {
    session.turnTimeoutMs = codexTimeoutMs;
    const accountResponse = await session.getAccount({ refreshToken: true });

    if (!accountResponse?.account) {
      throw new Error('Codex CLI requires OpenAI sign-in. Open Settings and sign in to OpenAI under Codex CLI.');
    }

    const models = await session.listModels({ includeHidden: false });
    const selectedModel = pickCodexModel(requestConfig?.codexModel || sessionOptions.codexModel, models);
    const result = await session.runTurn({
      message,
      model: selectedModel,
      developerInstructions: requestConfig?.developerInstructions,
      outputSchema,
      effort: requestConfig?.codexEffort || 'medium'
    });

    if (result.turn?.status === 'failed') {
      throw new Error(result.turn?.error?.message || 'Codex CLI turn failed');
    }

    const text = sanitizeString(result.text);
    if (!text) {
      throw new Error('Codex CLI returned an empty response');
    }

    return {
      response: text,
      provider: 'codex',
      model: result.model || selectedModel,
      runtime: {
        processor: 'codex-app-server',
        model: result.model || selectedModel,
        codexHome: sessionOptions.effectiveCodexHome
      },
      tokenUsage: result.tokenUsage || null
    };
  });
}

async function shutdownCodexCliService() {
  const entries = Array.from(pendingCodexLogins.entries());
  pendingCodexLogins.clear();

  await Promise.all(entries.map(async ([, pending]) => {
    clearTimeout(pending.timeout);
    await pending.session.close().catch(() => {});
  }));
}

module.exports = {
  DEFAULT_AWS_VOLUME_ROOT,
  DEFAULT_CODEX_MODEL,
  CodexAppServerSession,
  buildCodexOutputSchema,
  completeCodexLogin,
  extractCodexTurnText,
  getCodexAuthHealth,
  getCodexModels,
  pickCodexModel,
  resolveCodexHomePath,
  resolveCodexLaunchSpec,
  resolveDraftCodexHome,
  resolveSessionOptions,
  sendRequestToCodex,
  shutdownCodexCliService,
  startCodexLogin
};
