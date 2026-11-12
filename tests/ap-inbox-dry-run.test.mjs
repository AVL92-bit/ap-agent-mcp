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
  { id: 'cnv_d', subject: 'Already drafted, awaiting finance', body: '', tags: ['Human Review'], attachments: [{ id: 'fil_d', filename: 'd.pdf', messageId: 'm' }] },
  { id: 'cnv_e', subject: 'Clean draft from an earlier run', body: '', attachments: [{ id: 'fil_e', filename: 'e.pdf', messageId: 'm' }] },
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
  if (a.id === 'fil_e') return cmd('DRAFTED-1');
  return cmd('HT1-34156', ['reference']);
};

test('dry run reports outcomes, tags and archive decisions without any write', async () => {
  const r = await dryRunApInbox({ conversations: convs, conversationsScanned: 5, makeDraftCommand, liveXero });
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
  assert.match(d.frontTag, /unchanged, awaiting finance/); assert.equal(d.wouldArchive, false); // tagged Human Review: left alone
  const e = r.items.find(i => i.conversationId === 'cnv_e');
  assert.equal(e.frontTag, 'AP Agent reviewed'); assert.equal(e.wouldArchive, true); // existing DRAFT, no flag: workflow archives
  assert.equal(c.documents.length, 0); assert.equal(c.frontTag, 'AP Agent reviewed'); // image ignored: no-attachment email
});
test('limit by named conversations and max count; unknown conversation is refused', () => {
  assert.deepEqual(selectConversations(convs, { conversationIds: ['cnv_b'] }).map(c => c.id), ['cnv_b']);
  assert.equal(selectConversations(convs, { maxConversations: 2 }).length, 2);
  assert.throws(() => selectConversations(convs, { conversationIds: ['cnv_zzz'] }), /Not open\/unassigned/);
});

test('attachments handled on an earlier run are skipped without re-reading', async () => {
  let reads = 0;
  const r = await dryRunApInbox({ conversations: [{ id: 'cnv_x', subject: 's', body: '', attachments: [{ id: 'fil_done', filename: 'x.pdf', messageId: 'm' }] }],
    conversationsScanned: 1, makeDraftCommand: async () => { reads++; return cmd('X-1'); }, liveXero,
    previous: async () => ({ status: 'draft_verified', xeroId: 'x1' }) });
  assert.equal(reads, 0);
  assert.equal(r.items[0].documents[0].outcome, 'already_in_xero');
  assert.equal(r.items[0].wouldArchive, true);
});
test('PDFs inside an attached email are processed; an attached email without a PDF goes to review', async () => {
  const seen = [];
  const convs2 = [{ id: 'cnv_m', subject: 'fwd', body: '', attachments: [{ id: 'fil_eml', filename: 'Untitled attachment.eml', messageId: 'm' }, { id: 'fil_eml2', filename: 'note.eml', messageId: 'm' }] }];
  const r = await dryRunApInbox({ conversations: convs2, conversationsScanned: 1, liveXero,
    makeDraftCommand: async (_c, a) => { seen.push(a.id); return cmd('EML-1'); },
    expandEmail: async (_c, a) => a.id === 'fil_eml' ? [{ id: 'fil_eml~1', filename: 'inv.pdf', messageId: 'm' }] : [] });
  assert.deepEqual(seen, ['fil_eml~1']);
  const docs = r.items[0].documents;
  assert.equal(docs.find(d => d.attachmentId === 'fil_eml~1').outcome, 'would_create_draft');
  assert.match(docs.find(d => d.attachmentId === 'fil_eml2').reason, /Attached email contains no PDF/);
  assert.equal(r.items[0].frontTag, 'Human review');
});
