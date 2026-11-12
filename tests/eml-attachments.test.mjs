import test from 'node:test';
import assert from 'node:assert/strict';
const { extractPdfsFromEml } = await import(new URL('../dist/eml-attachments.js', import.meta.url));
const pdfB64 = Buffer.from('%PDF-1.4 test invoice').toString('base64');
const eml = (inner) => `From: a@b.com\r\nSubject: Fwd\r\nContent-Type: multipart/mixed; boundary="XYZ"\r\n\r\n--XYZ\r\nContent-Type: text/plain\r\n\r\nSee attached\r\n${inner}--XYZ--\r\n`;
test('PDF attachment inside an attached email is extracted', () => {
  const out = extractPdfsFromEml(eml(`--XYZ\r\nContent-Type: application/pdf; name="INV-9.pdf"\r\nContent-Disposition: attachment; filename="INV-9.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${pdfB64}\r\n`));
  assert.equal(out.length, 1); assert.equal(out[0].filename, 'INV-9.pdf');
  assert.equal(Buffer.from(out[0].bytes).toString(), '%PDF-1.4 test invoice');
});
test('PDF inside an email forwarded within the attached email is extracted', () => {
  const forwarded = `Subject: Original\r\nContent-Type: multipart/mixed; boundary="IN"\r\n\r\n--IN\r\nContent-Type: application/octet-stream; name="bill.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${pdfB64}\r\n--IN--\r\n`;
  const out = extractPdfsFromEml(eml(`--XYZ\r\nContent-Type: message/rfc822\r\n\r\n${forwarded}\r\n`));
  assert.equal(out.length, 1); assert.equal(out[0].filename, 'bill.pdf');
});
test('an attached email with only text and images yields no PDF', () => {
  const out = extractPdfsFromEml(eml(`--XYZ\r\nContent-Type: image/png; name="logo.png"\r\nContent-Transfer-Encoding: base64\r\n\r\niVBORw0KGgo=\r\n`));
  assert.equal(out.length, 0);
});
