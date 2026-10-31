/* Browser-only synthetic agent producer. No network, credentials or real data. */
(function (root) {
  'use strict';
  var steps = [
    ['scout', 'scan', 'Scanning synthetic candidates', 'debug'],
    ['filter', 'accept', 'Candidate passed Omniagents screening', 'info'],
    ['analyst', 'score', 'Evaluating synthetic signals', 'info'],
    ['risk', 'review', 'Checking Omniagents exposure limits', 'warn'],
    ['executor', 'paper-fill', 'Recorded a synthetic paper fill — no real execution', 'info'],
    ['logger', 'summary', 'Agent cycle complete; logs retained in this browser only', 'info']
  ];
  root.HermesShowcase = {
    create: function (options) {
      var seq = 0;
      var timer = null;
      var paused = false;
      function tick() {
        if (paused) return;
        var step = steps[seq % steps.length];
        var cycle = Math.floor(seq / steps.length) + 1;
        options.emit({
          channel: options.channel,
          level: step[3],
          message: '[Omniagents] ' + step[0] + ': ' + step[2],
          meta: { mode: 'simulation', agent: step[0], kind: step[1],
            symbol: 'SIM-' + cycle, cycle: cycle, synthetic: true },
          ts: Date.now(), seq: seq++
        });
      }
      function stop() {
        if (timer !== null) options.clearInterval(timer);
        timer = null;
      }
      return {
        start: function () {
          if (timer !== null) return;
          tick();
          timer = options.setInterval(tick, 850);
        },
        stop: stop,
        pause: function (value) { paused = value; }
      };
    }
  };
})(typeof window === 'undefined' ? globalThis : window);
