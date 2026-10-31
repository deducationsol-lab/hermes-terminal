(function (root) {
  'use strict';
  root.HermesTokenLinks = { gmgn: function (mint) {
    return typeof mint === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)
      ? 'https://gmgn.ai/sol/token/' + encodeURIComponent(mint) : null;
  } };
})(typeof window === 'undefined' ? globalThis : window);
