const HELPER_VERSION = '1.0.2';
const REQUIRED_COOKIE_NAMES = ['session-id', 'session-token', 'csrf'];
const IMPORTANT_COOKIE_NAMES = ['ubid-main', 'session-id-time', 'at-main', 'sess-at-main', 'x-main'];
const MAX_CAPTURE_AGE_MS = 10 * 60 * 1000;
const AMAZON_DOMAINS = ['amazon.com', 'amazon.co.uk', 'amazon.co.jp', 'amazon.ca', 'amazon.de', 'amazon.fr', 'amazon.it', 'amazon.es', 'amazon.com.au', 'amazon.com.br', 'amazon.in'];
let activeCapture = null;
let pollTimer = null;

function stopCapture() {
  activeCapture?.bootstrapAbort?.abort();
  clearInterval(pollTimer);
  pollTimer = null;
  activeCapture = null;
}

function captureContext(payload, sender) {
  if (sender?.id !== chrome.runtime.id || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id)) {
    throw new Error('Alexa session capture must start from the HomeBrain capture page.');
  }
  const page = new URL(sender.url || sender.tab.url);
  const trustedPage = (chrome.runtime.getManifest().content_scripts || []).some((entry) => (entry.matches || []).some((pattern) => {
    try {
      const target = new URL(pattern.replace(/\*$/, ''));
      return target.protocol === page.protocol && target.hostname === page.hostname;
    } catch (_error) {
      return false;
    }
  }));
  if (!trustedPage) throw new Error('Alexa session capture is not on this helper\'s HomeBrain host.');
  if (page.pathname !== '/alexa-session-capture.html'
      || (page.protocol !== 'https:' && !(page.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(page.hostname)))) {
    throw new Error('Alexa session capture requires a secure HomeBrain capture page.');
  }
  const captureId = String(payload.captureId || '');
  const token = String(payload.token || '');
  if (!captureId || !token || page.searchParams.get('captureId') !== captureId || page.searchParams.get('token') !== token) {
    throw new Error('Alexa session capture does not match the open HomeBrain page.');
  }
  const receiverUrl = `${page.origin}/api/alexa/session-capture/${encodeURIComponent(captureId)}/complete`;
  if (payload.receiverUrl !== receiverUrl) {
    throw new Error('Alexa session capture receiver must match its HomeBrain page.');
  }
  const login = new URL(payload.loginUrl);
  const amazonHost = (host) => AMAZON_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
  if (login.protocol !== 'https:' || login.username || login.password || !amazonHost(login.hostname)
      || !amazonHost(normalizeHost(payload.serviceHost || 'pitangui.amazon.com'))
      || !amazonHost(normalizeHost(payload.amazonPage || 'amazon.com'))) {
    throw new Error('Alexa session capture must use Amazon HTTPS hosts.');
  }
  return { tabId: sender.tab.id, receiverUrl };
}

async function reportProgress(capture, message, missingCookieNames = []) {
  try {
    await chrome.tabs.sendMessage(capture.tabId, {
      type: 'ALEXA_SESSION_CAPTURE_PROGRESS',
      captureId: capture.captureId,
      message,
      missingCookieNames
    });
  } catch (_error) {
    if (activeCapture === capture) stopCapture();
  }
}

function normalizeHost(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch (_error) {
    return raw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  }
}

function unique(values) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
}

function buildCaptureUrls(capture) {
  const serviceHost = normalizeHost(capture.serviceHost || 'pitangui.amazon.com');
  const amazonPage = normalizeHost(capture.amazonPage || 'amazon.com').replace(/^www\./i, '') || 'amazon.com';
  return unique([
    `https://${serviceHost}/api/devices-v2/device`,
    `https://${serviceHost}/`,
    `https://alexa.${amazonPage}/spa/index.html`,
    `https://www.${amazonPage}/`,
    `https://${amazonPage}/`,
    'https://alexa.amazon.com/spa/index.html',
    'https://pitangui.amazon.com/api/devices-v2/device'
  ]);
}

function cookieKey(cookie) {
  return `${cookie.domain || ''}\n${cookie.path || ''}\n${cookie.name || ''}`;
}

async function getCookiesForCapture(capture) {
  const urls = buildCaptureUrls(capture);
  const cookieMap = new Map();
  const amazonPage = normalizeHost(capture.amazonPage || 'amazon.com');
  const domain = AMAZON_DOMAINS.find((entry) => amazonPage === entry || amazonPage.endsWith(`.${entry}`));
  for (const url of urls) {
    // Cookie APIs otherwise omit Partitioned cookies. Read only Amazon's own
    // first-party partition, under the helper's existing host permissions.
    for (const partitionKey of [null, { topLevelSite: `https://${domain}`, hasCrossSiteAncestor: false }]) {
      try {
        const cookies = await chrome.cookies.getAll({ url, ...(partitionKey ? { partitionKey } : {}) });
        for (const cookie of cookies) {
          if (cookie && cookie.name && typeof cookie.value === 'string' && !cookieMap.has(cookieKey(cookie))) {
            cookieMap.set(cookieKey(cookie), cookie);
          }
        }
      } catch (_error) {
        // Older browsers may not support partition keys. Keep ordinary cookies.
      }
    }
  }
  return Array.from(cookieMap.values()).sort((a, b) => {
    const pathDelta = String(b.path || '').length - String(a.path || '').length;
    if (pathDelta !== 0) {
      return pathDelta;
    }
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

function buildCookieHeader(cookies) {
  return cookies
    .filter((cookie) => cookie && cookie.name && typeof cookie.value === 'string')
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

function getCookieNames(cookies) {
  return Array.from(new Set(cookies.map((cookie) => String(cookie.name || '').toLowerCase()).filter(Boolean)));
}

function hasRequiredCookies(cookies) {
  const names = new Set(getCookieNames(cookies));
  return REQUIRED_COOKIE_NAMES.every((name) => names.has(name));
}

function getCookieValue(cookies, name) {
  const expected = String(name || '').toLowerCase();
  const match = cookies.find((cookie) => String(cookie.name || '').toLowerCase() === expected);
  return match?.value || '';
}

async function bootstrapSession(capture, cookies) {
  const names = getCookieNames(cookies);
  if (!names.includes('session-id') || !names.includes('session-token') || names.includes('csrf')) return cookies;
  const sessionMarker = cookies.filter((cookie) => /^(session-token|at-)/i.test(cookie.name)).map((cookie) => cookie.value).join('\n');
  if (capture.bootstrapSessionMarker === sessionMarker) return cookies;
  capture.bootstrapSessionMarker = sessionMarker;
  await reportProgress(capture, 'Preparing the Alexa command session after Amazon sign-in.', ['csrf']);

  const serviceHost = normalizeHost(capture.serviceHost || 'pitangui.amazon.com');
  const amazonPage = normalizeHost(capture.amazonPage || 'amazon.com').replace(/^www\./i, '');
  // These read-only endpoints are also used by alexa-cookie/alexapy to obtain
  // Amazon's own CSRF cookie. Never create a token or submit a device command.
  const origins = unique([`https://${serviceHost}`, `https://alexa.${amazonPage}`]);
  for (const origin of origins) {
    for (const path of ['/api/language', '/api/devices-v2/device?cached=false', '/api/strings']) {
      if (activeCapture !== capture || Date.now() - capture.startedAt >= MAX_CAPTURE_AGE_MS) return cookies;
      const controller = new AbortController();
      capture.bootstrapAbort = controller;
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(`${origin}${path}`, {
          method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'error',
          headers: { Accept: 'application/json' }, signal: controller.signal
        });
        await response.body?.cancel();
      } catch (_error) {
        // A failed/retired endpoint cannot supply a cookie. Try the next one.
      } finally {
        clearTimeout(timer);
        capture.bootstrapAbort = null;
      }
      if (activeCapture !== capture) return cookies;
      cookies = await getCookiesForCapture(capture);
      if (hasRequiredCookies(cookies)) return cookies;
    }
  }
  return cookies;
}

async function submitCaptureIfReady(reason = 'poll') {
  const capture = activeCapture;
  if (!capture || capture.checking) return;
  capture.checking = true;
  try {
    await collectCapture(capture, reason);
  } finally {
    capture.checking = false;
  }
}

async function collectCapture(capture, reason) {
  if (capture.submitted) return;
  if (Date.now() - capture.startedAt >= MAX_CAPTURE_AGE_MS) {
    await reportProgress(capture, 'Alexa session capture expired. Start a new capture in HomeBrain.');
    if (activeCapture === capture) stopCapture();
    return;
  }
  let cookies = await getCookiesForCapture(capture);
  if (activeCapture !== capture) return;
  cookies = await bootstrapSession(capture, cookies);
  if (activeCapture !== capture || capture.submitted) return;
  if (Date.now() - capture.startedAt >= MAX_CAPTURE_AGE_MS) {
    await reportProgress(capture, 'Alexa session capture expired. Start a new capture in HomeBrain.');
    if (activeCapture === capture) stopCapture();
    return;
  }
  if (!hasRequiredCookies(cookies)) {
    const names = getCookieNames(cookies);
    const missing = REQUIRED_COOKIE_NAMES.filter((name) => !names.includes(name));
    activeCapture.lastMissing = missing;
    await reportProgress(capture, `Waiting for Amazon session cookies: ${missing.join(', ')}.`, missing);
    return;
  }

  const cookieHeader = buildCookieHeader(cookies);
  const csrf = getCookieValue(cookies, 'csrf');
  activeCapture.submitted = true;
  clearInterval(pollTimer);
  pollTimer = null;

  try {
    // The isolated content script returns the session from the HomeBrain
    // origin. Keep the server's CORS allowlist intact and keep cookies out of
    // window.postMessage/page JavaScript.
    const result = await chrome.tabs.sendMessage(capture.tabId, {
      type: 'COMPLETE_ALEXA_SESSION_CAPTURE',
      captureId: capture.captureId,
      receiverUrl: capture.receiverUrl,
      payload: {
        token: capture.token,
        cookie: cookieHeader,
        csrf,
        helperVersion: HELPER_VERSION,
        userAgent: navigator.userAgent,
        reason,
        cookieNames: getCookieNames(cookies),
        importantCookieNames: IMPORTANT_COOKIE_NAMES
      }
    });
    if (!result?.success) {
      capture.submitted = false;
      throw new Error(result?.error || 'HomeBrain could not activate the captured session.');
    }
    capture.done = true;
    await reportProgress(capture, 'Alexa session was returned to HomeBrain.');
    if (activeCapture === capture) stopCapture();
  } catch (error) {
    if (activeCapture !== capture) return;
    capture.submitted = false;
    capture.lastError = error?.message || 'Unable to send Alexa session to HomeBrain.';
    await reportProgress(capture, capture.lastError);
    if (activeCapture === capture && !pollTimer) {
      pollTimer = setInterval(() => submitCaptureIfReady('retry'), 20000);
    }
  }
}

async function startCapture(payload, sender) {
  const context = captureContext(payload, sender);
  const capture = {
    captureId: String(payload.captureId || ''),
    token: String(payload.token || ''),
    receiverUrl: context.receiverUrl,
    tabId: context.tabId,
    loginUrl: String(payload.loginUrl || ''),
    serviceHost: String(payload.serviceHost || 'pitangui.amazon.com'),
    amazonPage: String(payload.amazonPage || 'amazon.com'),
    submitted: false,
    done: false,
    startedAt: Date.now()
  };

  if (!capture.captureId || !capture.token || !capture.receiverUrl || !capture.loginUrl) {
    return {
      success: false,
      error: 'HomeBrain did not provide a complete Alexa capture request.'
    };
  }

  stopCapture();
  activeCapture = capture;
  pollTimer = setInterval(() => submitCaptureIfReady('poll'), 2500);

  await chrome.windows.create({
    url: capture.loginUrl,
    type: 'popup',
    focused: true,
    width: 1100,
    height: 850
  });
  submitCaptureIfReady('start');

  return {
    success: true,
    message: 'Alexa login window opened. Sign in there and the helper will send the fresh session to HomeBrain.'
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'START_ALEXA_SESSION_CAPTURE') {
    return false;
  }
  startCapture(message.payload || {}, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({
      success: false,
      error: error?.message || 'Unable to start Alexa session capture.'
    }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeCapture?.tabId === tabId) stopCapture();
});

chrome.webNavigation.onCompleted.addListener((details) => {
  if (!activeCapture || details.frameId !== 0) {
    return;
  }
  const url = String(details.url || '');
  if (url.includes('amazon.') || url.includes('alexa.')) {
    submitCaptureIfReady('navigation');
  }
});
