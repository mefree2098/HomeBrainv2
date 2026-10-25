const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function withMongoToolsConfig(uri, callback, tempRoot = os.tmpdir()) {
  const directory = await fs.mkdtemp(path.join(tempRoot, 'homebrain-mongo-'));
  try {
    await fs.chmod(directory, 0o700);
    const configPath = path.join(directory, 'connection.json');
    // MongoDB Tools accepts JSON as YAML. Never put a credential URI in argv.
    await fs.writeFile(configPath, JSON.stringify({ uri }), { mode: 0o600 });
    return await callback(`--config=${configPath}`);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

module.exports = { withMongoToolsConfig };
