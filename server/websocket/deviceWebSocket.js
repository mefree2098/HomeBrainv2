const WebSocket = require('ws');
const { URL } = require('url');
const deviceUpdateEmitter = require('../services/deviceUpdateEmitter');
const auth = require('../routes/middlewares/auth');

const MAX_INBOUND_PAYLOAD_BYTES = 16 * 1024;
const MAX_BUFFERED_BYTES = 1024 * 1024;

class DeviceWebSocket {
  constructor() {
    this.wss = null;
    this.deviceUpdateListener = null;
    this.heartbeatInterval = null;
    this.upgradeHandlers = [];
  }

  ensureServer() {
    if (this.wss) {
      return;
    }

    this.wss = new WebSocket.Server({ noServer: true, maxPayload: MAX_INBOUND_PAYLOAD_BYTES });
    const currentServer = this.wss;

    this.wss.on('connection', async (socket, request) => {
      socket.authenticated = false;
      socket.isAlive = true;
      // Install transport handlers before async authentication. Otherwise an
      // invalid/oversized frame during verification can emit an unhandled error.
      socket.on('error', (error) => {
        console.warn('DeviceWebSocket: client error', error.message);
      });
      socket.on('pong', () => { socket.isAlive = true; });
      try {
        const token = auth.extractToken(request);
        const user = await auth.verifyAccessToken(token, undefined, request);
        if (socket.readyState !== WebSocket.OPEN || this.wss !== currentServer) return;
        if (user?.isReviewSandbox === true) {
          socket.close(4403, 'Review sandbox uses an isolated device stream');
          return;
        }
        socket.user = user;
        socket.authenticated = true;
      } catch (error) {
        console.warn('DeviceWebSocket: authentication failed:', error.message);
        socket.close(4401, 'Unauthorized');
        return;
      }

      console.log('DeviceWebSocket: client connected');
      socket.on('message', (message, isBinary) => {
        // ws delivers text frames as Buffers, not just JavaScript strings.
        if (!isBinary && message.toString().includes('ping')) {
          this.send(socket, JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        }
      });

      socket.on('close', () => {
        console.log('DeviceWebSocket: client disconnected');
      });

      this.send(socket, JSON.stringify({
        type: 'status',
        message: 'connected',
        timestamp: new Date().toISOString()
      }));
    });

    this.wss.on('close', () => {
      if (this.wss === currentServer) this.stopHeartbeat();
    });

    this.startHeartbeat();

    if (!this.deviceUpdateListener) {
      this.deviceUpdateListener = (payload) => {
        this.broadcast({
          type: 'devices:update',
          devices: payload,
          timestamp: new Date().toISOString()
        });
      };
      deviceUpdateEmitter.on('devices:update', this.deviceUpdateListener);
    }
  }

  startHeartbeat() {
    if (this.heartbeatInterval || !this.wss) {
      return;
    }

    this.heartbeatInterval = setInterval(() => {
      if (!this.wss) {
        return;
      }

      this.wss.clients.forEach((socket) => {
        if (socket.isAlive === false) {
          socket.terminate();
          return;
        }
        socket.isAlive = false;
        try {
          socket.ping();
        } catch (error) {
          socket.terminate();
        }
      });
    }, 30000);
    this.heartbeatInterval.unref?.();
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  initialize(server) {
    if (!server || typeof server.on !== 'function') {
      throw new Error('DeviceWebSocket.initialize requires a valid HTTP/S server');
    }

    if (this.upgradeHandlers.some((entry) => entry.server === server)) return;
    this.ensureServer();

    const upgradeHandler = (request, socket, head) => {
      let pathname;
      try {
        const base = request.headers?.host
          ? `http://${request.headers.host}`
          : 'http://localhost';
        pathname = new URL(request.url, base).pathname;
      } catch (error) {
        socket.destroy();
        return;
      }

      if (pathname !== '/ws/devices') {
        return;
      }

      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit('connection', ws, request);
      });
    };

    server.on('upgrade', upgradeHandler);
    this.upgradeHandlers.push({ server, upgradeHandler });
  }

  broadcast(payload) {
    if (!this.wss) {
      return;
    }
    const message = JSON.stringify(payload);

    this.wss.clients.forEach((client) => {
      if (
        client.readyState === WebSocket.OPEN
        && client.authenticated === true
        && client.user?.isReviewSandbox !== true
      ) {
        this.send(client, message);
      }
    });
  }

  send(socket, message) {
    if (socket.readyState !== WebSocket.OPEN) return;
    // Disconnect a slow consumer instead of growing its outbound queue forever.
    // A single large snapshot remains valid; subsequent queued sends are bounded.
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      socket.terminate();
      return;
    }
    try {
      socket.send(message);
    } catch (error) {
      console.warn('DeviceWebSocket: failed to send update', error.message);
      socket.terminate();
    }
  }

  stop() {
    this.stopHeartbeat();
    if (this.deviceUpdateListener) {
      deviceUpdateEmitter.removeListener('devices:update', this.deviceUpdateListener);
      this.deviceUpdateListener = null;
    }

    if (this.upgradeHandlers.length > 0) {
      this.upgradeHandlers.forEach(({ server, upgradeHandler }) => {
        if (typeof server.off === 'function') {
          server.off('upgrade', upgradeHandler);
        } else {
          server.removeListener('upgrade', upgradeHandler);
        }
      });
      this.upgradeHandlers = [];
    }

    if (!this.wss) {
      return;
    }

    this.wss.clients.forEach((socket) => {
      try {
        socket.close(1001, 'HomeBrain is shutting down');
      } catch (_error) {
        socket.terminate();
      }
      setTimeout(() => {
        if (socket.readyState !== WebSocket.CLOSED) {
          socket.terminate();
        }
      }, 1000).unref?.();
    });

    this.wss.close();
    this.wss = null;
    console.log('DeviceWebSocket: server stopped');
  }
}

module.exports = new DeviceWebSocket();
