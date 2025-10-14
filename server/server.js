// Load environment variables
require("dotenv").config();
const mongoose = require("mongoose");
const express = require("express");
const session = require("express-session");
const MongoStore = require('connect-mongo');
const basicRoutes = require("./routes/index");
const authRoutes = require("./routes/authRoutes");
const deviceRoutes = require("./routes/deviceRoutes");
const sceneRoutes = require("./routes/sceneRoutes");
const automationRoutes = require("./routes/automationRoutes");
const userProfileRoutes = require("./routes/userProfileRoutes");
const voiceDeviceRoutes = require("./routes/voiceDeviceRoutes");
const elevenLabsRoutes = require("./routes/elevenLabsRoutes");
const settingsRoutes = require("./routes/settingsRoutes");
const securityAlarmRoutes = require("./routes/securityAlarmRoutes");
const smartThingsRoutes = require("./routes/smartThingsRoutes");
const maintenanceRoutes = require("./routes/maintenanceRoutes");
const remoteDeviceRoutes = require("./routes/remoteDeviceRoutes");
const wakeWordRoutes = require("./routes/wakeWordRoutes");
const remoteUpdateRoutes = require("./routes/remoteUpdateRoutes");
const discoveryRoutes = require("./routes/discoveryRoutes");
const insteonRoutes = require("./routes/insteonRoutes");
const piperVoiceRoutes = require("./routes/piperVoiceRoutes");
const sslRoutes = require("./routes/sslRoutes");
const ollamaRoutes = require("./routes/ollamaRoutes");
const resourceRoutes = require("./routes/resourceRoutes");
const VoiceWebSocketServer = require("./websocket/voiceWebSocket");
const DiscoveryService = require("./services/discoveryService");
const settingsService = require("./services/settingsService");
const remoteUpdateService = require("./services/remoteUpdateService");
const wakeWordTrainingService = require("./services/wakeWordTrainingService");
const { connectDB } = require("./config/database");
const cors = require("cors");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const ACME_CHALLENGE_PORT = Number(process.env.ACME_CHALLENGE_PORT || 80);
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

const app = express();
const port = process.env.PORT || 3000;
// Pretty-print JSON responses
app.enable('json spaces');
// We want to be consistent with URL paths, so we enable strict routing
app.enable('strict routing');

app.use(cors({}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database connection
connectDB();

app.on("error", (error) => {
  console.error(`Server error: ${error.message}`);
  console.error(error.stack);
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
app.use('/api/smartthings', smartThingsRoutes);
// Maintenance Routes
app.use('/api/maintenance', maintenanceRoutes);
// Remote Device Routes
app.use('/api/remote-devices', remoteDeviceRoutes);
// Piper Voice Routes
app.use('/api/wake-words/voices', piperVoiceRoutes);
// Wake Word Routes
app.use('/api/wake-words', wakeWordRoutes);
// Remote Update Routes
app.use('/api/remote-updates', remoteUpdateRoutes);
// Discovery Routes
app.use('/api/discovery', discoveryRoutes);
// Insteon Routes
app.use('/api/insteon', insteonRoutes);
// SSL Routes
app.use('/api/ssl', sslRoutes);
// Ollama Routes
app.use('/api/ollama', ollamaRoutes);
// Resource Monitor Routes
app.use('/api/resources', resourceRoutes);

// Serve built client app in production (fallback for SPA routes)
const clientDistPath = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientDistPath)) {
  console.log(`Serving client build from ${clientDistPath}`);
  app.use(express.static(clientDistPath));

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) {
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

      const httpsPort = process.env.HTTPS_PORT || 443;

      httpsServer.listen(httpsPort, () => {
        console.log(`HTTPS server running at https://localhost:${httpsPort}`);
      });

      // Initialize WebSocket server on HTTPS
      const httpsVoiceWsServer = new VoiceWebSocketServer();
      httpsVoiceWsServer.initialize(httpsServer);

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
wakeWordTrainingService.setVoiceWebSocket(voiceWsServer);
wakeWordTrainingService.resumePendingTraining().catch((error) => {
  console.error('Failed to resume wake word training jobs:', error);
});

// Store voice WebSocket instance(s) for use in routes
app.set('voiceWebSocket', voiceWsServer);
app.set('voiceWebSocketHttp', voiceWsServer);

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

// Initialize Remote Update Service
(async () => {
  try {
    await remoteUpdateService.initialize();
    console.log('Remote Update Service initialized successfully');
  } catch (error) {
    console.error('Failed to initialize Remote Update Service:', error.message);
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
});
