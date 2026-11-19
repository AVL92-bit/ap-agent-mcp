import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseCompanies, loadCompanies, liveCompanies, runAsCompany, currentCompany, currentCompanyOrNull, _setCompaniesForTest,
} from '../dist/companies.js';
import { summariseRun } from '../dist/ap-schedule.js';
import { vatPolicyForInbox } from '../dist/inbox-vat-policy.js';

const T1 = '45a1074b-b172-4f49-a192-f0a8e293b54d';
const T2 = '11111111-2222-4333-8444-555555555555';
const entry = (over) => ({ key: 'st-georges', name: "St George's Road Surgery", frontInboxId: 'inb_bys7q', xeroTenantId: T1, xeroTenantName: "St George's Road Surgery", status: 'live', ...over });
const lamb = (over) => ({ key: 'lamberhurst', name: 'Lamberhurst', frontInboxId: 'inb_bys46', xeroTenantId: T2, xeroTenantName: 'Lamberhurst Surgery', status: 'live', ...over });
const two = () => parseCompanies({ companies: [entry(), lamb()] });

test('the shipped registry is valid, keeps St George\'s live, and Lamberhurst is off until its tenant is filled in', () => {
  _setCompaniesForTest(null);
  const list = loadCompanies();
  const sg = list.find(c => c.key === 'st-georges');
  assert.equal(sg.frontInboxId, 'inb_bys7q');
  assert.equal(sg.xeroTenantId, T1);
  assert.equal(sg.status, 'live');
  const lb = list.find(c => c.key === 'lamberhurst');
  assert.equal(lb.frontInboxId, 'inb_bys46');
  assert.equal(lb.status === 'off' || lb.xeroTenantId !== null, true);
});
test('shipped config also has a VAT policy for every inbox in the registry', () => {
  _setCompaniesForTest(null);
  for (const c of loadCompanies()) assert.doesNotThrow(() => vatPolicyForInbox(c.frontInboxId));
});

test('registry validation: rejects bad ids, duplicates, and a switched-on company with no Xero tenant', () => {
  assert.throws(() => parseCompanies({ companies: [] }));
  assert.throws(() => parseCompanies({ companies: [entry({ frontInboxId: 'bad' })] }), /Front inbox/);
  assert.throws(() => parseCompanies({ companies: [entry({ xeroTenantId: 'nope' })] }), /tenant ID/);
  assert.throws(() => parseCompanies({ companies: [entry({ status: 'on' })] }), /status/);
  assert.throws(() => parseCompanies({ companies: [entry({ xeroTenantId: null })] }), /switched on without/);
  assert.throws(() => parseCompanies({ companies: [entry(), lamb({ key: 'other', xeroTenantId: T1 })] }), /duplicate xeroTenantId/);
  assert.throws(() => parseCompanies({ companies: [entry(), lamb({ frontInboxId: 'inb_bys7q' })] }), /duplicate frontInboxId/);
  assert.doesNotThrow(() => parseCompanies({ companies: [entry(), lamb({ status: 'off', xeroTenantId: null, xeroTenantName: null })] }));
});

test('only live companies are scheduled; dry_run companies are readable but never writable', async () => {
  _setCompaniesForTest(parseCompanies({ companies: [entry(), lamb({ status: 'dry_run' })] }));
  assert.deepEqual(liveCompanies().map(c => c.key), ['st-georges']);
  const lb = loadCompanies()[1];
  await assert.rejects(() => runAsCompany(lb, async () => 1), /not live/);
  assert.equal(await runAsCompany(lb, async () => currentCompany().key, 'read'), 'lamberhurst');
  _setCompaniesForTest(parseCompanies({ companies: [entry(), lamb({ status: 'off', xeroTenantId: null, xeroTenantName: null })] }));
  await assert.rejects(() => runAsCompany(loadCompanies()[1], async () => 1, 'read'), /not switched on/);
  _setCompaniesForTest(null);
});

test('a run sees only its own company, even when the environment points at another and runs overlap', async () => {
  _setCompaniesForTest(two());
  process.env.FRONT_ENABLED_INBOX_ID = 'inb_bys7q';
  process.env.XERO_PILOT_TENANT_ID = T1;
  const [sg, lb] = loadCompanies();
  assert.equal(currentCompany().key, 'st-georges'); // outside a run: the legacy env company
  const seen = [];
  const job = (c, delay) => runAsCompany(c, async () => {
    await new Promise(r => setTimeout(r, delay));
    seen.push([c.key, currentCompany().key, currentCompany().xeroTenantId, currentCompany().frontInboxId]);
  });
  await Promise.all([job(lb, 20), job(sg, 5), job(lb, 1)]);
  for (const [started, saw, tenant, inbox] of seen) {
    assert.equal(saw, started);
    assert.equal(tenant, started === 'lamberhurst' ? T2 : T1);
    assert.equal(inbox, started === 'lamberhurst' ? 'inb_bys46' : 'inb_bys7q');
  }
  assert.equal(seen.length, 3);
  assert.equal(currentCompany().key, 'st-georges');
  _setCompaniesForTest(null);
});

test('outside a run, an env that disagrees with the registry is refused (fail closed)', () => {
  _setCompaniesForTest(two());
  process.env.FRONT_ENABLED_INBOX_ID = 'inb_bys46';
  process.env.XERO_PILOT_TENANT_ID = T1; // Lamberhurst's inbox paired with St George's tenant
  assert.throws(() => currentCompany(), /does not match/);
  assert.equal(currentCompanyOrNull(), null);
  process.env.FRONT_ENABLED_INBOX_ID = 'inb_unknown1';
  assert.throws(() => currentCompany(), /does not match/);
  _setCompaniesForTest(null);
});

test('the Xero writer is per company: the tenant it verifies is the run\'s, and caches are keyed by tenant', () => {
  for (const f of ['ap-xero-live-port.ts', 'ap-live-document-ports.ts', 'xero-pilot-test.ts']) {
    const s = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
    assert.equal(/45a1074b-b172-4f49-a192-f0a8e293b54d|inb_bys7q/.test(s.replace(/EXPECTED_INBOX_ID = "inb_bys7q"/, '')), false, `${f} must not hard-code a company`);
  }
  const ports = readFileSync(new URL('../src/ap-live-document-ports.ts', import.meta.url), 'utf8');
  assert.match(ports, /xeroCaches = new Map/);
  const session = readFileSync(new URL('../src/xero-pilot-test.ts', import.meta.url), 'utf8');
  assert.match(session, /verifiedSessions = new Map/);
});

test('scheduled-run summary keeps per-company numbers, totals them, and flags a failed company', () => {
  const sg = { status: 'completed', conversations: 3, documents: 2, archived: 2, items: [{ archived: true, failures: [] }, { archived: true, failures: [] }, { archived: false, failures: ['x'] }] };
  const s = summariseRun({ companies: { 'st-georges': sg, lamberhurst: { status: 'failed', error: 'boom' } } });
  assert.equal(s.conversations, 3);
  assert.equal(s.failures, 1);
  assert.deepEqual(s.failed_companies, ['lamberhurst']);
  assert.equal(s.by_company['st-georges'].documents, 2);
  assert.equal(s.by_company.lamberhurst.status, 'failed');
  // single-company results are summarised exactly as before
  assert.equal(summariseRun(sg).documents, 2);
});
