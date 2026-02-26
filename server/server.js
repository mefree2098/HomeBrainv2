// Load environment variables
require("dotenv").config();
const mongoose = require("mongoose");
const express = require("express");
const basicRoutes = require("./routes/index");
const authRoutes = require("./routes/authRoutes");
const deviceRoutes = require("./routes/deviceRoutes");
const sceneRoutes = require("./routes/sceneRoutes");
const automationRoutes = require("./routes/automationRoutes");
const workflowRoutes = require("./routes/workflowRoutes");
const userProfileRoutes = require("./routes/userProfileRoutes");
const voiceDeviceRoutes = require("./routes/voiceDeviceRoutes");
const elevenLabsRoutes = require("./routes/elevenLabsRoutes");
const settingsRoutes = require("./routes/settingsRoutes");
const securityAlarmRoutes = require("./routes/securityAlarmRoutes");
const smartThingsRoutes = require("./routes/smartThingsRoutes");
const smartThingsWebhookRoutes = require("./routes/smartThingsWebhookRoutes");
const ecobeeRoutes = require("./routes/ecobeeRoutes");
const harmonyRoutes = require("./routes/harmonyRoutes");
const maintenanceRoutes = require("./routes/maintenanceRoutes");
const platformDeployRoutes = require("./routes/platformDeployRoutes");
const remoteDeviceRoutes = require("./routes/remoteDeviceRoutes");
const wakeWordRoutes = require("./routes/wakeWordRoutes");
const remoteUpdateRoutes = require("./routes/remoteUpdateRoutes");
const eventStreamRoutes = require("./routes/eventStreamRoutes");
const discoveryRoutes = require("./routes/discoveryRoutes");
const insteonRoutes = require("./routes/insteonRoutes");
const piperVoiceRoutes = require("./routes/piperVoiceRoutes");
const sslRoutes = require("./routes/sslRoutes");
const ollamaRoutes = require("./routes/ollamaRoutes");
const resourceRoutes = require("./routes/resourceRoutes");
const whisperRoutes = require("./routes/whisperRoutes");
const VoiceWebSocketServer = require("./websocket/voiceWebSocket");
const deviceWebSocket = require("./websocket/deviceWebSocket");
const deviceUpdateEmitter = require("./services/deviceUpdateEmitter");
const { requireUser } = require("./routes/middlewares/auth");
const DiscoveryService = require("./services/discoveryService");
const settingsService = require("./services/settingsService");
const remoteUpdateService = require("./services/remoteUpdateService");
const wakeWordTrainingService = require("./services/wakeWordTrainingService");
const voiceAcknowledgmentService = require("./services/voiceAcknowledgmentService");
const whisperService = require("./services/whisperService");
const smartThingsService = require("./services/smartThingsService");
const ecobeeService = require("./services/ecobeeService");
const automationSchedulerService = require("./services/automationSchedulerService");
const { connectDB } = require("./config/database");
const cors = require("cors");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const ACME_CHALLENGE_PORT = Number(process.env.ACME_CHALLENGE_PORT || 80);
const SMARTTHINGS_STARTUP_BOOTSTRAP_DELAY_MS = Math.max(0, Number(process.env.SMARTTHINGS_STARTUP_BOOTSTRAP_DELAY_MS || 5000));
const ACME_CHALLENGE_DIR = path.join(__dirname, 'public', '.well-known', 'acme-challenge');
let challengeServer = null;
let isShuttingDown = false;

function startAcmeChallengeServer() {
  if (Number.isNaN(ACME_CHALLENGE_PORT)) {
    console.warn('ACME challenge server disabled: invalid ACME_CHALLENGE_PORT value');
    return;
  }

  const challengeApp = express();
  challengeApp.use('/.well-known/acme-challenge', express.static(ACME_CHALLENGE_DIR));
  challengeApp.use((req, res) => res.status(404).end());

  challengeServer = http.createServer(challengeApp);

  challengeServer.on('error', (error) => {
    const { code, message } = error;
    if (code === 'EACCES') {
      console.warn(`ACME challenge server requires elevated privileges to bind port ${ACME_CHALLENGE_PORT}: ${message}`);
    } else if (code === 'EADDRINUSE') {
      console.warn(`ACME challenge server could not bind port ${ACME_CHALLENGE_PORT}: address already in use`);
    } else {
      console.error(`ACME challenge server error: ${message}`);
    }
    challengeServer = null;
  });

  try {
    challengeServer.listen(ACME_CHALLENGE_PORT, () => {
      console.log(`ACME challenge server running on port ${ACME_CHALLENGE_PORT}`);
    });
  } catch (error) {
    console.warn(`Failed to start ACME challenge server on port ${ACME_CHALLENGE_PORT}: ${error.message}`);
    challengeServer = null;
  }
}

function closeServer(server, name) {
  return new Promise((resolve) => {
    if (!server || typeof server.close !== 'function' || !server.listening) {
      return resolve();
    }

    server.close((error) => {
      if (error) {
        console.error(`Error stopping ${name}: ${error.message}`);
      } else {
        console.log(`${name} stopped`);
      }
      resolve();
    });
  });
}

if (!process.env.DATABASE_URL) {
  console.error("Error: DATABASE_URL variables in .env missing.");
  process.exit(-1);
}

const SMARTTHINGS_WEBHOOK_DEFAULT_PATH = '/api/smartthings/webhook';

const normalizeWebhookPath = (value, fallback) => {
  if (!value || typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }

  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  if (withLeadingSlash === '/') {
    return withLeadingSlash;
  }

  return withLeadingSlash.replace(/\/+$/, '');
};

const app = express();
const port = process.env.PORT || 3000;
// Pretty-print JSON responses
app.enable('json spaces');
// We want to be consistent with URL paths, so we enable strict routing
app.enable('strict routing');

app.use(cors({}));
app.use(express.json({
  limit: '8mb',
  verify: (req, res, buf) => {
    if (buf && buf.length) {
      req.rawBody = Buffer.from(buf);
    }
  }
}));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));
// Serve ACME HTTP-01 challenge files on the primary app server as a fallback.
// This allows deployments that forward external :80 traffic to app :3000.
app.use('/.well-known/acme-challenge', express.static(ACME_CHALLENGE_DIR));

// Database connection
connectDB();

app.on("error", (error) => {
  console.error(`Server error: ${error.message}`);
  console.error(error.stack);
});

// Device Updates Stream (SSE)
app.get('/api/devices/stream', requireUser(), (req, res) => {
  console.log('Device SSE: client connected');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const heartbeat = setInterval(() => {
    try {
      res.write(':\n\n');
    } catch (error) {
      clearInterval(heartbeat);
    }
  }, 30000);

  const sendUpdate = (devices) => {
    try {
      const normalized = deviceUpdateEmitter.normalizeDevices(devices);
      if (normalized.length === 0) {
        return;
      }
      const payload = {
        type: 'devices:update',
        devices: normalized
      };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (error) {
      console.warn('Device SSE: failed to write update:', error.message);
    }
  };

  deviceUpdateEmitter.on('devices:update', sendUpdate);
  res.write('event: ready\n');
  res.write('data: {}\n\n');

  let closed = false;
  const cleanup = () => {
    if (closed) {
      return;
    }
    closed = true;
    console.log('Device SSE: client disconnected');
    clearInterval(heartbeat);
    deviceUpdateEmitter.removeListener('devices:update', sendUpdate);
    try {
      res.end();
    } catch (error) {
      console.warn('Device SSE: error ending response:', error.message);
    }
  };

  req.on('close', cleanup);
  req.on('end', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
});
// Basic Routes
app.use(basicRoutes);
// Authentication Routes
app.use('/api/auth', authRoutes);
// Device Routes
app.use('/api/devices', deviceRoutes);
// Scene Routes
app.use('/api/scenes', sceneRoutes);
// Automation Routes
app.use('/api/automations', automationRoutes);
// Workflow Routes
app.use('/api/workflows', workflowRoutes);
// User Profile Routes
app.use('/api/profiles', userProfileRoutes);
// Voice Device Routes
app.use('/api/voice', voiceDeviceRoutes);
// ElevenLabs Routes
app.use('/api/elevenlabs', elevenLabsRoutes);
// Settings Routes
app.use('/api/settings', settingsRoutes);
// Security Alarm Routes
app.use('/api/security-alarm', securityAlarmRoutes);
  // SmartThings Routes
const smartThingsWebhookPath = normalizeWebhookPath(process.env.SMARTTHINGS_WEBHOOK_PATH, SMARTTHINGS_WEBHOOK_DEFAULT_PATH);
app.use(smartThingsWebhookPath, smartThingsWebhookRoutes);
app.use('/api/smartthings', smartThingsRoutes);
// Ecobee Routes
app.use('/api/ecobee', ecobeeRoutes);
// Harmony Routes
app.use('/api/harmony', harmonyRoutes);
// Maintenance Routes
app.use('/api/maintenance', maintenanceRoutes);
// Platform Deploy Routes
app.use('/api/platform-deploy', platformDeployRoutes);
// Remote Device Routes
app.use('/api/remote-devices', remoteDeviceRoutes);
// Piper Voice Routes
app.use('/api/wake-words/voices', piperVoiceRoutes);
// Wake Word Routes
app.use('/api/wake-words', wakeWordRoutes);
// Remote Update Routes
app.use('/api/remote-updates', remoteUpdateRoutes);
// Event Stream Routes
app.use('/api/events', eventStreamRoutes);
// Discovery Routes
app.use('/api/discovery', discoveryRoutes);
// Insteon Routes
app.use('/api/insteon', insteonRoutes);
  // SSL Routes
  app.use('/api/ssl', sslRoutes);
  // Ollama Routes
  app.use('/api/ollama', ollamaRoutes);
  // Whisper Routes
  app.use('/api/whisper', whisperRoutes);
  // Resource Monitor Routes
  app.use('/api/resources', resourceRoutes);

// Serve update packages from server/public/downloads so devices can fetch them
const updatesPath = path.join(__dirname, 'public', 'downloads');
if (fs.existsSync(updatesPath)) {
  console.log(`Serving update downloads from ${updatesPath} at /downloads`);
  app.use('/downloads', express.static(updatesPath));
}

// Serve built client app in production (fallback for SPA routes)
const clientDistPath = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientDistPath)) {
  console.log(`Serving client build from ${clientDistPath}`);
  app.use(express.static(clientDistPath));

  app.get('/{*splat}', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/downloads/')) {
      return next();
    }

    const indexFilePath = path.join(clientDistPath, 'index.html');
    res.sendFile(indexFilePath, (error) => {
      if (error) {
        next(error);
      }
    });
  });
}

// If no routes handled the request, it's a 404
app.use((req, res, next) => {
  res.status(404).send("Page not found.");
});

// Error handling
app.use((err, req, res, next) => {
  console.error(`Unhandled application error: ${err.message}`);
  console.error(err.stack);
  res.status(500).send("There was an error serving your request.");
});

// Create HTTP server
const httpServer = http.createServer(app);

// Create HTTPS server if SSL certificate is available
let httpsServer = null;
const sslService = require('./services/sslService');

async function setupHttpsServer() {
  try {
    const sslConfig = await sslService.getActiveCertificateForServer();

    if (sslConfig) {
      console.log(`SSL certificate found for ${sslConfig.domain}, enabling HTTPS...`);

      httpsServer = https.createServer({
        key: sslConfig.key,
        cert: sslConfig.cert
      }, app);

      const httpsPort = Number(process.env.HTTPS_PORT || 443);

      const listenResult = await new Promise((resolve) => {
        const onError = (error) => {
          httpsServer.off('listening', onListening);
          resolve({ ok: false, error });
        };

        const onListening = () => {
          httpsServer.off('error', onError);
          resolve({ ok: true });
        };

        httpsServer.once('error', onError);
        httpsServer.once('listening', onListening);

        try {
          httpsServer.listen(httpsPort);
        } catch (error) {
          onError(error);
        }
      });

      if (!listenResult.ok) {
        const { error } = listenResult;
        if (error && error.code === 'EACCES') {
          console.warn(`HTTPS disabled: insufficient privileges to bind port ${httpsPort}`);
        } else if (error && error.code === 'EADDRINUSE') {
          console.warn(`HTTPS disabled: port ${httpsPort} already in use`);
        } else {
          console.warn(`HTTPS disabled: failed to bind port ${httpsPort}: ${error?.message || 'unknown error'}`);
        }

        try {
          await closeServer(httpsServer, 'HTTPS server');
        } catch (closeError) {
          // noop
        }
        httpsServer = null;
        return null;
      }

      httpsServer.on('error', (error) => {
        console.error(`HTTPS server error: ${error.message}`);
      });

      console.log(`HTTPS server running at https://localhost:${httpsPort}`);

      // Initialize WebSocket server on HTTPS
      const httpsVoiceWsServer = new VoiceWebSocketServer();
      httpsVoiceWsServer.initialize(httpsServer);
      deviceWebSocket.initialize(httpsServer);

      return httpsVoiceWsServer;
    } else {
      console.log('No active SSL certificate found, HTTPS disabled');
      return null;
    }
  } catch (error) {
    console.error('Error setting up HTTPS server:', error.message);
    return null;
  }
}

// Initialize WebSocket server on HTTP
const voiceWsServer = new VoiceWebSocketServer();
voiceWsServer.initialize(httpServer);
deviceWebSocket.initialize(httpServer);
wakeWordTrainingService.setVoiceWebSocket(voiceWsServer);
wakeWordTrainingService.resumePendingTraining().catch((error) => {
  console.error('Failed to resume wake word training jobs:', error);
});

// Store voice WebSocket instance(s) for use in routes
app.set('voiceWebSocket', voiceWsServer);
app.set('voiceWebSocketHttp', voiceWsServer);
app.set('deviceWebSocket', deviceWebSocket);

// Initialize Discovery service
const discoveryService = new DiscoveryService();
app.locals.discoveryService = discoveryService;

async function initializeDiscoveryService() {
  try {
    const settings = await settingsService.getSettings();
    const shouldEnable = settings?.autoDiscoveryEnabled === true;

    if (shouldEnable) {
      discoveryService.start();
      console.log('Auto-discovery service started (persisted preference)');
    } else {
      console.log('Auto-discovery service disabled by default (persisted preference)');
    }
  } catch (error) {
    console.warn('Failed to initialize auto-discovery service from settings:', error.message);
  }
}

void initializeDiscoveryService();
automationSchedulerService.start();

// Initialize Remote Update Service
(async () => {
  try {
    await remoteUpdateService.initialize();
    console.log('Remote Update Service initialized successfully');
  } catch (error) {
    console.error('Failed to initialize Remote Update Service:', error.message);
  }
})();

// Initialize Whisper Service (local STT)
(async () => {
  try {
    await whisperService.initialize();
    console.log('Whisper Service initialized successfully');
  } catch (error) {
    console.error('Failed to initialize Whisper Service:', error.message);
  }
})();

// Prime profile acknowledgment audio in background
(async () => {
  try {
    await voiceAcknowledgmentService.primeAllProfiles();
    console.log('Voice acknowledgment cache primed');
  } catch (error) {
    console.warn('Failed to prime voice acknowledgment cache:', error.message);
  }
})();

startAcmeChallengeServer();

async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  console.log(`Received ${signal}, shutting down gracefully`);

  try {
    voiceWsServer.stop();
  } catch (error) {
    console.error('Error stopping voice WebSocket server:', error.message);
  }

  try {
    discoveryService.stop();
  } catch (error) {
    console.error('Error stopping discovery service:', error.message);
  }

  try {
    automationSchedulerService.stop();
  } catch (error) {
    console.error('Error stopping automation scheduler service:', error.message);
  }

  try {
    await whisperService.stopService();
    } catch (error) {
      console.error('Error stopping Whisper service:', error.message);
    }

    try {
      if (typeof smartThingsService.stopSubscriptionRenewalTask === 'function') {
        smartThingsService.stopSubscriptionRenewalTask();
      }
    } catch (error) {
      console.error('Error stopping SmartThings subscription task:', error.message);
    }

    try {
      if (typeof ecobeeService.stopDeviceStatusSync === 'function') {
        ecobeeService.stopDeviceStatusSync();
      }
    } catch (error) {
      console.error('Error stopping Ecobee status sync task:', error.message);
    }

    await closeServer(challengeServer, 'ACME challenge server');
    challengeServer = null;

  await closeServer(httpServer, 'HTTP server');

  await closeServer(httpsServer, 'HTTPS server');
  httpsServer = null;

  process.exit(0);
}

// Graceful shutdown
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start HTTP server
httpServer.listen(port, async () => {
  console.log(`HTTP server running at http://localhost:${port}`);
  console.log(`WebSocket server ready for voice devices`);

  // Try to setup HTTPS server after HTTP is running
  const httpsWs = await setupHttpsServer();
  if (httpsWs) {
    // Prefer HTTPS WebSocket server for device operations if available
    app.set('voiceWebSocket', httpsWs);
    console.log('Voice WebSocket (HTTPS) selected for device operations');
  } else {
    console.log('Voice WebSocket (HTTP) selected for device operations');
  }

  const bootstrapTimer = setTimeout(() => {
    smartThingsService.bootstrapConnectionState({ reason: 'server-startup' })
      .then((result) => {
        if (result?.success) {
          console.log('SmartThings startup bootstrap completed successfully');
        } else if (result?.skipped) {
          console.log(`SmartThings startup bootstrap skipped: ${result.reason}`);
        } else {
          console.warn(`SmartThings startup bootstrap failed: ${result?.error || 'unknown error'}`);
        }
      })
      .catch((error) => {
        console.warn(`SmartThings startup bootstrap error: ${error.message}`);
      });
  }, SMARTTHINGS_STARTUP_BOOTSTRAP_DELAY_MS);

  if (typeof bootstrapTimer?.unref === 'function') {
    bootstrapTimer.unref();
  }
});
