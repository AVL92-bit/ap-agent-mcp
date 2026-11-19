import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPayRunConfig, parsePayRunConfig } from '../dist/pay-run-config.js';

test('the shipped pay run config loads and lists JP Medassist as always business', () => {
  const c = loadPayRunConfig();
  assert.ok(c.alwaysBusiness.includes('JP Medassist'));
});
test('config validation rejects malformed lists', () => {
  assert.throws(() => parsePayRunConfig({}), /always_business/);
  assert.throws(() => parsePayRunConfig({ always_business: 'JP Medassist' }), /always_business/);
  assert.throws(() => parsePayRunConfig({ always_business: [''] }), /always_business/);
  assert.throws(() => parsePayRunConfig({ always_business: [1] }), /always_business/);
  assert.deepEqual(parsePayRunConfig({ always_business: ['A', 'B'] }), { alwaysBusiness: ['A', 'B'] });
});
