const dgram = require('dgram');
const os = require('os');
const { getConfiguredPublicOrigin } = require('../utils/publicOrigin');

class DiscoveryService {
  constructor() {
    this.isEnabled = false;
    this.discoveryPort = 12345; // HomeBrain discovery port
    this.broadcastInterval = null;
    this.server = null;
    this.pendingDevices = new Map(); // deviceId -> device info
    this.discoveryInterval = 5000; // Broadcast every 5 seconds

    console.log('DiscoveryService: Initialized');
  }

  start() {
    if (this.isEnabled) {
      console.warn('DiscoveryService: Already running');
      return;
    }

    console.log('DiscoveryService: Starting auto-discovery service...');

    try {
      // Create UDP server for discovery
      this.server = dgram.createSocket('udp4');

      // Handle incoming discovery requests
      this.server.on('message', (msg, rinfo) => {
        this.handleDiscoveryRequest(msg, rinfo);
      });

      this.server.on('error', (err) => {
        console.error('DiscoveryService: Server error:', err);
        this.stop();
      });

      // Bind to discovery port
      this.server.bind(this.discoveryPort, () => {
        console.log(`DiscoveryService: Listening on UDP port ${this.discoveryPort}`);
        this.server.setBroadcast(true);

        // Start broadcasting
        this.startBroadcasting();
        this.isEnabled = true;
      });

    } catch (error) {
      console.error('DiscoveryService: Failed to start:', error.message);
      throw error;
    }
  }

  stop() {
    console.log('DiscoveryService: Stopping auto-discovery service...');

    this.isEnabled = false;

    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
      this.broadcastInterval = null;
    }

    if (this.server) {
      this.server.close(() => {
        console.log('DiscoveryService: UDP server closed');
      });
      this.server = null;
    }

    // Clear pending devices
    this.pendingDevices.clear();
  }

  startBroadcasting() {
    console.log('DiscoveryService: Starting periodic broadcasts');

    this.broadcastInterval = setInterval(() => {
      this.broadcastPresence();
    }, this.discoveryInterval);

    // Send initial broadcast
    this.broadcastPresence();
  }

  broadcastPresence() {
    try {
      const publicOrigin = getConfiguredPublicOrigin();
      const advertisedPort = publicOrigin
        ? (new URL(publicOrigin).port || (new URL(publicOrigin).protocol === 'https:' ? '443' : '80'))
        : String(process.env.PORT || 3000);
      const hubInfo = {
        type: 'homebrain_hub',
        version: '1.0.0',
        hubId: this.getHubId(),
        name: 'HomeBrain Hub',
        services: {
          http: advertisedPort,
          websocket: advertisedPort
        },
        timestamp: new Date().toISOString(),
        capabilities: ['voice_commands', 'automation', 'device_control']
      };

      const message = JSON.stringify(hubInfo);
      const broadcastAddresses = this.getBroadcastAddresses();

      // Broadcast to all network interfaces
      broadcastAddresses.forEach(address => {
        this.server.send(message, 0, message.length, this.discoveryPort, address, (err) => {
          if (err && err.code !== 'ENETUNREACH') {
            console.warn(`DiscoveryService: Broadcast failed to ${address}:`, err.message);
          }
        });
      });

      console.log(`DiscoveryService: Broadcasted to ${broadcastAddresses.length} addresses`);

    } catch (error) {
      console.error('DiscoveryService: Broadcast error:', error.message);
    }
  }

  handleDiscoveryRequest(msg, rinfo) {
    try {
      const request = JSON.parse(msg.toString());
      console.log(`DiscoveryService: Received request from ${rinfo.address}:${rinfo.port}`, request);

      if (request.type === 'homebrain_device_discovery') {
        this.handleDeviceDiscovery(request, rinfo);
      } else if (request.type === 'homebrain_device_connect') {
        this.handleDeviceConnect(request, rinfo);
      }

    } catch (error) {
      console.warn('DiscoveryService: Invalid discovery message:', error.message);
    }
  }

  handleDeviceDiscovery(request, rinfo) {
    // Device is scanning for hubs
    const publicOrigin = getConfiguredPublicOrigin();
    const publicUrl = publicOrigin ? new URL(publicOrigin) : null;
    const baseUrl = publicOrigin || `http://${this.getLocalIpAddress()}:${process.env.PORT || 3000}`;
    const response = {
      type: 'homebrain_hub_response',
      hubId: this.getHubId(),
      name: 'HomeBrain Hub',
      address: publicUrl ? publicUrl.hostname : this.getLocalIpAddress(),
      port: publicUrl ? (publicUrl.port || (publicUrl.protocol === 'https:' ? '443' : '80')) : (process.env.PORT || 3000),
      baseUrl,
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      capabilities: ['voice_commands', 'automation', 'device_control']
    };

    const responseMessage = JSON.stringify(response);

    // Send direct response to the requesting device
    this.server.send(responseMessage, 0, responseMessage.length, rinfo.port, rinfo.address, (err) => {
      if (err) {
        console.error(`DiscoveryService: Failed to respond to ${rinfo.address}:`, err.message);
      } else {
        console.log(`DiscoveryService: Sent hub info to ${rinfo.address}:${rinfo.port}`);
      }
    });
  }

  handleDeviceConnect(request, rinfo) {
    // Device wants to connect automatically
    const deviceInfo = {
      id: request.deviceId || this.generateDeviceId(),
      name: request.name || `Remote Device`,
      type: request.deviceType || 'speaker',
      macAddress: request.macAddress,
      ipAddress: rinfo.address,
      firmwareVersion: request.firmwareVersion,
      capabilities: request.capabilities || [],
      timestamp: new Date(),
      status: 'pending_approval'
    };

    // Add to pending devices
    this.pendingDevices.set(deviceInfo.id, deviceInfo);

    console.log(`DiscoveryService: Device ${deviceInfo.name} (${deviceInfo.id}) requesting auto-connect`);

    // Send response with temporary connection info
    const publicOrigin = getConfiguredPublicOrigin();
    const response = {
      type: 'homebrain_connect_response',
      status: 'pending_approval',
      deviceId: deviceInfo.id,
      message: 'Device discovered. Awaiting user approval.',
      hubUrl: publicOrigin || `http://${this.getLocalIpAddress()}:${process.env.PORT || 3000}`
    };

    const responseMessage = JSON.stringify(response);
    this.server.send(responseMessage, 0, responseMessage.length, rinfo.port, rinfo.address, (err) => {
      if (err) {
        console.error(`DiscoveryService: Failed to respond to connect request:`, err.message);
      } else {
        console.log(`DiscoveryService: Sent connect response to ${deviceInfo.name}`);
      }
    });

    // Emit event for frontend notification
    this.notifyPendingDevice(deviceInfo);
  }

  notifyPendingDevice(deviceInfo) {
    // In a real implementation, you might use Socket.IO or WebSockets
    // For now, we'll store it and the frontend can poll for pending devices
    console.log(`DiscoveryService: New pending device: ${deviceInfo.name} (${deviceInfo.id})`);
  }

  getPendingDevices() {
    return Array.from(this.pendingDevices.values());
  }

  approvePendingDevice(deviceId, approvalData) {
    const pendingDevice = this.pendingDevices.get(deviceId);
    if (!pendingDevice) {
      throw new Error('Pending device not found');
    }

    // Update device info with user-provided data
    const approvedDevice = {
      ...pendingDevice,
      name: approvalData.name || pendingDevice.name,
      room: approvalData.room,
      deviceType: approvalData.deviceType || pendingDevice.type,
      status: 'approved',
      approvedAt: new Date()
    };

    // Remove from pending
    this.pendingDevices.delete(deviceId);

    console.log(`DiscoveryService: Device ${approvedDevice.name} approved for room: ${approvedDevice.room}`);

    return approvedDevice;
  }

  rejectPendingDevice(deviceId) {
    const pendingDevice = this.pendingDevices.get(deviceId);
    if (!pendingDevice) {
      throw new Error('Pending device not found');
    }

    this.pendingDevices.delete(deviceId);
    console.log(`DiscoveryService: Device ${pendingDevice.name} (${deviceId}) rejected`);

    return pendingDevice;
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

  getLocalIpAddress() {
    const interfaces = os.networkInterfaces();

    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }

    return '127.0.0.1';
  }

  getHubId() {
    // Generate or retrieve hub ID
    // In production, this should be persistent
    return process.env.HUB_ID || 'homebrain-hub-' + os.hostname();
  }

  generateDeviceId() {
    return 'device-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
  }

  isRunning() {
    return this.isEnabled;
  }

  getStats() {
    return {
      enabled: this.isEnabled,
      port: this.discoveryPort,
      pendingDevices: this.pendingDevices.size,
      broadcastInterval: this.discoveryInterval,
      hubId: this.getHubId(),
      localIp: this.getLocalIpAddress()
    };
  }
}

module.exports = DiscoveryService;
