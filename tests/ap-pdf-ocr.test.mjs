import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ocrInvoicePdf } from '../src/ap-pdf-ocr.ts';

test('OCR rejects non-PDF input without invoking external tools', async () => {
  await assert.rejects(ocrInvoicePdf(new TextEncoder().encode('not a PDF')), /bounded PDF/);
});
test('OCR rejects oversized input', async () => {
  const data = new Uint8Array(15 * 1024 * 1024 + 1);
  data.set(new TextEncoder().encode('%PDF-'));
  await assert.rejects(ocrInvoicePdf(data), /bounded PDF/);
});
