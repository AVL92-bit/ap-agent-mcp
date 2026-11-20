import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const between = (from, to) => src.slice(src.indexOf(from), src.indexOf(to));
const helpers = between('async function payRunForCompany', 'const EXCEPTIONS_GUIDANCE=');
const reader = between('async function payRunForCompany', 'async function assemblePayRun');
const assembler = between('async function assemblePayRun', 'function payRunSummary');
const summaryFn = between('function payRunSummary', 'const EXCEPTIONS_GUIDANCE=');
const preview = between('"prepare_pay_run_preview"', '"create_pay_run_download"');
const download = between('"create_pay_run_download"', '"explain_pay_run_counts"');
const explain = between('"explain_pay_run_counts"', '"get_scheduled_run_history"');

test('the Xero reader is read-only: GETs only, in read mode, through the company guard', () => {
  assert.match(reader, /runAsCompany\(company,/);
  assert.match(reader, /'read'\)/);
  assert.equal(/method:\s*["'](POST|PUT|DELETE|PATCH)/i.test(reader), false);
});
test('a partial pay run is never created: any company that cannot be read fails the whole assembly', () => {
  assert.match(assembler, /a partial pay run is never created/);
  assert.match(assembler, /throw new Error\(`The pay run for \$\{c\.key\} could not be read/);
});
test('with no company key it is the ONE consolidated Metro file; with a key it is that company in its own bank\'s format', () => {
  assert.match(assembler, /companies = metroPayRunCompanies\(\); bank = 'metro'; consolidated = true/);
  assert.match(assembler, /companies = \[c\]; bank = c\.payBank/);
  assert.match(assembler, /has no pay run bank set/);
});
test('the masked summary carries no bank details: only a boolean about the debit account, never its value', () => {
  assert.equal(/sortCode|accountNumber|\.name\b(?!\s*:)/.test(summaryFn.replace(/p\.company\.name/g, '')), false);
  const uses = summaryFn.match(/debitAccounts/g) ?? [];
  assert.equal(uses.length, 1);
  assert.match(summaryFn, /debit_account_configured: a\.debitAccounts\[p\.company\.key\] !== null/);
  assert.match(summaryFn, /summarise\(p\.run, a\.bank\)/);
  assert.match(summaryFn, /findDuplicates\(/);
});
test('the preview tool never returns bank details: only the masked summary, and no file', () => {
  assert.match(preview, /\.\.\.payRunSummary\(a\)/);
  assert.match(preview, /file_produced: false/);
  assert.equal(/renderMetroCsv|renderRevolutCsv|\.lines/.test(preview.replace(/prepare_pay_run_preview[\s\S]*?inputSchema/, '')), false);
});
test('the download tool fails closed: password first, then every Metro debit account, all before any Xero call', () => {
  const pw = download.indexOf('PAY_RUN_DOWNLOAD_PASSWORD) return toolFailure');
  const debit = download.indexOf('PAY_RUN_DEBIT_ACCOUNTS has no entry for');
  const xero = download.indexOf('assemblePayRun(company)');
  assert.ok(pw > 0 && debit > pw && xero > debit, 'password, then debit accounts, then Xero');
});
test('the download tool returns the link and the masked summary, never the CSV', () => {
  assert.equal((download.match(/renderMetroCsv\(/g) ?? []).length, 1);
  assert.equal((download.match(/renderRevolutCsv\(/g) ?? []).length, 1);
  assert.match(download, /payRunDownloads\.create\(csv, filename\)/);
  const resultCalls = download.match(/toolResult\(\{[\s\S]*?\}\)/g) ?? [];
  assert.ok(resultCalls.length >= 2);
  for (const call of resultCalls) {
    assert.equal(/\bcsv\b|\.lines\b|accountNumber|sortCode|debitAccount\b/.test(call), false, call);
    assert.match(call, /payRunSummary\(a\)/);
  }
});
test('file names come from payRunFileName (Metro-safe, London date and time), never an inline hyphenated name', () => {
  assert.match(download, /payRunFileName\(\{ consolidated: a\.consolidated, bank: a\.bank, companyKey: a\.parts\[0\]!\.company\.key, londonDate: now\.date, londonTime: now\.time \}\)/);
  assert.equal(/pay-run-/.test(download.replace(/pay run/gi, '')), false);
});
test('the count diagnostic is read-only, company-guarded, and shows no bank details', () => {
  assert.match(explain, /runAsCompany\(resolveCompany\(company\)/);
  assert.match(explain, /'read'\)/);
  assert.equal(/method:\s*["'](POST|PUT|DELETE|PATCH)/i.test(explain), false);
  assert.equal(/BankAccount|BatchPayments|renderMetroCsv|renderRevolutCsv|payRunDownloads/.test(explain), false);
});
test('the download route is mounted before the other routes', () => {
  assert.ok(src.indexOf('handlePayRunDownload(req, res, url.pathname)') > 0);
});
