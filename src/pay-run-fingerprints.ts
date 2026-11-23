/**
 * Bank-details change check (owner decision 2026-11-23; the second guard in the pay run brief).
 *
 * The pay run file is built from whatever Xero holds on the day, so a quietly changed account (a standard fraud)
 * would flow straight into the file. For every supplier the agent keeps a KEYED HASH (HMAC-SHA256) of the
 * details a person last verified: sort code, account number and account name. Never the details themselves: a
 * plain hash of an 8-digit account number could be guessed, so the hash is keyed with a secret derived from
 * XERO_TOKEN_ENCRYPTION_KEY that never leaves the server.
 *
 *   unverified  never verified: a person must check it (by phone, from a trusted record), then accept it
 *   changed     differs from the verified details: check before paying, then accept
 *   unchanged   identical to what was verified
 *   n/a         incomplete details, nothing to compare (the blank cells already flag it)
 *
 * Previews only READ. A supplier's details are recorded as verified only when the owner asks for it
 * (accept_pay_run_bank_details), so a flag cannot disappear just because a file was generated twice.
 */
import { createHmac } from 'node:crypto';
import type { BankStatus, PayLine } from './pay-run.js';

/** A separate subkey, so the master key is never used directly for two purposes. */
export function fingerprintKey(masterHex: string | undefined): Buffer {
  if (!masterHex || !/^[a-fA-F0-9]{64}$/.test(masterHex)) throw new Error('The bank-details change check is unavailable: encryption configuration is invalid');
  return createHmac('sha256', Buffer.from(masterHex, 'hex')).update('ap-agent pay-run bank-details fingerprint v1').digest();
}

type Details = { sortCode: string; accountNumber: string; name: string };
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
/** Hex HMAC of the details, or null when they are incomplete. */
export function fingerprintOf(key: Buffer, d: Details): string | null {
  if (!d.sortCode || !d.accountNumber || !norm(d.name)) return null;
  return createHmac('sha256', key).update([d.sortCode, d.accountNumber, norm(d.name)].join('|')).digest('hex');
}

export function bankStatusFor(fingerprint: string | null, baseline: string | undefined): BankStatus {
  if (!fingerprint) return 'n/a';
  if (baseline === undefined) return 'unverified';
  return baseline === fingerprint ? 'unchanged' : 'changed';
}

/** Sets bankStatus on each line from the verified baselines (contact id to fingerprint). */
export function annotateBankStatus(lines: PayLine[], baselines: Map<string, string>, key: Buffer): PayLine[] {
  for (const l of lines) l.bankStatus = bankStatusFor(fingerprintOf(key, l), baselines.get(l.contactId));
  return lines;
}

export type Verification = { supplier: string; status: 'changed' | 'unverified'; lines: number };
/** One entry per supplier that needs a person to verify its bank details. Changed first. Never any values. */
export function suppliersToVerify(lines: PayLine[]): Verification[] {
  const by = new Map<string, Verification>();
  for (const l of lines) {
    if (l.bankStatus !== 'changed' && l.bankStatus !== 'unverified') continue;
    const cur = by.get(l.contactId);
    if (cur) cur.lines++; else by.set(l.contactId, { supplier: l.supplier, status: l.bankStatus, lines: 1 });
  }
  return [...by.values()].sort((a, b) => Number(b.status === 'changed') - Number(a.status === 'changed') || a.supplier.localeCompare(b.supplier));
}
export function bankCheckCounts(lines: PayLine[]) {
  const n = { unchanged: 0, changed: 0, unverified: 0, not_checkable: 0 };
  for (const l of lines) { if (l.bankStatus === 'unchanged') n.unchanged++; else if (l.bankStatus === 'changed') n.changed++; else if (l.bankStatus === 'unverified') n.unverified++; else n.not_checkable++; }
  return n;
}

// ---- storage (Postgres): only fingerprints, supplier names and dates ----
export type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };
export async function ensureBaselineTable(db: Queryable): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS pay_run_bank_baselines (
    company_key text NOT NULL, contact_id text NOT NULL, supplier text NOT NULL, fingerprint text NOT NULL,
    accepted_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (company_key, contact_id))`);
}
export async function loadBaselines(db: Queryable, companyKey: string): Promise<Map<string, string>> {
  const r = await db.query('SELECT contact_id, fingerprint FROM pay_run_bank_baselines WHERE company_key = $1', [companyKey]);
  return new Map(r.rows.map((row: any) => [String(row.contact_id), String(row.fingerprint)]));
}
/** Records the current details of these lines as verified. Lines with incomplete details are never recorded. */
export async function acceptBaselines(db: Queryable, companyKey: string, lines: PayLine[], key: Buffer): Promise<number> {
  const done = new Set<string>();
  for (const l of lines) {
    const fp = fingerprintOf(key, l);
    if (!fp || done.has(l.contactId)) continue;
    await db.query(`INSERT INTO pay_run_bank_baselines (company_key, contact_id, supplier, fingerprint) VALUES ($1,$2,$3,$4)
      ON CONFLICT (company_key, contact_id) DO UPDATE SET supplier = EXCLUDED.supplier, fingerprint = EXCLUDED.fingerprint, accepted_at = now()`,
      [companyKey, l.contactId, l.supplier, fp]);
    done.add(l.contactId);
  }
  return done.size;
}
