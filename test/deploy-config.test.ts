import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Vercel uses static hosting and the built-in Node runtime for api functions', () => {
  const config = JSON.parse(readFileSync('vercel.json', 'utf8'));
  assert.equal(config.framework, null, 'override the project Node backend preset');
  assert.equal(config.outputDirectory, 'public');
  for (const settings of Object.values(config.functions)) {
    assert.equal(Object.hasOwn(settings as object, 'runtime'), false,
      'built-in Node functions must not specify a custom runtime package');
  }
  assert.equal(config.functions['api/stream.ts'].maxDuration, 60);
  assert.deepEqual(config.rewrites, [{ source: '/', destination: '/index.html' }]);
});
