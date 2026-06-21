const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function loadService(cacheRoot) {
  process.env.HOMEBRAIN_ELEVENLABS_CACHE_DIR = cacheRoot;
  const servicePath = require.resolve('../services/elevenLabsService');
  delete require.cache[servicePath];
  return require('../services/elevenLabsService');
}

test('textToSpeechDetailed uses Eleven v3 tagged text and reuses cached audio', async (t) => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'homebrain-elevenlabs-cache-'));
  const service = loadService(cacheRoot);
  const axios = require('axios');
  const originalPost = axios.post;
  const originalApiKey = service._getApiKey;
  const originalTagger = service._tagTextWithCodex;
  const bodies = [];
  let taggerCalls = 0;

  service._getApiKey = async () => 'test-elevenlabs-key';
  service._tagTextWithCodex = async (text) => {
    taggerCalls += 1;
    return {
      text: `[cheerfully] ${text}`,
      tagger: {
        status: 'codex',
        provider: 'codex',
        model: 'gpt-test',
        changed: true
      }
    };
  };
  axios.post = async (_url, body) => {
    bodies.push(body);
    return { data: Buffer.from(`mp3-${bodies.length}`) };
  };

  t.after(async () => {
    axios.post = originalPost;
    service._getApiKey = originalApiKey;
    service._tagTextWithCodex = originalTagger;
    await fs.rm(cacheRoot, { recursive: true, force: true });
    delete process.env.HOMEBRAIN_ELEVENLABS_CACHE_DIR;
  });

  const first = await service.textToSpeechDetailed('The security system is armed.', 'voice-hannah');
  const second = await service.textToSpeechDetailed('The security system is armed.', 'voice-hannah');

  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(bodies.length, 1);
  assert.equal(taggerCalls, 1);
  assert.equal(bodies[0].model_id, 'eleven_v3');
  assert.equal(bodies[0].text, '[cheerfully] The security system is armed.');
  assert.equal(second.audioBuffer.toString(), first.audioBuffer.toString());
  assert.equal(second.metadata.generatedText, '[cheerfully] The security system is armed.');
});

test('textToSpeechDetailed does not call Codex when text already has inline audio tags', async (t) => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'homebrain-elevenlabs-tagged-'));
  const service = loadService(cacheRoot);
  const axios = require('axios');
  const originalPost = axios.post;
  const originalApiKey = service._getApiKey;
  const originalTagger = service._tagTextWithCodex;
  let requestBody = null;

  service._getApiKey = async () => 'test-elevenlabs-key';
  service._tagTextWithCodex = async () => {
    throw new Error('Codex should not be called for pre-tagged text');
  };
  axios.post = async (_url, body) => {
    requestBody = body;
    return { data: Buffer.from('mp3-tagged') };
  };

  t.after(async () => {
    axios.post = originalPost;
    service._getApiKey = originalApiKey;
    service._tagTextWithCodex = originalTagger;
    await fs.rm(cacheRoot, { recursive: true, force: true });
    delete process.env.HOMEBRAIN_ELEVENLABS_CACHE_DIR;
  });

  const result = await service.textToSpeechDetailed('[urgent] Please leave now.', 'voice-hannah');

  assert.equal(result.cacheHit, false);
  assert.equal(result.tagger.status, 'provided');
  assert.equal(requestBody.text, '[urgent] Please leave now.');
  assert.equal(requestBody.model_id, 'eleven_v3');
});

test('legacy model and emotion-tagging opt out keep caller voice settings intact', async (t) => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'homebrain-elevenlabs-legacy-'));
  const service = loadService(cacheRoot);
  const axios = require('axios');
  const originalPost = axios.post;
  const originalApiKey = service._getApiKey;
  const originalTagger = service._tagTextWithCodex;
  let requestBody = null;

  service._getApiKey = async () => 'test-elevenlabs-key';
  service._tagTextWithCodex = async () => {
    throw new Error('Codex should not be called when emotionTagging=false');
  };
  axios.post = async (_url, body) => {
    requestBody = body;
    return { data: Buffer.from('mp3-legacy') };
  };

  t.after(async () => {
    axios.post = originalPost;
    service._getApiKey = originalApiKey;
    service._tagTextWithCodex = originalTagger;
    await fs.rm(cacheRoot, { recursive: true, force: true });
    delete process.env.HOMEBRAIN_ELEVENLABS_CACHE_DIR;
  });

  const result = await service.textToSpeechDetailed('Plain legacy line.', 'voice-hannah', {
    model_id: 'eleven_monolingual_v1',
    emotionTagging: false,
    cache: false,
    stability: 0,
    similarity_boost: 0.25,
    style: 0
  });

  assert.equal(result.tagger.status, 'disabled');
  assert.equal(requestBody.model_id, 'eleven_monolingual_v1');
  assert.equal(requestBody.text, 'Plain legacy line.');
  assert.deepEqual(requestBody.voice_settings, {
    stability: 0,
    similarity_boost: 0.25,
    style: 0,
    use_speaker_boost: true
  });
});

test('getVoices can require a configured ElevenLabs API key', async (t) => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'homebrain-elevenlabs-voices-'));
  const service = loadService(cacheRoot);
  const originalApiKey = service._getApiKey;

  service._getApiKey = async () => '';

  t.after(async () => {
    service._getApiKey = originalApiKey;
    await fs.rm(cacheRoot, { recursive: true, force: true });
    delete process.env.HOMEBRAIN_ELEVENLABS_CACHE_DIR;
  });

  await assert.rejects(
    () => service.getVoices({ requireConfigured: true }),
    /ElevenLabs API key not configured/
  );

  const fallbackVoices = await service.getVoices();
  assert.equal(fallbackVoices.length > 0, true);
});

test('emotion tag sanitization rejects Codex output that changes spoken words or adds SSML', async (t) => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'homebrain-elevenlabs-sanitize-'));
  const service = loadService(cacheRoot);

  t.after(async () => {
    await fs.rm(cacheRoot, { recursive: true, force: true });
    delete process.env.HOMEBRAIN_ELEVENLABS_CACHE_DIR;
  });

  assert.equal(
    service._sanitizeTaggedText('[sad] Please leave the house.', 'Please leave now.'),
    'Please leave now.'
  );
  assert.equal(
    service._sanitizeTaggedText('[calmly] Please leave now. <break time="1s"/>', 'Please leave now.'),
    'Please leave now.'
  );
  assert.equal(
    service._sanitizeTaggedText('[urgent] Please leave now!', 'Please leave now.'),
    '[urgent] Please leave now!'
  );
});
