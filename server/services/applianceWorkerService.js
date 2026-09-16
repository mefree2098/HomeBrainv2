const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const crypto = require('node:crypto');

const python = path.resolve(__dirname, '../.appliance-venv/bin/python');
const requirements = path.resolve(__dirname, '../python/appliance-requirements.txt');
let installPromise;

function run(command, args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Appliance runtime installation timed out')); }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('Appliance runtime installation failed; Python 3.10+ with venv and package access is required'));
    });
  });
}

async function ensureRuntime() {
  if (installPromise) return installPromise;
  installPromise = (async () => {
    const digest = crypto.createHash('sha256').update(await fs.readFile(requirements)).digest('hex');
    const marker = path.resolve(__dirname, '../.appliance-venv/requirements.sha256');
    if (await fs.readFile(marker, 'utf8').catch(() => '') === digest) return;
    await run('python3', ['-m', 'venv', path.dirname(path.dirname(python))]);
    await run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', requirements]);
    await fs.writeFile(marker, digest);
  })().finally(() => { installPromise = null; });
  return installPromise;
}

class ApplianceWorker {
  constructor() { this.child = null; this.pending = new Map(); this.counter = 0; }

  async start(config) {
    await ensureRuntime();
    this.stop();
    const child = spawn(python, ['-u', path.resolve(__dirname, '../python/appliance_worker.py')], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.child = child;
    const fail = () => {
      if (this.child !== child) return;
      this.child = null;
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error('Appliance connection worker stopped; HomeBrain will retry'));
        this.pending.delete(id);
      }
    };
    child.on('error', fail);
    child.on('exit', fail);
    child.stdin.on('error', () => {});
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const entry = this.pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new Error(message.error || 'Appliance request failed'));
    });
    await this.request({ op: 'configure', config });
  }

  request(payload) {
    if (!this.child) return Promise.reject(new Error('Appliance connection worker is not running'));
    const requestId = ++this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.stop(); }, 85000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ ...payload, requestId }) + '\n');
    });
  }

  stop() {
    const child = this.child;
    this.child = null;
    if (child) child.kill('SIGKILL');
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Appliance connection was restarted or timed out'));
    }
    this.pending.clear();
  }
}

module.exports = { ApplianceWorker, ensureRuntime };
