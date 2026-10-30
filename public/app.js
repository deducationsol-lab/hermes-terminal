/*
 * Self-contained terminal dashboard for the live log stream.
 *
 * No framework, no build step. The page hosts one or more independent log
 * panels laid out side by side. Each panel:
 *   - owns a single channel name and its own live connection via a transport
 *     abstraction (WebSocket for the local/long-process server with the
 *     original per-connection exponential-backoff reconnect, or SSE for
 *     serverless/Vercel deploys), with a visible status,
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

  var selectedMode = new URLSearchParams(window.location.search).get('mode');
  var showcaseMode = selectedMode !== 'live';
  var paperMode = showcaseMode && selectedMode !== 'synthetic';

  var MAX_BUFFER = 2000; // max events retained in memory per panel
  var MAX_LINES = 2000; // max rendered DOM lines per panel
  var RECONNECT_BASE_MS = 500;
  var RECONNECT_MAX_MS = 15000;

  var KNOWN_LEVELS = ['debug', 'info', 'warn', 'error'];
  var STORAGE_CHANNELS = 'hermes.channels';
  var STORAGE_THEME = 'hermes.theme';
  var STORAGE_TICKER = 'hermes.ticker';
  var THEMES = ['midnight', 'light', 'ocean', 'amber'];
  var METRICS_WINDOW_MS = 1000; // trailing window for events/sec
  var METRICS_INTERVAL_MS = 750; // how often the metrics strip refreshes

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

  // Mirror of the authoritative pure logic in src/metrics.ts. Kept tiny and
  // consistent: total is the buffer length, perLevel counts by raw level
  // string (custom levels included), and eventsPerSec counts events whose ts
  // falls within the trailing window (nowMs - windowMs, nowMs] scaled to /sec.
  function computeMetrics(events, nowMs, windowMs) {
    windowMs = windowMs || METRICS_WINDOW_MS;
    var perLevel = {};
    var inWindow = 0;
    var windowStart = nowMs - windowMs;
    for (var i = 0; i < events.length; i += 1) {
      var ev = events[i];
      var lvl = typeof ev.level === 'string' && ev.level.length > 0 ? ev.level : 'info';
      perLevel[lvl] = (perLevel[lvl] || 0) + 1;
      var ts = ev.ts;
      if (typeof ts === 'number' && ts > windowStart && ts <= nowMs) {
        inWindow += 1;
      }
    }
    return {
      total: events.length,
      perLevel: perLevel,
      eventsPerSec: windowMs > 0 ? (inWindow * 1000) / windowMs : 0,
    };
  }

  // Render an arbitrary meta value as a short, safe string for the ticker /
  // metrics labels. Objects are JSON.stringify'd; everything is plain text.
  function valueToText(value) {
    if (value == null) {
      return '';
    }
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch (e) {
        return '[object]';
      }
    }
    return String(value);
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
    if (showcaseMode) return;
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

  // ---- Generic ticker strip (upgrade 5) -----------------------------------

  /*
   * The ticker is fully generic: it tracks the most-recent value seen for each
   * meta key across every CURRENTLY-OPEN panel's stream and renders
   * label=value chips. It makes NO domain assumptions - keys and values come
   * straight from the producer's meta objects and are treated as untrusted
   * (textContent only). The user can toggle the ticker on/off and choose which
   * discovered keys to show; this config persists to localStorage.
   *
   * Lifecycle: observed keys/values are scoped to panels, not the page. Each
   * panel registers a source (ticker.register) and feeds its own events into
   * it; removing a panel unregisters the source and a panel Clear resets it.
   * The discovered-key set and latest values are then recomputed from only the
   * sources that are still open, so a chip never shows a stale value from a
   * channel that is no longer present.
   */
  var ticker = (function () {
    var tickerEl = document.getElementById('ticker');
    var toggleBtn = document.getElementById('ticker-toggle');
    var chipsEl = document.getElementById('ticker-chips');
    var configBtn = document.getElementById('ticker-config-btn');
    var configEl = document.getElementById('ticker-config');
    var keysEl = document.getElementById('ticker-keys');

    // Per-panel sources, in registration order. Each source owns the most
    // recent value it has seen for each meta key plus a monotonically
    // increasing sequence used to resolve "latest across sources".
    var sources = []; // { latest: {key: {value, seq}} }
    var observeSeq = 0; // global monotonic counter across all sources

    // Aggregated view, recomputed from the live sources only.
    var latest = {}; // key -> most-recent value across open sources
    var discovered = []; // key names in the order first seen (live sources)
    // Explicitly selected keys. null means "auto": show all discovered keys.
    var selected = null;
    var enabled = true;
    var dirty = false; // chips need a re-render

    // Recompute `latest`/`discovered` from only the currently-registered
    // sources. Discovery order is the order each key was first observed (by
    // sequence), and each key's value is the one with the highest sequence,
    // so removing a panel drops the keys only it contributed and reverts a
    // shared key to whatever the remaining open panels last reported.
    function recompute() {
      var winners = {}; // key -> {value, seq}
      for (var s = 0; s < sources.length; s += 1) {
        var src = sources[s].latest;
        for (var key in src) {
          if (!Object.prototype.hasOwnProperty.call(src, key)) {
            continue;
          }
          var entry = src[key];
          if (
            !Object.prototype.hasOwnProperty.call(winners, key) ||
            entry.seq > winners[key].seq
          ) {
            winners[key] = { value: entry.value, seq: entry.seq, first: entry.first };
          } else if (entry.first < winners[key].first) {
            winners[key].first = entry.first;
          }
        }
      }
      var keys = [];
      for (var k in winners) {
        if (Object.prototype.hasOwnProperty.call(winners, k)) {
          keys.push(k);
        }
      }
      keys.sort(function (a, b) {
        return winners[a].first - winners[b].first;
      });
      latest = {};
      discovered = [];
      for (var i = 0; i < keys.length; i += 1) {
        discovered.push(keys[i]);
        latest[keys[i]] = winners[keys[i]].value;
      }
      dirty = true;
    }

    function loadConfig() {
      try {
        var raw = window.localStorage.getItem(STORAGE_TICKER);
        if (!raw) {
          return;
        }
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          if (typeof parsed.enabled === 'boolean') {
            enabled = parsed.enabled;
          }
          if (Array.isArray(parsed.keys)) {
            selected = parsed.keys.filter(function (k) {
              return typeof k === 'string';
            });
          }
        }
      } catch (e) {
        /* ignore malformed config */
      }
    }

    function saveConfig() {
      try {
        window.localStorage.setItem(
          STORAGE_TICKER,
          JSON.stringify({ enabled: enabled, keys: selected })
        );
      } catch (e) {
        /* ignore */
      }
    }

    function isSelected(key) {
      return selected === null ? true : selected.indexOf(key) >= 0;
    }

    function visibleKeys() {
      var out = [];
      for (var i = 0; i < discovered.length; i += 1) {
        if (isSelected(discovered[i])) {
          out.push(discovered[i]);
        }
      }
      return out;
    }

    // Register a panel as a ticker source. Returns a small handle the panel
    // uses to feed events, reset (on Clear), and unregister (on removal).
    function register() {
      var source = { latest: {} };
      sources.push(source);

      function observe(event) {
        if (!event || typeof event.meta !== 'object' || event.meta === null) {
          return;
        }
        var meta = event.meta;
        var touched = false;
        for (var key in meta) {
          if (!Object.prototype.hasOwnProperty.call(meta, key)) {
            continue;
          }
          observeSeq += 1;
          var first = Object.prototype.hasOwnProperty.call(source.latest, key)
            ? source.latest[key].first
            : observeSeq;
          source.latest[key] = { value: meta[key], seq: observeSeq, first: first };
          touched = true;
        }
        if (touched) {
          recompute();
        }
      }

      function reset() {
        // Panel Clear: drop this source's contributed keys/values.
        source.latest = {};
        recompute();
      }

      function unregister() {
        var idx = sources.indexOf(source);
        if (idx >= 0) {
          sources.splice(idx, 1);
          recompute();
        }
      }

      return { observe: observe, reset: reset, unregister: unregister };
    }

    function renderChips() {
      while (chipsEl.firstChild) {
        chipsEl.removeChild(chipsEl.firstChild);
      }
      if (!enabled) {
        return;
      }
      var keys = visibleKeys();
      for (var i = 0; i < keys.length; i += 1) {
        var key = keys[i];
        var chip = document.createElement('span');
        chip.className = 'ticker-chip';

        var labelEl = document.createElement('span');
        labelEl.className = 'ticker-chip-key';
        labelEl.textContent = key; // untrusted producer key -> textContent

        var sep = document.createElement('span');
        sep.className = 'ticker-chip-sep';
        sep.textContent = '=';

        var valueEl = document.createElement('span');
        valueEl.className = 'ticker-chip-value';
        valueEl.textContent = valueToText(latest[key]); // untrusted value

        chip.appendChild(labelEl);
        chip.appendChild(sep);
        chip.appendChild(valueEl);
        chipsEl.appendChild(chip);
      }
      if (keys.length === 0) {
        var empty = document.createElement('span');
        empty.className = 'ticker-empty';
        empty.textContent = 'waiting for meta...';
        chipsEl.appendChild(empty);
      }
    }

    function renderKeyChooser() {
      while (keysEl.firstChild) {
        keysEl.removeChild(keysEl.firstChild);
      }
      if (discovered.length === 0) {
        var none = document.createElement('span');
        none.className = 'ticker-empty';
        none.textContent = 'no meta keys discovered yet';
        keysEl.appendChild(none);
        return;
      }
      for (var i = 0; i < discovered.length; i += 1) {
        (function (key) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'ticker-key' + (isSelected(key) ? ' active' : '');
          btn.textContent = key; // untrusted key -> textContent
          btn.setAttribute('aria-pressed', isSelected(key) ? 'true' : 'false');
          btn.addEventListener('click', function () {
            // First explicit choice materialises the current auto set.
            if (selected === null) {
              selected = visibleKeys();
            }
            var idx = selected.indexOf(key);
            if (idx >= 0) {
              selected.splice(idx, 1);
            } else {
              selected.push(key);
            }
            saveConfig();
            renderKeyChooser();
            renderChips();
          });
          keysEl.appendChild(btn);
        })(discovered[i]);
      }
    }

    function applyEnabled() {
      tickerEl.hidden = false; // the strip shell is always present once started
      toggleBtn.classList.toggle('active', enabled);
      toggleBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
      chipsEl.hidden = !enabled;
      configBtn.hidden = !enabled;
      if (!enabled) {
        configEl.hidden = true;
        configBtn.setAttribute('aria-expanded', 'false');
      }
    }

    function start() {
      loadConfig();
      applyEnabled();
      renderChips();

      toggleBtn.addEventListener('click', function () {
        enabled = !enabled;
        applyEnabled();
        renderChips();
        saveConfig();
      });

      configBtn.addEventListener('click', function () {
        var open = configEl.hidden;
        configEl.hidden = !open;
        configBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) {
          renderKeyChooser();
        }
      });

      // Refresh chips (and the open chooser) on a timer so a burst of events
      // does not thrash the DOM.
      window.setInterval(function () {
        if (!dirty) {
          return;
        }
        dirty = false;
        renderChips();
        if (!configEl.hidden) {
          renderKeyChooser();
        }
      }, 500);
    }

    return { start: start, register: register };
  })();

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
    var metricRateEl = root.querySelector('.metric-rate-value');
    var metricTotalEl = root.querySelector('.metric-total-value');
    var metricLevelsEl = root.querySelector('.metric-levels');
    var metricConnEl = root.querySelector('.metric-conn-value');
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
    var droppedWhilePaused = 0; // events dropped from pausedBuffer when capped
    var paused = false;
    var stickToBottom = true;

    // Seq-based de-duplication. The SSE transport is routinely recycled at the
    // platform maxDuration; EventSource then auto-reconnects and the server
    // replays the FULL {type:'history'} envelope, so the same events arrive
    // again. We skip any event whose seq we have already rendered for this
    // channel so a reconnect does not duplicate lines. The first connection's
    // history replay still renders once (nothing seen yet). The WebSocket path
    // is unaffected: it also carries monotonic per-channel seq, and its single
    // history-then-live sequence has no repeats, so dedup is a no-op there.
    // Events without a numeric seq (should not happen) are never deduped.
    // This state is reset by clearView() so a Clear + re-subscribe replays
    // correctly.
    var seenSeqs = Object.create(null);
    function alreadySeen(event) {
      if (!event || typeof event.seq !== 'number') {
        return false;
      }
      var key = String(event.seq);
      if (seenSeqs[key]) {
        return true;
      }
      seenSeqs[key] = true;
      return false;
    }

    // This panel's slice of the generic ticker. Scoped to the panel so its
    // discovered keys/values are pruned when the panel is Cleared or removed.
    var tickerSource = ticker.register();

    // Enabled levels: all known + 'other' on by default.
    var enabledLevels = {};
    var li;
    for (li = 0; li < KNOWN_LEVELS.length; li += 1) {
      enabledLevels[KNOWN_LEVELS[li]] = true;
    }
    enabledLevels.other = true;

    var searchText = '';

    // --- connection state ---
    // The active transport (WebSocket or SSE). Both implement the same tiny
    // interface: start() opens the connection and stop() tears it down. A
    // transport reports status through setStatus() and feeds parsed events
    // through the shared handleServerMessage() pipeline below.
    var transport = null;
    var destroyed = false;

    // --- rendering helpers ---

    // Seed with a concrete initial status so the metrics strip's conn value
    // carries a status color class on its very first render, before the WS
    // lifecycle callbacks fire (avoids a brief uncolored template default).
    var connState = 'connecting';
    function setStatus(state, text) {
      connState = state;
      statusEl.className = 'panel-status status status-' + state;
      statusEl.textContent = text;
      if (metricConnEl) {
        metricConnEl.className = 'metric-value metric-conn-value status-text-' + state;
        metricConnEl.textContent = state;
      }
    }

    // --- metrics strip (upgrade 4) ---

    var metricsTimer = null;

    // Order levels for display: known levels first, then any custom levels
    // discovered in the buffer, alphabetically for stability.
    function orderedLevels(perLevel) {
      var out = [];
      for (var i = 0; i < KNOWN_LEVELS.length; i += 1) {
        if (Object.prototype.hasOwnProperty.call(perLevel, KNOWN_LEVELS[i])) {
          out.push(KNOWN_LEVELS[i]);
        }
      }
      var custom = [];
      for (var key in perLevel) {
        if (
          Object.prototype.hasOwnProperty.call(perLevel, key) &&
          KNOWN_LEVELS.indexOf(key) < 0
        ) {
          custom.push(key);
        }
      }
      custom.sort();
      return out.concat(custom);
    }

    function renderMetrics() {
      var m = computeMetrics(buffer, Date.now(), METRICS_WINDOW_MS);
      // One decimal place keeps the rate readable without jitter.
      metricRateEl.textContent = (Math.round(m.eventsPerSec * 10) / 10).toString();
      metricTotalEl.textContent = String(m.total);
      // Keep the conn metric in sync with the current connection state so the
      // first render (before the WS callbacks) is already colored.
      if (metricConnEl) {
        metricConnEl.className = 'metric-value metric-conn-value status-text-' + connState;
        metricConnEl.textContent = connState;
      }

      while (metricLevelsEl.firstChild) {
        metricLevelsEl.removeChild(metricLevelsEl.firstChild);
      }
      var levels = orderedLevels(m.perLevel);
      for (var i = 0; i < levels.length; i += 1) {
        var lvl = levels[i];
        var chip = document.createElement('span');
        chip.className = 'metric metric-level level-' + knownLevelClass(lvl);
        var label = document.createElement('span');
        label.className = 'metric-label';
        label.textContent = lvl; // level string may be custom -> textContent
        var value = document.createElement('span');
        value.className = 'metric-value';
        value.textContent = String(m.perLevel[lvl]);
        chip.appendChild(label);
        chip.appendChild(value);
        metricLevelsEl.appendChild(chip);
      }
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

      if (event.meta && event.meta.mode === 'simulated-execution' && event.meta.kind === 'pair-check' &&
          event.meta.highlightedQuote === true && ['WSOL', 'USDC', 'USD1', 'SOL'].indexOf(event.meta.quoteSymbol) >= 0) {
        var pairBadge = document.createElement('span');
        pairBadge.className = 'pair-badge';
        pairBadge.textContent = 'PAIR ' + event.meta.quoteSymbol;
        head.appendChild(pairBadge);
      }

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
        var text = 'paused - ' + n + ' buffered';
        if (droppedWhilePaused > 0) {
          // The pause buffer is capped at MAX_BUFFER; report any overflow so
          // the count stays truthful about what resume will actually render.
          text += ' (' + droppedWhilePaused + ' dropped)';
        }
        bufferedEl.hidden = false;
        bufferedEl.textContent = text;
      } else {
        bufferedEl.hidden = true;
        bufferedEl.textContent = '';
      }
    }

    // Record an event in the in-memory buffer (always), then render unless
    // paused (upgrade 6: keep buffering while frozen).
    function ingest(event) {
      // Skip events already rendered for this channel (e.g. a history replay
      // after an SSE reconnect). See seenSeqs above.
      if (alreadySeen(event)) {
        return;
      }
      buffer.push(event);
      while (buffer.length > MAX_BUFFER) {
        buffer.shift();
      }
      updateCount();
      tickerSource.observe(event);

      if (paused) {
        pausedBuffer.push(event);
        // Bound the pause buffer like the main buffer: a long pause under high
        // throughput drops the oldest buffered events rather than growing
        // memory without limit. The indicator reports what is actually kept.
        while (pausedBuffer.length > MAX_BUFFER) {
          pausedBuffer.shift();
          droppedWhilePaused += 1;
        }
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
      droppedWhilePaused = 0;
      updateBufferedIndicator();
    }

    function clearView() {
      buffer = [];
      pausedBuffer = [];
      droppedWhilePaused = 0;
      // Reset the seq dedup set so a re-subscribe (or reconnect after Clear)
      // replays the recent history into the now-empty view instead of being
      // suppressed as "already seen".
      seenSeqs = Object.create(null);
      // Clearing a panel also drops the meta keys it contributed to the
      // ticker, so the ticker keeps reflecting currently-live state.
      tickerSource.reset();
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

    // --- transport abstraction (per panel) ---
    //
    // A panel is driven by a transport object with start()/stop(). Both the
    // WebSocket and the SSE transport share one message handler: each server
    // message is a JSON envelope tagged by `type` ({type:'history',events} on
    // connect, then {type:'event',event} per live event). The handler parses
    // the raw string and feeds events through ensureOtherToggle()/ingest().
    // This is the SAME shape over both wires, so the parsing logic is shared
    // and the two transports differ only in how they open/close a connection.

    // Parse one raw server message string and feed it into the pipeline. Used
    // identically by the WebSocket onmessage and the SSE EventSource onmessage.
    function handleServerMessage(raw) {
      var msg;
      try {
        msg = JSON.parse(raw);
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
    }

    // WebSocket transport: identical behavior to the original dashboard.
    // Connects to ws(s)://host/?channel=NAME and reconnects with the same
    // exponential backoff (RECONNECT_BASE_MS..RECONNECT_MAX_MS). Used for the
    // local / long-process node server (npm start).
    function createWebSocketTransport() {
      var socket = null;
      var reconnectAttempts = 0;
      var reconnectTimer = null;
      var manualClose = false;
      var stopped = false;

      function wsUrl(ch) {
        var proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return proto + '//' + window.location.host + '/?channel=' + encodeURIComponent(ch);
      }

      function scheduleReconnect() {
        if (manualClose || stopped || destroyed) {
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
        if (stopped || destroyed) {
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
          handleServerMessage(ev.data);
        };

        ws.onclose = function () {
          if (socket === ws) {
            socket = null;
          }
          if (!manualClose && !stopped && !destroyed) {
            scheduleReconnect();
          }
        };

        ws.onerror = function () {
          if (socket === ws && ws.readyState !== WebSocket.OPEN) {
            setStatus('connecting', 'connection error');
          }
        };
      }

      function start() {
        stopped = false;
        connect();
      }

      function stop() {
        stopped = true;
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
      }

      return { start: start, stop: stop };
    }

    // SSE transport: opens an EventSource to /api/stream?channel=NAME. The
    // serverless backend (FEAT-002) sends the SAME tagged envelope framing on
    // the default message event: one {type:'history',events} message on
    // connect, then {type:'event',event} per live event, with ':' heartbeat
    // comment lines that EventSource ignores automatically. So the message
    // handler is shared with the WebSocket path. EventSource provides its own
    // automatic reconnect, so this transport only maps onopen/onerror to the
    // existing status indicator (and hence the conn metric). Used on Vercel,
    // which does not run long-lived WebSocket servers.
    function createSseTransport() {
      var source = null;
      var stopped = false;

      function sseUrl(ch) {
        return '/api/stream?channel=' + encodeURIComponent(ch);
      }

      function start() {
        stopped = false;
        setStatus('connecting', 'connecting');
        try {
          source = new EventSource(sseUrl(channel));
        } catch (e) {
          setStatus('connecting', 'connection error');
          return;
        }
        source.onopen = function () {
          setStatus('connected', 'connected');
        };
        source.onmessage = function (ev) {
          handleServerMessage(ev.data);
        };
        source.onerror = function () {
          // EventSource auto-reconnects; reflect the interim state so the
          // status indicator and conn metric behave like the WS path.
          if (!stopped && !destroyed) {
            setStatus('connecting', 'reconnecting');
          }
        };
      }

      function stop() {
        stopped = true;
        if (source) {
          try {
            source.close();
          } catch (e) {
            /* ignore */
          }
          source = null;
        }
      }

      return { start: start, stop: stop };
    }

    // Transport auto-detection (no build step; the dashboard is framework-free
    // and ships as static files). The chosen transport is decided at runtime
    // from the page environment:
    //   1. An explicit override wins: a global `window.HERMES_TRANSPORT` set to
    //      'sse' or 'ws' (e.g. injected by an inline <script> or a static
    //      config file) forces that transport.
    //   2. Otherwise, if the page is served from a Vercel deployment host
    //      (hostname ends with '.vercel.app'), use SSE, because Vercel has no
    //      long-lived WebSocket server to connect to.
    //   3. Otherwise default to WebSocket, so the local `npm start`
    //      long-process server behaves exactly as before.
    function createTransport() {
      if (showcaseMode) {
        var demo = paperMode ? window.HermesBackground.create({
          channel: channel, emit: ingest, status: setStatus,
          fetch: window.fetch.bind(window),
          setInterval: window.setInterval.bind(window), clearInterval: window.clearInterval.bind(window),
          setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window)
        }) : window.HermesShowcase.create({
          channel: channel,
          emit: ingest,
          setInterval: window.setInterval.bind(window),
          clearInterval: window.clearInterval.bind(window)
        });
        return {
          start: function () { if (!paperMode) setStatus('connected', 'simulated showcase'); demo.start(); },
          stop: demo.stop,
          pause: demo.pause
        };
      }
      var forced = typeof window.HERMES_TRANSPORT === 'string'
        ? window.HERMES_TRANSPORT.toLowerCase()
        : '';
      if (forced === 'sse') {
        return createSseTransport();
      }
      if (forced === 'ws' || forced === 'websocket') {
        return createWebSocketTransport();
      }
      var host = window.location.hostname || '';
      var onVercel = /\.vercel\.app$/i.test(host);
      if (onVercel) {
        return createSseTransport();
      }
      return createWebSocketTransport();
    }

    // --- wire up controls ---

    pauseBtn.addEventListener('click', function () {
      paused = !paused;
      if (transport && transport.pause) transport.pause(paused);
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
      // Prune this panel's contribution so the ticker no longer shows keys or
      // values sourced from a channel that is no longer open.
      tickerSource.unregister();
      if (metricsTimer) {
        window.clearInterval(metricsTimer);
        metricsTimer = null;
      }
      if (transport) {
        transport.stop();
        transport = null;
      }
      if (root.parentNode) {
        root.parentNode.removeChild(root);
      }
    }

    removeBtn.addEventListener('click', function () {
      removePanel(channel);
    });

    // Mount and connect. The panel auto-connects immediately via the
    // runtime-selected transport (no manual Connect click).
    panelsContainer.appendChild(root);
    updateCount();
    renderMetrics();
    metricsTimer = window.setInterval(renderMetrics, METRICS_INTERVAL_MS);
    transport = createTransport();
    transport.start();

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

  var modeTitle = document.getElementById('mode-title');
  var modeDescription = document.getElementById('mode-description');
  var modeLink = document.getElementById('mode-link');
  var restartButton = document.getElementById('showcase-restart');
  var tokenFilters = document.getElementById('token-filters');
  tokenFilters.hidden = !paperMode;
  tokenFilters.textContent = '5m OR 1h trending · Market cap ≥$5,000 · Volume ≥$1,000 in matching window · Liquidity ≥$1,500 · Top 10 holders 12–28% · Age ≤500 min · ≥1 social · Mint/freeze revoked + LP burned required; unknowns rejected. Quote highlights: WSOL / USDC / USD1 / SOL (GMGN-reported).';
  modeTitle.textContent = paperMode ? 'GMGN Solana · Simulated execution' : showcaseMode ? 'Simulated agent showcase' : 'Real log stream';
  modeDescription.textContent = paperMode
    ? 'Daily loss budget $5,000 · Day resets at midnight UTC−4; remaining balance retained · One buy per mint · AUTO-RUN ON SERVER · Continues when this tab is closed · Shared persistent account · About once per minute (may miss M1 windows) · Pause/Clear affect this viewer only · Solana · $10,000 virtual · Max 5% of initial capital/buy ($500 incl. fees) · Next-candle entry: last M1 hammer/inverted hammer OR last two M1/M5 bullish engulfing · Stop −35% · +50%: sell 90% · Moonbag: no stop, sell 90% at 5× and again at 10× entry. No real orders.'
    : showcaseMode
    ? 'Synthetic browser-only events. No real market data, funds, or execution. Nothing is sent to Redis.'
    : 'Waiting for events from your producers. Simulation is off.';
  modeLink.textContent = showcaseMode ? 'Switch to producer logs' : 'Start GMGN showcase';
  modeLink.href = showcaseMode ? '/?mode=live&channel=desk' : '/';
  restartButton.hidden = !showcaseMode || paperMode;
  restartButton.textContent = paperMode ? 'Reset virtual account' : 'Restart showcase';
  restartButton.addEventListener('click', function () {
    var channels = panelOrder.slice();
    for (var i = 0; i < channels.length; i += 1) removePanel(channels[i]);
    addPanel(paperMode ? 'solana-desk' : 'showcase');
  });
  window.addEventListener('pagehide', function () {
    for (var i = 0; i < panelOrder.length; i += 1) panels[panelOrder[i]].destroy();
  });
  window.addEventListener('pageshow', function (event) {
    if (event.persisted) window.location.reload();
  });

  initTheme();
  ticker.start();

  addForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var channel = channelInput.value.trim() || 'default';
    channelInput.value = '';
    addPanel(channel);
  });

  // Determine the initial set of channels and AUTO-CONNECT on load (no manual
  // Connect/Add-panel click): ?channel= wins as the first panel, then any
  // persisted channels, else a single auto-panel on channel 'demo'. The 'demo'
  // default is a dashboard bootstrap concern only; the raw WebSocket server
  // keeps its own 'default' channel for connections without a ?channel= param.
  var initial = [];
  var qc = showcaseMode ? (paperMode ? 'solana-desk' : 'showcase') : queryChannel();
  if (qc) {
    initial.push(qc);
  }
  var saved = showcaseMode ? [] : loadChannels();
  for (var si = 0; si < saved.length; si += 1) {
    if (initial.indexOf(saved[si]) < 0) {
      initial.push(saved[si]);
    }
  }
  if (initial.length === 0) {
    initial.push('demo');
  }
  for (var ii = 0; ii < initial.length; ii += 1) {
    addPanel(initial[ii]);
  }
})();
