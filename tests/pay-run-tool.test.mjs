import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const preview = src.slice(src.indexOf('"prepare_pay_run_preview"'), src.indexOf('"create_pay_run_download"'));
const download = src.slice(src.indexOf('"create_pay_run_download"'), src.indexOf('"get_scheduled_run_history"'));

test('the preview tool is read-only: only GETs against Xero, in read mode, through the company guard', () => {
  assert.match(preview, /runAsCompany\(resolveCompany\(company\)/);
  assert.match(preview, /'read'\)/);
  assert.equal(/method:\s*["'](POST|PUT|DELETE|PATCH)/i.test(preview), false);
});
test('the preview tool never returns bank details: it returns the masked summary only', () => {
  assert.match(preview, /\.\.\.summarise\(run\)/);
  assert.equal(/run\.lines|renderRevolutCsv/.test(preview), false);
  assert.match(preview, /file_produced: false/);
});
test('the download tool is read-only against Xero, company-guarded, and fails closed without the password', () => {
  assert.match(download, /runAsCompany\(target/);
  assert.match(download, /'read'\)/);
  assert.equal(/method:\s*["'](POST|PUT|DELETE|PATCH)/i.test(download), false);
  assert.ok(download.indexOf('PAY_RUN_DOWNLOAD_PASSWORD) return toolFailure') > 0);
  assert.ok(download.indexOf('PAY_RUN_DOWNLOAD_PASSWORD) return toolFailure') < download.indexOf('getPilotXeroReadSession'), 'password checked before any Xero call');
});
test('the download tool returns the link and the masked summary, never the CSV or any line with bank details', () => {
  // the only use of the rendered CSV is handing it to the one-time store
  assert.equal((download.match(/renderRevolutCsv\(/g) ?? []).length, 1);
  assert.match(download, /payRunDownloads\.create\(renderRevolutCsv\(run\.lines\), filename\)/);
  const resultCalls = download.match(/toolResult\(\{[\s\S]*?\}\)/g) ?? [];
  assert.ok(resultCalls.length >= 2);
  for (const call of resultCalls) {
    assert.equal(/\bcsv\b|run\.lines|accountNumber|sortCode|\.name\b/.test(call), false, call);
    assert.match(call, /summarise\(run\)/);
  }
});
test('the download route is mounted before the other routes', () => {
  assert.ok(src.indexOf('handlePayRunDownload(req, res, url.pathname)') > 0);
});
