import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withReviewColumn, REVIEW_COMPLETE_HEADER, COMPANY_HEADER } from '../dist/google-sheets-review.js';

const AI = ['Logged at','Outcome','Xero draft URL','Supplier selected','Invoice / credit note ref','Gross amount','Field / failure','Question or error detail','Front conversation URL'];
const values = ['t','o','u','s','r','1','f','d','l'];
const src = readFileSync(new URL('../src/google-sheets-review.ts', import.meta.url), 'utf8');

test('no company: rows get FALSE in column J only when the "Human review complete" header exists', () => {
  assert.deepEqual(withReviewColumn([[...AI]], values), values);
  assert.deepEqual(withReviewColumn([[...AI, REVIEW_COMPLETE_HEADER]], values), [...values, false]);
});
test('with a company: J is FALSE and K carries the company name', () => {
  const rows = [[...AI, REVIEW_COMPLETE_HEADER, COMPANY_HEADER]];
  assert.deepEqual(withReviewColumn(rows, values, 'Lamberhurst'), [...values, false, 'Lamberhurst']);
});
test('with a company: refuses to write when column J or K is missing, so no row is ever unattributed', () => {
  assert.throws(() => withReviewColumn([[...AI]], values, 'Lamberhurst'), /column K/);
  assert.throws(() => withReviewColumn([[...AI, REVIEW_COMPLETE_HEADER]], values, 'Lamberhurst'), /column K/);
  assert.throws(() => withReviewColumn([[...AI, 'Something else', COMPANY_HEADER]], values, 'Lamberhurst'), /column J/);
});
test('columns A-I are still checked exactly and every writer reads A-K', () => {
  assert.equal((src.match(/withReviewColumn\(rows,/g) ?? []).length, 2);
  assert.equal((src.match(/'Finance review'!A1:K10000/g) ?? []).length >= 4, true);
  assert.equal(/A1:J10000/.test(src), false);
  assert.match(src, /if\(expected\.some\(\(h,i\)=>rows\[0\]\?\.\[i\]!==h\)\)/);
});
