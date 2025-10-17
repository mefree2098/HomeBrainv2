const WebSocket = require('ws');
const { URL } = require('url');
const deviceUpdateEmitter = require('../services/deviceUpdateEmitter');
const { verifyAccessToken } = require('../routes/middlewares/auth');

class DeviceWebSocket {
  constructor() {
    this.servers = [];
    this.boundEmitter = false;
  }

  /**
   * Initialize a WebSocket server for device updates on the provided HTTP/S server.
   * Multiple transports (HTTP/HTTPS) can register by calling initialize more than once.
   * @param {import('http').Server|import('https').Server} server
   */
  initialize(server) {
    this.registerServer(server);

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

  registerServer(server) {
    const wss = new WebSocket.Server({ server, path: '/ws/devices' });

    const heartbeat = () => {
      this.servers
        .filter((entry) => entry.wss === wss)
        .forEach((entry) => {
          entry.wss.clients.forEach((socket) => {
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
        });
    };

    const heartbeatInterval = setInterval(heartbeat, 30000);

    wss.on('connection', async (socket, request) => {
      try {
        const url = new URL(request.url, 'http://localhost');
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
        // Currently the channel is broadcast-only. Accept heartbeat messages silently.
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

    wss.on('close', () => {
      clearInterval(heartbeatInterval);
    });

    this.servers.push({ wss, heartbeatInterval });
  }

  broadcast(payload) {
    const message = JSON.stringify(payload);

    this.servers.forEach(({ wss }) => {
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          try {
            client.send(message);
          } catch (error) {
            console.warn('DeviceWebSocket: failed to send update', error.message);
          }
        }
      });
    });
  }
}

module.exports = new DeviceWebSocket();
