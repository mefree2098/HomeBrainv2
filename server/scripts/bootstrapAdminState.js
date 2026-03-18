#!/usr/bin/env node

const path = require('path');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.startsWith('mongodb')) {
  process.env.DATABASE_URL = 'mongodb://localhost/HomeBrain';
}

const initDb = require('../models/init');
const adminBootstrapService = require('../services/adminBootstrapService');

function parseActor(argv) {
  const actorFlag = argv.find((entry) => entry.startsWith('--actor='));
  if (actorFlag) {
    return actorFlag.slice('--actor='.length).trim() || 'system:admin-bootstrap';
  }

  const actorIndex = argv.indexOf('--actor');
  if (actorIndex >= 0 && argv[actorIndex + 1]) {
    return String(argv[actorIndex + 1]).trim() || 'system:admin-bootstrap';
  }

  return 'system:admin-bootstrap';
}

async function main() {
  const actor = parseActor(process.argv.slice(2));
  console.log(`Bootstrapping admin state as ${actor}...`);

  await initDb();

  try {
    const result = await adminBootstrapService.ensureBootstrapState({ actor });
    console.log(`Enabled: ${result.enabled ? 'yes' : 'no'}`);
    console.log(`Email: ${result.email || 'none'}`);
    console.log(`Created: ${result.created ? 'yes' : 'no'}`);
    console.log(`Updated: ${result.updated ? 'yes' : 'no'}`);
    console.log(`Skipped: ${result.skipped ? 'yes' : 'no'}`);
    console.log(`Reason: ${result.reason || 'none'}`);
    console.log(`Changes: ${result.changes.length > 0 ? result.changes.join(', ') : 'none'}`);
  } finally {
    await mongoose.connection.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`Admin bootstrap failed: ${error.message}`);
  process.exit(1);
});
