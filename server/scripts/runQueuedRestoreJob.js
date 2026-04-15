#!/usr/bin/env node

const path = require('path');

require('dotenv').config({
  path: path.resolve(__dirname, '..', '..', '.env')
});

const systemBackupService = require('../services/systemBackupService');

function getRequestedJobId(argv = process.argv.slice(2)) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || '').trim();

    if (arg === '--latest') {
      return null;
    }

    if (arg === '--job-id') {
      const next = String(argv[index + 1] || '').trim();
      if (!next) {
        throw new Error('--job-id requires a value');
      }
      return next;
    }
  }

  return null;
}

async function main() {
  const jobId = getRequestedJobId();
  const result = jobId
    ? await systemBackupService.runRestoreJob(jobId, { restartOnComplete: false })
    : await systemBackupService.runLatestQueuedRestoreJob({ restartOnComplete: false });

  console.log(JSON.stringify(result, null, 2));

  if (result?.status !== 'completed') {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  if (error?.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
