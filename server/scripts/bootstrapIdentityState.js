#!/usr/bin/env node

const path = require('path');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.startsWith('mongodb')) {
  process.env.DATABASE_URL = 'mongodb://localhost/HomeBrain';
}

const initDb = require('../models/init');
const oidcService = require('../services/oidcService');

function parseActor(argv) {
  const actorFlag = argv.find((entry) => entry.startsWith('--actor='));
  if (actorFlag) {
    return actorFlag.slice('--actor='.length).trim() || 'system:identity-bootstrap';
  }

  const actorIndex = argv.indexOf('--actor');
  if (actorIndex >= 0 && argv[actorIndex + 1]) {
    return String(argv[actorIndex + 1]).trim() || 'system:identity-bootstrap';
  }

  return 'system:identity-bootstrap';
}

async function main() {
  const actor = parseActor(process.argv.slice(2));
  console.log(`Bootstrapping identity state as ${actor}...`);

  await initDb();

  try {
    const result = await oidcService.ensureBootstrapState({ actor });
    console.log(`Settings updated: ${result.settingsUpdated.length > 0 ? result.settingsUpdated.join(', ') : 'none'}`);
    console.log(`Clients created: ${result.createdClients.length > 0 ? result.createdClients.join(', ') : 'none'}`);
    console.log(`Clients updated: ${result.updatedClients.length > 0 ? result.updatedClients.join(', ') : 'none'}`);
  } finally {
    await mongoose.connection.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`Identity bootstrap failed: ${error.message}`);
  process.exit(1);
});
