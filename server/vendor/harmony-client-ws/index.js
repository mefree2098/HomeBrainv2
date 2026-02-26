const http = require('http');
const { EventEmitter } = require('events');
const WebSocket = require('ws');

const HEARTBEAT_INTERVAL_MS = 55_000;
const REQUEST_TIMEOUT_MS = 10_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeHost(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  const withoutProtocol = trimmed
    .replace(/^https?:\/\//i, '')
    .replace(/^wss?:\/\//i, '');

  const [hostWithPort] = withoutProtocol.split('/');
  const bracketedIpv6 = hostWithPort.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketedIpv6) {
    return bracketedIpv6[1].trim().toLowerCase();
  }

  const colonCount = (hostWithPort.match(/:/g) || []).length;
  if (colonCount === 1) {
    const [host, port] = hostWithPort.split(':');
    if (host && /^\d+$/.test(port || '')) {
      return host.trim().toLowerCase();
    }
  }

  return hostWithPort.trim().toLowerCase();
}

function requestProvisionInfo(hubHost) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      id: 124,
      cmd: 'setup.account?getProvisionInfo',
      params: {}
    });

    const req = http.request(
      {
        host: hubHost,
        port: 8088,
        method: 'POST',
        path: '/',
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Accept-Charset': 'utf-8',
          Origin: 'http://sl.dhg.myharmony.com',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      (res) => {
        let raw = '';

        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });

        res.on('end', () => {
          if (!raw) {
            reject(new Error(`Harmony hub ${hubHost} returned an empty provisioning response`));
            return;
          }

          try {
            resolve(JSON.parse(raw));
          } catch (error) {
            reject(new Error(`Failed to parse Harmony provisioning response from ${hubHost}: ${error.message}`));
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Timed out while requesting Harmony provisioning info from ${hubHost}`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

class HarmonyClient extends EventEmitter {
  constructor() {
    super();
    this.remoteId = null;
    this.hubHost = '';
    this.wsClient = null;
    this.heartbeatTimer = null;
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
  }

  async connect(hubHost, remoteId = null) {
    const normalizedHost = normalizeHost(hubHost);
    if (!normalizedHost) {
      throw new Error('Harmony hub host is required');
    }

    this.hubHost = normalizedHost;
    if (remoteId != null && `${remoteId}`.trim() !== '') {
      this.remoteId = `${remoteId}`.trim();
    } else {
      const provisionInfo = await requestProvisionInfo(normalizedHost);
      const discoveredRemoteId = provisionInfo?.data?.remoteId || provisionInfo?.data?.activeRemoteId;
      if (!discoveredRemoteId) {
        throw new Error(`Failed to resolve Harmony remoteId for hub ${normalizedHost}`);
      }
      this.remoteId = `${discoveredRemoteId}`.trim();
    }

    await this._connectWebSocket();
    return this;
  }

  async _connectWebSocket() {
    if (!this.remoteId) {
      throw new Error('Harmony remoteId is required before opening websocket');
    }

    const wsUrl = `ws://${this.hubHost}:8088/?domain=svcs.myharmony.com&hubId=${this.remoteId}`;
    const wsClient = new WebSocket(wsUrl);

    await new Promise((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        wsClient.removeListener('open', onOpen);
        wsClient.removeListener('error', onError);
        wsClient.removeListener('close', onClose);
      };

      const onOpen = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      const onError = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const onClose = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`Harmony websocket closed before opening for hub ${this.hubHost}`));
      };

      wsClient.on('open', onOpen);
      wsClient.on('error', onError);
      wsClient.on('close', onClose);
    });

    this.wsClient = wsClient;
    this.wsClient.on('message', (raw) => this._onMessage(raw));
    this.wsClient.on('close', () => this._onClose());
    this.wsClient.on('error', (error) => this._rejectPending(error));

    this._startHeartbeat();
    this.emit(HarmonyClient.Events.CONNECTED);

    await this.sendPacked({
      hubId: this.remoteId,
      timeout: 30,
      hbus: {
        cmd: 'vnd.logitech.connect/vnd.logitech.statedigest?get',
        id: 0,
        params: {
          verb: 'get',
          format: 'json'
        }
      }
    });
  }

  _startHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    this.heartbeatTimer = setInterval(() => {
      if (!this.wsClient || this.wsClient.readyState !== WebSocket.OPEN) {
        return;
      }
      this.wsClient.send('');
    }, HEARTBEAT_INTERVAL_MS);
  }

  _clearHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  _onClose() {
    this._clearHeartbeat();
    const error = new Error(`Harmony websocket disconnected from ${this.hubHost}`);
    this._rejectPending(error);
    this.emit(HarmonyClient.Events.DISCONNECTED);
  }

  _onMessage(raw) {
    const payload = raw == null
      ? ''
      : Buffer.isBuffer(raw)
        ? raw.toString('utf8')
        : raw.toString();

    if (!payload) {
      return;
    }

    let message;
    try {
      message = JSON.parse(payload);
    } catch (_error) {
      return;
    }

    const responseId = Number(message?.id);
    if (Number.isFinite(responseId) && this.pendingRequests.has(responseId)) {
      const pending = this.pendingRequests.get(responseId);
      this.pendingRequests.delete(responseId);
      clearTimeout(pending.timeout);
      pending.resolve(message);
    }

    if (message?.type === 'connect.stateDigest?notify') {
      this.emit(HarmonyClient.Events.STATE_DIGEST, message.data);
    }
  }

  _rejectPending(error) {
    const pending = Array.from(this.pendingRequests.values());
    this.pendingRequests.clear();
    pending.forEach((entry) => {
      clearTimeout(entry.timeout);
      entry.reject(error);
    });
  }

  async sendPacked(payload) {
    if (!this.wsClient || this.wsClient.readyState !== WebSocket.OPEN) {
      throw new Error('Harmony websocket is not connected');
    }

    return new Promise((resolve, reject) => {
      this.wsClient.send(JSON.stringify(payload), (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async sendRequest(payload, timeoutMs = REQUEST_TIMEOUT_MS) {
    const requestId = this.nextRequestId++;
    const request = {
      ...payload,
      hbus: {
        ...(payload?.hbus || {}),
        id: requestId
      }
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Harmony request timed out: ${request?.hbus?.cmd || 'unknown'}`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timeout });
      this.sendPacked(request).catch((error) => {
        this.pendingRequests.delete(requestId);
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  async getCurrentActivity() {
    const response = await this.sendRequest({
      hubId: this.remoteId,
      timeout: 30,
      hbus: {
        cmd: 'vnd.logitech.harmony/vnd.logitech.harmony.engine?getCurrentActivity',
        params: {
          verb: 'get',
          format: 'json'
        }
      }
    });

    return `${response?.data?.result ?? '-1'}`;
  }

  async getAvailableCommands() {
    const response = await this.sendRequest({
      hubId: this.remoteId,
      timeout: 30,
      hbus: {
        cmd: 'vnd.logitech.harmony/vnd.logitech.harmony.engine?config',
        params: {
          verb: 'get',
          format: 'json'
        }
      }
    });

    return response?.data || {};
  }

  async startActivity(activityId) {
    return this.sendRequest({
      hubId: this.remoteId,
      timeout: 30,
      hbus: {
        cmd: 'harmony.activityengine?runactivity',
        params: {
          async: 'true',
          timestamp: 0,
          args: {
            rule: 'start'
          },
          activityId: `${activityId}`
        }
      }
    });
  }

  async turnOff() {
    return this.startActivity('-1');
  }

  async send(action, body, commandTimeframe = 0) {
    let encodedAction;
    if (typeof body === 'string') {
      encodedAction = body;
    } else if (body && body.command && body.deviceId) {
      encodedAction = JSON.stringify({
        command: body.command,
        type: body.type || body.deviceId || 'IRCommand',
        deviceId: body.deviceId
      });
    } else {
      throw new Error(
        'With the send command you need to provide a body parameter which can be a string or {command, deviceId, type?}'
      );
    }

    const payloadBase = {
      hubId: this.remoteId,
      timeout: 30,
      hbus: {
        cmd: `harmony.engine?${action}`,
        params: {
          async: 'true',
          timestamp: 0,
          status: 'press',
          verb: 'render',
          action: encodedAction
        }
      }
    };

    await this.sendPacked(payloadBase);

    if (commandTimeframe > 0) {
      await delay(commandTimeframe);
    }

    const payloadRelease = {
      ...payloadBase,
      hbus: {
        ...payloadBase.hbus,
        params: {
          ...payloadBase.hbus.params,
          timestamp: Math.max(0, Number(commandTimeframe) || 0),
          status: 'release'
        }
      }
    };

    await this.sendPacked(payloadRelease);
  }

  end() {
    this._clearHeartbeat();
    const wsClient = this.wsClient;
    this.wsClient = null;

    if (!wsClient) {
      return;
    }

    if (wsClient.readyState === WebSocket.OPEN || wsClient.readyState === WebSocket.CONNECTING) {
      wsClient.close();
    }
  }
}

HarmonyClient.Events = Object.freeze({
  STATE_DIGEST: 'stateDigest',
  CONNECTED: 'open',
  DISCONNECTED: 'close'
});

async function getHarmonyClient(hubhost, options = {}) {
  const opts = typeof options === 'number' ? { port: options } : options;
  const client = new HarmonyClient();
  await client.connect(hubhost, opts?.remoteId);
  return client;
}

module.exports = {
  HarmonyClient,
  getHarmonyClient,
  default: getHarmonyClient
};
