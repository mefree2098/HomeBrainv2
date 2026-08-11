(function () {
  if (!window.location.pathname.endsWith('/alexa-session-capture.html')) {
    return;
  }

  const AVAILABLE_TYPE = 'homebrain-alexa-session-capture:helper-available';
  const START_TYPE = 'homebrain-alexa-session-capture:start';
  const RESPONSE_TYPE = 'homebrain-alexa-session-capture:response';

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
