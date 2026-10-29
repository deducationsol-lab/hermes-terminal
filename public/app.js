/*
 * Self-contained terminal dashboard for the live log stream.
 *
 * No framework, no build step. The page hosts one or more independent log
 * panels laid out side by side. Each panel:
 *   - owns a single channel name and its own WebSocket connection (with the
 *     original per-connection exponential-backoff reconnect + visible status),
 *   - keeps its own bounded in-memory buffer of events (separate from the DOM),
 *   - has its own view state: level filters, free-text search, pause/resume,
 *     and stick-to-bottom auto-scroll,
 *   - renders color-coded lines, supports per-event detail expansion, and can
 *     export its buffer as JSON or NDJSON.
 *
 * The set of open channels and the chosen theme persist to localStorage so the
 * layout and palette are restored on reload.
 *
 * Server -> client message protocol (JSON, tagged by `type`):
 *   { type: 'history', events: [...] }  // sent once on connect
 *   { type: 'event', event: {...} }     // sent for each new live event
 *
 * LogEvent = { channel, level, message, meta?, ts, seq }.
 *
 * XSS safety: all event-derived data (message, meta, level, channel) is written
 * with textContent / DOM text nodes. innerHTML is never used with event data.
 */
(function () {
  'use strict';

  var MAX_BUFFER = 2000; // max events retained in memory per panel
  var MAX_LINES = 2000; // max rendered DOM lines per panel
  var RECONNECT_BASE_MS = 500;
  var RECONNECT_MAX_MS = 15000;

  var KNOWN_LEVELS = ['debug', 'info', 'warn', 'error'];
  var STORAGE_CHANNELS = 'hermes.channels';
  var STORAGE_THEME = 'hermes.theme';
  var THEMES = ['midnight', 'light', 'ocean', 'amber'];

  var panelTemplate = document.getElementById('panel-template');
  var panelsContainer = document.getElementById('panels');
  var addForm = document.getElementById('add-panel-form');
  var channelInput = document.getElementById('channel-input');
  var themeSelect = document.getElementById('theme-select');

  // Live set of panels keyed by channel name.
  var panels = {};

  // ---- small helpers ------------------------------------------------------

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }
  function pad3(n) {
    return (n < 100 ? '0' : '') + (n < 10 ? '0' : '') + n;
  }

  function formatTs(ts) {
    var d = new Date(typeof ts === 'number' ? ts : Date.now());
    return (
      pad2(d.getHours()) +
      ':' +
      pad2(d.getMinutes()) +
      ':' +
      pad2(d.getSeconds()) +
      '.' +
      pad3(d.getMilliseconds())
    );
  }

  function knownLevelClass(level) {
    switch (level) {
      case 'debug':
      case 'info':
      case 'warn':
      case 'error':
        return level;
      default:
        return 'other';
    }
  }

  function levelKey(level) {
    // Normalise a level to one of the known buckets, else 'other'.
    return KNOWN_LEVELS.indexOf(level) >= 0 ? level : 'other';
  }

  function sanitizeForFilename(name) {
    // Strip path separators and other awkward characters from a channel name.
    return String(name).replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'channel';
  }

  function fileTimestamp(d) {
    d = d || new Date();
    return (
      d.getFullYear() +
      pad2(d.getMonth() + 1) +
      pad2(d.getDate()) +
      '-' +
      pad2(d.getHours()) +
      pad2(d.getMinutes()) +
      pad2(d.getSeconds())
    );
  }

  function loadChannels() {
    try {
      var raw = window.localStorage.getItem(STORAGE_CHANNELS);
      if (!raw) {
        return [];
      }
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(function (c) {
        return typeof c === 'string' && c.length > 0;
      }) : [];
    } catch (e) {
      return [];
    }
  }

  function saveChannels() {
    try {
      var list = [];
      for (var i = 0; i < panelOrder.length; i += 1) {
        list.push(panelOrder[i]);
      }
      window.localStorage.setItem(STORAGE_CHANNELS, JSON.stringify(list));
    } catch (e) {
      /* ignore */
    }
  }

  // Preserve insertion order of panels for persistence.
  var panelOrder = [];

  function queryChannel() {
    try {
      var params = new URLSearchParams(window.location.search);
      return params.get('channel');
    } catch (e) {
      return null;
    }
  }

  // ---- theming ------------------------------------------------------------

  function applyTheme(theme) {
    if (THEMES.indexOf(theme) < 0) {
      theme = THEMES[0];
    }
    document.documentElement.setAttribute('data-theme', theme);
    try {
      window.localStorage.setItem(STORAGE_THEME, theme);
    } catch (e) {
      /* ignore */
    }
    if (themeSelect) {
      themeSelect.value = theme;
    }
  }

  function initTheme() {
    var stored;
    try {
      stored = window.localStorage.getItem(STORAGE_THEME);
    } catch (e) {
      stored = null;
    }
    applyTheme(stored || THEMES[0]);
    if (themeSelect) {
      themeSelect.addEventListener('change', function () {
        applyTheme(themeSelect.value);
      });
    }
  }

  // ---- Panel abstraction --------------------------------------------------

  /**
   * Create a panel bound to `channel`. Returns an object exposing `destroy()`
   * so it can be removed. All per-panel state is captured in this closure.
   */
  function createPanel(channel) {
    // --- DOM ---
    var root = panelTemplate.content.firstElementChild.cloneNode(true);
    var channelEl = root.querySelector('.panel-channel');
    var statusEl = root.querySelector('.panel-status');
    var countEl = root.querySelector('.panel-count');
    var pauseBtn = root.querySelector('.panel-pause');
    var exportJsonBtn = root.querySelector('.panel-export-json');
    var exportNdjsonBtn = root.querySelector('.panel-export-ndjson');
    var clearBtn = root.querySelector('.panel-clear');
    var removeBtn = root.querySelector('.panel-remove');
    var levelTogglesEl = root.querySelector('.level-toggles');
    var searchInput = root.querySelector('.panel-search');
    var bufferedEl = root.querySelector('.panel-buffered');
    var logView = root.querySelector('.log-view');
    var logLines = root.querySelector('.log-lines');
    var autoscrollEl = root.querySelector('.panel-autoscroll');

    channelEl.textContent = channel;

    // --- state ---
    var buffer = []; // bounded in-memory LogEvent list
    var pausedBuffer = []; // events received while paused, awaiting flush
    var paused = false;
    var stickToBottom = true;

    // Enabled levels: all known + 'other' on by default.
    var enabledLevels = {};
    var li;
    for (li = 0; li < KNOWN_LEVELS.length; li += 1) {
      enabledLevels[KNOWN_LEVELS[li]] = true;
    }
    enabledLevels.other = true;

    var searchText = '';

    // --- connection state ---
    var socket = null;
    var reconnectAttempts = 0;
    var reconnectTimer = null;
    var manualClose = false;
    var destroyed = false;

    // --- rendering helpers ---

    function setStatus(state, text) {
      statusEl.className = 'panel-status status status-' + state;
      statusEl.textContent = text;
    }

    function updateCount() {
      var n = buffer.length;
      countEl.textContent = n + (n === 1 ? ' line' : ' lines');
    }

    function matchesFilter(event) {
      var lvl = levelKey(String(event.level || 'info'));
      if (!enabledLevels[lvl]) {
        return false;
      }
      if (searchText) {
        var msg = String(event.message == null ? '' : event.message).toLowerCase();
        if (msg.indexOf(searchText) < 0) {
          return false;
        }
      }
      return true;
    }

    // Build a message span, highlighting search matches via text nodes only
    // (never innerHTML) to stay injection-safe.
    function buildMessage(text) {
      var span = document.createElement('span');
      span.className = 'message';
      var value = String(text == null ? '' : text);
      if (!searchText) {
        span.textContent = value;
        return span;
      }
      var lower = value.toLowerCase();
      var from = 0;
      var idx = lower.indexOf(searchText);
      if (idx < 0) {
        span.textContent = value;
        return span;
      }
      while (idx >= 0) {
        if (idx > from) {
          span.appendChild(document.createTextNode(value.slice(from, idx)));
        }
        var mark = document.createElement('span');
        mark.className = 'match';
        mark.textContent = value.slice(idx, idx + searchText.length);
        span.appendChild(mark);
        from = idx + searchText.length;
        idx = lower.indexOf(searchText, from);
      }
      if (from < value.length) {
        span.appendChild(document.createTextNode(value.slice(from)));
      }
      return span;
    }

    function buildLine(event) {
      var line = document.createElement('div');
      line.className = 'log-line level-' + knownLevelClass(String(event.level || 'info'));
      line.setAttribute('tabindex', '0');
      line.setAttribute('role', 'button');

      var head = document.createElement('div');
      head.className = 'log-line-head';

      var ts = document.createElement('span');
      ts.className = 'ts';
      ts.textContent = formatTs(event.ts);

      var level = document.createElement('span');
      level.className = 'level';
      level.textContent = String(event.level || 'info');

      head.appendChild(ts);
      head.appendChild(level);
      head.appendChild(buildMessage(event.message));

      if (event.meta && typeof event.meta === 'object') {
        var metaPreview = document.createElement('span');
        metaPreview.className = 'meta';
        try {
          metaPreview.textContent = JSON.stringify(event.meta);
        } catch (e) {
          metaPreview.textContent = '[meta]';
        }
        head.appendChild(metaPreview);
      }

      line.appendChild(head);

      // Per-event detail toggle (upgrade 8). Built lazily on first expand.
      var detail = null;
      function toggleDetail() {
        if (detail) {
          line.removeChild(detail);
          detail = null;
          line.classList.remove('expanded');
          return;
        }
        detail = document.createElement('pre');
        detail.className = 'log-detail';
        var full = {
          channel: event.channel,
          level: event.level,
          ts: event.ts,
          seq: event.seq,
          message: event.message,
          meta: event.meta == null ? null : event.meta,
        };
        try {
          detail.textContent = JSON.stringify(full, null, 2);
        } catch (e) {
          detail.textContent = '[unserializable event]';
        }
        line.appendChild(detail);
        line.classList.add('expanded');
      }

      line.addEventListener('click', toggleDetail);
      line.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          e.preventDefault();
          toggleDetail();
        }
      });

      return line;
    }

    function scrollToBottom() {
      logView.scrollTop = logView.scrollHeight;
    }

    function appendLine(event) {
      var line = buildLine(event);
      logLines.appendChild(line);
      while (logLines.childElementCount > MAX_LINES) {
        logLines.removeChild(logLines.firstChild);
      }
      if (stickToBottom) {
        scrollToBottom();
      }
    }

    // Re-render the visible lines from the buffer, applying current filters.
    function rerender() {
      while (logLines.firstChild) {
        logLines.removeChild(logLines.firstChild);
      }
      var start = 0;
      if (buffer.length > MAX_LINES) {
        start = buffer.length - MAX_LINES;
      }
      for (var i = start; i < buffer.length; i += 1) {
        if (matchesFilter(buffer[i])) {
          var line = buildLine(buffer[i]);
          logLines.appendChild(line);
        }
      }
      if (stickToBottom) {
        scrollToBottom();
      }
    }

    function updateBufferedIndicator() {
      if (paused) {
        var n = pausedBuffer.length;
        bufferedEl.hidden = false;
        bufferedEl.textContent = 'paused - ' + n + ' buffered';
      } else {
        bufferedEl.hidden = true;
        bufferedEl.textContent = '';
      }
    }

    // Record an event in the in-memory buffer (always), then render unless
    // paused (upgrade 6: keep buffering while frozen).
    function ingest(event) {
      buffer.push(event);
      while (buffer.length > MAX_BUFFER) {
        buffer.shift();
      }
      updateCount();

      if (paused) {
        pausedBuffer.push(event);
        updateBufferedIndicator();
        return;
      }
      if (matchesFilter(event)) {
        appendLine(event);
      }
    }

    function flushPaused() {
      // On resume, render any events that arrived while paused.
      for (var i = 0; i < pausedBuffer.length; i += 1) {
        if (matchesFilter(pausedBuffer[i])) {
          appendLine(pausedBuffer[i]);
        }
      }
      pausedBuffer = [];
      updateBufferedIndicator();
    }

    function clearView() {
      buffer = [];
      pausedBuffer = [];
      while (logLines.firstChild) {
        logLines.removeChild(logLines.firstChild);
      }
      updateCount();
      updateBufferedIndicator();
    }

    // --- export (upgrade 7): always the full buffer, not the filtered view ---

    function download(filename, text, mime) {
      var blob = new Blob([text], { type: mime });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Release the object URL on the next tick.
      window.setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 0);
    }

    function exportJson() {
      var name = sanitizeForFilename(channel) + '-' + fileTimestamp() + '.json';
      download(name, JSON.stringify(buffer, null, 2), 'application/json');
    }

    function exportNdjson() {
      var lines = [];
      for (var i = 0; i < buffer.length; i += 1) {
        lines.push(JSON.stringify(buffer[i]));
      }
      var name = sanitizeForFilename(channel) + '-' + fileTimestamp() + '.ndjson';
      download(name, lines.join('\n') + (lines.length ? '\n' : ''), 'application/x-ndjson');
    }

    // --- level toggle bar (upgrade 3) ---

    var levelButtons = {};
    function buildLevelToggle(level) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'level-toggle level-toggle-' + knownLevelClass(level) + ' active';
      btn.textContent = level;
      btn.setAttribute('aria-pressed', 'true');
      btn.addEventListener('click', function () {
        enabledLevels[level] = !enabledLevels[level];
        btn.classList.toggle('active', enabledLevels[level]);
        btn.setAttribute('aria-pressed', enabledLevels[level] ? 'true' : 'false');
        rerender();
      });
      levelButtons[level] = btn;
      levelTogglesEl.appendChild(btn);
    }

    var seededOther = false;
    (function seedLevelToggles() {
      for (var i = 0; i < KNOWN_LEVELS.length; i += 1) {
        buildLevelToggle(KNOWN_LEVELS[i]);
      }
    })();

    // Reveal an 'other' toggle the first time a non-standard level appears.
    function ensureOtherToggle(event) {
      if (seededOther) {
        return;
      }
      if (levelKey(String(event.level || 'info')) === 'other') {
        buildLevelToggle('other');
        seededOther = true;
      }
    }

    // --- WebSocket connection (per panel) ---

    function wsUrl(ch) {
      var proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return proto + '//' + window.location.host + '/?channel=' + encodeURIComponent(ch);
    }

    function scheduleReconnect() {
      if (manualClose || destroyed) {
        return;
      }
      var delay = Math.min(
        RECONNECT_MAX_MS,
        RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts)
      );
      reconnectAttempts += 1;
      setStatus('connecting', 'reconnecting in ' + Math.round(delay / 1000) + 's');
      reconnectTimer = window.setTimeout(function () {
        connect();
      }, delay);
    }

    function connect() {
      if (destroyed) {
        return;
      }
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      manualClose = false;
      setStatus('connecting', 'connecting');

      var ws;
      try {
        ws = new WebSocket(wsUrl(channel));
      } catch (e) {
        scheduleReconnect();
        return;
      }
      socket = ws;

      ws.onopen = function () {
        reconnectAttempts = 0;
        setStatus('connected', 'connected');
      };

      ws.onmessage = function (ev) {
        var msg;
        try {
          msg = JSON.parse(ev.data);
        } catch (e) {
          return;
        }
        if (!msg || typeof msg !== 'object') {
          return;
        }
        if (msg.type === 'history' && Array.isArray(msg.events)) {
          for (var i = 0; i < msg.events.length; i += 1) {
            ensureOtherToggle(msg.events[i]);
            ingest(msg.events[i]);
          }
        } else if (msg.type === 'event' && msg.event) {
          ensureOtherToggle(msg.event);
          ingest(msg.event);
        }
      };

      ws.onclose = function () {
        if (socket === ws) {
          socket = null;
        }
        if (!manualClose && !destroyed) {
          scheduleReconnect();
        }
      };

      ws.onerror = function () {
        if (socket === ws && ws.readyState !== WebSocket.OPEN) {
          setStatus('connecting', 'connection error');
        }
      };
    }

    // --- wire up controls ---

    pauseBtn.addEventListener('click', function () {
      paused = !paused;
      if (paused) {
        pauseBtn.textContent = 'Resume';
        pauseBtn.classList.add('active');
      } else {
        pauseBtn.textContent = 'Pause';
        pauseBtn.classList.remove('active');
        flushPaused();
      }
      updateBufferedIndicator();
    });

    exportJsonBtn.addEventListener('click', exportJson);
    exportNdjsonBtn.addEventListener('click', exportNdjson);
    clearBtn.addEventListener('click', clearView);

    searchInput.addEventListener('input', function () {
      searchText = searchInput.value.trim().toLowerCase();
      rerender();
    });

    logView.addEventListener('scroll', function () {
      var distanceFromBottom =
        logView.scrollHeight - logView.scrollTop - logView.clientHeight;
      stickToBottom = distanceFromBottom < 24;
      autoscrollEl.textContent = 'auto-scroll: ' + (stickToBottom ? 'on' : 'off');
      autoscrollEl.className =
        'panel-autoscroll ' + (stickToBottom ? 'autoscroll-on' : 'autoscroll-off');
    });

    function destroy() {
      destroyed = true;
      manualClose = true;
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket) {
        try {
          socket.close();
        } catch (e) {
          /* ignore */
        }
        socket = null;
      }
      if (root.parentNode) {
        root.parentNode.removeChild(root);
      }
    }

    removeBtn.addEventListener('click', function () {
      removePanel(channel);
    });

    // Mount and connect.
    panelsContainer.appendChild(root);
    updateCount();
    connect();

    return {
      channel: channel,
      root: root,
      destroy: destroy,
    };
  }

  // ---- panel registry -----------------------------------------------------

  function addPanel(channel) {
    channel = String(channel || '').trim() || 'default';
    if (panels[channel]) {
      // Already open; flash it instead of duplicating.
      panels[channel].root.classList.add('flash');
      window.setTimeout(function () {
        if (panels[channel]) {
          panels[channel].root.classList.remove('flash');
        }
      }, 400);
      return;
    }
    panels[channel] = createPanel(channel);
    panelOrder.push(channel);
    saveChannels();
  }

  function removePanel(channel) {
    var panel = panels[channel];
    if (!panel) {
      return;
    }
    panel.destroy();
    delete panels[channel];
    var idx = panelOrder.indexOf(channel);
    if (idx >= 0) {
      panelOrder.splice(idx, 1);
    }
    saveChannels();
  }

  // ---- bootstrap ----------------------------------------------------------

  initTheme();

  addForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var channel = channelInput.value.trim() || 'default';
    channelInput.value = '';
    addPanel(channel);
  });

  // Determine the initial set of channels: ?channel= wins as the first panel,
  // then any persisted channels, else a single 'default' panel.
  var initial = [];
  var qc = queryChannel();
  if (qc) {
    initial.push(qc);
  }
  var saved = loadChannels();
  for (var si = 0; si < saved.length; si += 1) {
    if (initial.indexOf(saved[si]) < 0) {
      initial.push(saved[si]);
    }
  }
  if (initial.length === 0) {
    initial.push('default');
  }
  for (var ii = 0; ii < initial.length; ii += 1) {
    addPanel(initial[ii]);
  }
})();
