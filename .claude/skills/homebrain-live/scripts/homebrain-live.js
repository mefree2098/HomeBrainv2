#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

const URL_ENV_VAR = 'HOMEBRAIN_CODEX_URL';
const TOKEN_ENV_VAR = 'HOMEBRAIN_CODEX_TOKEN';

function getConfigPathCandidates() {
  const candidates = [path.join(os.homedir(), '.claude', 'homebrain-live.json')];

  const codexHome = String(process.env.CODEX_HOME || '').trim();
  if (codexHome) {
    candidates.push(path.join(codexHome, 'homebrain-live.json'));
  }

  const globalConfigPath = path.join(os.homedir(), '.codex', 'homebrain-live.json');
  if (!candidates.includes(globalConfigPath)) {
    candidates.push(globalConfigPath);
  }

  return candidates;
}

function getPreferredConfigPath() {
  return getConfigPathCandidates()[0];
}

function printUsage() {
  const configPaths = getConfigPathCandidates();
  const message = [
    'Usage:',
    '  node scripts/homebrain-live.js overview [--window-minutes 60]',
    '  node scripts/homebrain-live.js deploy-status',
    '  node scripts/homebrain-live.js deploy-health',
    '  node scripts/homebrain-live.js deploy-run [--preset safe|minimal|full] [--allow-dirty true|false]',
    '  node scripts/homebrain-live.js events-latest [--limit 50] [--category deploy] [--source platform_deploy]',
    '  node scripts/homebrain-live.js events-tail [--category deploy] [--source platform_deploy]',
    '  node scripts/homebrain-live.js request <path> [--method GET] [--body \'{"key":"value"}\']',
    '',
    `Connection values come from ${URL_ENV_VAR} and ${TOKEN_ENV_VAR},`,
    `or from ${configPaths.join(' or ')}.`
  ].join('\n');

  process.stdout.write(`${message}\n`);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith('--')) {
      positional.push(entry);
      continue;
    }

    const key = entry.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = 'true';
      continue;
    }

    flags[key] = next;
    index += 1;
  }

  return { positional, flags };
}

function loadConfig() {
  for (const configPath of getConfigPathCandidates()) {
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed) {
        return parsed;
      }
    } catch (_error) {
      continue;
    }
  }

  return {};
}

function sanitizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function resolveConnection(flags) {
  const config = loadConfig();
  const baseUrl = sanitizeBaseUrl(flags.url || process.env[URL_ENV_VAR] || config.baseUrl || '');
  const token = String(flags.token || process.env[TOKEN_ENV_VAR] || config.token || '').trim();

  if (!baseUrl || !token) {
    throw new Error(
      `HomeBrain connection info is missing. Set ${URL_ENV_VAR} and ${TOKEN_ENV_VAR}, pass --url/--token, or store them in ${getPreferredConfigPath()}.`
    );
  }

  return { baseUrl, token };
}

function parseBoolean(value, fallback = undefined) {
  if (value === undefined) {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function buildQuery(params = {}) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') {
      return;
    }
    search.set(key, String(value));
  });
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (_error) {
    return text;
  }
}

async function requestJson(connection, requestPath, options = {}) {
  const url = `${connection.baseUrl}${requestPath.startsWith('/') ? requestPath : `/${requestPath}`}`;
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${connection.token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

  const payload = await readResponseBody(response);

  if (!response.ok) {
    const detail = typeof payload === 'string'
      ? payload
      : payload?.message || payload?.error || JSON.stringify(payload);
    throw new Error(`${response.status} ${response.statusText}: ${detail}`);
  }

  return payload;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function runOverview(connection, flags) {
  const windowMinutes = Math.max(1, Number.parseInt(String(flags['window-minutes'] || flags.windowMinutes || 60), 10) || 60);

  const [user, deployStatus, deployHealth, resources, eventsSummary] = await Promise.all([
    requestJson(connection, '/api/auth/me'),
    requestJson(connection, '/api/platform-deploy/status'),
    requestJson(connection, '/api/platform-deploy/health'),
    requestJson(connection, '/api/resources/utilization'),
    requestJson(connection, `/api/events/summary${buildQuery({ windowMinutes })}`)
  ]);

  printJson({
    user,
    deployStatus,
    deployHealth,
    resources,
    eventsSummary
  });
}

async function runDeploy(connection, flags) {
  const payload = {
    preset: String(flags.preset || 'safe').trim(),
    allowDirty: parseBoolean(flags['allow-dirty'] ?? flags.allowDirty),
    installDependencies: parseBoolean(flags['install-dependencies'] ?? flags.installDependencies),
    runServerTests: parseBoolean(flags['run-server-tests'] ?? flags.runServerTests),
    runClientLint: parseBoolean(flags['run-client-lint'] ?? flags.runClientLint),
    restartServices: parseBoolean(flags['restart-services'] ?? flags.restartServices)
  };

  Object.keys(payload).forEach((key) => {
    if (payload[key] === undefined) {
      delete payload[key];
    }
  });

  const result = await requestJson(connection, '/api/platform-deploy/run', {
    method: 'POST',
    body: payload
  });

  printJson(result);
}

async function runEventsLatest(connection, flags) {
  const limit = Math.max(1, Number.parseInt(String(flags.limit || 50), 10) || 50);
  const result = await requestJson(
    connection,
    `/api/events/latest${buildQuery({
      limit,
      category: flags.category,
      source: flags.source,
      types: flags.types
    })}`
  );
  printJson(result);
}

async function runRequest(connection, positional, flags) {
  const requestPath = positional[1];
  if (!requestPath) {
    throw new Error('request requires a path argument, for example: request /api/devices');
  }

  let body;
  if (typeof flags.body === 'string' && flags.body.trim()) {
    body = JSON.parse(flags.body);
  }

  const response = await requestJson(connection, requestPath, {
    method: String(flags.method || 'GET').toUpperCase(),
    body
  });
  printJson(response);
}

async function runEventsTail(connection, flags) {
  const query = buildQuery({
    category: flags.category,
    source: flags.source,
    types: flags.types,
    sinceSequence: flags['since-sequence'] || flags.sinceSequence,
    limit: flags.limit
  });

  const url = `${connection.baseUrl}/api/events/stream${query}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${connection.token}`
    }
  });

  if (!response.ok) {
    const payload = await readResponseBody(response);
    const detail = typeof payload === 'string'
      ? payload
      : payload?.message || payload?.error || JSON.stringify(payload);
    throw new Error(`${response.status} ${response.statusText}: ${detail}`);
  }

  if (!response.body) {
    throw new Error('The HomeBrain event stream did not provide a readable response body');
  }

  const decoder = new TextDecoder();
  let buffer = '';

  const flushChunk = (chunk) => {
    const trimmed = chunk.trim();
    if (!trimmed) {
      return;
    }

    const lines = trimmed.split('\n');
    let eventName = 'message';
    const dataLines = [];

    lines.forEach((line) => {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    });

    if (dataLines.length === 0) {
      return;
    }

    const rawData = dataLines.join('\n');
    if (eventName === 'ready') {
      process.stdout.write(`READY ${rawData}\n`);
      return;
    }

    try {
      const parsed = JSON.parse(rawData);
      printJson(parsed);
    } catch (_error) {
      process.stdout.write(`${rawData}\n`);
    }
  };

  process.stderr.write(`Streaming HomeBrain events from ${url}\n`);

  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    let separatorIndex = buffer.indexOf('\n\n');
    while (separatorIndex >= 0) {
      const complete = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      flushChunk(complete);
      separatorIndex = buffer.indexOf('\n\n');
    }
  }

  if (buffer.trim()) {
    flushChunk(buffer);
  }
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    process.exit(command ? 0 : 1);
  }

  const connection = resolveConnection(flags);

  switch (command) {
    case 'overview':
      await runOverview(connection, flags);
      return;
    case 'deploy-status':
      printJson(await requestJson(connection, '/api/platform-deploy/status'));
      return;
    case 'deploy-health':
      printJson(await requestJson(connection, '/api/platform-deploy/health'));
      return;
    case 'deploy-run':
      await runDeploy(connection, flags);
      return;
    case 'events-latest':
      await runEventsLatest(connection, flags);
      return;
    case 'events-tail':
      await runEventsTail(connection, flags);
      return;
    case 'request':
      await runRequest(connection, positional, flags);
      return;
    default:
      throw new Error(`Unknown command "${command}"`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
