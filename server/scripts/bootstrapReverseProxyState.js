#!/usr/bin/env node

const path = require('path');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.startsWith('mongodb')) {
  process.env.DATABASE_URL = 'mongodb://localhost/HomeBrain';
}

const initDb = require('../models/init');
const reverseProxyService = require('../services/reverseProxyService');

function parseOptions(argv) {
  const actorFlag = argv.find((entry) => entry.startsWith('--actor='));
  let actor = 'system:bootstrap-script';

  if (actorFlag) {
    actor = actorFlag.slice('--actor='.length).trim() || actor;
  } else {
    const actorIndex = argv.indexOf('--actor');
    if (actorIndex >= 0 && argv[actorIndex + 1]) {
      actor = String(argv[actorIndex + 1]).trim() || actor;
    }
  }

  return {
    actor,
    apply: argv.includes('--apply'),
    applyIfChanged: argv.includes('--apply-if-changed')
  };
}

function shouldApplyConfig(options, status = null) {
  if (!options.apply && !options.applyIfChanged) {
    return false;
  }
  return !(options.applyIfChanged && status?.config?.changed === false);
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const { actor, applyIfChanged } = options;
  console.log(`Bootstrapping reverse proxy state as ${actor}...`);

  await initDb();

  try {
    const result = await reverseProxyService.ensureBootstrapState({
      actor,
      seedDefaultRoutes: true,
      validateExistingRoutes: true
    });

    console.log(`Settings updated: ${result.settingsUpdated.length > 0 ? result.settingsUpdated.join(', ') : 'none'}`);
    console.log(`Routes created: ${result.createdRoutes.length > 0 ? result.createdRoutes.join(', ') : 'none'}`);
    console.log(`Routes already present: ${result.existingRoutes.length > 0 ? result.existingRoutes.join(', ') : 'none'}`);
    console.log(`Routes revalidated: ${result.revalidatedRoutes.length > 0 ? result.revalidatedRoutes.join(', ') : 'none'}`);

    let status = null;
    if (applyIfChanged) {
      try {
        status = await reverseProxyService.getStatus();
        if (status?.config?.changed === false) {
          console.log(`Caddy config unchanged: ${status.config.desiredHash || 'unknown'}`);
        }
      } catch (error) {
        console.warn(`Unable to compare Caddy config before apply; applying normally: ${error.message}`);
      }
    }

    if (shouldApplyConfig(options, status)) {
      const applyResult = await reverseProxyService.applyConfig(actor);
      const appliedRoutes = Array.isArray(applyResult.appliedRoutes)
        ? applyResult.appliedRoutes.join(', ')
        : 'none';
      console.log(`Caddy config applied: ${applyResult.success ? 'yes' : 'no'}`);
      console.log(`Caddy routes applied: ${appliedRoutes || 'none'}`);
    }
  } finally {
    await mongoose.connection.close().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Reverse proxy bootstrap failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  parseOptions,
  shouldApplyConfig
};
