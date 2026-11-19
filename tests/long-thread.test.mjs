import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLongThread, longThreadNote, sourceOf, LONG_THREAD_MIN_SOURCES } from '../dist/ap-long-thread.js';
import { runApInbox } from '../dist/ap-inbox-runner.js';
import { extractPdfsFromEml } from '../dist/eml-attachments.js';
import { scanApFrontInbox } from '../dist/ap-front-inbox-scan.js';
import { decideDocumentConversation } from '../dist/ap-conversation-completion.js';

const T = (day) => Date.UTC(2026, 10, day, 9, 0, 0);
// a PDF that came out of an attached email `src`, sent on `day` of November 2026
const inEml = (src, n, day) => ({ id: `${src}~${n}`, filename: `${src}-${n}.pdf`, messageId: 'msg_1', sourceId: src, receivedAt: T(day) });

test('three different emails make a long thread; two do not', () => {
  assert.equal(LONG_THREAD_MIN_SOURCES, 3);
  assert.equal(planLongThread([inEml('fil_a', 1, 1), inEml('fil_b', 1, 2)], new Map()).isLong, false);
  assert.equal(planLongThread([inEml('fil_a', 1, 1), inEml('fil_b', 1, 2), inEml('fil_c', 1, 3)], new Map()).isLong, true);
});
test('ONE email with many invoices attached is one source: never a long thread', () => {
  const six = Array.from({ length: 6 }, (_, i) => ({ id: `fil_${i}`, filename: `inv${i}.pdf`, messageId: 'msg_1', receivedAt: T(5) }));
  const p = planLongThread(six, new Map());
  assert.equal(p.isLong, false);
  assert.equal(p.keep.length, 6);
  // two PDFs inside one attached email also count once
  assert.equal(planLongThread([inEml('fil_a', 1, 1), inEml('fil_a', 2, 1), inEml('fil_b', 1, 2)], new Map()).isLong, false);
});
test('the newest email is kept, every older document is skipped', () => {
  const docs = [inEml('fil_old', 1, 1), inEml('fil_new', 1, 9), inEml('fil_mid', 1, 5), inEml('fil_old2', 1, 3)];
  const p = planLongThread(docs, new Map());
  assert.equal(p.isLong, true);
  assert.deepEqual(p.keptDocuments.map(d => d.id), ['fil_new~1']);
  assert.deepEqual(p.skipped.map(d => d.id).sort(), ['fil_mid~1', 'fil_old2~1', 'fil_old~1']);
  assert.deepEqual(p.keep.map(d => d.id), ['fil_new~1']);
  assert.equal(p.sources, 4);
  assert.equal(p.newestAt, T(9));
});
test('all documents of the newest email are kept (an invoice and its report)', () => {
  const p = planLongThread([inEml('fil_old', 1, 1), inEml('fil_new', 1, 9), inEml('fil_new', 2, 9), inEml('fil_mid', 1, 5)], new Map());
  assert.deepEqual(p.keptDocuments.map(d => d.id), ['fil_new~1', 'fil_new~2']);
});
test('documents already handled do not count and are never skipped again; they stay in the kept list', () => {
  const docs = [inEml('fil_a', 1, 1), inEml('fil_b', 1, 2), inEml('fil_c', 1, 3)];
  // two of the three were handled earlier: only one unprocessed source remains, so no long thread
  assert.equal(planLongThread(docs, new Map([['fil_a~1', 'draft_verified'], ['fil_b~1', 'skipped_long_thread']])).isLong, false);
  // a fourth email arrives: a long thread again, and the previously handled ones are never in `skipped`
  const more = [...docs, inEml('fil_d', 1, 4), inEml('fil_e', 1, 5)];
  const p = planLongThread(more, new Map([['fil_a~1', 'draft_verified'], ['fil_b~1', 'skipped_long_thread']]));
  assert.equal(p.isLong, true);
  assert.deepEqual(p.skipped.map(d => d.id).sort(), ['fil_c~1', 'fil_d~1']);
  assert.ok(p.keep.some(d => d.id === 'fil_a~1') && p.keep.some(d => d.id === 'fil_b~1') && p.keep.some(d => d.id === 'fil_e~1'));
  // a document that failed technically last time is still unprocessed
  assert.equal(planLongThread(docs, new Map([['fil_a~1', 'technical_failure']])).isLong, true);
});
test('without dates, the email that appears last in the thread is the newest', () => {
  const docs = ['a', 'b', 'c'].map(s => ({ id: `fil_${s}`, filename: `${s}.pdf`, messageId: `msg_${s}` }));
  const p = planLongThread(docs, new Map());
  assert.deepEqual(p.keptDocuments.map(d => d.id), ['fil_c']);
});
test('an attached email with no PDF is its own source; a plain attachment\'s source is its message', () => {
  assert.equal(sourceOf({ id: 'fil_x', filename: 'forward.eml', messageId: 'msg_1' }), 'fil_x');
  assert.equal(sourceOf({ id: 'fil_y', filename: 'inv.pdf', messageId: 'msg_2' }), 'msg_2');
  assert.equal(sourceOf(inEml('fil_z', 1, 1)), 'fil_z');
});
test('the Sheet note names files, counts, and what to do; it carries no amounts', () => {
  const p = planLongThread([inEml('fil_old', 1, 1), inEml('fil_new', 1, 9), inEml('fil_mid', 1, 5)], new Map());
  const note = longThreadNote(p);
  assert.match(note, /3 different emails/);
  assert.match(note, /2026-11-09/);
  assert.match(note, /fil_new-1\.pdf/);
  assert.match(note, /2 older document\(s\) were skipped/);
  assert.match(note, /Open the conversation in Front/);
});
test('a skipped document keeps the conversation with finance: Human review, never archived', () => {
  const d = decideDocumentConversation([{ attachmentId: 'a', disposition: 'xero_draft_attached' }, { attachmentId: 'b', disposition: 'long_thread_skipped' }]);
  assert.equal(d.tag, 'Human review');
  assert.equal(d.archive, false);
});

// ---- the runner, end to end with fakes ----
const pdf = { filename: 'a.pdf', contentType: 'application/pdf', bytes: new TextEncoder().encode('%PDF-example') };
function fixture({ journal = {} } = {}) {
  const calls = [], made = [], skipped = [];
  const emls = { fil_e1: [inEml('fil_e1', 1, 1)], fil_e2: [inEml('fil_e2', 1, 2)], fil_e3: [inEml('fil_e3', 1, 3)], fil_e4: [inEml('fil_e4', 1, 4)], fil_e5: [inEml('fil_e5', 1, 5)] };
  const port = {
    listAllOpenConversations: async () => [{ id: 'cnv_a', subject: 'Fw: chain', body: '', attachments: Object.keys(emls).map(id => ({ id, filename: `${id}.eml`, messageId: 'msg_1', receivedAt: T(5) })) }],
    expandEmail: async (c, a) => emls[a.id],
    makeDraftCommand: async (c, a) => { made.push(a.id); return { kind: 'Invoices', number: a.id, supplierContactId: 'c', accountCode: '449', invoiceDate: '2026-11-09', dueDate: '2026-11-09', gross: 12, pdf, uncertainFields: [] }; },
    applyTag: async (id, tag) => calls.push(['tag', tag]), archive: async (id) => calls.push(['archive', id]),
    reportReview: async (row) => calls.push(['sheet', row.outcome, row.reason, row.attachmentId]),
    journal: { previous: async (c, a) => journal[a] ?? null, begin: async () => {}, complete: async () => {}, skip: async (c, a) => { skipped.push(a); } },
  };
  const xero = { lookup: async () => [], createDraft: async () => 'xero1', attachOriginal: async () => {}, verifyOriginal: async () => true };
  return { port, xero, calls, made, skipped };
}

test('a long thread: only the newest invoice is drafted, older ones skipped and recorded, ONE Sheet row, Human review, no archive', async () => {
  const f = fixture();
  const r = await runApInbox(f.port, f.xero);
  assert.deepEqual(f.made, ['fil_e5~1']);                                   // only the most recent invoice is read and drafted
  assert.deepEqual(f.skipped.sort(), ['fil_e1~1', 'fil_e2~1', 'fil_e3~1', 'fil_e4~1']);
  const sheet = f.calls.filter(c => c[0] === 'sheet');
  assert.equal(sheet.length, 1);                                            // one row, not one per old document
  assert.equal(sheet[0][1], 'long_thread');
  assert.match(sheet[0][2], /4 older document\(s\) were skipped/);
  assert.deepEqual(f.calls.filter(c => c[0] === 'tag'), [['tag', 'Human review']]);
  assert.equal(f.calls.some(c => c[0] === 'archive'), false);
  assert.equal(r.archived, 0);
  assert.equal(r.items[0].skippedOlder, 4);
  assert.equal(r.documents, 1);
});
test('the next run: nothing is re-read, no second Sheet row, the conversation stays with finance', async () => {
  const journal = { 'fil_e1~1': { status: 'skipped_long_thread' }, 'fil_e2~1': { status: 'skipped_long_thread' }, 'fil_e3~1': { status: 'skipped_long_thread' },
    'fil_e4~1': { status: 'skipped_long_thread' }, 'fil_e5~1': { status: 'draft_verified', xeroId: 'x' } };
  const f = fixture({ journal });
  const r = await runApInbox(f.port, f.xero);
  assert.deepEqual(f.made, []);
  assert.deepEqual(f.skipped, []);
  assert.equal(f.calls.filter(c => c[0] === 'sheet').length, 0);
  assert.deepEqual(f.calls.filter(c => c[0] === 'tag'), [['tag', 'Human review']]);
  assert.equal(f.calls.some(c => c[0] === 'archive'), false);
  assert.equal(r.items[0].skippedOlder, undefined);
});
test('a normal email with several invoices attached is processed in full, drafted and archived as before', async () => {
  const f = fixture();
  f.port.listAllOpenConversations = async () => [{ id: 'cnv_b', subject: 'Invoices', body: '', attachments: ['i1', 'i2', 'i3', 'i4', 'i5'].map(n => ({ id: `fil_${n}`, filename: `${n}.pdf`, messageId: 'msg_9', receivedAt: T(5) })) }];
  const r = await runApInbox(f.port, f.xero);
  assert.equal(f.made.length, 5);
  assert.equal(f.skipped.length, 0);
  assert.equal(f.calls.filter(c => c[0] === 'sheet').length, 0);
  assert.equal(r.archived, 1);
});
test('the newest invoice still gets its own outcome (here: supplier not in Xero) alongside the single thread row', async () => {
  const f = fixture();
  const { DocumentNeedsHumanReview } = await import('../dist/ap-document-verification.js');
  f.port.makeDraftCommand = async () => { throw new DocumentNeedsHumanReview('supplier_missing', 'Supplier "X" is not in Xero'); };
  await runApInbox(f.port, f.xero);
  assert.deepEqual(f.calls.filter(c => c[0] === 'sheet').map(c => c[1]).sort(), ['long_thread', 'supplier_missing']);
  assert.deepEqual(f.calls.filter(c => c[0] === 'tag'), [['tag', 'Human review']]);
});
test('a conversation already tagged Human review is never re-tagged, and old documents are still skipped once', async () => {
  const f = fixture();
  const list = await f.port.listAllOpenConversations();
  f.port.listAllOpenConversations = async () => [{ ...list[0], tags: ['Human review'] }];
  const r = await runApInbox(f.port, f.xero);
  assert.equal(f.skipped.length, 4);
  assert.equal(f.calls.filter(c => c[0] === 'tag').length, 0);
  assert.match(r.items[0].tag, /unchanged/);
});

// ---- email dates ----
const b64pdf = 'JVBERi0xLjQK'; // "%PDF-1.4\n"
const part = `Content-Type: application/pdf; name="inv.pdf"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="inv.pdf"\r\n\r\n${b64pdf}\r\n`;
test('a PDF in an attached email carries that email\'s Date header', () => {
  const eml = `From: a@b.com\r\nDate: Tue, 17 Nov 2026 10:00:00 +0000\r\nContent-Type: multipart/mixed; boundary="B1"\r\n\r\n--B1\r\nContent-Type: text/plain\r\n\r\nhi\r\n--B1\r\n${part}--B1--\r\n`;
  const out = extractPdfsFromEml(eml);
  assert.equal(out.length, 1);
  assert.equal(out[0].date, Date.UTC(2026, 10, 17, 10, 0, 0));
});
test('a PDF in a forwarded email inside an attached email takes the INNER email\'s date', () => {
  const inner = `From: s@x.com\r\nDate: Mon, 02 Mar 2026 08:30:00 +0000\r\nContent-Type: multipart/mixed; boundary="B2"\r\n\r\n--B2\r\n${part}--B2--\r\n`;
  const eml = `From: a@b.com\r\nDate: Tue, 17 Nov 2026 10:00:00 +0000\r\nContent-Type: multipart/mixed; boundary="B1"\r\n\r\n--B1\r\nContent-Type: message/rfc822\r\n\r\n${inner}\r\n--B1--\r\n`;
  const out = extractPdfsFromEml(eml);
  assert.equal(out.length, 1);
  assert.equal(out[0].date, Date.UTC(2026, 2, 2, 8, 30, 0));
});
test('no usable Date header gives null, never a made-up date', () => {
  const eml = `From: a@b.com\r\nContent-Type: multipart/mixed; boundary="B1"\r\n\r\n--B1\r\n${part}--B1--\r\n`;
  assert.equal(extractPdfsFromEml(eml)[0].date, null);
  const bad = `From: a@b.com\r\nDate: not a date\r\nContent-Type: multipart/mixed; boundary="B1"\r\n\r\n--B1\r\n${part}--B1--\r\n`;
  assert.equal(extractPdfsFromEml(bad)[0].date, null);
});

// ---- the scan carries message times ----
test('the inbox scan keeps each message\'s time (epoch milliseconds) on its attachments', async () => {
  const base = 'https://api2.frontapp.com';
  const pages = {
    '/inboxes/inb_123/conversations': { _results: [{ id: 'cnv_abc', status: 'unassigned', assignee: null, subject: 'x' }] },
    '/conversations/cnv_abc/messages': { _results: [
      { id: 'msg_1', created_at: 1_700_000_000, attachments: [{ filename: 'old.pdf', url: `${base}/download/fil_old` }] },
      { id: 'msg_2', created_at: 1_700_500_000.5, attachments: [{ filename: 'new.pdf', url: `${base}/download/fil_new` }] },
      { id: 'msg_3', attachments: [{ filename: 'undated.pdf', url: `${base}/download/fil_nodate` }] },
    ] },
  };
  const r = await scanApFrontInbox({ inboxId: 'inb_123', fetchPage: async (url) => { const u = new URL(url, base); return pages[u.pathname]; } });
  const by = Object.fromEntries(r[0].attachments.map(a => [a.id, a]));
  assert.equal(by.fil_old.receivedAt, 1_700_000_000_000);
  assert.equal(by.fil_new.receivedAt, 1_700_500_001_000 - 500); // rounded to the millisecond
  assert.equal('receivedAt' in by.fil_nodate, false);
});
