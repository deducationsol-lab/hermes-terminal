(function () {
  'use strict';
  var day = document.getElementById('history-date'), status = document.getElementById('history-status');
  var next = document.getElementById('history-next'), output = document.getElementById('history-events');
  var exportButton = document.getElementById('history-export'), events = [], offset = 0, loading = false;
  day.value = new Date(Date.now() - 4 * 3600000).toISOString().slice(0, 10);
  async function load(reset) {
    if (loading) return; loading = true; next.disabled = true; day.disabled = true;
    if (reset) { events = []; offset = 0; output.textContent = ''; next.hidden = true; exportButton.disabled = true; }
    status.textContent = 'Loading retained logs…';
    try {
      var response = await fetch('/api/history?day=' + encodeURIComponent(day.value) + '&offset=' + offset, { cache: 'no-store' });
      if (!response.ok) throw new Error('History unavailable');
      var data = await response.json(); events = events.concat(data.events); offset = data.nextOffset;
      output.textContent = events.map(function (e) { return JSON.stringify(e); }).join('\n');
      next.hidden = offset === null; exportButton.disabled = !events.length;
      status.textContent = events.length + ' events loaded for ' + day.value + ' (UTC−4)' + (offset === null ? ' · End of retained history for this day' : ' · More available');
    } catch { status.textContent = 'Could not load history. Retry Load day.'; }
    finally { loading = false; next.disabled = false; day.disabled = false; }
  }
  document.getElementById('history-form').addEventListener('submit', function (e) { e.preventDefault(); load(true); });
  next.addEventListener('click', function () { load(false); });
  exportButton.addEventListener('click', function () {
    var url = URL.createObjectURL(new Blob([JSON.stringify(events, null, 2)], { type: 'application/json' }));
    var a = document.createElement('a'); a.href = url; a.download = 'hermes-' + day.value + '-loaded.json'; a.click(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });
  load(true);
})();
