(function (root) {
  'use strict';
  function number(n) { return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 6 }) : '—'; }
  function usd(n) { return Number.isFinite(n) ? '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'; }
  function price(n) { return Number.isFinite(n) ? '$' + n.toLocaleString(undefined, { maximumSignificantDigits: 6 }) : '—'; }
  function el(tag, text, className) { var e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; }
  function cell(row, main, sub) { var td = el('td'); td.appendChild(el('div', main)); if (sub) td.appendChild(el('small', sub)); row.appendChild(td); return td; }
  root.HermesDashboard = { render: function (data) {
    var section = document.getElementById('account-dashboard');
    if (!section || section.hidden || !data.dashboard || !data.snapshot) return;
    var d = data.dashboard, s = data.snapshot, a = d.activity;
    document.getElementById('account-updated').textContent = 'Last saved ' + (data.lastAttempt ? new Date(data.lastAttempt).toLocaleTimeString() : '—') +
      (Date.now() - data.lastAttempt > 180000 ? ' · DELAYED' : ' · 30s target');
    var cards = document.getElementById('account-cards'); cards.replaceChildren();
    [ ['Total portfolio', usd(s.equity), 'Includes protected reserve once'], ['USDC reserve · simulator', usd(s.reserve || 0), '40% of future positive net sell profits · not spendable'], ['Trading equity', usd(s.tradingEquity === undefined ? s.equity : s.tradingEquity), 'Available cash ' + usd(s.cash)], ['Total P/L', usd(s.pnl), 'Since account reset'],
      ['Realized / unrealized', usd(s.realized), 'Unrealized ' + usd(d.unrealized)],
      ['Virtual fills', number(a.buys + a.sells), a.buys + ' buys · ' + a.sells + ' sells'],
      ['Virtual turnover', usd(a.buyCost + a.sellProceeds), 'Fees ' + usd(a.fees)],
      ['Source observations', number(d.source.swaps), number(d.source.scanned) + ' transaction records scanned; not our fills']
    ].forEach(function (item) { var card = el('div', undefined, 'account-card'); card.append(el('small', item[0]), el('strong', item[1]), el('span', item[2])); cards.appendChild(card); });
    var body = document.getElementById('holdings-body'); body.replaceChildren();
    document.getElementById('holdings-count').textContent = d.holdings.length + ' held · ' + d.holdings.filter(function (h) { return h.stale; }).length + ' stale marks';
    if (!d.holdings.length) { var empty = el('tr'); var td = cell(empty, 'No open holdings', 'Waiting for the next supported source signal'); td.colSpan = 7; body.appendChild(empty); }
    d.holdings.forEach(function (h) {
      var row = el('tr');
      var name = h.symbol || h.address.slice(0, 5) + '…' + h.address.slice(-5);
      var tokenCell = cell(row, name, h.address.slice(0, 6) + '…' + h.address.slice(-6)); tokenCell.title = h.address;
      var href = root.HermesTokenLinks.gmgn(h.address);
      if (href) { var link = el('a', name + ' ↗'); link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.title = 'Open token on GMGN: ' + h.address; tokenCell.firstChild.replaceWith(link); }
      cell(row, number(h.quantity), 'Accum. ≥ ' + number(h.accumulatedQuantity)).title = h.accumulationCoverage;
      cell(row, usd(h.totalBuyCost), 'Remaining ' + usd(h.remainingCost));
      cell(row, price(h.averageEntry), 'Mark ' + price(h.price));
      var pnl = cell(row, usd(h.value), 'Unrealized ' + usd(h.unrealized)); pnl.className = h.unrealized < 0 ? 'account-negative' : 'account-positive';
      cell(row, (h.buys === null ? '—' : h.buys) + ' / ' + (h.sells === null ? '—' : h.sells));
      var state = cell(row, h.moonbag ? 'MOONBAG' : 'POSITION', h.stale ? 'STALE · last known mark' : 'Fresh quote');
      state.className = h.stale ? 'account-stale' : ''; state.title = h.quoteTime ? new Date(h.quoteTime).toISOString() : 'No quote';
      body.appendChild(row);
    });
    document.getElementById('activity-coverage').textContent = 'Counters since ' + new Date(a.since).toLocaleString() + '. ' + a.coverage + ' Accumulated = recorded gross buys, not current quantity. Turnover = all-in buys + net sell proceeds.';
    document.getElementById('fill-count').textContent = '(' + d.fills.length + ' retained recent)';
    var list = document.getElementById('fill-list'); list.replaceChildren();
    d.fills.forEach(function (f) {
      var m = f.meta || {}, details = el('details'), summary = el('summary');
      summary.textContent = new Date(f.ts).toLocaleTimeString() + ' · ' + (m.kind || 'fill') + ' · ' + (m.address || '').slice(0, 8) + '… · ' + number(m.quantity) + ' @ ' + price(m.fill);
      var tokenHref = root.HermesTokenLinks.gmgn(m.address);
      if (tokenHref) { var tokenLink = el('a', 'Token contract on GMGN ↗'); tokenLink.href = tokenHref; tokenLink.target = '_blank'; tokenLink.rel = 'noopener noreferrer'; details.appendChild(tokenLink); }
      details.prepend(summary); details.append(el('pre', JSON.stringify({ time: new Date(f.ts).toISOString(), token: m.address, quantity: m.quantity, price: m.fill, fee: m.fee, totalCost: m.totalCost, realizedPnl: m.realizedPnl, reason: m.kind }, null, 2))); list.appendChild(details);
    });
  } };
})(typeof window === 'undefined' ? globalThis : window);
