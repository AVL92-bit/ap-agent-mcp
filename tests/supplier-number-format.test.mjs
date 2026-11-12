import test from 'node:test';
import assert from 'node:assert/strict';
const { alignToSupplierNumberFormat } = await import(new URL('../dist/supplier-number-format.js', import.meta.url));
test('Henry Schein: "RI 65930654" follows existing plain-number bills', () => {
  assert.equal(alignToSupplierNumberFormat('RI 65930654', ['65930802', '65812233', '65790001']), '65930654');
});
test('numbers already in the supplier format are unchanged', () => {
  assert.equal(alignToSupplierNumberFormat('HT1-34156', ['HT1-32779', 'HT1-31125']), null);
  assert.equal(alignToSupplierNumberFormat('65930654', ['65930802', '65812233']), null);
});
test('a prefix the supplier does use is kept; too little history changes nothing', () => {
  assert.equal(alignToSupplierNumberFormat('INV 123', ['INV 100', 'INV 101']), null);
  assert.equal(alignToSupplierNumberFormat('RI 65930654', ['65930802']), null);
  assert.equal(alignToSupplierNumberFormat('RI 65930654', ['65930802', 'X-1']), null);
});
