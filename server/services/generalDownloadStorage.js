const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const DEFAULT_MAX_UPLOAD_BYTES = 20 * 1024 * 1024 * 1024;
const DEFAULT_DIRECTORY_NAME = 'general-downloads';

function getGeneralDownloadsRoot() {
  const configuredRoot = String(process.env.GENERAL_DOWNLOADS_ROOT || '').trim();
  if (configuredRoot) {
    return path.resolve(configuredRoot);
  }

  if (process.platform === 'linux' && fs.existsSync('/mnt/nvme')) {
    return path.resolve('/mnt/nvme', DEFAULT_DIRECTORY_NAME);
  }

  return path.resolve(__dirname, '..', 'data', DEFAULT_DIRECTORY_NAME);
}

function ensureGeneralDownloadsRoot() {
  const root = getGeneralDownloadsRoot();
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function normalizeDownloadPath(inputPath) {
  const rawPath = String(inputPath || '').trim().replace(/\\/g, '/');
  if (!rawPath) {
    throw Object.assign(new Error('Download path is required'), { status: 400 });
  }

  if (rawPath.includes('\0')) {
    throw Object.assign(new Error('Download path is invalid'), { status: 400 });
  }

  if (path.posix.isAbsolute(rawPath) || rawPath.split('/').includes('..')) {
    throw Object.assign(new Error('Download path must stay inside the downloads folder'), { status: 400 });
  }

  const normalized = path.posix.normalize(`/${rawPath}`).replace(/^\/+/, '');
  if (!normalized || normalized === '.' || normalized.startsWith('../')) {
    throw Object.assign(new Error('Download path must stay inside the downloads folder'), { status: 400 });
  }

  const segments = normalized.split('/');
  const invalidSegment = segments.find((segment) => {
    return !segment
      || segment === '.'
      || segment === '..'
      || !/^[A-Za-z0-9._()+@=-]+$/.test(segment);
  });

  if (invalidSegment) {
    throw Object.assign(new Error('Download path contains unsupported characters'), { status: 400 });
  }

  return normalized;
}

function resolveDownloadPath(inputPath) {
  const root = getGeneralDownloadsRoot();
  const relativePath = normalizeDownloadPath(inputPath);
  const absolutePath = path.resolve(root, relativePath);

  if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
    throw Object.assign(new Error('Download path must stay inside the downloads folder'), { status: 400 });
  }

  return {
    root,
    relativePath,
    absolutePath
  };
}

function parseMaxBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_UPLOAD_BYTES;
  }
  return parsed;
}

function parseRequiredByteCount(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw Object.assign(new Error(`${label} must be a non-negative integer byte count`), { status: 400 });
  }
  return parsed;
}

function getChunkUploadTempPath(absolutePath) {
  return path.join(path.dirname(absolutePath), `.${path.basename(absolutePath)}.chunked-upload`);
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;

  for await (const chunk of fs.createReadStream(filePath)) {
    bytes += chunk.length;
    hash.update(chunk);
  }

  return {
    bytes,
    sha256: hash.digest('hex')
  };
}

async function writeDownloadStream(inputPath, readable, options = {}) {
  const { root, relativePath, absolutePath } = resolveDownloadPath(inputPath);
  const maxBytes = parseMaxBytes(options.maxBytes || process.env.GENERAL_DOWNLOADS_MAX_UPLOAD_BYTES);
  const expectedBytes = Number(options.expectedBytes || 0);

  if (expectedBytes > maxBytes) {
    throw Object.assign(new Error(`Upload exceeds the ${maxBytes} byte limit`), { status: 413 });
  }

  await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });

  const tempPath = path.join(
    path.dirname(absolutePath),
    `.${path.basename(absolutePath)}.${Date.now()}.${process.pid}.upload`
  );
  const hash = crypto.createHash('sha256');
  let bytes = 0;

  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        callback(Object.assign(new Error(`Upload exceeds the ${maxBytes} byte limit`), { status: 413 }));
        return;
      }

      hash.update(chunk);
      callback(null, chunk);
    }
  });

  try {
    await pipeline(readable, counter, fs.createWriteStream(tempPath, { flags: 'wx' }));
    await fs.promises.rename(tempPath, absolutePath);
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }

  return {
    root,
    relativePath,
    absolutePath,
    bytes,
    sha256: hash.digest('hex')
  };
}

async function writeDownloadChunk(inputPath, readable, options = {}) {
  const { root, relativePath, absolutePath } = resolveDownloadPath(inputPath);
  const maxBytes = parseMaxBytes(options.maxBytes || process.env.GENERAL_DOWNLOADS_MAX_UPLOAD_BYTES);
  const offset = parseRequiredByteCount(options.offset, 'offset');
  const totalBytes = parseRequiredByteCount(options.totalBytes, 'totalBytes');
  const expectedBytes = parseRequiredByteCount(options.expectedBytes, 'content-length');
  const completeRequested = Boolean(options.complete);

  if (totalBytes > maxBytes) {
    throw Object.assign(new Error(`Upload exceeds the ${maxBytes} byte limit`), { status: 413 });
  }

  if (offset > totalBytes || offset + expectedBytes > totalBytes) {
    throw Object.assign(new Error('Chunk byte range exceeds the declared upload size'), { status: 400 });
  }

  await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });

  const tempPath = getChunkUploadTempPath(absolutePath);
  if (offset > 0) {
    let currentSize = 0;
    try {
      currentSize = (await fs.promises.stat(tempPath)).size;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }

    if (currentSize !== offset) {
      throw Object.assign(
        new Error(`Chunk offset mismatch: expected ${currentSize}, received ${offset}`),
        { status: 409, expectedOffset: currentSize }
      );
    }
  }

  let bytes = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > expectedBytes) {
        callback(Object.assign(new Error('Chunk exceeded its declared content-length'), { status: 400 }));
        return;
      }
      callback(null, chunk);
    }
  });

  try {
    await pipeline(
      readable,
      counter,
      fs.createWriteStream(tempPath, {
        flags: offset === 0 ? 'w' : 'r+',
        start: offset
      })
    );
  } catch (error) {
    if (offset === 0) {
      await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    } else {
      await fs.promises.truncate(tempPath, offset).catch(() => {});
    }
    throw error;
  }

  if (bytes !== expectedBytes) {
    await fs.promises.truncate(tempPath, offset).catch(() => {});
    throw Object.assign(new Error(`Chunk size mismatch: expected ${expectedBytes}, received ${bytes}`), { status: 400 });
  }

  const nextOffset = offset + bytes;
  if (!completeRequested) {
    return {
      root,
      relativePath,
      absolutePath,
      tempPath,
      complete: false,
      offset,
      bytes,
      nextOffset,
      totalBytes
    };
  }

  const stat = await fs.promises.stat(tempPath);
  if (nextOffset !== totalBytes || stat.size !== totalBytes) {
    throw Object.assign(new Error('Upload cannot be completed before all bytes are received'), { status: 400 });
  }

  const digest = await hashFile(tempPath);
  if (digest.bytes !== totalBytes) {
    throw Object.assign(new Error('Upload size changed while finalizing'), { status: 500 });
  }

  await fs.promises.rename(tempPath, absolutePath);

  return {
    root,
    relativePath,
    absolutePath,
    complete: true,
    offset,
    bytes,
    nextOffset,
    totalBytes,
    sha256: digest.sha256
  };
}

async function getDownloadFileInfo(inputPath) {
  const { root, relativePath, absolutePath } = resolveDownloadPath(inputPath);

  try {
    const stat = await fs.promises.stat(absolutePath);
    return {
      root,
      relativePath,
      absolutePath,
      exists: true,
      isFile: stat.isFile(),
      size: stat.size,
      updatedAt: stat.mtime.toISOString()
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        root,
        relativePath,
        absolutePath,
        exists: false,
        isFile: false,
        size: 0,
        updatedAt: null
      };
    }
    throw error;
  }
}

async function getDownloadUploadInfo(inputPath) {
  const file = await getDownloadFileInfo(inputPath);
  const tempPath = getChunkUploadTempPath(file.absolutePath);

  try {
    const stat = await fs.promises.stat(tempPath);
    return {
      file,
      staging: {
        exists: true,
        isFile: stat.isFile(),
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
        absolutePath: tempPath
      }
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        file,
        staging: {
          exists: false,
          isFile: false,
          size: 0,
          updatedAt: null,
          absolutePath: tempPath
        }
      };
    }
    throw error;
  }
}

module.exports = {
  DEFAULT_MAX_UPLOAD_BYTES,
  ensureGeneralDownloadsRoot,
  getDownloadFileInfo,
  getDownloadUploadInfo,
  getGeneralDownloadsRoot,
  normalizeDownloadPath,
  resolveDownloadPath,
  writeDownloadChunk,
  writeDownloadStream
};
