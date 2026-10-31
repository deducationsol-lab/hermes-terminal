import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
test('GMGN link is fixed HTTPS Solana route and rejects malformed mint URLs', () => {
  const c: any = {}; runInNewContext(readFileSync('public/token-links.js', 'utf8'), c);
  const mint = 'So11111111111111111111111111111111111111112';
  assert.equal(c.HermesTokenLinks.gmgn(mint), 'https://gmgn.ai/sol/token/' + mint);
  for (const value of ['javascript:alert(1)', '../../path', '<script>', '', null]) assert.equal(c.HermesTokenLinks.gmgn(value), null);
});
