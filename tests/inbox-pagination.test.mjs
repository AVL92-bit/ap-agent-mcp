import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
test('inbox discovery defaults to deep traversal rather than six-page truncation', () => {
  assert.match(source, /max\(1000\)\.default\(1000\)/);
  assert.match(source, /const maxPages = max_pages;/);
  assert.doesNotMatch(source, /Math\.min\(max_pages, 6\)/);
});
test('truncated discovery is explicitly marked incomplete', () => {
  assert.match(source, /queue_incomplete: scanTruncated/);
  assert.match(source, /search_complete: !scanTruncated/);
  assert.match(source, /if \(visitedPages\.size >= maxPages\)/);
});
test('discovery retains status filter and prevents pagination cycles', () => {
  assert.match(source, /visitedPages\.has\(nextPath\)/);
  assert.match(source, /nextUrl\.searchParams\.set\(statusFilterKey, statusFilterValue\)/);
});
