const mongoose = require('mongoose');
require('dotenv').config();

mongoose.set('bufferCommands', false);

const DEFAULT_SERVER_SELECTION_TIMEOUT_MS = 5000;
const DEFAULT_HEARTBEAT_FREQUENCY_MS = 5000;
const DEFAULT_CONNECT_RETRY_DELAY_MS = 2000;
const DEFAULT_MAX_CONNECT_RETRY_DELAY_MS = 30000;

let connectionLoopPromise = null;
let listenersAttached = false;
let shutdownHandlerAttached = false;
let isShuttingDown = false;
let currentRetryDelayMs = DEFAULT_CONNECT_RETRY_DELAY_MS;
let activeLogger = console;
let activeConnectOptions = null;

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function wait(delayMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    if (typeof timer?.unref === 'function') {
      timer.unref();
    }
  });
}

function getDatabaseStateLabel(readyState = mongoose.connection.readyState) {
  switch (Number(readyState)) {
    case 1:
      return 'connected';
    case 2:
      return 'connecting';
    case 3:
      return 'disconnecting';
    default:
      return 'disconnected';
  }
}

function isDatabaseReady() {
  return mongoose.connection.readyState === 1;
}

function buildConnectOptions(overrides = {}) {
  return {
    serverSelectionTimeoutMS: parsePositiveInt(
      overrides.serverSelectionTimeoutMS ?? process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
      DEFAULT_SERVER_SELECTION_TIMEOUT_MS
    ),
    heartbeatFrequencyMS: parsePositiveInt(
      overrides.heartbeatFrequencyMS ?? process.env.MONGODB_HEARTBEAT_FREQUENCY_MS,
      DEFAULT_HEARTBEAT_FREQUENCY_MS
    ),
    ...overrides
  };
}

function getRetryConfig(options = {}) {
  return {
    initialDelayMs: parsePositiveInt(
      options.initialRetryDelayMs ?? process.env.MONGODB_CONNECT_RETRY_DELAY_MS,
      DEFAULT_CONNECT_RETRY_DELAY_MS
    ),
    maxDelayMs: parsePositiveInt(
      options.maxRetryDelayMs ?? process.env.MONGODB_MAX_CONNECT_RETRY_DELAY_MS,
      DEFAULT_MAX_CONNECT_RETRY_DELAY_MS
    )
  };
}

function attachShutdownHandler() {
  if (shutdownHandlerAttached) {
    return;
  }

  shutdownHandlerAttached = true;

  process.on('SIGINT', async () => {
    isShuttingDown = true;

    try {
      await mongoose.connection.close();
      console.log('MongoDB connection closed through app termination');
      process.exit(0);
    } catch (error) {
      console.error('Error during MongoDB shutdown:', error);
      process.exit(1);
    }
  });
}

function attachConnectionListeners() {
  if (listenersAttached) {
    return;
  }

  listenersAttached = true;

  mongoose.connection.on('error', (error) => {
    activeLogger.error(`MongoDB connection error: ${error}`);
  });

  mongoose.connection.on('disconnected', () => {
    if (isShuttingDown) {
      return;
    }

    activeLogger.warn('MongoDB disconnected. Attempting to reconnect...');
    void connectDB({
      logger: activeLogger,
      connectOptions: activeConnectOptions || undefined
    });
  });

  mongoose.connection.on('reconnected', () => {
    currentRetryDelayMs = getRetryConfig().initialDelayMs;
    activeLogger.info('MongoDB reconnected');
  });
}

async function connectDB(options = {}) {
  const logger = options.logger || console;
  const retryConfig = getRetryConfig(options);
  const connectOptions = buildConnectOptions(options.connectOptions || {});

  activeLogger = logger;
  activeConnectOptions = connectOptions;
  currentRetryDelayMs = Math.max(
    parsePositiveInt(currentRetryDelayMs, retryConfig.initialDelayMs),
    retryConfig.initialDelayMs
  );

  attachShutdownHandler();
  attachConnectionListeners();

  if (isDatabaseReady()) {
    return mongoose.connection;
  }

  if (connectionLoopPromise) {
    return connectionLoopPromise;
  }

  connectionLoopPromise = (async () => {
    let attempt = 0;

    while (!isShuttingDown) {
      attempt += 1;

      try {
        const conn = await mongoose.connect(process.env.DATABASE_URL, connectOptions);
        currentRetryDelayMs = retryConfig.initialDelayMs;
        logger.log(`MongoDB Connected: ${conn.connection.host}`);
        return conn;
      } catch (error) {
        logger.error(`MongoDB connection attempt ${attempt} failed: ${error.message}`);

        const retryDelayMs = Math.min(currentRetryDelayMs, retryConfig.maxDelayMs);
        logger.warn(`Retrying MongoDB connection in ${retryDelayMs}ms`);

        await wait(retryDelayMs);
        currentRetryDelayMs = Math.min(retryDelayMs * 2, retryConfig.maxDelayMs);
      }
    }

    return mongoose.connection;
  })().finally(() => {
    connectionLoopPromise = null;
  });

  return connectionLoopPromise;
}

module.exports = {
  connectDB,
  getDatabaseStateLabel,
  isDatabaseReady
};
