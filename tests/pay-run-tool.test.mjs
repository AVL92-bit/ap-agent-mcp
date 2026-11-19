import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const block = src.slice(src.indexOf('"prepare_pay_run_preview"'), src.indexOf('"get_scheduled_run_history"'));

test('the preview tool is read-only: only GETs against Xero, in read mode, through the company guard', () => {
  assert.match(block, /runAsCompany\(resolveCompany\(company\)/);
  assert.match(block, /'read'\)/);
  assert.equal(/method:\s*["'](POST|PUT|DELETE|PATCH)/i.test(block), false);
});
test('the preview tool never returns bank details: it returns the masked summary only', () => {
  assert.match(block, /\.\.\.summarise\(run\)/);
  assert.equal(/run\.lines|renderRevolutCsv/.test(block), false);
  assert.match(block, /file_produced: false/);
});
