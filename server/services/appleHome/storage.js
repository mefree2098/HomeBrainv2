'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, randomBytes, randomInt } = require('node:crypto');

/** Pairing identity is local to this hub, never in generic Settings responses or source control. */
class BridgeStorage {
  constructor(directory) { this.directory = directory; this.locked = false; }
  async prepare() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Apple Home storage must be a real private directory.');
    await fs.chmod(this.directory, 0o700);
  }
  async read() {
    await this.prepare();
    try {
      const filename = path.join(this.directory, 'bridge.json');
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid Apple Home identity file.');
      const value = JSON.parse(await fs.readFile(filename, 'utf8'));
      if (value.version !== 1 || typeof value.namespace !== 'string' || !value.namespace
          || !/^\d{3}-\d{2}-\d{3}$/.test(value.pin) || typeof value.ownerId !== 'string'
          || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65000) {
        throw new Error('Apple Home identity is corrupt; restore the pairing-state backup.');
      }
      return value;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async write(value) {
    await this.prepare();
    const filename = path.join(this.directory, `.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(filename, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
      await fs.rename(filename, path.join(this.directory, 'bridge.json'));
    } finally { await fs.rm(filename, { force: true }); }
  }
  async acquire() {
    if (this.locked) return;
    await this.prepare();
    const lock = path.join(this.directory, 'publisher.lock');
    try { await fs.mkdir(lock, { mode: 0o700 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let old;
      try { old = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8')); }
      catch { throw new Error('Apple Home publisher lock needs operator inspection.'); }
      if (old.host !== os.hostname() || !Number.isInteger(old.pid) || old.pid <= 0) throw new Error('Another hub owns Apple Home pairing storage.');
      let alive = true;
      try { process.kill(old.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('Apple Home already has a publisher using this storage.');
      await fs.rm(lock, { recursive: true });
      // Competing restarters must win this atomic operation, not both publish.
      await fs.mkdir(lock, { mode: 0o700 });
    }
    await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, host: os.hostname() }), { mode: 0o600, flag: 'wx' });
    this.locked = true;
  }
  async release() {
    if (this.locked) {
      await fs.rm(path.join(this.directory, 'publisher.lock'), { recursive: true, force: true });
      this.locked = false;
    }
  }
  create(ownerId) {
    let digits;
    do { digits = String(randomInt(0, 100_000_000)).padStart(8, '0'); }
    while (/^(\d)\1+$/.test(digits) || digits === '12345678' || digits === '87654321');
    return { version: 1, namespace: randomUUID(), pin: `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`,
      setupSeed: randomBytes(16).toString('hex'), ownerId, enabled: false, port: 51826, assignments: {} };
  }
}
module.exports = { BridgeStorage };
