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
const remoteUpdateRoutes = require("./routes/remoteUpdateRoutes");
const discoveryRoutes = require("./routes/discoveryRoutes");
const insteonRoutes = require("./routes/insteonRoutes");
const sslRoutes = require("./routes/sslRoutes");
const VoiceWebSocketServer = require("./websocket/voiceWebSocket");
const DiscoveryService = require("./services/discoveryService");
const remoteUpdateService = require("./services/remoteUpdateService");
const { connectDB } = require("./config/database");
const cors = require("cors");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

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
// Remote Update Routes
app.use('/api/remote-updates', remoteUpdateRoutes);
// Discovery Routes
app.use('/api/discovery', discoveryRoutes);
// Insteon Routes
app.use('/api/insteon', insteonRoutes);
// SSL Routes
app.use('/api/ssl', sslRoutes);

// Serve Let's Encrypt challenge files
app.use('/.well-known/acme-challenge', express.static(path.join(__dirname, 'public', '.well-known', 'acme-challenge')));

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

      const httpsPort = process.env.HTTPS_PORT || 3443;

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

// Store voice WebSocket instance for use in routes
app.set('voiceWebSocket', voiceWsServer);

// Initialize Discovery service
const discoveryService = new DiscoveryService();
app.locals.discoveryService = discoveryService;

// Auto-start discovery service (can be disabled via API)
try {
  discoveryService.start();
  console.log('Auto-discovery service started');
} catch (error) {
  console.warn('Auto-discovery service failed to start:', error.message);
}

// Initialize Remote Update Service
(async () => {
  try {
    await remoteUpdateService.initialize();
    console.log('Remote Update Service initialized successfully');
  } catch (error) {
    console.error('Failed to initialize Remote Update Service:', error.message);
  }
})();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully');
  voiceWsServer.stop();
  discoveryService.stop();
  httpServer.close(() => {
    console.log('HTTP server stopped');
    if (httpsServer) {
      httpsServer.close(() => {
        console.log('HTTPS server stopped');
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  });
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully');
  voiceWsServer.stop();
  discoveryService.stop();
  httpServer.close(() => {
    console.log('HTTP server stopped');
    if (httpsServer) {
      httpsServer.close(() => {
        console.log('HTTPS server stopped');
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  });
});

// Start HTTP server
httpServer.listen(port, async () => {
  console.log(`HTTP server running at http://localhost:${port}`);
  console.log(`WebSocket server ready for voice devices`);

  // Try to setup HTTPS server after HTTP is running
  await setupHttpsServer();
});
