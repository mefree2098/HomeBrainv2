/* Shared by the frame, web preview, and iOS WKWebView preview. No home controls. */
(function () {
  'use strict';
  var preview = new URLSearchParams(location.search).get('preview') === '1';
  var credentialsKey = 'homebrain.frame.credentials.v1';
  var manifestKey = 'homebrain.frame.manifest.v1';
  var positions = ['topLeft', 'topCenter', 'topRight', 'bottomLeft', 'bottomCenter', 'bottomRight'];
  var state = null;
  var credentials = null;
  var currentId = null;
  var activeLayer = 0;
  var lastChangeAt = Date.now();
  var showing = false;
  var refreshing = false;
  var generation = 0;
  var layers = [document.getElementById('photo-a'), document.getElementById('photo-b')];
  var canvas = document.getElementById('canvas');
  var overlayRoot = document.getElementById('overlays');
  var status = document.getElementById('connection');
  var urls = new Map();
  var failedPhotos = new Set();
  var cacheCursor = 0;
  var dbPromise = null;

  function stored(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (_error) { return null; } }
  function persist(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_error) { /* Playback works when storage is full. */ } }
  function notice(message) { status.textContent = message || ''; status.hidden = !message || preview; }
  function db() {
    if (!dbPromise) dbPromise = new Promise(function (resolve) {
      if (!window.indexedDB) return resolve(null);
      var request = indexedDB.open('homebrain-frame-photos-v1', 1);
      request.onupgradeneeded = function () { request.result.createObjectStore('photos'); };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { resolve(null); };
    });
    return dbPromise;
  }
  async function cache(action, key, value) {
    var database = await db();
    if (!database) return null;
    return new Promise(function (resolve) {
      try {
        var transaction = database.transaction('photos', action === 'get' ? 'readonly' : 'readwrite');
        var store = transaction.objectStore('photos');
        var request = action === 'put' ? store.put(value, key) : action === 'delete' ? store.delete(key) : store.get(key);
        var result = null;
        request.onsuccess = function () { result = request.result; };
        transaction.oncomplete = function () { resolve(result); };
        transaction.onerror = transaction.onabort = function () { resolve(null); };
      } catch (_error) { resolve(null); }
    });
  }
  function photoKey(photo) { return state.frameId + ':' + photo.id; }
  function clearImages() {
    urls.forEach(function (url) { URL.revokeObjectURL(url); });
    urls.clear();
    failedPhotos.clear();
    layers.forEach(function (layer) { layer.style.backgroundImage = ''; layer.className = 'photo'; });
    currentId = null;
    document.getElementById('empty').hidden = false;
  }
  async function revoke() {
    var previous = state;
    generation++;
    state = null;
    credentials = null;
    clearImages();
    overlayRoot.textContent = '';
    localStorage.removeItem(credentialsKey);
    localStorage.removeItem(manifestKey);
    document.getElementById('sleep').hidden = true;
    document.getElementById('pairing').hidden = false;
    document.getElementById('pairing-message').textContent = 'This credential was revoked. Create a new pairing link in HomeBrain.';
    if (previous) for (var photo of previous.photos) await cache('delete', previous.frameId + ':' + photo.id);
  }
  async function request(url) {
    var controller = window.AbortController ? new AbortController() : null;
    var timeout = controller ? setTimeout(function () { controller.abort(); }, 12000) : null;
    try {
      var response = await fetch(url, {
        headers: preview ? {} : { 'X-HomeBrain-Frame-Token': credentials.token },
        credentials: preview ? 'same-origin' : 'omit',
        cache: 'no-store', signal: controller ? controller.signal : undefined
      });
      if (!response.ok) {
        if (!preview && (response.status === 401 || response.status === 403)) await revoke();
        throw new Error('HomeBrain response ' + response.status);
      }
      return response;
    } finally { if (timeout) clearTimeout(timeout); }
  }
  async function photoBlob(photo) {
    if (preview && /^data:image\/(jpeg|png);base64,/.test(photo.url)) return (await fetch(photo.url)).blob();
    var expected = preview ? /^\/api\/photo-frames\/[a-f0-9]{24}\/photos\/[a-f0-9-]+$/i : /^\/api\/photo-frames\/[a-f0-9]{24}\/device\/photos\/[a-f0-9-]+$/i;
    if (!expected.test(photo.url)) throw new Error('Invalid photo URL');
    var key = photoKey(photo);
    var blob = preview ? null : await cache('get', key);
    if (blob) return blob;
    blob = await (await request(photo.url)).blob();
    if (!preview && state) await cache('put', key, blob);
    return blob;
  }
  async function photoURL(photo) {
    if (urls.has(photo.id)) return urls.get(photo.id);
    var blob = await photoBlob(photo);
    var url = URL.createObjectURL(blob);
    urls.set(photo.id, url);
    if (urls.size > 4) {
      var candidate = Array.from(urls.keys()).find(function (id) { return id !== currentId && id !== photo.id; });
      URL.revokeObjectURL(urls.get(candidate)); urls.delete(candidate);
    }
    return url;
  }
  function resize() {
    if (!state) return;
    var width = state.config.orientation === 'portrait' ? 800 : 1280;
    var height = state.config.orientation === 'portrait' ? 1280 : 800;
    var scale = Math.min(innerWidth / width, innerHeight / height);
    canvas.style.width = width + 'px'; canvas.style.height = height + 'px';
    canvas.style.transform = 'translate(-50%, -50%) scale(' + scale + ')';
  }
  function clockParts() {
    var parts = new Intl.DateTimeFormat('en-GB', { timeZone: state.config.timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
    return parts.filter(function (part) { return part.type === 'hour' || part.type === 'minute'; }).map(function (part) { return part.value; }).join(':');
  }
  function isSleeping() {
    if (!state || preview || !state.config.sleep.enabled) return false;
    var now = clockParts();
    var schedule = state.config.sleep;
    return schedule.start < schedule.end ? now >= schedule.start && now < schedule.end : now >= schedule.start || now < schedule.end;
  }
  function lineText(line) {
    var config = state.config;
    var date = new Date();
    var timeOptions = { timeZone: config.timeZone, hour: 'numeric', minute: '2-digit', hour12: config.hour12 };
    var dateOptions = { timeZone: config.timeZone, weekday: 'short', month: 'short', day: 'numeric' };
    var metric = line.metric;
    var text;
    var stale = false;
    function formatted(options) {
      try { return new Intl.DateTimeFormat('en-US', options).format(date); }
      catch (_error) { return 'Invalid time zone'; }
    }
    if (metric === 'time') text = formatted(timeOptions);
    else if (metric === 'date') text = formatted(dateOptions);
    else if (metric === 'dateTime') text = formatted(timeOptions) + ' · ' + formatted(dateOptions);
    else if (metric === 'text') text = line.text || '';
    else {
      var value = state.values[metric];
      stale = Boolean(value && value.stale) || Date.now() - new Date(state.generatedAt).getTime() > 90000;
      text = value ? value.text : 'Unavailable';
      if (metric === 'alarm' && stale) text = 'Alarm status unavailable';
      else if (value && value.kind === 'solarTime' && value.value) {
        // Weather services return local ISO times without an offset. Preserve
        // the source's wall clock instead of interpreting it in the Mac's zone.
        var match = /T(\d{2}):(\d{2})/.exec(value.value);
        if (match) {
          var hours = Number(match[1]);
          var time = config.hour12 ? ((hours % 12) || 12) + ':' + match[2] + (hours >= 12 ? ' PM' : ' AM') : match[1] + ':' + match[2];
          text = (metric === 'sunrise' ? 'Sunrise ' : 'Sunset ') + time;
        }
      }
      if (stale && metric !== 'alarm' && value && value.value !== null) text += ' · stale';
    }
    return { text: (line.label ? line.label + ' ' : '') + text, stale: stale, alarm: metric === 'alarm' && text === 'ALARM TRIGGERED' && !stale };
  }
  function renderOverlays() {
    if (!state) return;
    overlayRoot.textContent = '';
    positions.forEach(function (position) {
      var slot = state.config.overlays[position];
      if (!slot || !slot.enabled || !slot.lines.length) return;
      var element = document.createElement('div');
      var center = position.indexOf('Center') !== -1;
      var right = position.indexOf('Right') !== -1;
      element.className = 'overlay' + (center ? ' center' : right ? ' right' : '');
      if (!center) element.style.width = 'calc(33% - ' + (2 * state.config.margin) + 'px)';
      element.dataset.position = position;
      element.style[position.indexOf('top') === 0 ? 'top' : 'bottom'] = state.config.margin + 'px';
      if (!center) element.style[right ? 'right' : 'left'] = state.config.margin + 'px';
      element.style.fontFamily = slot.font === 'display' ? 'FrameDisplay, sans-serif' : slot.font === 'mono' ? 'monospace' : 'FrameSans, sans-serif';
      element.style.fontSize = slot.fontSize + 'px';
      element.style.backgroundColor = 'rgba(0,0,0,' + slot.panelOpacity + ')';
      element.style.color = slot.color;
      slot.lines.slice(0, center ? 1 : 2).forEach(function (line) {
        var content = lineText(line);
        var row = document.createElement('span');
        row.className = 'overlay-line' + (content.stale ? ' stale' : '') + (content.alarm ? ' alarm' : '');
        row.style.opacity = slot.textOpacity;
        row.textContent = content.text;
        element.appendChild(row);
      });
      overlayRoot.appendChild(element);
    });
    document.getElementById('sleep').hidden = !isSleeping();
    canvas.style.filter = 'brightness(' + state.config.brightness / 100 + ')';
  }
  async function showPhoto(photo, immediate) {
    if (showing || !state) return;
    showing = true;
    var expectedGeneration = generation;
    try {
      var url = await photoURL(photo);
      await new Promise(function (resolve, reject) { var image = new Image(); image.onload = resolve; image.onerror = reject; image.src = url; });
      if (!state || generation !== expectedGeneration || !state.photos.some(function (entry) { return entry.id === photo.id; })) return;
      var next = layers[1 - activeLayer];
      var previous = layers[activeLayer];
      var transition = state.config.transition;
      var duration = immediate || transition === 'cut' ? 0 : state.config.transitionSeconds;
      next.style.transitionDuration = '0s';
      next.className = 'photo' + (transition === 'slide' ? ' slide-enter' : '');
      next.style.backgroundImage = 'url("' + url + '")';
      next.style.backgroundSize = state.config.fit;
      void next.offsetWidth;
      next.style.transitionDuration = duration + 's';
      previous.style.transitionDuration = duration + 's';
      next.className = 'photo active'; previous.className = 'photo';
      activeLayer = 1 - activeLayer;
      currentId = photo.id;
      lastChangeAt = Date.now();
      failedPhotos.delete(photo.id);
      document.getElementById('empty').hidden = true;
    } catch (_error) {
      failedPhotos.add(photo.id);
      lastChangeAt = Date.now() - (state ? state.config.intervalSeconds * 1000 : 0) + 2000;
    }
    finally {
      showing = false;
      if (state && state.photos.length && !state.photos.some(function (entry) { return entry.id === photo.id; })) showPhoto(state.photos[0], true);
    }
  }
  function nextPhoto() {
    if (!state || !state.photos.length) return;
    var candidates = state.photos.filter(function (photo) { return !failedPhotos.has(photo.id); });
    if (!candidates.length) return;
    var index = candidates.findIndex(function (photo) { return photo.id === currentId; });
    var nextIndex = (index + 1) % candidates.length;
    if (state.config.shuffle && candidates.length > 1) {
      var other = candidates.filter(function (photo) { return photo.id !== currentId; });
      return showPhoto(other[Math.floor(Math.random() * other.length)], false);
    }
    return showPhoto(candidates[nextIndex], false);
  }
  function apply(manifest) {
    if (!manifest || !manifest.config || !manifest.config.overlays || !Array.isArray(manifest.photos)) return;
    var previous = state;
    state = manifest;
    if (previous && previous.frameId !== state.frameId) { generation++; clearImages(); }
    if (previous && !preview) {
      var keep = new Set(state.photos.map(function (photo) { return photo.id; }));
      previous.photos.forEach(function (photo) { if (!keep.has(photo.id)) cache('delete', previous.frameId + ':' + photo.id); });
    }
    resize(); renderOverlays();
    layers.forEach(function (layer) { layer.style.backgroundSize = state.config.fit; });
    if (!state.photos.length) clearImages();
    else if (!state.photos.some(function (photo) { return photo.id === currentId; })) showPhoto(state.photos[0], true);
    if (!preview) persist(manifestKey, state);
  }
  async function refresh() {
    if (preview || !credentials || refreshing) return;
    refreshing = true;
    try {
      var result = await (await request('/api/photo-frames/' + credentials.frameId + '/device/manifest')).json();
      if (!credentials) return;
      apply(result.manifest);
      failedPhotos.clear();
      document.getElementById('pairing').hidden = true;
      notice('');
      // Warm a bounded batch so large libraries do not monopolize the hub or
      // exhaust its rate limit. Current photos always load on demand as well.
      var snapshot = state;
      for (var count = 0; count < Math.min(3, snapshot.photos.length); count++) {
        if (state !== snapshot || !credentials) break;
        var photo = snapshot.photos[(cacheCursor++) % snapshot.photos.length];
        try { await photoBlob(photo); } catch (_error) { break; }
      }
    } catch (_error) {
      if (credentials) notice(state ? 'HomeBrain offline · showing cached photos · live data may be stale' : 'Connecting to HomeBrain…');
    } finally { refreshing = false; }
  }
  function acceptLink(link) {
    var url = new URL(link, location.href);
    if (url.origin !== location.origin) throw new Error('Use a pairing link from this HomeBrain server');
    var parts = new URLSearchParams(url.hash.slice(1));
    var frameId = parts.get('frame'); var token = parts.get('token');
    if (!/^[a-f0-9]{24}$/i.test(frameId || '') || !/^[a-f0-9]{64}$/.test(token || '')) throw new Error('Invalid pairing link');
    generation++; clearImages(); state = null;
    credentials = { frameId: frameId, token: token };
    persist(credentialsKey, credentials);
    localStorage.removeItem(manifestKey);
  }
  window.addEventListener('resize', resize);
  if (preview) {
    window.HomeBrainFramePreview = apply;
    window.addEventListener('message', function (event) {
      if (event.source === window.parent && event.origin === location.origin && event.data && event.data.type === 'homebrain-frame-preview') apply(event.data.manifest);
    });
    if (window.parent !== window) window.parent.postMessage({ type: 'homebrain-frame-ready' }, location.origin);
  } else {
    credentials = stored(credentialsKey);
    if (location.hash) {
      try { acceptLink(location.href); } catch (error) { notice(error.message); }
      history.replaceState(null, '', location.pathname + location.search);
    }
    var cached = stored(manifestKey);
    if (credentials && cached && cached.frameId === credentials.frameId) apply(cached);
    document.getElementById('pairing').hidden = Boolean(credentials);
    document.getElementById('pairing').addEventListener('submit', function (event) {
      event.preventDefault();
      try { acceptLink(document.getElementById('pairing-link').value); refresh(); }
      catch (error) { document.getElementById('pairing-message').textContent = error.message; }
    });
    refresh();
    setInterval(refresh, 15000);
  }
  setInterval(function () {
    renderOverlays();
    if (state && !preview && !state.config.paused && !isSleeping() && Date.now() - lastChangeAt >= state.config.intervalSeconds * 1000) nextPhoto();
  }, 1000);
  // Read-only hooks are useful for device diagnostics and renderer smoke tests.
  window.HomeBrainFrameStatus = function () { return { preview: preview, currentPhotoId: currentId, frameId: state && state.frameId, sleeping: isSleeping() }; };
}());
