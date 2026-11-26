import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { frontCommentText, makeFrontCommentDeliver, frontCommentsEnabled, FRONT_COMMENTS_TABLE, FRONT_COMMENT_MAX_ATTEMPTS } from '../dist/ap-front-comments.js';
import { makeApSheetOutbox } from '../dist/ap-sheet-outbox.js';

const row = (over = {}) => ({ conversationId: 'cnv_1d8tfwuu', attachmentId: 'fil_1', outcome: 'supplier_missing', reason: 'Supplier "Amazon" is not in Xero.',
  filename: 'inv.pdf', supplier: 'Acme (Xero)', extractedSupplier: 'Acme Ltd', reference: 'INV-1', gross: 33.5, company: 'Giffard Drive Surgery', ...over });

test('the comment says what happened, why, and the file, supplier, number and amount', () => {
  const t = frontCommentText(row());
  assert.match(t, /^AP Agent: NOT DRAFTED - supplier not in Xero\n/);
  assert.match(t, /Supplier "Amazon" is not in Xero\./);
  assert.match(t, /File: inv\.pdf/); assert.match(t, /Supplier in Xero: Acme \(Xero\)/); assert.match(t, /Supplier on the document: Acme Ltd/);
  assert.match(t, /Invoice number: INV-1/); assert.match(t, /Amount: £33\.50/);
});
test('every outcome has a plain label, and a row with only the required fields still reads well', () => {
  for (const o of ['draft_uncertain', 'technical_failure', 'not_invoice', 'unclear', 'not_posted', 'supplier_missing', 'long_thread'])
    assert.match(frontCommentText({ conversationId: 'cnv_1', attachmentId: 'a', outcome: o, reason: 'why' }), /^AP Agent: [A-Z]/);
  assert.equal(frontCommentText({ conversationId: 'cnv_1', attachmentId: 'a', outcome: 'unclear', reason: 'why' }), 'AP Agent: NOT DRAFTED - needs a person\nwhy');
});
test('the comment never carries the company field, an Xero id, or anything but the named fields', () => {
  const t = frontCommentText(row({ xeroId: 'secret-xero-id' }));
  assert.equal(/secret-xero-id|Giffard Drive Surgery/.test(t), false);
  assert.ok(t.length <= 4000);
});
test('delivery posts one internal comment to the conversation and nothing else', async () => {
  const calls = [];
  await makeFrontCommentDeliver(async (path, method, body) => { calls.push({ path, method, body }); return { ok: true, status: 201, text: async () => '' }; })(row());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/conversations/cnv_1d8tfwuu/comments'); assert.equal(calls[0].method, 'POST');
  assert.deepEqual(Object.keys(calls[0].body), ['body']);
});
test('a Front error is thrown (so the queue retries) with the status, and a bad conversation id never reaches Front', async () => {
  await assert.rejects(makeFrontCommentDeliver(async () => ({ ok: false, status: 404, text: async () => '{"_error":{"message":"Not found"}}' }))(row()), /Front comment HTTP 404: .*Not found/);
  let called = 0;
  await assert.rejects(makeFrontCommentDeliver(async () => { called++; return { ok: true, status: 200, text: async () => '' }; })(row({ conversationId: '../x' })), /Invalid Front conversation id/);
  assert.equal(called, 0);
});
test('comments are on unless FRONT_COMMENTS_ENABLED is false', () => {
  assert.equal(frontCommentsEnabled({}), true);
  assert.equal(frontCommentsEnabled({ FRONT_COMMENTS_ENABLED: 'true' }), true);
  assert.equal(frontCommentsEnabled({ FRONT_COMMENTS_ENABLED: 'false' }), false);
  assert.equal(frontCommentsEnabled({ FRONT_COMMENTS_ENABLED: ' FALSE ' }), false);
});

// ---- the queue: its own table, one comment per conversation+document+outcome, give-up after repeated failure ----
function fakeDb() {
  const tables = new Map(); const sqls = [];
  const rows = (sql) => { const m = /(?:INTO|FROM|UPDATE|TABLE IF NOT EXISTS) (ap_[a-z_]+)/.exec(sql); const n = m[1]; if (!tables.has(n)) tables.set(n, new Map()); return tables.get(n); };
  return { tables, sqls, async query(sql, args = []) {
    sqls.push(sql); const r = rows(sql);
    if (sql.includes('INSERT INTO')) { if (!r.has(args[0]) || !r.get(args[0]).delivered) r.set(args[0], { payload: JSON.parse(args[1]), delivered: false, attempts: 0 }); return { rows: [] }; }
    if (sql.includes('SELECT source_key,payload')) return { rows: [...r].filter(([, v]) => !v.delivered).map(([source_key, v]) => ({ source_key, payload: v.payload, attempts: v.attempts })) };
    if (sql.includes('SET delivered_at=now()')) { const v = r.get(args[0]); v.delivered = true; v.attempts++; if (args[1]) v.error = args[1]; return { rows: [] }; }
    if (sql.includes('SET attempts=attempts+1')) { const v = r.get(args[0]); v.attempts++; v.error = args[1]; return { rows: [] }; }
    if (sql.includes('SELECT count(*)')) return { rows: [{ n: [...r.values()].filter(x => !x.delivered).length }] };
    return { rows: [] };
  } };
}
test('the comment queue has its own table: a Sheet delivery never counts as a comment delivery', async () => {
  const db = fakeDb(); let sheet = 0, comments = 0;
  const s = makeApSheetOutbox(db, async () => { sheet++; });
  const c = makeApSheetOutbox(db, async () => { comments++; }, FRONT_COMMENTS_TABLE, FRONT_COMMENT_MAX_ATTEMPTS);
  await s.enqueue(row()); await s.flush();
  await c.enqueue(row()); await c.flush();
  assert.deepEqual([sheet, comments], [1, 1]);
  assert.ok(db.tables.has('ap_sheet_outbox') && db.tables.has('ap_front_comment_outbox'));
});
test('a repeated exception is commented once, not every morning', async () => {
  const db = fakeDb(); let comments = 0;
  const c = makeApSheetOutbox(db, async () => { comments++; }, FRONT_COMMENTS_TABLE, FRONT_COMMENT_MAX_ATTEMPTS);
  for (let day = 0; day < 4; day++) { await c.enqueue(row()); await c.flush(); }
  assert.equal(comments, 1);
  await c.enqueue(row({ outcome: 'unclear' })); await c.flush(); // a different outcome for the same document is a new comment
  assert.equal(comments, 2);
});
test('a comment that keeps failing is retried, then given up on with the error kept, so it never sits pending forever', async () => {
  const db = fakeDb();
  const c = makeApSheetOutbox(db, async () => { throw new Error('Front comment HTTP 404'); }, FRONT_COMMENTS_TABLE, FRONT_COMMENT_MAX_ATTEMPTS);
  await c.enqueue(row());
  for (let i = 1; i < FRONT_COMMENT_MAX_ATTEMPTS; i++) assert.deepEqual(await c.flush(), { delivered: 0, failed: 1, pending: 1 });
  assert.deepEqual(await c.flush(), { delivered: 0, failed: 1, pending: 0 });
  assert.match([...db.tables.get('ap_front_comment_outbox').values()][0].error, /GAVE UP after 5 attempts: .*404/);
  assert.deepEqual(await c.flush(), { delivered: 0, failed: 0, pending: 0 });
});
test('only a safe table name can be used', () => {
  assert.throws(() => makeApSheetOutbox(fakeDb(), async () => {}, 'x; DROP TABLE y'), /Invalid outbox table name/);
});

// ---- wiring ----
const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const live = index.slice(index.indexOf('async function runLiveInboxForCurrentCompany'), index.indexOf('async function runAllLiveCompanies'));
test('the Sheet row is queued first, and a comment problem can never block the Sheet, a draft, a tag or an archive', () => {
  assert.ok(live.indexOf('await sheetOutbox.enqueue') < live.indexOf('commentOutbox.enqueue'));
  assert.match(live, /try \{ await commentOutbox\.enqueue\(.*\} catch\(e\)\{ console\.warn\('Front comment not queued'/);
  assert.match(live, /catch\(e\)\{ console\.warn\('Front comments unavailable'/);
  assert.match(live, /if \(frontCommentsEnabled\(\)\)/);
});
test('comment results are reported per run, separately from failures (a comment error is not a failed conversation)', () => {
  assert.match(live, /front_comments:\{before:commentsBefore,after:commentsAfter\}/);
  assert.equal(/failures\.push[^\n]*comment/i.test(live), false);
  const sched = readFileSync(new URL('../src/ap-schedule.ts', import.meta.url), 'utf8');
  assert.match(sched, /front_comments: result\.front_comments \?\? null/);
});
test('the dry run writes no comments', () => {
  const dry = readFileSync(new URL('../src/ap-inbox-dry-run.ts', import.meta.url), 'utf8');
  assert.equal(/comment/i.test(dry), false);
});
