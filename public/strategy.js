/* Session-local virtual accounting only; no wallet or order submission. */
(function (root) {
  'use strict';
  root.HermesRules = {
    create: function (emit, now) {
      var initialCapital = 10000, maxOrderFraction = 0.05;
      var maxOrderCost = initialCapital * maxOrderFraction;
      var cash = initialCapital, realized = 0, positions = {}, quotes = {}, excluded = {}, used = {};
      var feeRate = 0.001, slippage = 0.0005;
      function snapshot() {
        var equity = cash, stale = [];
        Object.keys(positions).forEach(function (address) {
          var quote = quotes[address];
          equity += positions[address].qty * quote.price;
          if (now() - quote.time > 60000) stale.push(address);
        });
        return { cash: cash, equity: equity, pnl: equity - initialCapital, realized: realized,
          initialCapital: initialCapital, maxOrderFraction: maxOrderFraction, maxOrderCost: maxOrderCost,
          staleMarks: stale, positions: JSON.parse(JSON.stringify(positions)), skipped: Object.keys(excluded) };
      }
      function sell(address, fraction, kind) {
        var p = positions[address], quantity = p.qty * fraction;
        var fill = quotes[address].price * (1 - slippage), proceeds = quantity * fill;
        var fee = proceeds * feeRate, cost = p.cost * fraction, profit = proceeds - fee - cost;
        cash += proceeds - fee; realized += profit; p.qty -= quantity; p.cost -= cost;
        emit('executor', kind, address, 'Simulated SELL ' + (fraction * 100) + '% of remaining tokens: ' + kind + ' — no real order',
          { quantity: quantity, remaining: p.qty, fill: fill, fee: fee, realizedPnl: profit });
        if (fraction === 1) delete positions[address];
      }
      return {
        snapshot: snapshot,
        excluded: function (address) { return Boolean(excluded[address]); },
        holding: function (address) { return Boolean(positions[address]); },
        update: function (tokens, timestamp) {
          if (!Number.isFinite(timestamp) || now() - timestamp > 60000 || timestamp > now() + 5000) return false;
          tokens.forEach(function (token) {
            if (Number.isFinite(token.price) && token.price > 0 && (!quotes[token.address] || timestamp > quotes[token.address].time))
              quotes[token.address] = { price: token.price, time: timestamp };
          });
          Object.keys(positions).forEach(function (address) {
            var p = positions[address], q = quotes[address];
            if (!q || q.time !== timestamp) return; // Never execute using absent/stale marks.
            var multiple = q.price / p.entry;
            if (!p.moonbag && multiple <= 0.65) {
              sell(address, 1, 'stop-loss'); excluded[address] = true;
              emit('risk', 'skip-token', address, '35% stop hit. Token excluded for this session; scanning a replacement.', {});
              return;
            }
            if (!p.moonbag && multiple >= 1.5) {
              sell(address, 0.9, 'take-profit-50'); p.moonbag = true;
            }
            // Ordered one-shot milestones: a price gap can trigger both, once each.
            if (p.moonbag && !p.sold5x && multiple >= 5) { sell(address, 0.9, 'moonbag-5x'); p.sold5x = true; }
            if (p.moonbag && !p.sold10x && multiple >= 10) { sell(address, 0.9, 'moonbag-10x'); p.sold10x = true; }
          });
          return true;
        },
        enter: function (address, signal) {
          var q = quotes[address], time = now();
          if (excluded[address] || positions[address] || !q || time - q.time > 60000 || cash < maxOrderCost ||
              !signal || !signal.qualified || ['1m', '5m'].indexOf(signal.resolution) < 0 ||
              !Number.isFinite(signal.closedAt) || signal.closedAt > time ||
              !Number.isFinite(signal.expiresAt) || signal.expiresAt <= time) return false;
          var id = address + ':' + signal.resolution + ':' + signal.closedAt;
          if (used[id]) return false;
          used[id] = true;
          // Budget is fixed to initial capital, never compounded from current equity.
          // Slippage is included in fill; reserve the entry fee inside the budget.
          var notional = maxOrderCost / (1 + feeRate), fee = maxOrderCost - notional;
          var fill = q.price * (1 + slippage), qty = notional / fill;
          cash -= maxOrderCost;
          positions[address] = { entry: fill, originalQty: qty, qty: qty, cost: maxOrderCost,
            moonbag: false, sold5x: false, sold10x: false };
          var patternName = signal.pattern === 'hammer' ? 'hammer' : signal.pattern === 'inverted-hammer' ? 'inverted hammer' : 'bullish engulfing';
          emit('executor', 'simulated-buy', address, 'Simulated BUY: closed ' + signal.resolution + ' ' + patternName + '; entry on the next candle',
            { quantity: qty, fill: fill, fee: fee, notional: notional, totalCost: maxOrderCost,
              initialCapital: initialCapital, maxOrderFraction: maxOrderFraction, signal: signal });
          return true;
        }
      };
    }
  };
})(typeof window === 'undefined' ? globalThis : window);
