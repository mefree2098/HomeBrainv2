#!/usr/bin/env node

/**
 * Polls the SmartThings webhook metrics endpoint and emits a health summary.
 *
 * Example:
 *   node scripts/checkSmartThingsWebhookHealth.js --url https://example.com/api/smartthings/webhook/metrics --token <JWT>
 */

const http = require('node:http');
const https = require('node:https');
const axios = require('axios');
const mongoose = require('mongoose');
const { connectDB } = require('../config/database');
const {
  createLocalAddressLookup,
  isAllowedLocalHostname,
  isCloudMetadataHostname,
  parseHttpUrl,
  parseLocalHttpUrl
} = require('../utils/networkSafety');

const DEFAULTS = {
  url: 'http://localhost:3000/api/smartthings/webhook/metrics',
  maxMinutesSinceEvent: 15,
  maxSignatureFailures: 5,
  maxConsecutiveSignatureFailures: 0,
  minRequestTotal: 1,
  minLifecycleTotal: 1
};

function parseArgs(argv) {
  const options = { ...DEFAULTS };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    switch (arg) {
      case '--url':
        options.url = next;
        i += 1;
        break;
      case '--token':
        options.token = next;
        i += 1;
        break;
      case '--max-event-minutes':
        options.maxMinutesSinceEvent = Number(next);
        i += 1;
        break;
      case '--max-signature-failures':
        options.maxSignatureFailures = Number(next);
        i += 1;
        break;
      case '--max-consecutive-signature-failures':
        options.maxConsecutiveSignatureFailures = Number(next);
        i += 1;
        break;
      case '--min-request-total':
        options.minRequestTotal = Number(next);
        i += 1;
        break;
      case '--min-lifecycle-total':
        options.minLifecycleTotal = Number(next);
        i += 1;
        break;
      case '--insecure':
        options.insecure = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        console.warn(`Unknown argument "${arg}" ignored`);
        break;
    }
  }

  return options;
}

function printHelp() {
  console.log(`SmartThings webhook health checker

Usage:
  node scripts/checkSmartThingsWebhookHealth.js [options]

Options:
  --url <metrics-endpoint>                      Metrics endpoint (default: ${DEFAULTS.url})
  --token <jwt>                                 Bearer token for authenticated installs
  --max-event-minutes <n>                       Fail if last event is older than N minutes (default: ${DEFAULTS.maxMinutesSinceEvent})
  --max-signature-failures <n>                  Fail if cumulative signature failures exceed N (default: ${DEFAULTS.maxSignatureFailures})
  --max-consecutive-signature-failures <n>      Fail if consecutive signature failures exceed N (default: ${DEFAULTS.maxConsecutiveSignatureFailures})
  --min-request-total <n>                       Fail if total webhook requests below N (default: ${DEFAULTS.minRequestTotal})
  --min-lifecycle-total <n>                     Fail if lifecycles processed below N (default: ${DEFAULTS.minLifecycleTotal})
  --insecure                                    Skip TLS validation (only for local/staging with self-signed certs)
  --help                                        Show this help
`);
}

function buildMetricsRequest(options) {
  const url = parseHttpUrl(options.url, 'Metrics URL');
  const targetsLocalNetwork = isAllowedLocalHostname(url.hostname)
    && !isCloudMetadataHostname(url.hostname);
  if (url.protocol !== 'https:' && !targetsLocalNetwork) {
    throw new Error('Metrics URL must use https unless it targets a local or private host');
  }
  if (options.insecure && !targetsLocalNetwork) {
    throw new Error('Disabled TLS verification is only allowed for local or private metrics targets');
  }

  const headers = { Accept: 'application/json' };
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  const requestConfig = {
    headers,
    timeout: 10_000,
    maxRedirects: 0,
    maxContentLength: 2 * 1024 * 1024,
    validateStatus: () => true
  };

  if (targetsLocalNetwork) {
    parseLocalHttpUrl(url.toString(), 'Metrics URL');
    const lookup = createLocalAddressLookup(url.hostname);
    requestConfig.httpAgent = new http.Agent({ lookup });
    requestConfig.httpsAgent = new https.Agent({
      lookup,
      rejectUnauthorized: options.insecure !== true
    });
  }

  return { url, requestConfig };
}

async function fetchMetrics(options) {
  const { url, requestConfig } = buildMetricsRequest(options);
  const response = await axios.get(url.toString(), requestConfig);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Metrics request failed with status ${response.status}`);
  }

  const body = response.data;
  if (!body || typeof body !== 'object') {
    throw new Error('Metrics response missing JSON body');
  }

  if (body.success === false) {
    const message = body.message || 'metrics endpoint returned error';
    throw new Error(message);
  }

  return body.metrics || {};
}

function parseDate(value) {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return null;
  }
  return new Date(timestamp);
}

function minutesSince(date) {
  if (!(date instanceof Date)) {
    return null;
  }
  return (Date.now() - date.getTime()) / 60000;
}

function evaluate(metrics, options) {
  const issues = [];
  const warnings = [];

  const totals = metrics?.received?.total ?? 0;
  const lifecycleTotals = metrics?.received?.successful ?? 0;
  const signatureFailures = metrics?.signature?.failures ?? 0;
  const signatureConsecutive = metrics?.signature?.consecutiveFailures ?? 0;

  if (totals < options.minRequestTotal) {
    issues.push(`only ${totals} webhook requests recorded (min ${options.minRequestTotal})`);
  }

  if (lifecycleTotals < options.minLifecycleTotal) {
    issues.push(`only ${lifecycleTotals} lifecycles processed (min ${options.minLifecycleTotal})`);
  }

  const lastEventMinutes = minutesSince(parseDate(metrics?.events?.lastAt));
  if (lastEventMinutes !== null && lastEventMinutes > options.maxMinutesSinceEvent) {
    issues.push(`last event received ${lastEventMinutes.toFixed(1)} minutes ago (max ${options.maxMinutesSinceEvent})`);
  } else if (lastEventMinutes === null) {
    warnings.push('no events processed yet');
  }

  if (signatureFailures > options.maxSignatureFailures) {
    issues.push(`signature failures ${signatureFailures} > ${options.maxSignatureFailures}`);
  }

  if (signatureConsecutive > options.maxConsecutiveSignatureFailures) {
    issues.push(`consecutive signature failures ${signatureConsecutive} > ${options.maxConsecutiveSignatureFailures}`);
  }

  return {
    issues,
    warnings,
    summary: {
      requestTotal: totals,
      lifecycleTotal: lifecycleTotals,
      lastEventMinutes,
      signatureFailures,
      signatureConsecutive
    },
    metrics
  };
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    printHelp();
    return;
  }

  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim().length === 0) {
    process.env.DATABASE_URL = 'mongodb://localhost:27017/HomeBrain';
  }
  if (mongoose.connection.readyState === 0) {
    await connectDB();
  }

  try {
    const metrics = await fetchMetrics(options);
    const result = evaluate(metrics, options);

    const payload = {
      status: result.issues.length > 0 ? 'unhealthy' : 'healthy',
      summary: result.summary,
      warnings: result.warnings,
      issues: result.issues
    };

    console.log(JSON.stringify(payload, null, 2));

    if (result.issues.length > 0) {
      process.exit(1);
    }

    process.exit(0);
  } catch (error) {
    console.error(JSON.stringify({
      status: 'error',
      error: error.message
    }, null, 2));
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  buildMetricsRequest,
  evaluate,
  fetchMetrics,
  parseArgs
};
