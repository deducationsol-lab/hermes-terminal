/* GMGN snapshots/candles through same-origin read-only routes. All fills virtual. */
(function (root) {
  'use strict';
  root.HermesGmgn = {
    create: function (options) {
      var stopped = true, paused = false, timer = null, controller = null, seq = 0;
      var watch = [], names = {}, lastFetch = 0, cursor = 0, holdingCursor = 0;
      function log(agent, kind, address, message, meta) {
        options.emit({ channel: options.channel, level: agent === 'feed' || agent === 'risk' ? 'warn' : 'info',
          message: '[Omniagents · GMGN] ' + agent + ': ' + message,
          meta: Object.assign({ mode: 'simulated-execution', chain: 'sol', source: 'GMGN', agent: agent,
            kind: kind, address: address, symbol: names[address] || address, virtual: true }, meta),
          seq: seq++, ts: Date.now() });
      }
      var account = root.HermesRules.create(log, Date.now);
      function status(state, text) { options.status(state, text); }
      function schedule() { if (!stopped) timer = options.setTimeout(poll, 25000); }
      async function read(path) {
        var response = await options.fetch(path, { signal: controller.signal });
        if (!response.ok) throw new Error('Feed unavailable');
        return response.json();
      }
      async function poll() {
        if (stopped) return;
        if (paused) { schedule(); return; }
        controller = new AbortController();
        var timeout = options.setTimeout(function () { if (controller) controller.abort(); }, 65000);
        try {
          var data = await read('/api/market');
          if (stopped || paused) return;
          if (data.chain !== 'sol' || data.source !== 'GMGN' || !Array.isArray(data.tokens) ||
              !Number.isFinite(data.fetchedAt) || Date.now() - data.fetchedAt > 60000 || data.fetchedAt > Date.now() + 5000) throw new Error('Invalid snapshot');
          if (data.fetchedAt <= lastFetch) { status('connecting', 'Waiting for a new GMGN snapshot'); return; }
          data.tokens.forEach(function (token) { names[token.address] = token.symbol; });
          account.update(data.tokens, data.fetchedAt);
          lastFetch = data.fetchedAt;
          // Stopped-out tokens are blacklisted for this session. Moonbags stay tracked.
          watch = watch.filter(function (address) { return !account.excluded(address) && (account.holding(address) ||
            data.tokens.some(function (token) { return token.address === address; })); });
          data.tokens.forEach(function (token) {
            if (watch.length < 4 && !account.excluded(token.address) && watch.indexOf(token.address) < 0) {
              watch.push(token.address);
              log('scout', 'watch', token.address, 'Watching Solana token ' + token.symbol + ' for a closed M1/M5 entry', { marketCap: token.marketCap, liquidity: token.liquidity, trending: token.trending, volumes: token.volumes,
                top10Percent: token.top10Percent, ageMinutes: token.ageMinutes, socialCount: token.socialCount,
                mintRevoked: token.mintRevoked, freezeRevoked: token.freezeRevoked, lpBurned: token.lpBurned });
            }
          });
          if (!data.tokens.length) log('scout', 'no-eligible-tokens', 'SCAN',
            'No eligible tokens in top-20 5m volume ranking. Strict filters remain active; no fallback buys.', {});
          var state = account.snapshot();
          var missingHoldings = Object.keys(state.positions).filter(function (address) {
            return !data.tokens.some(function (token) { return token.address === address; });
          });
          if (missingHoldings.length) {
            var holding = missingHoldings[holdingCursor++ % missingHoldings.length];
            try {
              var quote = await read('/api/quote?address=' + encodeURIComponent(holding));
              if (stopped || paused) return;
              if (quote.chain === 'sol' && quote.address === holding) {
                account.update([{ address: holding, price: quote.price }], quote.fetchedAt);
                log('scout', 'holding-quote', holding, 'Refreshed holding price outside entry universe; moonbags remain tracked at all caps', { price: quote.price });
              }
            } catch {
              if (!stopped && !paused) log('feed', 'holding-unavailable', holding, 'Holding price unavailable; no invented exit or liquidation.', {});
            }
          }
          var candidates = watch.filter(function (address) { return !account.holding(address) && data.tokens.some(function (token) { return token.address === address; }); });
          // One candidate per cycle: pair lookup plus up to two candle calls, all paced.
          if (candidates.length && !missingHoldings.length) {
            var address = candidates[cursor++ % candidates.length];
            try {
              var pair = await read('/api/quote?address=' + encodeURIComponent(address));
              if (stopped || paused) return;
              if (pair.chain === 'sol' && pair.address === address && Number.isFinite(pair.fetchedAt) &&
                  Date.now() - pair.fetchedAt <= 60000 && pair.fetchedAt <= Date.now() + 5000) {
                account.update([{ address: address, price: pair.price }], pair.fetchedAt);
                log('scout', 'pair-check', address, 'GMGN-reported quote pair: ' + (pair.quoteSymbol || 'UNKNOWN') +
                  ' (provider label, not independent verification)',
                  { quoteSymbol: pair.quoteSymbol, quoteAddress: pair.quoteAddress, highlightedQuote: pair.highlightedQuote === true });
              }
            } catch {
              if (!stopped && !paused) log('scout', 'pair-unknown', address, 'Quote pair unavailable; not assumed SOL/WSOL/USDC/USD1.', {});
            }
            if (stopped || paused) return;
            try {
              var result = await read('/api/signal?address=' + encodeURIComponent(address));
              if (stopped || paused) return;
              var entered = false;
              var candidate = data.tokens.find(function (token) { return token.address === address; });
              var withinAge = candidate && Number.isFinite(candidate.ageMinutes) &&
                candidate.ageMinutes + (Date.now() - data.fetchedAt) / 60000 <= 500;
              if (withinAge && result.chain === 'sol' && result.address === address && Array.isArray(result.signals)) {
                result.signals.forEach(function (signal) { if (!entered) entered = account.enter(address, signal); });
              }
              if (!entered) log('analyst', 'wait-entry', address, 'No latest closed M1 hammer/inverted hammer OR two-candle M1/M5 bullish engulfing. Entry only during the next candle.', {});
            } catch {
              if (!stopped && !paused) log('feed', 'candles-unavailable', address, 'Candle data unavailable. New entries paused; existing positions still managed from fresh market snapshots.', {});
            }
          }
          if (stopped || paused) return;
          state = account.snapshot();
          log('logger', 'account', 'ACCOUNT', 'Virtual equity $' + state.equity.toFixed(2) + ' | P/L $' + state.pnl.toFixed(2) + ' | cash $' + state.cash.toFixed(2) +
            (state.staleMarks.length ? ' | STALE last-known marks: ' + state.staleMarks.length : ''), state);
          status(state.staleMarks.length ? 'connecting' : 'connected', state.staleMarks.length ? 'Missing holding quotes — exits paused for affected tokens' : 'GMGN live · closed-candle entries · Omniagents execution');
        } catch {
          if (!stopped && !paused) {
            status('connecting', 'GMGN unavailable — Omniagents execution paused');
            log('feed', 'paused', 'FEED', 'No fresh market snapshot. No fills; positions retained at last-known marks. No synthetic fallback.', {});
          }
        } finally {
          options.clearTimeout(timeout); controller = null; schedule();
        }
      }
      return {
        start: function () {
          if (!stopped) return; stopped = false;
          status('connecting', 'Loading GMGN candles and prices');
          log('risk', 'rules', 'ACCOUNT', '$10,000 virtual. Each buy capped at 5% of initial capital ($500 including entry fees); no compounding or leverage. Insufficient cash skips entry. Stop −35% before moonbag. At +50% sell 90%; at 5× and 10× entry sell 90% of the remainder each. Moonbags have NO stop. Snapshot fills may gap; fees 0.10%, slippage 0.05% estimated, not guaranteed.', {});
          poll();
        },
        stop: function () { stopped = true; if (timer !== null) options.clearTimeout(timer); timer = null; if (controller) controller.abort(); },
        pause: function (value) { paused = value; status('connecting', value ? 'Omniagents execution paused by you' : 'Waiting for next GMGN snapshot'); }
      };
    }
  };
})(typeof window === 'undefined' ? globalThis : window);
