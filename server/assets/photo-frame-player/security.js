/* Optional touchscreen controls. PINs live only in this dialog's memory. */
(function () {
  'use strict';
  window.HomeBrainFrameSecurity = function (options) {
    var modal = document.getElementById('security-modal');
    var panel = document.getElementById('security-panel');
    var launcher = document.getElementById('security-launcher');
    var actions = document.getElementById('security-actions');
    var confirm = document.getElementById('security-confirm');
    var pinArea = document.getElementById('security-pin');
    var dots = document.getElementById('security-pin-dots');
    var submit = document.getElementById('security-submit');
    var message = document.getElementById('security-message');
    var actionButtons = {
      armStay: document.getElementById('security-arm-stay'),
      armAway: document.getElementById('security-arm-away'),
      disarm: document.getElementById('security-disarm')
    };
    var labels = { armStay: 'Arm Stay', armAway: 'Arm Away', disarm: 'Disarm' };
    var states = { disarmed: 'Disarmed', armedStay: 'Armed · stay', armedAway: 'Armed · away', arming: 'Arming · exit delay', triggered: 'ALARM TRIGGERED' };
    var enabled = false;
    var info = null;
    var action = null;
    var pin = '';
    var busy = false;
    var reading = false;
    var session = 0;
    var lastInteraction = 0;
    var lastRefresh = 0;
    var returnFocus = null;

    function clearPin() { pin = ''; renderPin(); }
    function requiresPin() { return Boolean(info && (action === 'disarm' ? info.pinSettings.requireForDisarm : info.pinSettings.requireForArm)); }
    function renderPin() {
      dots.textContent = '•'.repeat(pin.length);
      dots.setAttribute('aria-label', pin.length + ' PIN digits entered');
      submit.disabled = busy || !info || !info.available || (requiresPin() && pin.length < 4);
    }
    function close() {
      session++;
      modal.hidden = true;
      clearPin(); action = null; info = null; busy = false;
      message.textContent = '';
      if (returnFocus && returnFocus.isConnected) returnFocus.focus();
    }
    function render() {
      if (action && info && ((action === 'disarm' && info.alarmState === 'disarmed') || (action !== 'disarm' && info.alarmState !== 'disarmed'))) { action = null; clearPin(); }
      document.getElementById('security-state').textContent = info && info.available ? (states[info.alarmState] || 'Status unavailable') : 'Security system unavailable';
      Object.keys(actionButtons).forEach(function (key) {
        var armed = info && info.alarmState !== 'disarmed';
        actionButtons[key].hidden = key === 'disarm' ? !armed : Boolean(armed);
        actionButtons[key].disabled = busy || !info || !info.available;
      });
      actions.hidden = Boolean(action);
      confirm.hidden = !action;
      pinArea.hidden = !action || !requiresPin();
      document.getElementById('security-action-title').textContent = action ? labels[action] + (requiresPin() ? ' · enter your security PIN' : '?') : '';
      submit.textContent = options.preview ? 'Preview ' + (labels[action] || 'action') : (busy ? 'Sending…' : 'Confirm ' + (labels[action] || 'action'));
      renderPin();
    }
    async function request(method, body) {
      var credentials = options.getCredentials();
      if (!credentials || !/^[a-f0-9]{24}$/i.test(credentials.frameId) || !/^[a-f0-9]{64}$/.test(credentials.token)) throw new Error('Connect this frame to HomeBrain first');
      var controller = new AbortController();
      var timeout = setTimeout(function () { controller.abort(); }, 12000);
      try {
        var response = await fetch('/api/photo-frames/' + credentials.frameId + '/device/security', {
          method: method, credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal,
          headers: { 'X-HomeBrain-Frame-Token': credentials.token, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body)
        });
        var result = await response.json();
        if (!response.ok) {
          if (result.code === 'FRAME_CREDENTIAL_INVALID') await options.onRevoked();
          var error = new Error(result.message || 'Security request failed');
          error.status = response.status;
          throw error;
        }
        return result.security;
      } finally { clearTimeout(timeout); }
    }
    async function refresh(expectedSession) {
      if (reading) return;
      reading = true;
      lastRefresh = Date.now();
      try {
        var next = options.preview ? options.getPreviewStatus() : await request('GET');
        if (session !== expectedSession || modal.hidden) return;
        info = next && next.pinSettings && typeof next.available === 'boolean' ? next : null;
        if (!info) message.textContent = 'Security system unavailable.';
        render();
      } catch (error) {
        if (session !== expectedSession || modal.hidden) return;
        info = null; clearPin(); render();
        message.textContent = error.message;
      } finally { reading = false; }
    }
    function open() {
      if (!enabled) return;
      session++; action = null; info = null; busy = false; clearPin();
      lastInteraction = Date.now(); returnFocus = document.activeElement;
      modal.hidden = false; message.textContent = 'Loading security status…';
      document.getElementById('security-preview').hidden = !options.preview;
      render(); panel.focus();
      var expected = session;
      refresh(expected).then(function () { if (session === expected && info) message.textContent = ''; });
    }
    function choose(next) {
      if (busy || !info || !info.available) return;
      lastInteraction = Date.now(); action = next; clearPin(); message.textContent = ''; render();
      (requiresPin() ? document.getElementById('security-keypad').firstElementChild : submit).focus();
    }
    function key(value) {
      if (busy || !action || !requiresPin()) return;
      lastInteraction = Date.now();
      if (value === 'clear') pin = '';
      else if (value === 'delete') pin = pin.slice(0, -1);
      else if (pin.length < 8) pin += value;
      renderPin();
    }
    async function send() {
      if (submit.disabled || !action) return;
      lastInteraction = Date.now();
      if (options.preview) { clearPin(); message.textContent = 'Preview only. No security command was sent.'; return; }
      var expected = session;
      var body = { action: action };
      if (requiresPin()) body.pin = pin;
      clearPin(); busy = true; message.textContent = ''; render();
      try {
        var result = await request('POST', body);
        if (session !== expected || modal.hidden) return;
        info = result; action = null; message.textContent = 'Security command completed.';
      } catch (error) {
        if (session !== expected || modal.hidden) return;
        message.textContent = error.name === 'AbortError' ? 'No confirmation received. Check the current status before trying again.' : error.message;
        if (!error.status || error.status >= 500) info = null;
        if (error.status === 401 && info && action) {
          // The platform may have enabled PINs after the dialog opened. A PIN
          // failure must never revoke the frame's independent pairing token.
          if (action === 'disarm') info.pinSettings.requireForDisarm = true;
          else info.pinSettings.requireForArm = true;
        }
        if (error.status === 403) { close(); return; }
      } finally {
        delete body.pin;
        if (session === expected) { busy = false; render(); }
      }
    }
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'delete'].forEach(function (value) {
      var button = document.createElement('button');
      button.type = 'button'; button.className = 'security-button';
      button.textContent = value === 'clear' ? 'Clear' : value === 'delete' ? '⌫' : value;
      button.setAttribute('aria-label', value === 'delete' ? 'Delete PIN digit' : value === 'clear' ? 'Clear PIN' : value);
      button.addEventListener('click', function () { key(value); });
      document.getElementById('security-keypad').appendChild(button);
    });
    launcher.addEventListener('click', open);
    Object.keys(actionButtons).forEach(function (value) { actionButtons[value].addEventListener('click', function () { choose(value); }); });
    submit.addEventListener('click', send);
    document.getElementById('security-cancel').addEventListener('click', close);
    modal.addEventListener('pointerdown', function () { lastInteraction = Date.now(); });
    modal.addEventListener('keydown', function (event) {
      lastInteraction = Date.now();
      if (event.key === 'Escape') { close(); event.preventDefault(); }
      else if (action && requiresPin() && /^\d$/.test(event.key)) { key(event.key); event.preventDefault(); }
      else if (action && event.key === 'Backspace') { key('delete'); event.preventDefault(); }
      else if (event.key === 'Tab') {
        var buttons = Array.from(panel.querySelectorAll('button')).filter(function (button) { return !button.disabled && button.offsetParent !== null; });
        var first = buttons[0]; var last = buttons[buttons.length - 1];
        if (buttons.length && ((event.shiftKey && (document.activeElement === first || document.activeElement === panel)) || (!event.shiftKey && document.activeElement === last))) {
          (event.shiftKey ? last : first).focus(); event.preventDefault();
        }
      }
    });
    setInterval(function () {
      if (modal.hidden || busy) return;
      if (Date.now() - lastInteraction > 30000) close();
      else if (Date.now() - lastRefresh >= 5000) refresh(session);
    }, 1000);
    return {
      open: open,
      update: function (allowed, hasAlarmOverlay) {
        enabled = allowed;
        launcher.hidden = !enabled || hasAlarmOverlay;
        if (!enabled && !modal.hidden) close();
      }
    };
  };
})();
