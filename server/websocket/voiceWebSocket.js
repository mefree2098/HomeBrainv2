const WebSocket = require('ws');
const VoiceDevice = require('../models/VoiceDevice');
const VoiceCommand = require('../models/VoiceCommand');

class VoiceWebSocketServer {
  constructor() {
    this.wss = null;
    this.deviceConnections = new Map(); // deviceId -> WebSocket connection
    this.heartbeatInterval = 30000; // 30 seconds
    this.heartbeatTimer = null;
  }

  initialize(server) {
    console.log('Initializing Voice WebSocket Server');

    this.wss = new WebSocket.Server({
      server,
      path: '/ws/voice-device',
      verifyClient: (info) => {
        // Extract device ID from URL path
        const url = new URL(info.req.url, `http://${info.req.headers.host}`);
        const deviceId = url.pathname.split('/').pop();

        if (!deviceId || deviceId.length !== 24) {
          console.warn('WebSocket connection rejected: Invalid device ID');
          return false;
        }

        return true;
      }
    });

    this.wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });

    // Start heartbeat monitoring
    this.startHeartbeat();

    console.log('Voice WebSocket Server initialized successfully');
  }

  async handleConnection(ws, req) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const deviceId = url.pathname.split('/').pop();

    console.log(`Voice device WebSocket connection established: ${deviceId}`);

    try {
      // Verify device exists in database
      const device = await VoiceDevice.findById(deviceId);
      if (!device) {
        console.warn(`WebSocket connection rejected: Device not found ${deviceId}`);
        ws.close(1008, 'Device not found');
        return;
      }

      // Store connection
      this.deviceConnections.set(deviceId, {
        ws: ws,
        device: device,
        lastPing: Date.now(),
        authenticated: false
      });

      // Update device status to online
      await VoiceDevice.findByIdAndUpdate(deviceId, {
        status: 'online',
        lastSeen: new Date(),
        ipAddress: req.connection.remoteAddress
      });

      // Set up WebSocket event handlers
      ws.on('message', (message) => {
        this.handleMessage(deviceId, message);
      });

      ws.on('close', (code, reason) => {
        this.handleDisconnection(deviceId, code, reason);
      });

      ws.on('error', (error) => {
        console.error(`WebSocket error for device ${deviceId}:`, error);
        this.handleDisconnection(deviceId, 1006, 'Connection error');
      });

      ws.on('pong', () => {
        const connection = this.deviceConnections.get(deviceId);
        if (connection) {
          connection.lastPing = Date.now();
        }
      });

      // Send welcome message
      this.sendMessage(deviceId, {
        type: 'welcome',
        deviceId: deviceId,
        timestamp: new Date().toISOString()
      });

      console.log(`Voice device ${device.name} connected successfully`);

    } catch (error) {
      console.error(`Error handling WebSocket connection for ${deviceId}:`, error);
      ws.close(1011, 'Server error');
    }
  }

  async handleMessage(deviceId, rawMessage) {
    try {
      const message = JSON.parse(rawMessage.toString());
      const connection = this.deviceConnections.get(deviceId);

      if (!connection) {
        console.warn(`Received message from unconnected device: ${deviceId}`);
        return;
      }

      console.log(`WebSocket message from ${deviceId}:`, message.type);

      switch (message.type) {
        case 'authenticate':
          await this.handleAuthentication(deviceId, message);
          break;

        case 'heartbeat':
          await this.handleHeartbeat(deviceId, message);
          break;

        case 'wake_word_detected':
          await this.handleWakeWordDetection(deviceId, message);
          break;

        case 'voice_command':
          await this.handleVoiceCommand(deviceId, message);
          break;

        case 'audio_data':
          await this.handleAudioData(deviceId, message);
          break;

        case 'status_update':
          await this.handleStatusUpdate(deviceId, message);
          break;

        case 'error':
          await this.handleDeviceError(deviceId, message);
          break;

        default:
          console.warn(`Unknown message type from device ${deviceId}: ${message.type}`);
      }

    } catch (error) {
      console.error(`Error processing message from device ${deviceId}:`, error);
      this.sendMessage(deviceId, {
        type: 'error',
        message: 'Failed to process message'
      });
    }
  }

  async handleAuthentication(deviceId, message) {
    const connection = this.deviceConnections.get(deviceId);
    if (!connection) return;

    const { registrationCode } = message;

    try {
      const device = await VoiceDevice.findById(deviceId);
      if (!device) {
        this.sendMessage(deviceId, {
          type: 'auth_failed',
          message: 'Device not found'
        });
        return;
      }

      if (device.settings.registrationCode !== registrationCode) {
        console.warn(`Authentication failed for device ${deviceId}: Invalid registration code`);
        this.sendMessage(deviceId, {
          type: 'auth_failed',
          message: 'Invalid registration code'
        });
        return;
      }

      // Mark as authenticated
      connection.authenticated = true;

      this.sendMessage(deviceId, {
        type: 'auth_success',
        config: {
          wakeWords: device.supportedWakeWords,
          volume: device.volume,
          microphoneSensitivity: device.microphoneSensitivity,
          settings: {
            audioSampleRate: 16000,
            audioChannels: 1,
            wakeWordThreshold: 0.5
          }
        }
      });

      console.log(`Device ${device.name} authenticated successfully`);

    } catch (error) {
      console.error(`Authentication error for device ${deviceId}:`, error);
      this.sendMessage(deviceId, {
        type: 'auth_failed',
        message: 'Authentication error'
      });
    }
  }

  async handleHeartbeat(deviceId, message) {
    const { status, batteryLevel, uptime } = message;

    try {
      await VoiceDevice.findByIdAndUpdate(deviceId, {
        lastSeen: new Date(),
        ...(status && { status }),
        ...(typeof batteryLevel === 'number' && { batteryLevel }),
        ...(typeof uptime === 'number' && { uptime })
      });

      this.sendMessage(deviceId, {
        type: 'heartbeat_ack',
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error(`Heartbeat error for device ${deviceId}:`, error);
    }
  }

  async handleWakeWordDetection(deviceId, message) {
    const connection = this.deviceConnections.get(deviceId);
    if (!connection || !connection.authenticated) return;

    const { wakeWord, confidence, timestamp } = message;

    console.log(`Wake word detected by ${connection.device.name}: ${wakeWord} (confidence: ${confidence})`);

    try {
      // Log wake word detection
      const voiceCommand = new VoiceCommand({
        deviceId: deviceId,
        originalText: `[WAKE_WORD] ${wakeWord}`,
        intent: 'wake_word_detection',
        confidence: confidence,
        timestamp: timestamp ? new Date(timestamp) : new Date(),
        status: 'processed'
      });

      await voiceCommand.save();

      // Send acknowledgment and prepare for voice command
      this.sendMessage(deviceId, {
        type: 'wake_word_ack',
        message: 'Ready for voice command',
        timeout: 5000 // 5 seconds to speak command
      });

      // Update device last interaction
      await VoiceDevice.findByIdAndUpdate(deviceId, {
        lastInteraction: new Date()
      });

    } catch (error) {
      console.error(`Wake word handling error for device ${deviceId}:`, error);
    }
  }

  async handleVoiceCommand(deviceId, message) {
    const connection = this.deviceConnections.get(deviceId);
    if (!connection || !connection.authenticated) return;

    const { command, confidence, timestamp } = message;

    console.log(`Voice command received from ${connection.device.name}: ${command}`);

    try {
      // Save voice command to database
      const voiceCommand = new VoiceCommand({
        deviceId: deviceId,
        originalText: command,
        processedText: command,
        wakeWord: 'anna', // Default wake word
        sourceRoom: connection.device.room,
        intent: {
          action: 'unknown',
          confidence: confidence || 0.5,
          entities: {}
        },
        execution: {
          status: 'pending'
        },
        llmProcessing: {
          provider: 'local',
          model: 'unknown'
        }
      });

      await voiceCommand.save();

      // Acknowledge command receipt
      this.sendMessage(deviceId, {
        type: 'command_processing',
        commandId: voiceCommand._id,
        message: 'Processing your command...'
      });

      // Check if this is an automation creation request
      const automationKeywords = ['automation', 'automate', 'when', 'every', 'if', 'create rule'];
      const isAutomationRequest = automationKeywords.some(keyword =>
        command.toLowerCase().includes(keyword)
      );

      if (isAutomationRequest) {
        console.log(`Voice command identified as automation request: ${command}`);

        // Import automation service (do it here to avoid circular dependency)
        const automationService = require('../services/automationService');

        try {
          // Create automation from voice command with room context
          const result = await automationService.createAutomationFromText(
            command,
            connection.device.room
          );

          // Update voice command with success
          voiceCommand.intent.action = 'automation_create';
          voiceCommand.execution.status = 'success';
          voiceCommand.execution.completedAt = new Date();
          voiceCommand.response = {
            text: `Automation "${result.automation.name}" created successfully!`,
            responseTime: Date.now() - voiceCommand.createdAt.getTime()
          };
          await voiceCommand.save();

          // Send success response
          this.sendMessage(deviceId, {
            type: 'tts_response',
            commandId: voiceCommand._id,
            text: `Automation "${result.automation.name}" created successfully!`,
            voice: 'default'
          });

        } catch (automationError) {
          console.error(`Failed to create automation from voice command:`, automationError);

          // Update voice command with failure
          voiceCommand.execution.status = 'failed';
          voiceCommand.execution.completedAt = new Date();
          voiceCommand.execution.errorMessage = automationError.message;
          await voiceCommand.save();

          // Send error response
          this.sendMessage(deviceId, {
            type: 'tts_response',
            commandId: voiceCommand._id,
            text: `Sorry, I couldn't create that automation. ${automationError.message}`,
            voice: 'default'
          });
        }
      } else {
        // Regular command processing (non-automation)
        // Here you would integrate with your LLM service for other commands
        voiceCommand.execution.status = 'success';
        voiceCommand.execution.completedAt = new Date();
        voiceCommand.response = {
          text: `Command "${command}" received and processed.`,
          responseTime: Date.now() - voiceCommand.createdAt.getTime()
        };
        await voiceCommand.save();

        this.sendMessage(deviceId, {
          type: 'tts_response',
          commandId: voiceCommand._id,
          text: `Command "${command}" received and processed.`,
          voice: 'default'
        });
      }

    } catch (error) {
      console.error(`Voice command handling error for device ${deviceId}:`, error);
      console.error('Full error:', error.stack);
      this.sendMessage(deviceId, {
        type: 'command_error',
        message: 'Failed to process voice command'
      });
    }
  }

  async handleAudioData(deviceId, message) {
    const connection = this.deviceConnections.get(deviceId);
    if (!connection || !connection.authenticated) return;

    const { audioData, sampleRate, channels, format } = message;

    console.log(`Audio data received from ${connection.device.name}: ${audioData.length} bytes`);

    // Here you would process the audio data (speech-to-text, etc.)
    // For now, just acknowledge receipt
    this.sendMessage(deviceId, {
      type: 'audio_received',
      bytesReceived: audioData.length
    });
  }

  async handleStatusUpdate(deviceId, message) {
    const { status, settings } = message;

    try {
      const updateData = { lastSeen: new Date() };
      if (status) updateData.status = status;
      if (settings) updateData.settings = { ...updateData.settings, ...settings };

      await VoiceDevice.findByIdAndUpdate(deviceId, updateData);

      console.log(`Status updated for device ${deviceId}: ${status}`);

    } catch (error) {
      console.error(`Status update error for device ${deviceId}:`, error);
    }
  }

  async handleDeviceError(deviceId, message) {
    const connection = this.deviceConnections.get(deviceId);
    if (!connection) return;

    const { error, details } = message;

    console.error(`Device error reported by ${connection.device.name}: ${error}`, details);

    try {
      // Update device status to error
      await VoiceDevice.findByIdAndUpdate(deviceId, {
        status: 'error',
        lastSeen: new Date()
      });

    } catch (dbError) {
      console.error(`Failed to update device error status for ${deviceId}:`, dbError);
    }
  }

  async handleDisconnection(deviceId, code, reason) {
    console.log(`Voice device ${deviceId} disconnected: ${code} - ${reason}`);

    try {
      // Update device status to offline
      await VoiceDevice.findByIdAndUpdate(deviceId, {
        status: 'offline',
        lastSeen: new Date()
      });

      // Remove from active connections
      this.deviceConnections.delete(deviceId);

    } catch (error) {
      console.error(`Error handling disconnection for device ${deviceId}:`, error);
    }
  }

  sendMessage(deviceId, message) {
    const connection = this.deviceConnections.get(deviceId);
    if (!connection || connection.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      connection.ws.send(JSON.stringify(message));
      return true;
    } catch (error) {
      console.error(`Error sending message to device ${deviceId}:`, error);
      return false;
    }
  }

  broadcastToRoom(room, message) {
    let sentCount = 0;
    for (const [deviceId, connection] of this.deviceConnections) {
      if (connection.device.room === room) {
        if (this.sendMessage(deviceId, message)) {
          sentCount++;
        }
      }
    }
    return sentCount;
  }

  startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();

      for (const [deviceId, connection] of this.deviceConnections) {
        // Check if device hasn't responded to ping in over 1 minute
        if (now - connection.lastPing > 60000) {
          console.warn(`Device ${deviceId} heartbeat timeout, closing connection`);
          connection.ws.close(1001, 'Heartbeat timeout');
          continue;
        }

        // Send ping to check connection
        if (connection.ws.readyState === WebSocket.OPEN) {
          connection.ws.ping();
        }
      }
    }, this.heartbeatInterval);

    console.log('WebSocket heartbeat monitoring started');
  }

  stop() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.wss) {
      this.wss.close();
      console.log('Voice WebSocket Server stopped');
    }
  }

  getStats() {
    return {
      connectedDevices: this.deviceConnections.size,
      connections: Array.from(this.deviceConnections.entries()).map(([deviceId, connection]) => ({
        deviceId,
        deviceName: connection.device.name,
        room: connection.device.room,
        authenticated: connection.authenticated,
        lastPing: new Date(connection.lastPing).toISOString()
      }))
    };
  }
}

module.exports = VoiceWebSocketServer;