/* Read-only same-origin GMGN proxy. Execution is entirely virtual. */
(function (root) {
  'use strict';
  root.HermesGmgn = {
    create: function (options) {
      var stopped = true, paused = false, timer = null, controller = null;
      var seq = 0, account = null, universe = [], names = {}, lastFetch = 0;
      function log(agent, kind, symbol, message, meta) {
        options.emit({ channel: options.channel, level: agent === 'feed' ? 'warn' : 'info',
          message: '[SIMULATED EXECUTION · GMGN] ' + agent + ': ' + message,
          meta: Object.assign({ mode: 'simulated-execution', chain: 'sol', source: 'GMGN',
            agent: agent, kind: kind.replace('paper-', 'simulated-'), address: symbol, symbol: names[symbol] || symbol,
            virtual: true, feeRate: 0.001, slippageRate: 0.0005 }, meta),
          seq: seq++, ts: Date.now() });
      }
      function status(state, text) { options.status(state, text); }
      function schedule() { if (!stopped) timer = options.setTimeout(poll, 25000); }
      async function poll() {
        if (stopped) return;
        if (paused) { schedule(); return; }
        controller = new AbortController();
        var timeout = options.setTimeout(function () { if (controller) controller.abort(); }, 12000);
        try {
          var response = await options.fetch('/api/market', { signal: controller.signal });
          if (!response.ok) throw new Error('Feed unavailable');
          var data = await response.json();
          if (stopped) return;
          if (data.chain !== 'sol' || data.source !== 'GMGN' || !Array.isArray(data.tokens) ||
              !Number.isFinite(data.fetchedAt) || Date.now() - data.fetchedAt > 60000 || data.fetchedAt > Date.now() + 5000) throw new Error('Invalid snapshot');
          if (paused) return;
          if (!account) {
            universe = data.tokens.slice(0, 4).map(function (token) { names[token.address] = token.symbol; return token.address; });
            if (!universe.length) throw new Error('No eligible tokens');
            // Fix the session universe: missing holdings must not silently disappear.
            account = root.HermesPaper.engine(log, Date.now, { symbols: universe, stale: 60000,
              currency: 'USD', sampleLabel: '25-second', source: 'GMGN' });
            log('filter', 'universe', 'ACCOUNT', 'Session tracks ' + universe.length + ' Solana tokens: $100k–$10m cap, ≥$50k liquidity. Filters do not guarantee token safety.', { tokens: data.tokens.slice(0, 4) });
          }
          if (data.fetchedAt <= lastFetch) { status('connecting', 'Waiting for a new GMGN snapshot — execution paused'); return; }
          var complete = universe.every(function (address) {
            return data.tokens.some(function (token) { return token.address === address && token.marketCap >= 100000 && token.marketCap <= 10000000 && token.liquidity >= 50000 && Number.isFinite(token.price) && token.price > 0; });
          });
          if (!complete) { account.resetSignal(); throw new Error('Tracked token absent'); }
          data.tokens.forEach(function (token) {
            if (universe.indexOf(token.address) >= 0) account.quote(token.address, token.price, data.fetchedAt);
          });
          lastFetch = data.fetchedAt;
          if (!account.step()) throw new Error('Stale quotes');
          status('connected', 'GMGN live snapshots · simulated execution');
        } catch (error) {
          if (!stopped && !paused) {
            if (account) account.resetSignal();
            status('connecting', 'GMGN unavailable / tracked token missing — execution paused');
            log('feed', 'paused', 'FEED', 'No valid complete GMGN snapshot. Execution paused; positions retained at last known marks (not current valuations). No synthetic fallback.', {});
          }
        } finally {
          options.clearTimeout(timeout); controller = null; schedule();
        }
      }
      return {
        start: function () {
          if (!stopped) return;
          stopped = false;
          status('connecting', 'Connecting to GMGN — simulated execution paused');
          log('risk', 'rules', 'ACCOUNT', '$10,000 virtual account. $500 cap per token; no leverage or real orders. Prices are snapshots, not executable quotes. Fees/slippage estimates may understate low-cap costs.', {});
          poll();
        },
        stop: function () {
          stopped = true;
          if (timer !== null) options.clearTimeout(timer);
          timer = null;
          if (controller) controller.abort();
        },
        pause: function (value) {
          paused = value;
          if (account) account.resetSignal();
          status('connecting', value ? 'Simulated execution paused by you' : 'Waiting for next GMGN snapshot');
        }
      };
    }
  };
})(typeof window === 'undefined' ? globalThis : window);
