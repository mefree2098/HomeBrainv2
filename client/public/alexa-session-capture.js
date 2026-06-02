(function () {
  const params = new URLSearchParams(window.location.search);
  const captureId = params.get('captureId') || '';
  const token = params.get('token') || '';
  const receiverUrl = params.get('receiver') || '';
  const statusUrl = params.get('status') || '';
  const loginUrl = params.get('login') || 'https://alexa.amazon.com/spa/index.html';
  const serviceHost = params.get('serviceHost') || 'pitangui.amazon.com';
  const amazonPage = params.get('amazonPage') || 'amazon.com';
  const statusTitle = document.getElementById('status-title');
  const statusCopy = document.getElementById('status-copy');
  const details = document.getElementById('details');
  const installHelp = document.getElementById('install-help');
  const openLoginButton = document.getElementById('open-login');
  const closeButton = document.getElementById('close-window');
  let helperAvailable = false;
  let started = false;

  function setStatus(title, copy, detail, tone) {
    statusTitle.textContent = title;
    statusTitle.className = tone || '';
    statusCopy.textContent = copy || '';
    details.textContent = detail || '';
  }

  function startCapture() {
    if (!captureId || !token || !receiverUrl) {
      setStatus('Capture link is incomplete', 'Go back to HomeBrain and start a new Alexa session capture.', '', 'bad');
      return;
    }
    started = true;
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    window.postMessage({
      type: 'homebrain-alexa-session-capture:start',
      requestId,
      payload: {
        captureId,
        token,
        receiverUrl,
        statusUrl,
        loginUrl,
        serviceHost,
        amazonPage
      }
    }, window.location.origin);
    setStatus('Alexa login is opening...', 'Sign in to Amazon in the new window. HomeBrain will activate the session when Alexa accepts it.', serviceHost, '');
  }

  async function pollStatus() {
    if (!statusUrl) {
      return;
    }
    try {
      const response = await fetch(statusUrl, { credentials: 'include' });
      const payload = await response.json();
      const capture = payload.capture || {};
      if (capture.status === 'activated') {
        setStatus('Alexa session activated', capture.message || 'HomeBrain saved the session and refreshed the broker.', '', 'good');
        return;
      }
      if (capture.status === 'failed' || capture.status === 'expired') {
        setStatus('Alexa session capture failed', capture.message || 'Start a new capture from HomeBrain.', '', 'bad');
        return;
      }
      if (capture.status) {
        setStatus('Waiting for Alexa login...', capture.message || 'Finish signing in to Amazon.', capture.status, '');
      }
    } catch (_error) {
      // The parent UI also polls. Keep this page quiet during transient restarts.
    }
    setTimeout(pollStatus, 2000);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) {
      return;
    }
    const message = event.data || {};
    if (message.type === 'homebrain-alexa-session-capture:helper-available') {
      helperAvailable = true;
      installHelp.classList.add('hidden');
      setStatus('Helper extension is ready', 'Opening Amazon login now.', `Helper ${message.version || ''}`, 'good');
      if (!started) {
        startCapture();
      }
    }
    if (message.type === 'homebrain-alexa-session-capture:response') {
      const response = message.response || {};
      if (response.success === false) {
        setStatus('Helper could not start', response.error || 'Check that the helper extension is installed and enabled.', '', 'bad');
      } else {
        setStatus('Alexa login window opened', response.message || 'Finish signing in to Amazon.', serviceHost, '');
      }
    }
  });

  openLoginButton.addEventListener('click', startCapture);
  closeButton.addEventListener('click', () => window.close());

  setTimeout(() => {
    if (!helperAvailable) {
      installHelp.classList.remove('hidden');
      setStatus('Helper extension was not detected', 'Install or enable the helper, then click Open Alexa Login.', '', 'bad');
    }
  }, 1400);

  pollStatus();
})();
