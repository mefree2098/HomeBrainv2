const fs = require('fs');
const path = require('path');

const fsp = fs.promises;

const DEFAULT_WEATHER_CACHE_FILE = path.join(__dirname, '..', 'data', 'weather-provider-cache.json');

let loadedFilePath = '';
let loadedStore = null;
let loadPromise = null;
let writePromise = Promise.resolve();

function getWeatherCacheFilePath() {
  const configuredPath = typeof process.env.WEATHER_PERSIST_PATH === 'string'
    ? process.env.WEATHER_PERSIST_PATH.trim()
    : '';
  return configuredPath || DEFAULT_WEATHER_CACHE_FILE;
}

function cloneStore(store = {}) {
  return JSON.parse(JSON.stringify(store));
}

async function ensureStoreLoaded() {
  const filePath = getWeatherCacheFilePath();
  if (loadedStore && loadedFilePath === filePath) {
    return loadedStore;
  }

  if (loadPromise) {
    return loadPromise;
  }

  loadPromise = (async () => {
    try {
      const raw = await fsp.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      loadedStore = parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.warn(`WeatherCacheStore: Failed to read ${filePath}: ${error.message}`);
      }
      loadedStore = {};
    }

    loadedFilePath = filePath;
    return loadedStore;
  })().finally(() => {
    loadPromise = null;
  });

  return loadPromise;
}

async function getEntry(kind, keys = []) {
  const store = await ensureStoreLoaded();
  const bucket = store?.[kind];
  if (!bucket || typeof bucket !== 'object') {
    return null;
  }

  for (const key of keys) {
    if (!key || !Object.prototype.hasOwnProperty.call(bucket, key)) {
      continue;
    }

    const entry = bucket[key];
    if (!entry || typeof entry !== 'object' || entry.value === undefined) {
      continue;
    }

    return {
      key,
      value: entry.value,
      updatedAt: entry.updatedAt || null
    };
  }

  return null;
}

async function setEntry(kind, keys, value) {
  const targetKeys = Array.from(new Set((Array.isArray(keys) ? keys : [keys]).filter(Boolean)));
  if (targetKeys.length === 0) {
    return;
  }

  const store = await ensureStoreLoaded();
  const nowIso = new Date().toISOString();
  if (!store[kind] || typeof store[kind] !== 'object') {
    store[kind] = {};
  }

  targetKeys.forEach((key) => {
    store[kind][key] = {
      value,
      updatedAt: nowIso
    };
  });

  const snapshot = cloneStore(store);
  const filePath = getWeatherCacheFilePath();
  writePromise = writePromise
    .catch(() => {})
    .then(async () => {
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      const tempPath = `${filePath}.tmp`;
      await fsp.writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
      await fsp.rename(tempPath, filePath);
    })
    .catch((error) => {
      console.warn(`WeatherCacheStore: Failed to write ${filePath}: ${error.message}`);
    });

  return writePromise;
}

function resetForTests() {
  loadedFilePath = '';
  loadedStore = null;
  loadPromise = null;
  writePromise = Promise.resolve();
}

module.exports = {
  getEntry,
  setEntry,
  resetForTests
};
