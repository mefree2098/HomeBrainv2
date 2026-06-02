const HELPER_VERSION = '1.0.0';
const REQUIRED_COOKIE_NAMES = ['session-id', 'session-token', 'csrf'];
const IMPORTANT_COOKIE_NAMES = ['ubid-main', 'session-id-time', 'at-main', 'sess-at-main', 'x-main'];
let activeCapture = null;
let pollTimer = null;

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
  for (const url of urls) {
    try {
      const cookies = await chrome.cookies.getAll({ url });
      for (const cookie of cookies) {
        if (cookie && cookie.name && typeof cookie.value === 'string') {
          cookieMap.set(cookieKey(cookie), cookie);
        }
      }
    } catch (_error) {
      // Ignore hosts that the browser rejects for the current region/account.
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

async function submitCaptureIfReady(reason = 'poll') {
  const capture = activeCapture;
  if (!capture || capture.submitted) {
    return;
  }
  const cookies = await getCookiesForCapture(capture);
  if (!hasRequiredCookies(cookies)) {
    const names = getCookieNames(cookies);
    const missing = REQUIRED_COOKIE_NAMES.filter((name) => !names.includes(name));
    activeCapture.lastMissing = missing;
    return;
  }

  const cookieHeader = buildCookieHeader(cookies);
  const csrf = getCookieValue(cookies, 'csrf');
  activeCapture.submitted = true;
  clearInterval(pollTimer);
  pollTimer = null;

  try {
    const response = await fetch(capture.receiverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        token: capture.token,
        cookie: cookieHeader,
        csrf,
        helperVersion: HELPER_VERSION,
        userAgent: navigator.userAgent,
        reason,
        cookieNames: getCookieNames(cookies),
        importantCookieNames: IMPORTANT_COOKIE_NAMES
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.success === false) {
      activeCapture.submitted = false;
      throw new Error(result.error || result.message || `HomeBrain rejected the captured session (${response.status}).`);
    }
    activeCapture.done = true;
  } catch (error) {
    activeCapture.submitted = false;
    activeCapture.lastError = error?.message || 'Unable to send Alexa session to HomeBrain.';
    if (!pollTimer) {
      pollTimer = setInterval(() => submitCaptureIfReady('retry'), 3000);
    }
  }
}

async function startCapture(payload) {
  const capture = {
    captureId: String(payload.captureId || ''),
    token: String(payload.token || ''),
    receiverUrl: String(payload.receiverUrl || ''),
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

  activeCapture = capture;
  clearInterval(pollTimer);
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'START_ALEXA_SESSION_CAPTURE') {
    return false;
  }
  startCapture(message.payload || {})
    .then(sendResponse)
    .catch((error) => sendResponse({
      success: false,
      error: error?.message || 'Unable to start Alexa session capture.'
    }));
  return true;
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
