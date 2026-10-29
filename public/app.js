/*
 * Self-contained terminal dashboard for the live log stream.
 *
 * No framework. It reads a channel name (from the input and/or the ?channel=
 * query param), opens a WebSocket to the server, renders 'history' and 'event'
 * messages as color-coded log lines, keeps the view stuck to the bottom unless
 * the user has scrolled up, and reconnects automatically with exponential
 * backoff while showing a visible connection status.
 *
 * Server -> client message protocol (JSON, tagged by `type`):
 *   { type: 'history', events: [...] }  // sent once on connect
 *   { type: 'event', event: {...} }     // sent for each new live event
 */
(function () {
  'use strict';

  var MAX_LINES = 2000;
  var RECONNECT_BASE_MS = 500;
  var RECONNECT_MAX_MS = 15000;

  var form = document.getElementById('connect-form');
  var channelInput = document.getElementById('channel-input');
  var clearBtn = document.getElementById('clear-btn');
  var statusEl = document.getElementById('status');
  var logView = document.getElementById('log-view');
  var logLines = document.getElementById('log-lines');
  var lineCountEl = document.getElementById('line-count');
  var autoscrollEl = document.getElementById('autoscroll-indicator');

  var socket = null;
  var currentChannel = null;
  var reconnectAttempts = 0;
  var reconnectTimer = null;
  var manualClose = false;
  var stickToBottom = true;

  function queryChannel() {
    try {
      var params = new URLSearchParams(window.location.search);
      return params.get('channel');
    } catch (e) {
      return null;
    }
  }

  function setStatus(state, text) {
    statusEl.className = 'status status-' + state;
    statusEl.textContent = text;
  }

  function updateLineCount() {
    var n = logLines.childElementCount;
    lineCountEl.textContent = n + (n === 1 ? ' line' : ' lines');
  }

  function formatTs(ts) {
    var d = new Date(typeof ts === 'number' ? ts : Date.now());
    function pad(n) {
      return (n < 10 ? '0' : '') + n;
    }
    function pad3(n) {
      return (n < 100 ? '0' : '') + (n < 10 ? '0' : '') + n;
    }
    return (
      pad(d.getHours()) +
      ':' +
      pad(d.getMinutes()) +
      ':' +
      pad(d.getSeconds()) +
      '.' +
      pad3(d.getMilliseconds())
    );
  }

  function knownLevel(level) {
    switch (level) {
      case 'debug':
      case 'info':
      case 'warn':
      case 'error':
        return level;
      default:
        return 'info';
    }
  }

  function renderEvent(event) {
    var line = document.createElement('div');
    line.className = 'log-line level-' + knownLevel(event.level);

    var ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = formatTs(event.ts);

    var level = document.createElement('span');
    level.className = 'level';
    level.textContent = String(event.level || 'info');

    var message = document.createElement('span');
    message.className = 'message';
    message.textContent = String(event.message == null ? '' : event.message);

    line.appendChild(ts);
    line.appendChild(level);
    line.appendChild(message);

    if (event.meta && typeof event.meta === 'object') {
      var meta = document.createElement('span');
      meta.className = 'meta';
      try {
        meta.textContent = JSON.stringify(event.meta);
      } catch (e) {
        meta.textContent = '[meta]';
      }
      line.appendChild(meta);
    }

    logLines.appendChild(line);

    // Trim old lines to bound memory/DOM size.
    while (logLines.childElementCount > MAX_LINES) {
      logLines.removeChild(logLines.firstChild);
    }

    updateLineCount();
    if (stickToBottom) {
      scrollToBottom();
    }
  }

  function scrollToBottom() {
    logView.scrollTop = logView.scrollHeight;
  }

  function clearLines() {
    while (logLines.firstChild) {
      logLines.removeChild(logLines.firstChild);
    }
    updateLineCount();
  }

  function wsUrl(channel) {
    var proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return (
      proto +
      '//' +
      window.location.host +
      '/?channel=' +
      encodeURIComponent(channel)
    );
  }

  function scheduleReconnect() {
    if (manualClose) {
      return;
    }
    var delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts)
    );
    reconnectAttempts += 1;
    setStatus('connecting', 'reconnecting in ' + Math.round(delay / 1000) + 's');
    reconnectTimer = window.setTimeout(function () {
      connect(currentChannel);
    }, delay);
  }

  function connect(channel) {
    if (reconnectTimer) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    // Close any existing socket cleanly before opening a new one.
    if (socket) {
      manualClose = true;
      try {
        socket.close();
      } catch (e) {
        /* ignore */
      }
      socket = null;
    }

    currentChannel = channel;
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
      setStatus('connected', 'connected: ' + channel);
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
          renderEvent(msg.events[i]);
        }
      } else if (msg.type === 'event' && msg.event) {
        renderEvent(msg.event);
      }
    };

    ws.onclose = function () {
      if (socket === ws) {
        socket = null;
      }
      if (!manualClose) {
        scheduleReconnect();
      }
    };

    ws.onerror = function () {
      // Let onclose drive reconnection; just surface the state.
      if (socket === ws && ws.readyState !== WebSocket.OPEN) {
        setStatus('connecting', 'connection error');
      }
    };
  }

  // Keep the view stuck to the bottom unless the user scrolls up.
  logView.addEventListener('scroll', function () {
    var distanceFromBottom =
      logView.scrollHeight - logView.scrollTop - logView.clientHeight;
    stickToBottom = distanceFromBottom < 24;
    autoscrollEl.textContent = 'auto-scroll: ' + (stickToBottom ? 'on' : 'off');
    autoscrollEl.className = stickToBottom ? 'autoscroll-on' : 'autoscroll-off';
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var channel = channelInput.value.trim() || 'default';
    channelInput.value = channel;
    clearLines();
    connect(channel);
  });

  clearBtn.addEventListener('click', function () {
    clearLines();
  });

  // Initial channel: query param wins, else input placeholder default.
  var initialChannel = queryChannel();
  if (initialChannel) {
    channelInput.value = initialChannel;
  }
  var startChannel = channelInput.value.trim() || 'default';
  channelInput.value = startChannel;
  connect(startChannel);
})();
