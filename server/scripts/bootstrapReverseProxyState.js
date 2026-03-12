#!/usr/bin/env node

const path = require('path');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.startsWith('mongodb')) {
  process.env.DATABASE_URL = 'mongodb://localhost/HomeBrain';
}

const initDb = require('../models/init');
const reverseProxyService = require('../services/reverseProxyService');

function parseActor(argv) {
  const actorFlag = argv.find((entry) => entry.startsWith('--actor='));
  if (actorFlag) {
    return actorFlag.slice('--actor='.length).trim() || 'system:bootstrap-script';
  }

  const actorIndex = argv.indexOf('--actor');
  if (actorIndex >= 0 && argv[actorIndex + 1]) {
    return String(argv[actorIndex + 1]).trim() || 'system:bootstrap-script';
  }

  return 'system:bootstrap-script';
}

async function main() {
  const actor = parseActor(process.argv.slice(2));
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
  } finally {
    await mongoose.connection.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`Reverse proxy bootstrap failed: ${error.message}`);
  process.exit(1);
});
