/**
 * Company registry. Each company (a practice, or AVL/AVCS) pairs ONE Front inbox with ONE Xero
 * organisation. Everything on the live-run path asks `currentCompany()` instead of reading a
 * hard-coded inbox/tenant, so a document read from one company's inbox can only ever be written
 * to that company's Xero organisation.
 *
 * Outside a run, `currentCompany()` falls back to the company named by the legacy environment
 * variables (FRONT_ENABLED_INBOX_ID + XERO_PILOT_TENANT_ID), which keeps the older supervised
 * pilot tools pinned to St George's exactly as before.
 */
import { readFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';

/** off: never touched. dry_run: may be scanned and dry-run (reads only), never written to or scheduled.
 * live: the daily schedule and execute runs may create Xero drafts, tag/archive Front and write the Sheet. */
export type CompanyStatus = 'off' | 'dry_run' | 'live';
/** The bank a company's pay run file is for: the eight practices pay through Metro (one consolidated file,
 * each line paid from that practice's own account); AVL pays through Revolut (its own separate file). */
export type PayBank = 'metro' | 'revolut';
export type Company = Readonly<{
  key: string; name: string; frontInboxId: string;
  xeroTenantId: string | null; xeroTenantName: string | null; status: CompanyStatus;
  /** null = no pay run file for this company. */
  payBank: PayBank | null;
}>;
/** A company that is switched on and fully configured. */
export type ReadyCompany = Company & Readonly<{ xeroTenantId: string; xeroTenantName: string; status: 'dry_run' | 'live' }>;

const file = new URL('../config/companies.json', import.meta.url);
const INBOX_RE = /^inb_[A-Za-z0-9]+$/;
const TENANT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseCompanies(raw: unknown): Company[] {
  const list = (raw as { companies?: unknown })?.companies;
  if (!Array.isArray(list) || !list.length) throw new Error('Company registry is empty or invalid; processing blocked');
  const out: Company[] = [];
  for (const e of list as Array<Record<string, unknown>>) {
    const key = String(e.key ?? '');
    if (!/^[a-z0-9-]{2,40}$/.test(key)) throw new Error(`Company registry: invalid key "${key}"`);
    if (typeof e.name !== 'string' || !e.name.trim()) throw new Error(`Company registry: ${key} has no name`);
    if (typeof e.frontInboxId !== 'string' || !INBOX_RE.test(e.frontInboxId)) throw new Error(`Company registry: ${key} has an invalid Front inbox ID`);
    const tenant = e.xeroTenantId ?? null, tenantName = e.xeroTenantName ?? null;
    if (tenant !== null && (typeof tenant !== 'string' || !TENANT_RE.test(tenant))) throw new Error(`Company registry: ${key} has an invalid Xero tenant ID`);
    if (tenantName !== null && (typeof tenantName !== 'string' || !tenantName.trim())) throw new Error(`Company registry: ${key} has an invalid Xero tenant name`);
    if (e.status !== 'off' && e.status !== 'dry_run' && e.status !== 'live') throw new Error(`Company registry: ${key} status must be off, dry_run or live`);
    if (e.status !== 'off' && (tenant === null || tenantName === null)) throw new Error(`Company registry: ${key} is switched on without a Xero tenant ID and name`);
    const payBank = e.payBank ?? null;
    if (payBank !== null && payBank !== 'metro' && payBank !== 'revolut') throw new Error(`Company registry: ${key} payBank must be metro, revolut or omitted`);
    out.push(Object.freeze({ key, name: e.name.trim(), frontInboxId: e.frontInboxId, xeroTenantId: tenant as string | null,
      xeroTenantName: tenantName as string | null, status: e.status as CompanyStatus, payBank: payBank as PayBank | null }));
  }
  for (const field of ['key', 'name', 'frontInboxId', 'xeroTenantId'] as const) {
    const values = out.map(c => c[field]).filter((v): v is string => v !== null);
    if (new Set(values).size !== values.length) throw new Error(`Company registry: duplicate ${field}`);
  }
  return out;
}

let cached: Company[] | null = null;
export function loadCompanies(): Company[] {
  if (!cached) {
    try { cached = parseCompanies(JSON.parse(readFileSync(file, 'utf8'))); }
    catch (error) { throw new Error(`Company registry unavailable or invalid; processing blocked (${String(error).slice(0, 200)})`); }
  }
  return cached;
}
/** Test hook only. */
export function _setCompaniesForTest(list: Company[] | null): void { cached = list; }

/** Companies that go into the consolidated Metro pay run file: switched on, fully configured, paying through Metro. */
export function metroPayRunCompanies(): ReadyCompany[] {
  return loadCompanies().filter((c): c is ReadyCompany => isReady(c) && c.payBank === 'metro');
}
export function isReady(c: Company): c is ReadyCompany { return c.status !== 'off' && !!c.xeroTenantId && !!c.xeroTenantName; }
/** Companies the daily schedule runs and execute runs may write for. */
export function liveCompanies(): ReadyCompany[] { return loadCompanies().filter((c): c is ReadyCompany => isReady(c) && c.status === 'live'); }
export function companyByKey(key: string): Company | undefined { return loadCompanies().find(c => c.key === key); }
export function companyByInbox(inboxId: string): Company | undefined { return loadCompanies().find(c => c.frontInboxId === inboxId); }

const store = new AsyncLocalStorage<ReadyCompany>();
/** Run `fn` with `company` as the current company. Everything it awaits sees the same company.
 * mode 'write' (default) needs status live; mode 'read' (dry runs, scans) also accepts dry_run. */
export function runAsCompany<T>(company: Company, fn: () => Promise<T>, mode: 'read' | 'write' = 'write'): Promise<T> {
  if (!isReady(company) || (mode === 'write' && company.status !== 'live'))
    return Promise.reject(new Error(`Company "${company.key}" is not ${mode === 'write' ? 'live' : 'switched on'} or not fully configured; nothing was run`));
  return store.run(company, fn);
}

/** The company this code is working for. In a run: the run's company. Otherwise: the company the legacy
 * environment variables point at, and only if it is enabled and both environment values agree with the registry. */
export function currentCompany(): ReadyCompany {
  const inRun = store.getStore();
  if (inRun) return inRun;
  const inbox = process.env.FRONT_ENABLED_INBOX_ID, tenant = process.env.XERO_PILOT_TENANT_ID;
  const c = inbox ? companyByInbox(inbox) : undefined;
  if (!c || !isReady(c) || c.xeroTenantId !== tenant) throw new Error('Front inbox / Xero organisation configuration does not match an enabled company');
  return c;
}
/** For read-only display paths: never throws. */
export function currentCompanyOrNull(): ReadyCompany | null { try { return currentCompany(); } catch { return null; } }
