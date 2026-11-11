const crypto = require('node:crypto');
const net = require('node:net');

class DecoError extends Error {
  constructor(kind, message, { code = null, attemptsRemaining = null } = {}) {
    super(message);
    this.name = 'DecoError'; this.kind = kind;
    this.code = Number.isSafeInteger(code) ? code : null;
    this.attemptsRemaining = Number.isSafeInteger(attemptsRemaining) ? attemptsRemaining : null;
  }

  diagnostic() { return { kind: this.kind, code: this.code, attemptsRemaining: this.attemptsRemaining }; }
}

function routerFailure(reply, login) {
  const raw = reply?.error_code ?? reply?.errorcode;
  const code = Number.isSafeInteger(raw) ? raw : null;
  if (code === 0 || (code === null && reply?.success === true)) return null;
  const failureCount = reply?.result?.failureCount;
  const allowed = reply?.result?.attemptsAllowed;
  const attemptsRemaining = Number.isSafeInteger(failureCount) && Number.isSafeInteger(allowed)
    && failureCount >= 0 && allowed >= failureCount && allowed <= 1000 ? allowed - failureCount : null;
  const detail = code === null ? '' : ` (code ${code})`;
  if (login && [-5003, -5007].includes(code)) return new DecoError('lockout', `Deco login is temporarily locked${detail}; automatic attempts are paused`, { code, attemptsRemaining });
  if (login && code === -5002) return new DecoError('authentication', `Deco rejected the login${detail}; automatic attempts are paused`, { code, attemptsRemaining });
  return new DecoError(login ? 'protocol' : 'session', `Deco ${login ? 'login exchange' : 'read'} was rejected${detail}; this does not establish a password failure`, { code, attemptsRemaining });
}

// Protocol reference: jvreagan/deco, c81af352e8559b740f91a2f2b86c2b558fa0b899.
// See docs/licenses/deco-MIT.txt. Only login and two read operations are exposed.
function privateIp(value) {
  if (typeof value !== 'string' || !net.isIPv4(value)) return false;
  const [a, b] = value.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function normalizeHost(value) {
  const host = typeof value === 'string' ? value.trim() : '';
  if (!privateIp(host)) throw new Error('Enter the Deco’s private LAN IPv4 address');
  return host;
}

function normalizeMac(value) {
  const compact = typeof value === 'string' ? value.replace(/[:-]/g, '').toUpperCase() : '';
  return /^[0-9A-F]{12}$/.test(compact) ? compact.match(/../g).join(':') : '';
}

function publicKey(pair) {
  if (!Array.isArray(pair) || !/^[a-f0-9]{128,1024}$/i.test(pair[0]) || !/^0*10001$/i.test(pair[1])) {
    throw new DecoError('protocol', 'Deco returned unsupported login keys');
  }
  const modulus = Buffer.from(pair[0], 'hex');
  return { size: modulus.length, key: crypto.createPublicKey({
    key: { kty: 'RSA', n: modulus.toString('base64url'), e: 'AQAB' }, format: 'jwk'
  }) };
}

function rsaEncrypt(value, rsa) {
  const input = Buffer.from(value);
  const chunks = [];
  for (let offset = 0; offset < input.length; offset += rsa.size - 11) {
    chunks.push(crypto.publicEncrypt({ key: rsa.key, padding: crypto.constants.RSA_PKCS1_PADDING }, input.subarray(offset, offset + rsa.size - 11)).toString('hex'));
  }
  return chunks.join('');
}

function decodeName(value) {
  const text = typeof value === 'string' ? value.slice(0, 1024) : '';
  if (!text || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) return text;
  const decoded = Buffer.from(text, 'base64').toString('utf8');
  return decoded && !/[\u0000-\u001f\u007f\ufffd]/u.test(decoded) ? decoded : text;
}

function normalizeClients(rows) {
  if (!Array.isArray(rows) || rows.length > 4096) throw new Error('Deco returned an invalid client list');
  return rows.flatMap((row) => {
    const mac = normalizeMac(row?.mac);
    if (!mac) return [];
    return [{ mac, name: decodeName(row.name), ip: privateIp(row.ip) ? row.ip : '',
      online: typeof row.online === 'boolean' ? row.online : null,
      connection: typeof row.connection_type === 'string' ? row.connection_type.slice(0, 64) : '' }];
  });
}

class DecoClient {
  constructor(host, password, { fetchImpl = fetch } = {}) {
    this.host = normalizeHost(host);
    this.password = password;
    this.fetch = fetchImpl;
    this.stok = ''; this.cookie = ''; this.authAt = 0;
    this.lastRequestAt = -Infinity;
  }

  async post(path, body = JSON.stringify({ operation: 'read' })) {
    const delayMs = 100 - (performance.now() - this.lastRequestAt);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    this.lastRequestAt = performance.now();
    let response;
    try {
      response = await this.fetch(`http://${this.host}/cgi-bin/luci/;stok=${this.stok}/${path}`, {
        // Aggregating clients across a mesh can outlast the login exchange.
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(path === 'admin/client?form=client_list' ? 30000 : 8000), body,
        // The firmware deliberately uses a JSON content type even when the
        // encrypted envelope body is URL-encoded (Connection.request in frame.js).
        headers: { 'Content-Type': 'application/json', Referer: `http://${this.host}/webpages/index.html`, ...(this.cookie ? { Cookie: this.cookie } : {}) }
      });
    } catch (error) {
      const stages = { 'login?form=keys': 'password-key read', 'login?form=auth': 'session-key read', 'login?form=login': 'login', 'admin/client?form=client_list': 'client-list read', 'admin/device?form=device_list': 'mesh read' };
      const stage = stages[path] || 'request';
      const codes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EACCES', 'EPERM', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);
      const reason = error?.name === 'TimeoutError' ? 'timed out'
        : error?.cause?.message === 'unexpected redirect' ? 'redirect blocked'
          : codes.has(error?.cause?.code) ? error.cause.code : 'network request failed';
      throw new DecoError('transport', `Cannot reach Deco during ${stage}: ${reason}`);
    }
    if (!response.ok) throw new DecoError(this.stok ? 'session' : 'protocol', `Deco returned HTTP ${response.status}`);
    const cookie = response.headers.get('set-cookie')?.match(/(?:^|[,;]\s*)sysauth=([^;,\s]+)/)?.[1];
    if (cookie) this.cookie = `sysauth=${cookie}`;
    let bytes = 0; const parts = [];
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) throw new DecoError('protocol', 'Deco response exceeded the client-list limit');
      parts.push(Buffer.from(chunk));
    }
    try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
    catch { throw new DecoError('protocol', 'Deco returned an unsupported response'); }
  }

  async probe() {
    const reply = await this.post('login?form=auth');
    publicKey(reply.result?.key);
    if (reply.error_code !== 0 || !Number.isSafeInteger(reply.result?.seq)) throw new DecoError('protocol', 'Deco login protocol is unavailable');
    return { reachable: true, loginProtocol: 'deco-rsa-aes' };
  }

  async encrypted(path, payload, login = false) {
    const cipher = crypto.createCipheriv('aes-128-cbc', this.aesKey, this.aesIv);
    const data = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]).toString('base64');
    // Firmware requires MD5(admin + owner password) inside this RSA-encrypted
    // LAN signature. Changing it breaks authentication; it is never persisted
    // or used to verify HomeBrain passwords. At-rest credentials use AES-GCM.
    // codeql[js/insufficient-password-hash, js/weak-cryptographic-algorithm] -- Deco wire-protocol compatibility only; see docs/deco-network-integration.md.
    const hash = crypto.createHash('md5').update(`admin${this.password}`).digest('hex');
    const sign = rsaEncrypt(`${login ? `k=${this.aesKey}&i=${this.aesIv}&` : ''}h=${hash}&s=${this.seq + data.length}`, this.signKey);
    const envelope = await this.post(path, new URLSearchParams({ sign, data }).toString());
    if (typeof envelope?.data !== 'string') throw routerFailure(envelope, login)
      || new DecoError('protocol', 'Deco returned no encrypted response; this does not establish a password failure');
    let reply;
    try {
      const decipher = crypto.createDecipheriv('aes-128-cbc', this.aesKey, this.aesIv);
      reply = JSON.parse(Buffer.concat([decipher.update(envelope.data, 'base64'), decipher.final()]).toString('utf8'));
    } catch {
      this.stok = '';
      throw new DecoError('protocol', `Deco ${login ? 'login' : 'read'} response could not be decoded; this does not establish a password failure`);
    }
    const failure = routerFailure(reply, login);
    if (failure) {
      this.stok = '';
      throw failure;
    }
    return reply.result;
  }

  async login() {
    this.stok = ''; this.cookie = '';
    // Match the firmware's generateRandomIntString(16), including leading zeros.
    const digits = () => Buffer.from(Array.from({ length: 16 }, () => crypto.randomInt(10)).join(''));
    this.aesKey = digits(); this.aesIv = digits();
    const pwd = await this.post('login?form=keys');
    const auth = await this.post('login?form=auth');
    if (pwd.error_code !== 0 || auth.error_code !== 0 || !Number.isSafeInteger(auth.result?.seq)) throw new DecoError('protocol', 'Deco returned unsupported login parameters');
    this.signKey = publicKey(auth.result.key); this.seq = auth.result.seq;
    const reply = await this.encrypted('login?form=login', { operation: 'login', params: { password: rsaEncrypt(this.password, publicKey(pwd.result?.password)) } }, true);
    if (!/^[a-z0-9_-]{1,128}$/i.test(reply?.stok)) throw new DecoError('protocol', 'Deco did not establish a session');
    this.stok = reply.stok; this.authAt = Date.now();
  }

  async snapshot() {
    if (!this.stok || Date.now() - this.authAt > 240000) await this.login();
    const clients = await this.encrypted('admin/client?form=client_list', { operation: 'read', params: { device_mac: 'default' } });
    // Mesh metadata is useful but its absence must not discard a valid client list.
    let nodes = []; let metadataError = '';
    try {
      const result = await this.encrypted('admin/device?form=device_list', { operation: 'read' });
      nodes = (Array.isArray(result?.device_list) ? result.device_list.slice(0, 64) : []).map((node) => ({
        name: decodeName(node.custom_nickname) || String(node.nickname || '').slice(0, 100),
        model: String(node.device_model || '').slice(0, 100), firmware: String(node.software_ver || '').slice(0, 200),
        mac: normalizeMac(node.mac), ip: privateIp(node.device_ip) ? node.device_ip : ''
      }));
    } catch { metadataError = 'Mesh firmware details unavailable'; }
    return { clients: normalizeClients(clients?.client_list), nodes, metadataError };
  }
}

module.exports = { DecoClient, DecoError, privateIp, normalizeHost, normalizeMac, normalizeClients };
