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
const discoveryRoutes = require("./routes/discoveryRoutes");
const VoiceWebSocketServer = require("./websocket/voiceWebSocket");
const DiscoveryService = require("./services/discoveryService");
const { connectDB } = require("./config/database");
const cors = require("cors");
const http = require("http");

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
// Discovery Routes
app.use('/api/discovery', discoveryRoutes);

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
const server = http.createServer(app);

// Initialize WebSocket server
const voiceWsServer = new VoiceWebSocketServer();
voiceWsServer.initialize(server);

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

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully');
  voiceWsServer.stop();
  discoveryService.stop();
  server.close(() => {
    console.log('Server stopped');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully');
  voiceWsServer.stop();
  discoveryService.stop();
  server.close(() => {
    console.log('Server stopped');
    process.exit(0);
  });
});

server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log(`WebSocket server ready for voice devices`);
});
