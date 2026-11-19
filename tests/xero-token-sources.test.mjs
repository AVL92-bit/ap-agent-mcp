import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { orderTokenSources } from '../dist/xero-pilot-test.js';

const row = (tenant) => ({ tenant_id: tenant, connection_id: `c-${tenant}` });

test('own connection is tried first, then the other connections newest tokens first', () => {
  const entries = [
    { row: row('lamb'), obtainedAt: 300 },
    { row: row('other-old'), obtainedAt: 100 },
    { row: row('sg'), obtainedAt: 50 }, // stale, but still first: it is tried before any sibling
    { row: row('other-new'), obtainedAt: 200 },
  ];
  assert.deepEqual(orderTokenSources(entries, 'sg').map(r => r.tenant_id), ['sg', 'lamb', 'other-new', 'other-old']);
});
test('with no own row, only siblings are returned (the caller then fails the tenant check)', () => {
  assert.deepEqual(orderTokenSources([{ row: row('a'), obtainedAt: 1 }], 'zzz').map(r => r.tenant_id), ['a']);
  assert.deepEqual(orderTokenSources([], 'zzz'), []);
});
test('a refreshed token pair is saved to its own row before any other Xero call, then shared only after verification', () => {
  const s = readFileSync(new URL('../src/xero-pilot-test.ts', import.meta.url), 'utf8');
  const update = s.indexOf('The old refresh token is now spent');
  const verify = s.indexOf('Xero write tenant verification failed');
  const share = s.indexOf('give them to every other connection in the same Xero login');
  assert.ok(update > 0 && verify > update && share > verify, 'save own row, then verify tenant, then share');
  assert.match(s, /ORDER BY connection_id\s+FOR UPDATE/);
});
