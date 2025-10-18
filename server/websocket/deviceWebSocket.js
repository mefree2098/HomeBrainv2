const WebSocket = require('ws');
const { URL } = require('url');
const deviceUpdateEmitter = require('../services/deviceUpdateEmitter');
const { verifyAccessToken } = require('../routes/middlewares/auth');

class DeviceWebSocket {
  constructor() {
    this.wss = null;
    this.boundEmitter = false;
    this.heartbeatInterval = null;
    this.upgradeHandlers = [];
  }

  ensureServer() {
    if (this.wss) {
      return;
    }

    this.wss = new WebSocket.Server({ noServer: true });

    this.wss.on('connection', async (socket, request) => {
      try {
        const base = request.headers?.host
          ? `http://${request.headers.host}`
          : 'http://localhost';
        const url = new URL(request.url, base);
        const token = url.searchParams.get('token');
        const user = await verifyAccessToken(token);
        socket.user = user;
      } catch (error) {
        console.warn('DeviceWebSocket: authentication failed:', error.message);
        socket.close(4401, 'Unauthorized');
        return;
      }

      console.log('DeviceWebSocket: client connected');
      socket.isAlive = true;

      socket.on('pong', () => {
        socket.isAlive = true;
      });

      socket.on('message', (message) => {
        if (typeof message === 'string' && message.includes('ping')) {
          socket.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        }
      });

      socket.on('error', (error) => {
        console.warn('DeviceWebSocket: client error', error.message);
      });

      socket.on('close', () => {
        console.log('DeviceWebSocket: client disconnected');
      });

      socket.send(JSON.stringify({
        type: 'status',
        message: 'connected',
        timestamp: new Date().toISOString()
      }));
    });

    this.wss.on('close', () => {
      this.stopHeartbeat();
    });

    this.startHeartbeat();

    if (!this.boundEmitter) {
      deviceUpdateEmitter.on('devices:update', (payload) => {
        this.broadcast({
          type: 'devices:update',
          devices: payload,
          timestamp: new Date().toISOString()
        });
      });
      this.boundEmitter = true;
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
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
        } catch (error) {
          console.warn('DeviceWebSocket: failed to send update', error.message);
        }
      }
    });
  }
}

module.exports = new DeviceWebSocket();
