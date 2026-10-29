/* Public price data only. All balances and fills are virtual, session-local. */
(function (root) {
  'use strict';
  var SYMBOLS = ['BTCUSDT', 'ETHUSDT'];
  var FEE = 0.001, SLIPPAGE = 0.0005, STALE = 15000;
  function engine(emit, now) {
    var cash = 10000, quotes = {}, previous = {}, positions = {}, realized = 0;
    function snapshot() {
      var equity = cash;
      SYMBOLS.forEach(function (s) { if (positions[s]) equity += positions[s].qty * quotes[s].price; });
      return { cash: cash, equity: equity, pnl: equity - 10000, realized: realized,
        positions: JSON.parse(JSON.stringify(positions)) };
    }
    return {
      quote: function (symbol, price, timestamp) {
        var time = now();
        if (SYMBOLS.indexOf(symbol) < 0 || !Number.isFinite(price) || price <= 0 ||
            !Number.isFinite(timestamp) || time - timestamp > STALE || timestamp > time + 5000 ||
            (quotes[symbol] && timestamp <= quotes[symbol].timestamp)) return false;
        quotes[symbol] = { price: price, timestamp: timestamp };
        return true;
      },
      snapshot: snapshot,
      step: function () {
        var time = now();
        if (SYMBOLS.some(function (s) { return !quotes[s] || time - quotes[s].timestamp > STALE; })) {
          previous = {};
          return false;
        }
        SYMBOLS.forEach(function (symbol) {
          var price = quotes[symbol].price;
          var change = previous[symbol] ? price / previous[symbol] - 1 : 0;
          var position = positions[symbol];
          emit('scout', 'quote', symbol, 'Live Binance trade price ' + price.toFixed(2) + ' USDT', { price: price, exchangeTime: quotes[symbol].timestamp });
          emit('analyst', 'signal', symbol, previous[symbol] ? '5-second momentum ' + (change * 100).toFixed(4) + '% (demo heuristic)' : 'Warming up; waiting for next sample', { momentum: change });
          if (!position && previous[symbol] && change > 0.0001) {
            var spend = 500, fill = price * (1 + SLIPPAGE), fee = spend * FEE;
            if (cash >= spend + fee) {
              cash -= spend + fee;
              positions[symbol] = { qty: spend / fill, entry: fill, cost: spend + fee, opened: time };
              emit('risk', 'approved', symbol, 'Virtual allocation capped at 500 USDT per symbol; no leverage', {});
              emit('executor', 'paper-buy', symbol, 'PAPER BUY at ' + fill.toFixed(2) + ' USDT — no real order', { quantity: spend / fill, fee: fee, fill: fill });
            }
          } else if (position && (change < -0.0001 || time - position.opened >= 60000)) {
            var sell = price * (1 - SLIPPAGE), proceeds = position.qty * sell;
            var sellFee = proceeds * FEE, profit = proceeds - sellFee - position.cost;
            cash += proceeds - sellFee; realized += profit; delete positions[symbol];
            emit('executor', 'paper-sell', symbol, 'PAPER SELL at ' + sell.toFixed(2) + ' USDT — no real order', { quantity: position.qty, fee: sellFee, fill: sell, realizedPnl: profit });
          }
          previous[symbol] = price;
        });
        var state = snapshot();
        emit('logger', 'account', 'ACCOUNT', 'Virtual equity ' + state.equity.toFixed(2) + ' USDT | P/L ' + state.pnl.toFixed(2) + ' USDT | cash ' + state.cash.toFixed(2) + ' USDT', state);
        return true;
      },
      resetSignal: function () { previous = {}; }
    };
  }
  root.HermesPaper = {
    engine: engine,
    create: function (options) {
      var socket = null, timer = null, retry = null, stopped = true, paused = false, seq = 0, lastStatus = '';
      function status(state, text) {
        options.status(state, text);
        if (text !== lastStatus) { lastStatus = text; log('feed', 'status', 'FEED', text, {}); }
      }
      function log(agent, kind, symbol, message, meta) {
        options.emit({ channel: options.channel, level: agent === 'feed' ? 'warn' : 'info',
          message: '[PAPER · LIVE DATA] ' + agent + ': ' + message,
          meta: Object.assign({ mode: 'paper', agent: agent, kind: kind, symbol: symbol,
            source: 'Binance public trades', virtual: true, feeRate: FEE, slippageRate: SLIPPAGE }, meta),
          ts: Date.now(), seq: seq++ });
      }
      var account = engine(log, Date.now);
      function connect() {
        if (stopped) return;
        status('connecting', 'Waiting for live prices — paper trading paused');
        try { socket = new options.WebSocket('wss://data-stream.binance.vision/stream?streams=btcusdt@trade/ethusdt@trade'); }
        catch (error) { reconnect(); return; }
        socket.onmessage = function (event) {
          try { var data = JSON.parse(event.data).data; if (data) account.quote(data.s, Number(data.p), data.T); } catch (error) { /* ignore invalid frames */ }
        };
        socket.onerror = function () { status('connecting', 'Feed unavailable — paper trading paused (network or region restrictions may apply)'); };
        socket.onclose = reconnect;
      }
      function reconnect() {
        if (stopped) return;
        account.resetSignal();
        status('connecting', 'Feed disconnected — paper trading paused; retrying in 10s');
        if (retry === null) retry = options.setTimeout(function () { retry = null; connect(); }, 10000);
      }
      return {
        start: function () {
          if (!stopped) return;
          stopped = false;
          log('risk', 'rules', 'ACCOUNT', '10,000 USDT virtual balance; 0.10% fee + 0.05% slippage per fill. Not investment advice.', {});
          connect();
          timer = options.setInterval(function () {
            if (paused) return;
            if (!socket || socket.readyState !== 1 || !account.step()) {
              account.resetSignal(); status('connecting', 'Live prices stale or unavailable — paper trading paused');
            } else status('connected', 'Live prices · paper trading');
          }, 5000);
        },
        stop: function () {
          stopped = true;
          if (timer !== null) options.clearInterval(timer);
          if (retry !== null) options.clearTimeout(retry);
          timer = retry = null;
          if (socket) { socket.onclose = null; socket.close(); socket = null; }
        },
        pause: function (value) {
          paused = value; account.resetSignal();
          status('connecting', value ? 'Paper trading paused by you' : 'Resuming — waiting for fresh sample');
        }
      };
    }
  };
})(typeof window === 'undefined' ? globalThis : window);
