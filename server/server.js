// Load environment variables
require("dotenv").config();
const { acquireSingletonProcessLock } = require("./utils/singletonProcessLock");
const homebrainServerLock = acquireSingletonProcessLock({
  name: 'homebrain-server',
  port: process.env.PORT || 3000
});

if (!homebrainServerLock.acquired) {
  const ownerPid = homebrainServerLock.owner?.pid || 'unknown';
  console.error(`HomeBrain server is already running for this port (pid ${ownerPid}); exiting duplicate startup.`);
  process.exit(0);
}

const mongoose = require("mongoose");
const { connectDB } = require("./config/database");
const { databaseAvailabilityGuard } = require("./middleware/databaseAvailability");
const express = require("express");
const basicRoutes = require("./routes/index");
const authRoutes = require("./routes/authRoutes");
const userRoutes = require("./routes/userRoutes");
const oidcRoutes = require("./routes/oidcRoutes");
const deviceRoutes = require("./routes/deviceRoutes");
const directRadioRoutes = require("./routes/directRadioRoutes");
const matterRoutes = require("./routes/matterRoutes");
const deviceGroupRoutes = require("./routes/deviceGroupRoutes");
const sceneRoutes = require("./routes/sceneRoutes");
const automationRoutes = require("./routes/automationRoutes");
const workflowRoutes = require("./routes/workflowRoutes");
const userProfileRoutes = require("./routes/userProfileRoutes");
const voiceDeviceRoutes = require("./routes/voiceDeviceRoutes");
const elevenLabsRoutes = require("./routes/elevenLabsRoutes");
const settingsRoutes = require("./routes/settingsRoutes");
const integrationRoutes = require("./routes/integrationRoutes");
const tempestRoutes = require("./routes/tempestRoutes");
const goveeAirQualityRoutes = require("./routes/goveeAirQualityRoutes");
const rainMachineRoutes = require("./routes/rainMachineRoutes");
const senseRoutes = require("./routes/senseRoutes");
const weatherRoutes = require("./routes/weatherRoutes");
const securityAlarmRoutes = require("./routes/securityAlarmRoutes");
const smartThingsRoutes = require("./routes/smartThingsRoutes");
const smartThingsWebhookRoutes = require("./routes/smartThingsWebhookRoutes");
const ecobeeRoutes = require("./routes/ecobeeRoutes");
const harmonyRoutes = require("./routes/harmonyRoutes");
const maintenanceRoutes = require("./routes/maintenanceRoutes");
const platformDeployRoutes = require("./routes/platformDeployRoutes");
const reverseProxyRoutes = require("./routes/reverseProxyRoutes");
const remoteDeviceRoutes = require("./routes/remoteDeviceRoutes");
const panelRoutes = require("./routes/panelRoutes");
const wakeWordRoutes = require("./routes/wakeWordRoutes");
const remoteUpdateRoutes = require("./routes/remoteUpdateRoutes");
const eventStreamRoutes = require("./routes/eventStreamRoutes");
const discoveryRoutes = require("./routes/discoveryRoutes");
const insteonRoutes = require("./routes/insteonRoutes");
const piperVoiceRoutes = require("./routes/piperVoiceRoutes");
const sslRoutes = require("./routes/sslRoutes");
const internalCaddyRoutes = require("./routes/internalCaddyRoutes");
const internalAxiomRoutes = require("./routes/internalAxiomRoutes");
const ollamaRoutes = require("./routes/ollamaRoutes");
const resourceRoutes = require("./routes/resourceRoutes");
const whisperRoutes = require("./routes/whisperRoutes");
const alexaRoutes = require("./routes/alexaRoutes");
const alexaCustomSkillRoutes = require("./routes/alexaCustomSkillRoutes");
const telemetryRoutes = require("./routes/telemetryRoutes");
const openclawRoutes = require("./routes/openclawRoutes");
const openclawMcpRoutes = require("./routes/openclawMcpRoutes");
const codexSkillRoutes = require("./routes/codexSkillRoutes");
const generalDownloadRoutes = require("./routes/generalDownloadRoutes");
const deviceCommandCoordinatorRoutes = require("./routes/deviceCommandCoordinatorRoutes");
const watchRoutes = require("./routes/watchRoutes");
const VoiceWebSocketServer = require("./websocket/voiceWebSocket");
const deviceWebSocket = require("./websocket/deviceWebSocket");
const deviceUpdateEmitter = require("./services/deviceUpdateEmitter");
const adminBootstrapService = require("./services/adminBootstrapService");
const { requireUser } = require("./routes/middlewares/auth");
const DiscoveryService = require("./services/discoveryService");
const settingsService = require("./services/settingsService");
const remoteUpdateService = require("./services/remoteUpdateService");
const wakeWordTrainingService = require("./services/wakeWordTrainingService");
const voiceAcknowledgmentService = require("./services/voiceAcknowledgmentService");
const whisperService = require("./services/whisperService");
const tempestService = require("./services/tempestService");
const goveeAirQualityService = require("./services/goveeAirQualityService");
const rainMachineService = require("./services/rainMachineService");
const senseService = require("./services/senseService");
const platformDeployService = require("./services/platformDeployService");
const deviceRestartService = require("./services/deviceRestartService");
const smbBackupSchedulerService = require("./services/smbBackupSchedulerService");
const smartThingsService = require("./services/smartThingsService");
const ecobeeService = require("./services/ecobeeService");
const axiomIngressSyncService = require("./services/axiomIngressSyncService");
const generalDownloadStorage = require("./services/generalDownloadStorage");
const { shutdownCodexCliService } = require("./services/codexCliService");
const automationService = require("./services/automationService");
const automationSchedulerService = require("./services/automationSchedulerService");
const alexaBridgeService = require("./services/alexaBridgeService");
const alexaBrokerService = require("./services/alexaBrokerService");
const platformUpdateMonitorService = require("./services/platformUpdateMonitorService");
const directRadioService = require("./services/directRadioService");
const matterService = require("./services/matterService");
const deviceLibraryUpdateService = require("./services/deviceLibraryUpdateService");
const telemetryService = require("./services/telemetryService");
const openclawMcpService = require("./services/openclawMcpService");
const { sendNotFound, sendUnhandledError } = require("./utils/apiErrorResponses");
const { assertRequiredAuthSecrets } = require("./utils/startupSecrets");
const cors = require("cors");
const http = require("http");
const fs = require("fs");
const path = require("path");
const SMARTTHINGS_STARTUP_BOOTSTRAP_DELAY_MS = Math.max(0, Number(process.env.SMARTTHINGS_STARTUP_BOOTSTRAP_DELAY_MS || 5000));
const AXIOM_STARTUP_SYNC_DELAY_MS = Math.max(0, Number(process.env.AXIOM_STARTUP_SYNC_DELAY_MS || 7000));
let isShuttingDown = false;

function envFlagEnabled(value, fallback = true) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!normalized) {
    return fallback;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  return fallback;
}

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeOrigin(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }

  try {
    return new URL(value.trim()).origin;
  } catch (_error) {
    return '';
  }
}

function buildAllowedOrigins() {
  const configured = [
    process.env.CLIENT_URL,
    process.env.HOMEBRAIN_PUBLIC_BASE_URL,
    process.env.PUBLIC_BASE_URL,
    process.env.AXIOM_PUBLIC_BASE_URL,
    process.env.AXIOM_PUBLIC_URL,
    ...splitList(process.env.CORS_ALLOWED_ORIGINS)
  ].map(normalizeOrigin).filter(Boolean);

  if (process.env.NODE_ENV !== 'production') {
    configured.push(
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:3000',
      'http://127.0.0.1:3000'
    );
  }

  return [...new Set(configured)];
}

function buildCorsOptions(req = null) {
  const allowedOrigins = buildAllowedOrigins();

  return {
    origin(origin, callback) {
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      const error = new Error('CORS origin not allowed');
      error.status = 403;
      return callback(error);
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'X-CSRF-Token',
      'X-HomeBrain-Client-Type',
      'X-HomeBrain-Client-Name',
      'X-HomeBrain-Device-Id',
      'X-HomeBrain-Registration-Code',
      'X-HomeBrain-Claim-Token',
      'X-HomeBrain-Device-Token'
    ]
  };
}

function buildConnectSrc(req = null) {
  const sources = new Set(["'self'"]);
  const host = req?.get?.('host');

  if (host) {
    sources.add(`ws://${host}`);
    sources.add(`wss://${host}`);
  }

  if (process.env.NODE_ENV !== 'production') {
    sources.add('ws://localhost:*');
    sources.add('ws://127.0.0.1:*');
    sources.add('http://localhost:*');
    sources.add('http://127.0.0.1:*');
  }

  return `connect-src ${Array.from(sources).join(' ')}`;
}

function getContentSecurityPolicy(req = null) {
  if (process.env.CONTENT_SECURITY_POLICY) {
    return process.env.CONTENT_SECURITY_POLICY;
  }

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https://fonts.gstatic.com",
    buildConnectSrc(req),
    "frame-ancestors 'self'",
    "form-action 'self'"
  ].join('; ');
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

try {
  assertRequiredAuthSecrets();
} catch (error) {
  console.error(`Error: ${error.message}`);
  console.error('Set strong JWT_SECRET and REFRESH_TOKEN_SECRET values before starting HomeBrain.');
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

const smartThingsWebhookPath = normalizeWebhookPath(process.env.SMARTTHINGS_WEBHOOK_PATH, SMARTTHINGS_WEBHOOK_DEFAULT_PATH);

const app = express();
const port = process.env.PORT || 3000;
const bindHost = process.env.HOMEBRAIN_BIND_HOST || '0.0.0.0';
openclawMcpService.setApp(app);
if (process.env.NODE_ENV !== 'production') {
  app.set('json spaces', 2);
}
// We want to be consistent with URL paths, so we enable strict routing
app.enable('strict routing');
app.disable('x-powered-by');
app.set('trust proxy', 'loopback, linklocal, uniquelocal');

app.use(cors((req, callback) => {
  callback(null, buildCorsOptions(req));
}));
app.use((req, res, next) => {
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(self), microphone=(self)');
  res.setHeader('Content-Security-Policy', getContentSecurityPolicy(req));
  next();
});
app.use(express.json({
  limit: '8mb',
  verify: (req, res, buf) => {
    if (req.method === 'POST' && req.path === smartThingsWebhookPath && buf && buf.length) {
      req.rawBody = buf;
    }
  }
}));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));
app.use('/api', databaseAvailabilityGuard);

// Database connection
const dbReady = connectDB();

void dbReady
  .then(async () => {
    try {
      const result = await adminBootstrapService.ensureBootstrapState({ actor: 'system:server-startup' });
      const details = [
        `email=${result.email || 'none'}`,
        `created=${result.created ? 'yes' : 'no'}`,
        `updated=${result.updated ? 'yes' : 'no'}`,
        `skipped=${result.skipped ? 'yes' : 'no'}`,
        `reason=${result.reason || 'none'}`,
        `changes=${result.changes.length > 0 ? result.changes.join(',') : 'none'}`
      ].join(' ');
      console.log(`Default admin bootstrap summary: ${details}`);
    } catch (error) {
      console.warn(`Default admin bootstrap failed: ${error.message}`);
    }

    try {
      await deviceRestartService.initialize();
      console.log('Device restart scheduler initialized successfully');
    } catch (error) {
      console.warn(`Device restart scheduler startup failed: ${error.message}`);
    }

    try {
      await smbBackupSchedulerService.initialize();
      console.log('SMB backup scheduler initialized successfully');
    } catch (error) {
      console.warn(`SMB backup scheduler startup failed: ${error.message}`);
    }
  })
  .catch((error) => {
    console.warn(`Database startup tasks skipped: ${error.message}`);
  });

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
// OIDC Provider Routes
app.use(oidcRoutes);
// Basic Routes
app.use(basicRoutes);
// Authentication Routes
app.use('/api/auth', authRoutes);
// User Management Routes
app.use('/api/users', userRoutes);
// Device Routes
app.use('/api/devices', deviceRoutes);
app.use('/api/direct-radios', directRadioRoutes);
app.use('/api/matter', matterRoutes);
app.use('/api/device-groups', deviceGroupRoutes);
app.use('/api/device-command-coordinator', deviceCommandCoordinatorRoutes);
app.use('/api/telemetry', telemetryRoutes);
app.use('/api/watch', watchRoutes);
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
app.use('/api/integrations', integrationRoutes);
// Weather Routes
app.use('/api/weather', weatherRoutes);
app.use('/api/tempest', tempestRoutes);
app.use('/api/govee-air-quality', goveeAirQualityRoutes);
app.use('/api/rainmachine', rainMachineRoutes);
app.use('/api/sense', senseRoutes);
// Security Alarm Routes
app.use('/api/security-alarm', securityAlarmRoutes);
  // SmartThings Routes
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
// Reverse Proxy Routes
app.use('/api/admin/reverse-proxy', reverseProxyRoutes);
// Remote Device Routes
app.use('/api/remote-devices', remoteDeviceRoutes);
// Wall Panel Routes
app.use('/api/panels', panelRoutes);
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
// Alexa Routes
app.use('/api/alexa', alexaRoutes);
app.use('/api/alexa/custom-skill', alexaCustomSkillRoutes);
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
// OpenClaw Integration Routes
app.use('/api/openclaw/mcp', openclawMcpRoutes);
app.use('/api/openclaw', openclawRoutes);
app.use('/api/codex-skill', codexSkillRoutes);
app.use('/api/admin/general-downloads', generalDownloadRoutes);
// Internal Caddy Policy Routes
app.use('/internal/caddy', internalCaddyRoutes);
// Internal Axiom Sync Routes
app.use('/internal/axiom', internalAxiomRoutes);

// Serve update packages from server/public/downloads so devices can fetch them
const updatesPath = path.join(__dirname, 'public', 'downloads');
if (fs.existsSync(updatesPath)) {
  console.log(`Serving update downloads from ${updatesPath} at /downloads`);
  app.use('/downloads', express.static(updatesPath));
}

const generalDownloadsRoot = generalDownloadStorage.ensureGeneralDownloadsRoot();
const publicDomainDownloadsPath = path.join(generalDownloadsRoot, 'public-domain');
fs.mkdirSync(publicDomainDownloadsPath, { recursive: true });
const generalDownloadStaticOptions = {
  acceptRanges: true,
  fallthrough: false,
  immutable: false,
  setHeaders(res, filePath) {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    if (filePath.endsWith('.scoreflowseed')) {
      res.type('application/octet-stream');
    }
  }
};
console.log(`Serving general downloads from ${generalDownloadsRoot} at /general-downloads`);
console.log(`Serving public-domain downloads from ${publicDomainDownloadsPath} at /public-domain`);
app.use('/general-downloads', express.static(generalDownloadsRoot, generalDownloadStaticOptions));
app.use('/public-domain', express.static(publicDomainDownloadsPath, generalDownloadStaticOptions));

const securityAudioPath = path.join(__dirname, 'public', 'audio', 'security');
if (fs.existsSync(securityAudioPath)) {
  console.log(`Serving security audio prompts from ${securityAudioPath} at /audio/security`);
  app.use('/audio/security', express.static(securityAudioPath));
}

// Serve built client app in production (fallback for SPA routes)
const clientDistPath = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientDistPath)) {
  console.log(`Serving client build from ${clientDistPath}`);
  app.use(express.static(clientDistPath));

  app.get('/{*splat}', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/downloads/') || req.path.startsWith('/audio/security/')) {
      return next();
    }

    const indexFilePath = path.join(clientDistPath, 'index.html');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(indexFilePath, (error) => {
      if (error) {
        next(error);
      }
    });
  });
}

// If no routes handled the request, it's a 404
app.use((req, res, next) => {
  sendNotFound(req, res);
});

// Error handling
app.use((err, req, res, next) => {
  console.error(`Unhandled application error: ${err.message}`);
  console.error(err.stack);
  if (res.headersSent) {
    return next(err);
  }

  return sendUnhandledError(err, req, res);
});

// Create HTTP server
const httpServer = http.createServer(app);

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
let automationRuntimeServicesStarted = false;

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

async function startAutomationRuntimeServices() {
  if (automationRuntimeServicesStarted) {
    return;
  }

  automationRuntimeServicesStarted = true;

  try {
    const result = await automationService.resumeRunningExecutions({ reason: 'server_startup' });
    if (result?.launchedCount > 0) {
      console.log(`Automation runtime resume launched ${result.launchedCount} persisted execution(s) on startup`);
    }
  } catch (error) {
    console.warn(`Automation runtime startup resume failed: ${error.message}`);
  }

  automationSchedulerService.start();
  platformUpdateMonitorService.start();
  deviceLibraryUpdateService.start();

  directRadioService.start()
    .then((status) => {
      const zigbeeReady = status?.controllers?.zigbee?.started ? 'ready' : 'not ready';
      const zwaveReady = status?.controllers?.zwave?.started ? 'ready' : 'not ready';
      console.log(`Direct radio startup complete: Zigbee ${zigbeeReady}, Z-Wave ${zwaveReady}`);
    })
    .catch((error) => {
      console.warn(`Direct radio startup skipped: ${error.message}`);
    });

  matterService.start()
    .then((status) => {
      const matterReady = status?.controllerStarted ? 'ready' : 'not ready';
      const threadReady = status?.thread?.readyForThreadCommissioning ? 'Thread ready' : 'Thread waiting';
      console.log(`Matter startup complete: controller ${matterReady}, ${threadReady}`);
    })
    .catch((error) => {
      console.warn(`Matter startup skipped: ${error.message}`);
    });
}

void initializeDiscoveryService();
alexaBridgeService.start();
void dbReady
  .then(() => startAutomationRuntimeServices())
  .catch((error) => {
    console.warn(`Automation runtime services startup skipped: ${error.message}`);
  });

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

// Initialize managed Alexa broker service
(async () => {
  try {
    await alexaBrokerService.initialize();
    console.log('Alexa Broker Service initialized successfully');
  } catch (error) {
    console.error('Failed to initialize Alexa Broker Service:', error.message);
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

// Initialize telemetry listeners
(() => {
  try {
    telemetryService.initialize();
    console.log('Telemetry listeners initialized successfully');
  } catch (error) {
    console.error('Failed to initialize telemetry listeners:', error.message);
  }
})();

// Initialize Tempest weather integration
(async () => {
  try {
    await tempestService.initialize();
    console.log('Tempest Service initialized successfully');
  } catch (error) {
    console.error('Failed to initialize Tempest Service:', error.message);
  }
})();

// Initialize Govee indoor air integration
(async () => {
  try {
    await goveeAirQualityService.initialize();
    console.log('Govee Indoor Air Service initialized successfully');
  } catch (error) {
    console.error('Failed to initialize Govee Indoor Air Service:', error.message);
  }
})();

// Initialize RainMachine irrigation integration
(async () => {
  try {
    await rainMachineService.initialize();
    console.log('RainMachine Service initialized successfully');
  } catch (error) {
    console.error('Failed to initialize RainMachine Service:', error.message);
  }
})();

// Initialize Sense energy integration
(async () => {
  try {
    await senseService.initialize();
    console.log('Sense Service initialized successfully');
  } catch (error) {
    console.error('Failed to initialize Sense Service:', error.message);
  }
})();

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
    deviceRestartService.stop();
  } catch (error) {
    console.error('Error stopping device restart scheduler:', error.message);
  }

  try {
    smbBackupSchedulerService.stop();
  } catch (error) {
    console.error('Error stopping SMB backup scheduler:', error.message);
  }

  try {
    await platformUpdateMonitorService.stop({ disconnectInsteon: true });
  } catch (error) {
    console.error('Error stopping platform update monitor service:', error.message);
  }

  try {
    await directRadioService.shutdown();
  } catch (error) {
    console.error('Error stopping direct radio service:', error.message);
  }

  try {
    await matterService.shutdown();
  } catch (error) {
    console.error('Error stopping Matter service:', error.message);
  }

  try {
    deviceLibraryUpdateService.stop();
  } catch (error) {
    console.error('Error stopping device library update service:', error.message);
  }

  console.log('Preserving running automation executions for resume after restart');

  try {
    await whisperService.stopService();
    } catch (error) {
      console.error('Error stopping Whisper service:', error.message);
    }

    try {
      await alexaBrokerService.stopService({
        preserveResumeAfterHostRestart: true,
        manual: false,
        actor: 'system:shutdown',
        source: 'server_shutdown',
        reason: 'HomeBrain is shutting down'
      });
    } catch (error) {
      console.error('Error stopping Alexa broker service:', error.message);
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

    try {
      await tempestService.shutdown();
    } catch (error) {
      console.error('Error stopping Tempest service:', error.message);
    }

    try {
      await goveeAirQualityService.shutdown();
    } catch (error) {
      console.error('Error stopping Govee Indoor Air service:', error.message);
    }

    try {
      await rainMachineService.shutdown();
    } catch (error) {
      console.error('Error stopping RainMachine service:', error.message);
    }

    try {
      await senseService.shutdown();
    } catch (error) {
      console.error('Error stopping Sense service:', error.message);
    }

    try {
      telemetryService.shutdown();
    } catch (error) {
      console.error('Error stopping telemetry listeners:', error.message);
    }

    try {
      await shutdownCodexCliService();
    } catch (error) {
      console.error('Error stopping Codex CLI sessions:', error.message);
    }

  await closeServer(httpServer, 'HTTP server');

  process.exit(0);
}

// Graceful shutdown
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start HTTP server
httpServer.listen(port, bindHost, async () => {
  console.log(`HTTP server running at http://${bindHost}:${port}`);
  console.log(`WebSocket server ready for voice devices`);
  console.log('Public 80/443 ingress is expected to be handled by Caddy');

  try {
    const runtime = await platformDeployService.ensureRuntimeSnapshot();
    console.log(
      `Platform deploy runtime snapshot captured: commit=${runtime.loadedShortCommit || 'unknown'} pid=${runtime.pid}`
    );

    const restartFinalization = await platformDeployService.finalizePendingRestart();
    if (restartFinalization?.finalized) {
      console.log(
        `Platform deploy restart handoff finalized: success=${restartFinalization.success ? 'yes' : 'no'} `
        + `jobId=${restartFinalization.pendingRestart?.jobId || 'none'}`
      );
    }
  } catch (error) {
    console.warn(`Platform deploy startup sync failed: ${error.message}`);
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

  if (envFlagEnabled(process.env.AXIOM_STARTUP_SYNC, true)) {
    const axiomSyncTimer = setTimeout(() => {
      axiomIngressSyncService.sync({
        actor: 'system:server-startup',
        reason: 'server-startup'
      })
        .then((result) => {
          console.log(
            `Axiom ingress startup sync completed: hosts=${result.manifest.mailHosts.join(',') || 'none'} `
            + `routesCreated=${result.routes.created.join(',') || 'none'} `
            + `routesUpdated=${result.routes.updated.join(',') || 'none'} `
            + `routesDeleted=${result.routes.deleted.join(',') || 'none'}`
          );
        })
        .catch((error) => {
          console.warn(`Axiom ingress startup sync failed: ${error.message}`);
        });
    }, AXIOM_STARTUP_SYNC_DELAY_MS);

    if (typeof axiomSyncTimer?.unref === 'function') {
      axiomSyncTimer.unref();
    }
  }
});
