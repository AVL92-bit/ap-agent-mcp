import test from 'node:test';
import assert from 'node:assert/strict';
const { dryRunApInbox, selectConversations } = await import(new URL('../dist/ap-inbox-dry-run.js', import.meta.url));
const { DocumentNeedsHumanReview } = await import(new URL('../dist/ap-document-verification.js', import.meta.url));

const pdf = { filename: 'x.pdf', bytes: new TextEncoder().encode('%PDF-1.4'), contentType: 'application/pdf' };
const cmd = (number, uncertain = []) => ({ kind: 'Invoices', number, supplierContactId: 'c1', supplierName: 'Healthtech-1 (DD)',
  accountCode: '468', invoiceDate: '2026-10-01', dueDate: '2026-10-01', gross: 667.92, pdf, uncertainFields: uncertain });
const convs = [
  { id: 'cnv_a', subject: 'Healthtech', body: '', attachments: [
    { id: 'fil_inv', filename: 'Invoice-HT1-34156.pdf', messageId: 'm' },
    { id: 'fil_rcpt', filename: 'Receipt-2439-6527.pdf', messageId: 'm' }] },
  { id: 'cnv_b', subject: 'Existing', body: '', attachments: [{ id: 'fil_old', filename: 'old.pdf', messageId: 'm' }] },
  { id: 'cnv_c', subject: 'Logo only', body: '', attachments: [{ id: 'fil_img', filename: 'image.png', messageId: 'm' }] },
  { id: 'cnv_d', subject: 'Already drafted', body: '', attachments: [{ id: 'fil_d', filename: 'd.pdf', messageId: 'm' }] },
];
const writes = [];
const liveXero = {
  lookup: async n => n === 'OLD-1' ? [{ kind: 'Invoices', id: 'x-old', number: 'OLD-1', status: 'AUTHORISED', contactId: 'c1', contactName: 'S', exact: true }]
    : n === 'DRAFTED-1' ? [{ kind: 'Invoices', id: 'x-draft', number: 'DRAFTED-1', status: 'DRAFT', contactId: 'c1', contactName: 'S', exact: true }] : [],
  verifyOriginal: async () => true,
  createDraft: async () => { writes.push('create'); return 'real'; },
  attachOriginal: async () => { writes.push('attach'); },
};
const makeDraftCommand = async (_c, a) => {
  if (a.id === 'fil_rcpt') throw new DocumentNeedsHumanReview('supporting_document', 'Receipt: supporting document only');
  if (a.id === 'fil_old') return cmd('OLD-1');
  if (a.id === 'fil_d') return cmd('DRAFTED-1');
  return cmd('HT1-34156', ['reference']);
};

test('dry run reports outcomes, tags and archive decisions without any write', async () => {
  const r = await dryRunApInbox({ conversations: convs, conversationsScanned: 4, makeDraftCommand, liveXero });
  assert.deepEqual(writes, []);
  assert.equal(r.writes_performed, 0);
  const a = r.items.find(i => i.conversationId === 'cnv_a');
  assert.equal(a.documents.find(d => d.attachmentId === 'fil_inv').outcome, 'would_create_draft');
  assert.equal(a.documents.find(d => d.attachmentId === 'fil_inv').draft.accountCode, '468');
  assert.equal(a.documents.find(d => d.attachmentId === 'fil_rcpt').outcome, 'supporting_document');
  assert.equal(a.frontTag, 'Human review'); assert.equal(a.wouldArchive, false); // uncertain reference
  const b = r.items.find(i => i.conversationId === 'cnv_b');
  assert.equal(b.documents[0].outcome, 'already_in_xero'); assert.equal(b.wouldArchive, true);
  const c = r.items.find(i => i.conversationId === 'cnv_c');
  const d = r.items.find(i => i.conversationId === 'cnv_d');
  assert.equal(d.frontTag, 'Human review'); assert.equal(d.wouldArchive, false); // existing DRAFT awaits review
  assert.equal(c.documents.length, 0); assert.equal(c.frontTag, 'AP Agent reviewed'); // image ignored: no-attachment email
});
test('limit by named conversations and max count; unknown conversation is refused', () => {
  assert.deepEqual(selectConversations(convs, { conversationIds: ['cnv_b'] }).map(c => c.id), ['cnv_b']);
  assert.equal(selectConversations(convs, { maxConversations: 2 }).length, 2);
  assert.throws(() => selectConversations(convs, { conversationIds: ['cnv_zzz'] }), /Not open\/unassigned/);
});
