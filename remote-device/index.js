#!/usr/bin/env node

const WebSocket = require('ws');
const recorder = require('node-record-lpcm16');
const Speaker = require('speaker');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const yargs = require('yargs');
const { hideBin } = require('yargs/helpers');
const dgram = require('dgram');
const os = require('os');

// Parse command line arguments
const argv = yargs(hideBin(process.argv))
  .option('register', {
    alias: 'r',
    type: 'string',
    description: 'Registration code for device setup'
  })
  .option('config', {
    alias: 'c',
    type: 'string',
    default: './config.json',
    description: 'Path to configuration file'
  })
  .option('hub', {
    alias: 'h',
    type: 'string',
    description: 'Hub URL (e.g., http://localhost:3000)'
  })
  .option('verbose', {
    alias: 'v',
    type: 'boolean',
    default: false,
    description: 'Enable verbose logging'
  })
  .option('auto-discover', {
    alias: 'a',
    type: 'boolean',
    default: false,
    description: 'Enable automatic hub discovery'
  })
  .option('device-name', {
    alias: 'n',
    type: 'string',
    description: 'Device name for auto-discovery (e.g., "Kitchen Speaker")'
  })
  .help()
  .alias('help', 'h')
  .argv;

class HomeBrainRemoteDevice {
  constructor(config) {
    this.config = config;
    this.ws = null;
    this.isConnected = false;
    this.isAuthenticated = false;
    this.isRecording = false;
    this.isListening = false;
    this.deviceId = null;
    this.heartbeatInterval = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.speaker = null;
    this.recordingStream = null;

    // Wake word detection (simplified for demo)
    this.wakeWords = ['anna', 'henry', 'home brain', 'homebrain'];
    this.isWakeWordListening = true;

    // Auto-discovery
    this.discoveryPort = 12345;
    this.discoverySocket = null;
    this.discoveredHubs = new Map();
    this.isScanning = false;

    // Status tracking
    this.startTime = Date.now();
    this.lastInteraction = null;
    this.stats = {
      wakeWordsDetected: 0,
      commandsProcessed: 0,
      errors: 0,
      uptime: 0
    };

    console.log(`HomeBrain Remote Device v${require('./package.json').version}`);
    if (argv.verbose) {
      console.log('Configuration:', JSON.stringify(this.config, null, 2));
    }
  }

  async initialize() {
    console.log('Initializing HomeBrain Remote Device...');

    try {
      // Initialize audio components
      await this.initializeAudio();

      // Auto-discovery mode
      if (argv['auto-discover']) {
        console.log('Starting auto-discovery mode...');
        await this.startAutoDiscovery();
        return; // Exit early, will continue after discovery
      }

      // If registration code provided, register device
      if (argv.register) {
        await this.registerDevice(argv.register);
      }

      // Load device configuration
      await this.loadDeviceConfig();

      // Connect to hub
      await this.connectToHub();

      // Start wake word detection
      this.startWakeWordDetection();

      // Start heartbeat
      this.startHeartbeat();

      console.log('HomeBrain Remote Device initialized successfully');
      console.log(`Device listening for wake words: ${this.wakeWords.join(', ')}`);

    } catch (error) {
      console.error('Failed to initialize remote device:', error.message);
      process.exit(1);
    }
  }

  async initializeAudio() {
    console.log('Initializing audio system...');

    try {
      // Initialize speaker for TTS playback
      this.speaker = new Speaker({
        channels: this.config.audio?.channels || 1,
        bitDepth: 16,
        sampleRate: this.config.audio?.sampleRate || 16000,
        device: this.config.audio?.playbackDevice || 'default'
      });

      console.log('Audio system initialized successfully');
    } catch (error) {
      console.warn('Audio initialization warning:', error.message);
      console.log('Continuing without audio playback...');
    }
  }

  async registerDevice(registrationCode) {
    console.log(`Registering device with code: ${registrationCode}`);

    const hubUrl = argv.hub || this.config.hubUrl || 'http://localhost:3000';

    try {
      // Get network information
      const networkInfo = await this.getNetworkInfo();

      const response = await fetch(`${hubUrl}/api/remote-devices/activate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          registrationCode: registrationCode,
          ipAddress: networkInfo.ipAddress,
          firmwareVersion: require('./package.json').version
        })
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.message || 'Registration failed');
      }

      // Save device configuration
      this.deviceId = data.device._id;
      this.config.deviceId = this.deviceId;
      this.config.hubUrl = hubUrl;
      this.config.hubWsUrl = data.hubUrl;

      await this.saveConfig();

      console.log(`Device registered successfully: ${data.device.name} (${this.deviceId})`);
      console.log(`Hub WebSocket URL: ${data.hubUrl}`);

    } catch (error) {
      console.error('Device registration failed:', error.message);
      throw error;
    }
  }

  async loadDeviceConfig() {
    if (!this.deviceId && this.config.deviceId) {
      this.deviceId = this.config.deviceId;
    }

    if (!this.deviceId) {
      throw new Error('Device not registered. Use --register <CODE> to register device.');
    }

    console.log(`Device ID: ${this.deviceId}`);
  }

  async connectToHub() {
    const wsUrl = this.config.hubWsUrl || `ws://localhost:3000/ws/voice-device/${this.deviceId}`;

    console.log(`Connecting to hub: ${wsUrl}`);

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        console.log('Connected to HomeBrain hub');
        this.isConnected = true;
        this.reconnectAttempts = 0;

        // Authenticate with hub
        this.authenticate();
        resolve();
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data);
      });

      this.ws.on('close', (code, reason) => {
        console.log(`Connection closed: ${code} - ${reason}`);
        this.isConnected = false;
        this.isAuthenticated = false;
        this.scheduleReconnect();
      });

      this.ws.on('error', (error) => {
        console.error('WebSocket error:', error.message);
        this.stats.errors++;

        if (!this.isConnected) {
          reject(error);
        }
      });

      setTimeout(() => {
        if (!this.isConnected) {
          reject(new Error('Connection timeout'));
        }
      }, 10000);
    });
  }

  authenticate() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    console.log('Authenticating with hub...');

    this.sendMessage({
      type: 'authenticate',
      registrationCode: this.config.registrationCode || 'auto',
      deviceInfo: {
        version: require('./package.json').version,
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version
      }
    });
  }

  handleMessage(rawData) {
    try {
      const message = JSON.parse(rawData.toString());

      if (argv.verbose) {
        console.log('Received message:', message.type);
      }

      switch (message.type) {
        case 'welcome':
          console.log('Received welcome from hub');
          break;

        case 'auth_success':
          console.log('Authentication successful');
          this.isAuthenticated = true;
          if (message.config) {
            this.updateConfig(message.config);
          }
          break;

        case 'auth_failed':
          console.error('Authentication failed:', message.message);
          process.exit(1);
          break;

        case 'wake_word_ack':
          console.log('Wake word acknowledged, listening for command...');
          this.startVoiceRecording();

          // Set timeout for voice command
          setTimeout(() => {
            if (this.isRecording) {
              this.stopVoiceRecording();
            }
          }, message.timeout || 5000);
          break;

        case 'command_processing':
          console.log('Command is being processed...');
          break;

        case 'tts_response':
          console.log('Playing TTS response:', message.text);
          this.playTTSResponse(message.text, message.voice);
          break;

        case 'command_error':
          console.error('Command processing error:', message.message);
          break;

        case 'heartbeat_ack':
          // Heartbeat acknowledged
          break;

        case 'error':
          console.error('Hub error:', message.message);
          this.stats.errors++;
          break;

        default:
          console.warn('Unknown message type:', message.type);
      }

    } catch (error) {
      console.error('Error processing message:', error.message);
      this.stats.errors++;
    }
  }

  sendMessage(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        ...message,
        timestamp: new Date().toISOString()
      }));
      return true;
    }
    return false;
  }

  updateConfig(config) {
    if (config.wakeWords) {
      this.wakeWords = config.wakeWords.map(w => w.toLowerCase());
      console.log(`Updated wake words: ${this.wakeWords.join(', ')}`);
    }

    if (config.volume !== undefined) {
      console.log(`Volume set to: ${config.volume}%`);
    }

    if (config.microphoneSensitivity !== undefined) {
      console.log(`Microphone sensitivity set to: ${config.microphoneSensitivity}%`);
    }
  }

  startWakeWordDetection() {
    console.log('Starting wake word detection...');

    // Simple wake word detection using speech recognition
    // In production, you would use Porcupine or similar
    this.isWakeWordListening = true;

    try {
      this.recordingStream = recorder.record({
        sampleRateHertz: this.config.audio?.sampleRate || 16000,
        threshold: 0.5,
        verbose: false,
        recordProgram: 'arecord',
        device: this.config.audio?.recordingDevice || 'default'
      });

      this.recordingStream.stream().on('data', (data) => {
        if (this.isWakeWordListening && !this.isRecording) {
          this.processAudioForWakeWord(data);
        }
      });

      console.log('Wake word detection active');

    } catch (error) {
      console.error('Failed to start wake word detection:', error.message);
      console.log('Running in test mode without audio input...');

      // Test mode - simulate wake word detection
      this.startTestMode();
    }
  }

  processAudioForWakeWord(audioData) {
    // Simplified wake word detection
    // In production, integrate with Porcupine or other wake word engines

    // For demo purposes, we'll simulate wake word detection
    if (Math.random() < 0.001) { // Very low probability for demo
      this.onWakeWordDetected('anna', 0.85);
    }
  }

  onWakeWordDetected(wakeWord, confidence) {
    if (!this.isAuthenticated) return;

    console.log(`Wake word detected: "${wakeWord}" (confidence: ${confidence})`);

    this.stats.wakeWordsDetected++;
    this.lastInteraction = new Date();

    this.sendMessage({
      type: 'wake_word_detected',
      wakeWord: wakeWord,
      confidence: confidence,
      timestamp: this.lastInteraction.toISOString()
    });

    // Brief pause to prevent multiple detections
    this.isWakeWordListening = false;
    setTimeout(() => {
      this.isWakeWordListening = true;
    }, 2000);
  }

  startVoiceRecording() {
    if (this.isRecording) return;

    console.log('Starting voice command recording...');
    this.isRecording = true;

    // In production, you would record audio and send to hub
    // For demo, we'll simulate command input
    setTimeout(() => {
      const testCommands = [
        'Turn on the living room lights',
        'Set the temperature to 72 degrees',
        'Lock all the doors',
        'What\'s the weather like?'
      ];

      const command = testCommands[Math.floor(Math.random() * testCommands.length)];
      this.onVoiceCommandRecorded(command, 0.9);
    }, 2000);
  }

  stopVoiceRecording() {
    if (!this.isRecording) return;

    console.log('Stopping voice command recording');
    this.isRecording = false;
  }

  onVoiceCommandRecorded(command, confidence) {
    console.log(`Voice command recorded: "${command}" (confidence: ${confidence})`);

    this.stats.commandsProcessed++;

    this.sendMessage({
      type: 'voice_command',
      command: command,
      confidence: confidence,
      timestamp: new Date().toISOString()
    });

    this.stopVoiceRecording();
  }

  async playTTSResponse(text, voice = 'default') {
    console.log(`Playing TTS: "${text}"`);

    // In production, you would play actual TTS audio
    // For demo, we'll just log the response
    console.log(`🔊 TTS Response: "${text}"`);
  }

  startHeartbeat() {
    console.log('Starting heartbeat...');

    this.heartbeatInterval = setInterval(() => {
      if (this.isAuthenticated) {
        this.sendHeartbeat();
      }
    }, 30000); // Every 30 seconds
  }

  sendHeartbeat() {
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);

    this.sendMessage({
      type: 'heartbeat',
      status: 'online',
      uptime: uptime,
      stats: this.stats,
      batteryLevel: this.getBatteryLevel(),
      memoryUsage: process.memoryUsage(),
      lastInteraction: this.lastInteraction?.toISOString()
    });
  }

  getBatteryLevel() {
    // For Raspberry Pi, you might check actual battery if using a HAT
    // For demo, return null (powered)
    return null;
  }

  async getNetworkInfo() {
    const os = require('os');
    const interfaces = os.networkInterfaces();

    let ipAddress = '127.0.0.1';

    // Find first non-internal IPv4 address
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          ipAddress = iface.address;
          break;
        }
      }
      if (ipAddress !== '127.0.0.1') break;
    }

    return {
      ipAddress,
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch()
    };
  }

  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnection attempts reached. Exiting...');
      process.exit(1);
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    console.log(`Reconnecting in ${delay/1000} seconds... (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      this.connectToHub().catch((error) => {
        console.error('Reconnection failed:', error.message);
      });
    }, delay);
  }

  startTestMode() {
    console.log('Starting test mode - press ENTER to simulate wake word detection');

    process.stdin.on('data', (data) => {
      const input = data.toString().trim();
      if (input === '') {
        this.onWakeWordDetected('anna', 0.95);
      } else if (input.startsWith('/')) {
        // Handle commands
        const command = input.substring(1);
        if (command === 'stats') {
          console.log('Stats:', this.stats);
        } else if (command === 'quit') {
          this.shutdown();
        }
      }
    });
  }

  async saveConfig() {
    const configPath = argv.config;
    try {
      await fs.promises.writeFile(configPath, JSON.stringify(this.config, null, 2));
      console.log(`Configuration saved to ${configPath}`);
    } catch (error) {
      console.warn('Failed to save configuration:', error.message);
    }
  }

  async startAutoDiscovery() {
    console.log('Starting automatic hub discovery...');

    try {
      // Create UDP socket for discovery
      this.discoverySocket = dgram.createSocket('udp4');

      // Set up message handler
      this.discoverySocket.on('message', (msg, rinfo) => {
        this.handleDiscoveryResponse(msg, rinfo);
      });

      this.discoverySocket.on('error', (err) => {
        console.error('Discovery socket error:', err);
        this.stopAutoDiscovery();
      });

      // Bind socket
      this.discoverySocket.bind(() => {
        this.discoverySocket.setBroadcast(true);
        console.log('Auto-discovery: UDP socket ready');

        // Start scanning for hubs
        this.scanForHubs();
      });

    } catch (error) {
      console.error('Failed to start auto-discovery:', error.message);
      throw error;
    }
  }

  scanForHubs() {
    console.log('Auto-discovery: Scanning network for HomeBrain hubs...');
    this.isScanning = true;
    this.discoveredHubs.clear();

    // Create discovery request
    const discoveryRequest = {
      type: 'homebrain_device_discovery',
      deviceId: this.generateDeviceId(),
      name: argv['device-name'] || `Remote Device ${os.hostname()}`,
      deviceType: 'speaker',
      version: require('./package.json').version,
      capabilities: ['voice_commands', 'wake_word'],
      timestamp: new Date().toISOString()
    };

    const message = JSON.stringify(discoveryRequest);

    // Get broadcast addresses
    const broadcastAddresses = this.getBroadcastAddresses();

    // Send discovery requests
    broadcastAddresses.forEach(address => {
      this.discoverySocket.send(message, 0, message.length, this.discoveryPort, address, (err) => {
        if (err && err.code !== 'ENETUNREACH') {
          console.warn(`Auto-discovery: Failed to send to ${address}:`, err.message);
        }
      });
    });

    console.log(`Auto-discovery: Sent discovery requests to ${broadcastAddresses.length} broadcast addresses`);

    // Stop scanning after timeout
    setTimeout(() => {
      this.stopScanning();
    }, 10000); // 10 seconds
  }

  handleDiscoveryResponse(msg, rinfo) {
    try {
      const response = JSON.parse(msg.toString());

      if (response.type === 'homebrain_hub_response') {
        console.log(`Auto-discovery: Found HomeBrain hub at ${rinfo.address}`);

        const hubInfo = {
          ...response,
          sourceAddress: rinfo.address,
          sourcePort: rinfo.port,
          discoveredAt: new Date()
        };

        this.discoveredHubs.set(response.hubId, hubInfo);

        // Auto-select first discovered hub
        if (this.discoveredHubs.size === 1) {
          console.log(`Auto-discovery: Auto-connecting to hub: ${response.name}`);
          this.connectToDiscoveredHub(hubInfo);
        }
      }

    } catch (error) {
      console.warn('Auto-discovery: Invalid discovery response:', error.message);
    }
  }

  async connectToDiscoveredHub(hubInfo) {
    console.log(`Auto-discovery: Connecting to hub ${hubInfo.name} at ${hubInfo.address}:${hubInfo.port}`);

    try {
      // Stop discovery
      this.stopAutoDiscovery();

      // Update configuration
      this.config.hubUrl = `http://${hubInfo.address}:${hubInfo.port}`;
      this.config.hubId = hubInfo.hubId;

      // Send connection request
      await this.requestAutoConnection(hubInfo);

    } catch (error) {
      console.error('Failed to connect to discovered hub:', error.message);

      // Resume scanning if connection fails
      console.log('Auto-discovery: Resuming hub scanning...');
      setTimeout(() => {
        this.scanForHubs();
      }, 5000);
    }
  }

  async requestAutoConnection(hubInfo) {
    // Create connection request
    const connectionRequest = {
      type: 'homebrain_device_connect',
      deviceId: this.generateDeviceId(),
      name: argv['device-name'] || `Remote Device ${os.hostname()}`,
      deviceType: 'speaker',
      macAddress: this.getMacAddress(),
      firmwareVersion: require('./package.json').version,
      capabilities: ['voice_commands', 'wake_word'],
      timestamp: new Date().toISOString()
    };

    const message = JSON.stringify(connectionRequest);

    // Send connection request
    const socket = dgram.createSocket('udp4');

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error('Connection request timeout'));
      }, 10000);

      socket.on('message', async (msg, rinfo) => {
        try {
          const response = JSON.parse(msg.toString());

          if (response.type === 'homebrain_connect_response') {
            clearTimeout(timeout);
            socket.close();

            if (response.status === 'pending_approval') {
              console.log('Auto-discovery: Connection request sent, awaiting approval...');
              console.log(`Device ID: ${response.deviceId}`);
              console.log('Please approve this device in your HomeBrain web interface.');

              // Set up periodic check for approval
              this.deviceId = response.deviceId;
              this.checkForApproval(hubInfo);
              resolve(response);
            } else {
              reject(new Error(response.message || 'Connection request failed'));
            }
          }

        } catch (error) {
          clearTimeout(timeout);
          socket.close();
          reject(error);
        }
      });

      socket.send(message, 0, message.length, this.discoveryPort, hubInfo.sourceAddress, (err) => {
        if (err) {
          clearTimeout(timeout);
          socket.close();
          reject(err);
        }
      });
    });
  }

  async checkForApproval(hubInfo) {
    console.log('Auto-discovery: Checking for device approval...');

    const checkApproval = async () => {
      try {
        // Try to connect with WebSocket to see if approved
        const wsUrl = `ws://${hubInfo.address}:${hubInfo.port}/ws/voice-device/${this.deviceId}`;

        const testWs = new WebSocket(wsUrl);

        testWs.on('open', () => {
          console.log('Auto-discovery: Device approved! Continuing with normal setup...');
          testWs.close();

          // Continue with normal initialization
          this.config.deviceId = this.deviceId;
          this.config.hubWsUrl = wsUrl;
          this.continueSetup();
        });

        testWs.on('error', () => {
          // Not approved yet, try again
          setTimeout(checkApproval, 5000);
        });

      } catch (error) {
        console.error('Error checking approval:', error.message);
        setTimeout(checkApproval, 5000);
      }
    };

    // Start checking
    setTimeout(checkApproval, 2000);
  }

  async continueSetup() {
    try {
      // Save the configuration
      await this.saveConfig();

      // Load device configuration
      await this.loadDeviceConfig();

      // Connect to hub
      await this.connectToHub();

      // Start wake word detection
      this.startWakeWordDetection();

      // Start heartbeat
      this.startHeartbeat();

      console.log('Auto-discovery: Setup completed successfully');

    } catch (error) {
      console.error('Failed to complete setup after auto-discovery:', error.message);
    }
  }

  stopScanning() {
    if (!this.isScanning) return;

    this.isScanning = false;

    if (this.discoveredHubs.size === 0) {
      console.log('Auto-discovery: No HomeBrain hubs found on the network');
      console.log('Make sure your HomeBrain hub is running and auto-discovery is enabled.');
      this.shutdown();
    } else {
      console.log(`Auto-discovery: Found ${this.discoveredHubs.size} hub(s)`);
    }
  }

  stopAutoDiscovery() {
    if (this.discoverySocket) {
      this.discoverySocket.close();
      this.discoverySocket = null;
    }
    this.isScanning = false;
    console.log('Auto-discovery: Discovery service stopped');
  }

  getBroadcastAddresses() {
    const addresses = [];
    const interfaces = os.networkInterfaces();

    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        // Skip non-IPv4 and internal addresses
        if (iface.family !== 'IPv4' || iface.internal) {
          continue;
        }

        // Calculate broadcast address
        const ip = iface.address.split('.').map(Number);
        const netmask = iface.netmask.split('.').map(Number);
        const broadcast = ip.map((octet, i) => octet | (255 - netmask[i]));

        addresses.push(broadcast.join('.'));
      }
    }

    // Always include common broadcast address
    if (!addresses.includes('255.255.255.255')) {
      addresses.push('255.255.255.255');
    }

    return addresses;
  }

  getMacAddress() {
    const interfaces = os.networkInterfaces();

    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal && iface.mac !== '00:00:00:00:00:00') {
          return iface.mac;
        }
      }
    }

    return null;
  }

  generateDeviceId() {
    return 'device-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
  }

  shutdown() {
    console.log('Shutting down HomeBrain Remote Device...');

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    if (this.recordingStream) {
      this.recordingStream.stop();
    }

    if (this.ws) {
      this.ws.close();
    }

    if (this.discoverySocket) {
      this.discoverySocket.close();
    }

    process.exit(0);
  }
}

// Load configuration
async function loadConfig() {
  const configPath = argv.config;
  let config = {
    audio: {
      sampleRate: 16000,
      channels: 1,
      recordingDevice: 'default',
      playbackDevice: 'default'
    }
  };

  try {
    if (fs.existsSync(configPath)) {
      const configData = await fs.promises.readFile(configPath, 'utf8');
      config = { ...config, ...JSON.parse(configData) };
      console.log(`Configuration loaded from ${configPath}`);
    } else {
      console.log(`Configuration file not found, using defaults`);
    }
  } catch (error) {
    console.warn(`Failed to load configuration: ${error.message}`);
  }

  return config;
}

// Main execution
async function main() {
  try {
    const config = await loadConfig();
    const device = new HomeBrainRemoteDevice(config);

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log('\nReceived SIGINT, shutting down gracefully...');
      device.shutdown();
    });

    process.on('SIGTERM', () => {
      console.log('Received SIGTERM, shutting down gracefully...');
      device.shutdown();
    });

    await device.initialize();

  } catch (error) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
}

// Start the application
if (require.main === module) {
  main();
}