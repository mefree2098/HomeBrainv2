const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');

const dictionaries = ['hubs', 'accountLinks', 'authCodes', 'accessTokens', 'refreshTokens', 'permissionGrants'];
const lists = { eventQueue: 'eventId', auditLog: 'auditId' };
const schema = `
  CREATE TABLE revision (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL);
  CREATE TABLE records (sequence INTEGER PRIMARY KEY, section TEXT NOT NULL, key TEXT NOT NULL,
    value TEXT NOT NULL, UNIQUE(section, key));
`;

function rowsFor(state) {
  const rows = new Map();
  function add(section, key, value) {
    const id = JSON.stringify([section, key]);
    if (rows.has(id)) throw new Error(`Duplicate record in broker ${section}`);
    rows.set(id, { section, key, value: JSON.stringify(value) });
  }
  for (const [section, value] of Object.entries(state)) {
    if (dictionaries.includes(section)) {
      for (const [key, record] of Object.entries(value)) {
        if (section === 'hubs') {
          const { catalog, state: snapshot, ...identity } = record;
          add(section, key, identity);
          if (catalog !== undefined) add('hubCatalog', key, catalog);
          if (snapshot !== undefined) add('hubState', key, snapshot);
        } else {
          add(section, key, record);
        }
      }
    } else if (Object.hasOwn(lists, section)) {
      for (const record of value) {
        const key = record[lists[section]];
        if (!key || typeof key !== 'string') throw new Error(`Missing record ID in broker ${section}`);
        add(section, key, record);
      }
    } else {
      add('metadata', section, value);
    }
  }
  return rows;
}

function readState(db) {
  const state = Object.create(null);
  for (const name of dictionaries) state[name] = Object.create(null);
  for (const name of Object.keys(lists)) state[name] = [];
  const parts = [];
  for (const row of db.prepare('SELECT section, key, value FROM records ORDER BY sequence').iterate()) {
    const { section, key } = row;
    const value = JSON.parse(row.value);
    if (section === 'metadata') state[key] = value;
    else if (dictionaries.includes(section)) state[section][key] = value;
    else if (Object.hasOwn(lists, section)) state[section].push(value);
    else if (section === 'hubCatalog' || section === 'hubState') parts.push({ section, key, value });
    else throw new Error(`Unknown broker record section ${section}`);
  }
  for (const { section, key, value } of parts) {
    if (!state.hubs[key]) throw new Error('Orphaned broker hub data');
    state.hubs[key][section === 'hubCatalog' ? 'catalog' : 'state'] = value;
  }
  return state;
}

function inspect(file) {
  try {
    fs.statSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return { missing: true };
    throw error;
  }
  const db = new DatabaseSync(file);
  try {
    const check = db.prepare('PRAGMA quick_check').get();
    if (check.quick_check !== 'ok') throw new Error('SQLite integrity check failed');
    const revision = db.prepare('SELECT value FROM revision WHERE id = 1').get()?.value;
    if (!revision) throw new Error('Missing broker storage revision');
    return { revision };
  } catch (error) {
    return { error };
  } finally {
    db.close();
  }
}

// Publish only complete databases. An interrupted import can restart from the original source.
function publish(file, build, replace = false) {
  const scratch = fs.mkdtempSync(path.join(path.dirname(file), '.broker-import-'));
  const temp = path.join(scratch, 'store.sqlite');
  try {
    build(temp);
    fs.chmodSync(temp, 0o600);
    if (replace) fs.renameSync(temp, file);
    else fs.linkSync(temp, file);
    const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function copyDatabase(from, to, replace) {
  const db = new DatabaseSync(from);
  try {
    publish(to, (file) => db.prepare('VACUUM INTO ?').run(file), replace);
  } finally {
    db.close();
  }
}

class SqliteStore {
  constructor(file) {
    this.file = file;
    this.backup = file + '.bak';
  }

  async open(initialState) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    let primary = inspect(this.file);
    const backup = inspect(this.backup);
    const marker = this.file + '.initialized';
    if (!primary.revision) {
      if (backup.revision) {
        copyDatabase(this.backup, this.file, !primary.missing);
      } else {
        if (primary.error || backup.error) throw primary.error || backup.error;
        if (fs.existsSync(marker)) throw new Error('Both initialized broker databases are missing. Restore a current backup.');
        const seed = await initialState();
        const rows = rowsFor(seed);
        publish(this.file, (file) => {
          const db = new DatabaseSync(file);
          try {
            db.exec(schema);
            db.exec('BEGIN');
            const insert = db.prepare('INSERT INTO records(section,key,value) VALUES(?,?,?)');
            for (const row of rows.values()) insert.run(row.section, row.key, row.value);
            db.prepare('INSERT INTO revision VALUES(1,?)').run(randomUUID());
            if (!isDeepStrictEqual(JSON.parse(JSON.stringify(readState(db))), JSON.parse(JSON.stringify(seed)))) {
              throw new Error('Broker import failed its record-by-record verification');
            }
            db.exec('COMMIT');
          } finally { db.close(); }
        });
      }
      primary = inspect(this.file);
      if (!primary.revision) throw primary.error || new Error('Broker database import failed');
    }
    if (backup.revision !== primary.revision) copyDatabase(this.file, this.backup, !backup.missing);
    this.db = new DatabaseSync(this.file);
    try {
      this.db.prepare('ATTACH DATABASE ? AS mirror').run(this.backup);
      // SQLite commits attached rollback-journal databases atomically on the same filesystem.
      for (const name of ['main', 'mirror']) {
        this.db.exec(`PRAGMA ${name}.journal_mode=DELETE; PRAGMA ${name}.synchronous=FULL`);
      }
      this.db.exec('BEGIN');
      const state = readState(this.db);
      this.revision = this.db.prepare('SELECT value FROM revision WHERE id=1').get().value;
      this.db.exec('COMMIT');
      this.rows = rowsFor(state);
      try { fs.closeSync(fs.openSync(marker, 'wx', 0o600)); } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      this.writers = ['main', 'mirror'].map((name) => ({
        put: this.db.prepare(`INSERT INTO ${name}.records(section,key,value) VALUES(?,?,?)
          ON CONFLICT(section,key) DO UPDATE SET value=excluded.value`),
        remove: this.db.prepare(`DELETE FROM ${name}.records WHERE section=? AND key=?`),
        advance: this.db.prepare(`UPDATE ${name}.revision SET value=? WHERE id=1 AND value=?`)
      }));
      return state;
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  save(state) {
    const rows = rowsFor(state);
    const changed = [];
    const removed = [];
    for (const [key, row] of rows) {
      if (this.rows.get(key)?.value !== row.value) changed.push(row);
    }
    for (const [key, row] of this.rows) {
      if (!rows.has(key)) removed.push(row);
    }
    if (!changed.length && !removed.length) return;
    const revision = randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const writer of this.writers) {
        if (writer.advance.run(revision, this.revision).changes !== 1) {
          throw new Error('Broker store changed in another writer. Reload before writing.');
        }
        for (const row of changed) writer.put.run(row.section, row.key, row.value);
        for (const row of removed) writer.remove.run(row.section, row.key);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.rows = rows;
    this.revision = revision;
  }

  readSnapshot(file) {
    const db = new DatabaseSync(file, { readOnly: true });
    try { return readState(db); } finally { db.close(); }
  }
}

module.exports = { SqliteStore };
