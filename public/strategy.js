/* Virtual accounting shared by the server runner and deterministic browser tests. No real orders. */
(function (root) {
  'use strict';
  root.HermesRules = {
    create: function (emit, now, saved) {
      var initialCapital = 10000, maxOrderFraction = 0.05;
      var maxOrderCost = initialCapital * maxOrderFraction;
      var cash = initialCapital, realized = 0, positions = {}, quotes = {}, excluded = {}, used = {}, traded = {};
      if (saved) {
        if (saved.version !== 1) throw new Error('Unsupported virtual account state');
        var restored = JSON.parse(JSON.stringify(saved));
        cash = restored.cash; realized = restored.realized; positions = restored.positions;
        quotes = restored.quotes; excluded = restored.excluded; used = restored.used;
        traded = restored.traded || {};
        // Migrate v1 accounts without losing prior entries, even after their logs trim out.
        Object.keys(positions).concat(Object.keys(excluded)).forEach(function (address) { traded[address] = true; });
        Object.keys(used).forEach(function (id) { traded[id.split(':')[0]] = true; });
      }
      var daily = saved && saved.daily ? JSON.parse(JSON.stringify(saved.daily)) : null;
      function dayKey() { return new Date(now() - 4 * 3600000).toISOString().slice(0, 10); }
      function equity() {
        return cash + Object.keys(positions).reduce(function (sum, address) {
          return sum + positions[address].qty * quotes[address].price;
        }, 0);
      }
      function rollDay() {
        var day = dayKey();
        if (!daily || daily.day !== day) {
          daily = { day: day, openingEquity: equity(), lossLimit: 5000, paused: false, pausedAt: null, timezone: 'UTC-04:00' };
          emit('risk', 'daily-open', 'ACCOUNT', 'New UTC−4 risk day: retain balances and positions; $5,000 daily loss budget. No capital top-up.', daily);
        }
      }
      function checkDaily() {
        if (!daily.paused && daily.openingEquity - equity() >= daily.lossLimit) {
          daily.paused = true; daily.pausedAt = now();
          emit('risk', 'daily-loss-limit', 'ACCOUNT', '$5,000 daily equity loss limit reached. New buys paused until next UTC−4 day; existing exits continue.', daily);
        }
      }
      rollDay(); checkDaily();
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
          daily: Object.assign({}, daily, { pnl: equity - daily.openingEquity }),
          staleMarks: stale, positions: JSON.parse(JSON.stringify(positions)), skipped: Object.keys(excluded) };
      }
      function sell(address, fraction, kind) {
        var p = positions[address], quantity = p.qty * fraction;
        var fill = quotes[address].price * (1 - slippage), proceeds = quantity * fill;
        var fee = proceeds * feeRate, cost = p.cost * fraction, profit = proceeds - fee - cost;
        cash += proceeds - fee; realized += profit; p.qty -= quantity; p.cost -= cost;
        emit('executor', kind, address, 'Simulated SELL ' + (fraction * 100) + '% of remaining tokens: ' + kind + ' — no real order',
          { quantity: quantity, remaining: p.qty, fill: fill, fee: fee, realizedPnl: profit, moonbagPrice: p.moonbagPrice });
        if (fraction === 1) delete positions[address];
      }
      return {
        snapshot: snapshot,
        exportState: function () { return JSON.parse(JSON.stringify({ version: 1, cash: cash,
          realized: realized, positions: positions, quotes: quotes, excluded: excluded, used: used, traded: traded, daily: daily })); },
        excluded: function (address) { return Boolean(excluded[address] || traded[address]); },
        holding: function (address) { return Boolean(positions[address]); },
        update: function (tokens, timestamp) {
          rollDay();
          if (!Number.isFinite(timestamp) || now() - timestamp > 60000 || timestamp > now() + 5000) return false;
          tokens.forEach(function (token) {
            if (Number.isFinite(token.price) && token.price > 0 && (!quotes[token.address] || timestamp > quotes[token.address].time))
              quotes[token.address] = { price: token.price, time: timestamp,
                marketCap: Number.isFinite(token.marketCap) && token.marketCap >= 0 ? token.marketCap : null };
          });
          Object.keys(positions).forEach(function (address) {
            var p = positions[address], q = quotes[address];
            if (!q || q.time !== timestamp) return; // Never execute using absent/stale marks.
            if (Number.isFinite(q.marketCap) && q.marketCap < 5000) {
              sell(address, 1, 'market-cap-exit'); excluded[address] = true;
              emit('risk', 'skip-token', address, 'Market cap below $5,000. Full exit; no re-entry. Scanning a replacement.', { marketCap: q.marketCap });
              return;
            }
            if (p.moonbag && !Number.isFinite(p.moonbagPrice)) {
              p.moonbagPrice = q.price;
              emit('risk', 'moonbag-anchor-migration', address, 'Historical moonbag creation price unavailable; protection starts from this first fresh quote (not a reconstructed creation price).', { moonbagPrice: q.price });
            }
            if (p.moonbag && q.price <= p.moonbagPrice * 0.5) {
              sell(address, 1, 'moonbag-stop-50'); excluded[address] = true;
              emit('risk', 'skip-token', address, 'Moonbag dropped 50% from its fixed creation-price anchor. Full exit; no re-entry.', { moonbagPrice: p.moonbagPrice });
              return;
            }
            var multiple = q.price / p.entry;
            if (!p.moonbag && multiple <= 0.65) {
              sell(address, 1, 'stop-loss'); excluded[address] = true;
              emit('risk', 'skip-token', address, '35% stop hit. Token permanently blocked from re-entry in this account; scanning a replacement.', {});
              return;
            }
            if (!p.moonbag && multiple >= 1.5) {
              p.moonbagPrice = q.price;
              sell(address, 0.9, 'take-profit-50'); p.moonbag = true;
            }
            // Ordered one-shot milestones: a price gap can trigger both, once each.
            if (p.moonbag && !p.sold5x && multiple >= 5) { sell(address, 0.9, 'moonbag-5x'); p.sold5x = true; }
            if (p.moonbag && !p.sold10x && multiple >= 10) { sell(address, 0.9, 'moonbag-10x'); p.sold10x = true; }
          });
          checkDaily();
          return true;
        },
        followSell: function (address) {
          rollDay();
          var p = positions[address], q = quotes[address];
          if (!p || !q || now() - q.time > 60000 || q.time > now() + 5000) return false;
          var profitable = p.qty * q.price * (1 - slippage) * (1 - feeRate) > p.cost;
          if (profitable) {
            if (!p.moonbag) p.moonbagPrice = q.price;
            p.moonbag = true;
            sell(address, 0.9, 'wallet-profit-sell');
          } else { sell(address, 1, 'wallet-sell'); excluded[address] = true; }
          checkDaily(); return true;
        },
        enter: function (address, signal) {
          rollDay(); checkDaily();
          var q = quotes[address], time = now();
          if (Number.isFinite(q && q.marketCap) && q.marketCap < 5000 || daily.paused || traded[address] || excluded[address] || positions[address] || !q || time - q.time > 60000 || cash < maxOrderCost ||
              !signal || !signal.qualified || ['1m', '5m', 'wallet'].indexOf(signal.resolution) < 0 ||
              !Number.isFinite(signal.closedAt) || signal.closedAt > time ||
              !Number.isFinite(signal.expiresAt) || signal.expiresAt <= time) return false;
          var id = address + ':' + signal.resolution + ':' + signal.closedAt;
          if (used[id]) return false;
          used[id] = true;
          traded[address] = true;
          // Budget is fixed to initial capital, never compounded from current equity.
          // Slippage is included in fill; reserve the entry fee inside the budget.
          var notional = maxOrderCost / (1 + feeRate), fee = maxOrderCost - notional;
          var fill = q.price * (1 + slippage), qty = notional / fill;
          cash -= maxOrderCost;
          positions[address] = { entry: fill, originalQty: qty, qty: qty, cost: maxOrderCost,
            moonbag: false, sold5x: false, sold10x: false };
          checkDaily();
          var patternName = signal.pattern === 'hammer' ? 'hammer' : signal.pattern === 'inverted-hammer' ? 'inverted hammer' : 'bullish engulfing';
          emit('executor', 'simulated-buy', address, (signal.resolution === 'wallet' ? 'Simulated BUY following wallet; signal ' : 'Simulated BUY: closed ') + signal.resolution + ' ' + patternName + '; entry on the next candle',
            { quantity: qty, fill: fill, fee: fee, notional: notional, totalCost: maxOrderCost,
              initialCapital: initialCapital, maxOrderFraction: maxOrderFraction, signal: signal });
          return true;
        }
      };
    }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.HermesRules;
})(typeof window === 'undefined' ? globalThis : window);
