/* Read-only viewer: closing, pausing or clearing this tab never controls the runner. */
(function (root) {
  'use strict';
  root.HermesBackground = {
    create: function (options) {
      var stopped = true, timer = null, controller = null, seen = -1;
      async function poll() {
        if (stopped) return;
        controller = new AbortController();
        var timeout = options.setTimeout(function () { if (controller) controller.abort(); }, 10000);
        try {
          var response = await options.fetch('/api/background', { signal: controller.signal, cache: 'no-store' });
          if (!response.ok) throw new Error('Unavailable');
          var data = await response.json();
          if (stopped) return;
          if (!Array.isArray(data.events)) throw new Error('Invalid state');
          data.events.forEach(function (event) {
            if (Number.isFinite(event.seq) && event.seq > seen) { options.emit(event); seen = event.seq; }
          });
          var stale = !Number.isFinite(data.lastAttempt) || Date.now() - data.lastAttempt > 180000;
          var healthy = !stale && Number.isFinite(data.lastSuccess) && Date.now() - data.lastSuccess <= 180000;
          var daily = data.snapshot && data.snapshot.daily;
          options.status(healthy ? 'connected' : 'connecting', data.status + (daily ? ' · Day ' + daily.day + ' UTC−4 · Daily P/L $' + daily.pnl.toFixed(2) + (daily.enabled === false ? ' · Daily loss pause OFF' : ' / −$5,000 limit') : '') +
            (data.lastAttempt ? ' · Last attempt ' + new Date(data.lastAttempt).toLocaleTimeString() : '') +
            (stale ? ' · Awaiting scheduler / delayed' : ' · Runs with tab closed') +
            (data.snapshot && data.snapshot.staleMarks.length ? ' · Stale holding marks: ' + data.snapshot.staleMarks.length : ''));
        } catch {
          if (!stopped) options.status('connecting', 'Cannot read background status — this does not stop the server');
        } finally {
          options.clearTimeout(timeout); controller = null;
          if (!stopped) timer = options.setTimeout(poll, 15000);
        }
      }
      return {
        start: function () { if (!stopped) return; stopped = false; options.status('connecting', 'Loading persistent background account'); poll(); },
        stop: function () { stopped = true; if (timer !== null) options.clearTimeout(timer); timer = null; if (controller) controller.abort(); },
        pause: function () {} // The panel buffers rendering; the server keeps running.
      };
    }
  };
})(typeof window === 'undefined' ? globalThis : window);
