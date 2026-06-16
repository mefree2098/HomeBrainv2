const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

function createJsonServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`
      });
    });
  });
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

test('LAN Whisper adapter posts OpenAI-compatible transcription requests', async (t) => {
  let captured = null;
  const { server, baseUrl } = await createJsonServer(async (req, res) => {
    captured = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: await readRequestBody(req)
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      text: 'turn on the living room lights',
      language: 'en',
      segments: [{ confidence: 0.91 }]
    }));
  });
  t.after(() => server.close());

  const speechService = require('../services/speechService');
  const result = await speechService.transcribeWithLanWhisper({
    audioBuffer: Buffer.alloc(16000),
    sampleRate: 16000,
    channels: 1,
    format: 'S16LE',
    language: 'en',
    model: 'large-v3',
    endpoint: baseUrl,
    apiKey: 'local-key',
    timeoutMs: 5000
  });

  assert.equal(captured.method, 'POST');
  assert.equal(captured.url, '/v1/audio/transcriptions');
  assert.equal(captured.headers.authorization, 'Bearer local-key');
  assert.match(captured.body.toString('utf8'), /name="model"/);
  assert.match(captured.body.toString('utf8'), /large-v3/);
  assert.equal(result.provider, 'lan_whisper');
  assert.equal(result.text, 'turn on the living room lights');
  assert.equal(result.confidence, 0.91);
});

test('S2 Pro adapter queries voices and generates speech through common local endpoints', async (t) => {
  const requests = [];
  const { server, baseUrl } = await createJsonServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url, body: await readRequestBody(req) });

    if (req.method === 'GET' && req.url === '/voices') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ voices: [{ id: 'avery', name: 'Avery' }] }));
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/audio/speech') {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.end(Buffer.from('mp3-bytes'));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  t.after(() => server.close());

  const ttsProviderService = require('../services/ttsProviderService');
  const voices = await ttsProviderService.listS2Voices({
    endpoint: baseUrl,
    apiKey: 's2-key',
    timeoutMs: 5000
  });
  const speech = await ttsProviderService.textToSpeechWithS2Pro('hello', 'avery', {
    endpoint: baseUrl,
    apiKey: 's2-key',
    model: 's2-pro',
    format: 'mp3',
    timeoutMs: 5000
  });

  assert.equal(voices.voices.length, 1);
  assert.deepEqual(voices.voices[0], {
    id: 'avery',
    name: 'Avery',
    provider: 's2_pro',
    previewUrl: '',
    raw: { id: 'avery', name: 'Avery' }
  });
  assert.equal(speech.provider, 's2_pro');
  assert.equal(speech.contentType, 'audio/mpeg');
  assert.equal(speech.audioBuffer.toString(), 'mp3-bytes');

  const speechRequest = requests.find((request) => request.method === 'POST');
  assert.equal(speechRequest.url, '/v1/audio/speech');
  assert.equal(JSON.parse(speechRequest.body.toString()).voice, 'avery');
});
