import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../src/google-sheets-review.ts', import.meta.url), 'utf8');
test('rows get FALSE in column J only when the "Human review complete" header exists', () => {
  assert.match(src, /\(rows\[0\]\?\.\[9\] \?\? ''\)\.trim\(\) === REVIEW_COMPLETE_HEADER \? \[\.\.\.values, false\] : values/);
  assert.match(src, /export const REVIEW_COMPLETE_HEADER = 'Human review complete'/);
});
test('columns A-I are still checked exactly and both writers use the review column', () => {
  assert.equal((src.match(/withReviewColumn\(rows,/g) ?? []).length, 2);
  assert.equal((src.match(/'Finance review'!A1:J10000/g) ?? []).length >= 3, true);
  assert.match(src, /if\(expected\.some\(\(h,i\)=>rows\[0\]\?\.\[i\]!==h\)\)/);
});
