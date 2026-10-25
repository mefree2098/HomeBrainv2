(function () {
  if (!window.location.pathname.endsWith('/alexa-session-capture.html')) {
    return;
  }

  const AVAILABLE_TYPE = 'homebrain-alexa-session-capture:helper-available';
  const START_TYPE = 'homebrain-alexa-session-capture:start';
  const RESPONSE_TYPE = 'homebrain-alexa-session-capture:response';
  const captureParameters = new URLSearchParams(window.location.search);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender?.id !== chrome.runtime.id || message?.captureId !== captureParameters.get('captureId')) return false;
    if (message.type === 'ALEXA_SESSION_CAPTURE_PROGRESS') {
      window.postMessage({
        type: 'homebrain-alexa-session-capture:progress',
        message: message.message,
        missingCookieNames: message.missingCookieNames || []
      }, window.location.origin);
      sendResponse({ success: true });
      return false;
    }
    if (message.type !== 'COMPLETE_ALEXA_SESSION_CAPTURE') return false;
    const expected = `${window.location.origin}/api/alexa/session-capture/${encodeURIComponent(message.captureId)}/complete`;
    if (message.receiverUrl !== expected || message.payload?.token !== captureParameters.get('token')) {
      sendResponse({ success: false, error: 'Alexa session return does not match this HomeBrain capture.' });
      return false;
    }
    fetch(expected, {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message.payload)
    }).then(async (response) => {
      const result = await response.json().catch(() => ({}));
      sendResponse({
        success: response.ok && result.success !== false,
        error: result.error || (response.ok ? '' : `HomeBrain rejected the session (${response.status}).`)
      });
    }).catch(() => sendResponse({ success: false, error: 'Could not return the Alexa session to HomeBrain.' }));
    return true;
  });

  function postAvailable() {
    window.postMessage({
      type: AVAILABLE_TYPE,
      version: chrome.runtime.getManifest().version
    }, window.location.origin);
  }

  // Both the sender window and exact origin are validated before the payload is used.
  // nosemgrep: javascript.browser.security.insufficient-postmessage-origin-validation.insufficient-postmessage-origin-validation
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) {
      return;
    }
    const message = event.data || {};
    if (message.type !== START_TYPE || !message.payload) {
      return;
    }

    chrome.runtime.sendMessage({
      type: 'START_ALEXA_SESSION_CAPTURE',
      payload: message.payload
    }, (response) => {
      window.postMessage({
        type: RESPONSE_TYPE,
        requestId: message.requestId || '',
        response: response || {
          success: false,
          error: chrome.runtime.lastError?.message || 'No response from HomeBrain Alexa Session Helper.'
        }
      }, window.location.origin);
    });
  });

  postAvailable();
  setTimeout(postAvailable, 500);
})();
