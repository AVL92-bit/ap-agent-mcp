import type { PoolClient } from 'pg';

/** Durable claim before a non-idempotent Xero Contacts POST. Never automatically
 * clear a claim: a timed-out POST may have succeeded on Xero's side. */
export function normalizeContactName(name: string): string {
  return name.replace(/[\x00-\x1f]/g, ' ').trim().replace(/\s+/g, ' ').slice(0, 200);
}
export function contactIdentity(name: string): string {
  return normalizeContactName(name).toLocaleLowerCase('en-GB');
}
export async function ensureApContactIntent(client: PoolClient): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS ap_contact_write_intent (
    supplier_key text PRIMARY KEY, supplier_name text NOT NULL,
    xero_contact_id text, claimed_at timestamptz NOT NULL DEFAULT now(),
    reconciled_at timestamptz)`);
}
export function makeApContactIntent(client: PoolClient) {
  return {
    async get(name: string): Promise<string | null | undefined> {
      const r = await client.query('SELECT xero_contact_id FROM ap_contact_write_intent WHERE supplier_key=$1', [contactIdentity(name)]);
      if (!r.rowCount) return undefined;
      return r.rows[0].xero_contact_id ?? null;
    },
    async claim(name: string): Promise<boolean> {
      const r = await client.query(`INSERT INTO ap_contact_write_intent(supplier_key,supplier_name)
        VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING supplier_key`, [contactIdentity(name), normalizeContactName(name)]);
      return r.rowCount === 1;
    },
    async reconciled(name: string, contactId: string): Promise<void> {
      if (!contactId) throw new Error('Missing reconciled Xero contact ID');
      const r = await client.query(`UPDATE ap_contact_write_intent
        SET xero_contact_id=$2,reconciled_at=now() WHERE supplier_key=$1
        RETURNING supplier_key`, [contactIdentity(name), contactId]);
      if (r.rowCount !== 1) throw new Error('Missing durable contact intent');
    },
  };
}

/** Reconcile an exact Xero name before any POST. A previous claimed intent with
 * no exact match is intentionally blocked instead of risking duplicate creation. */
export async function resolveProvisionalContact<T extends {id:string;name:string}>(input: {
  name: string;
  listContacts: () => Promise<T[]>;
  intent: ReturnType<typeof makeApContactIntent>;
  postContact: (name:string) => Promise<T>;
}): Promise<T> {
  const name = normalizeContactName(input.name);
  if (!name) throw new Error('No provisional supplier name available');
  const matches = (await input.listContacts()).filter(c => contactIdentity(c.name) === contactIdentity(name));
  if (matches.length > 1) throw new Error('Multiple Xero contacts share the supplier name; reconcile manually');
  if (matches.length === 1) {
    if (await input.intent.get(name) !== undefined) await input.intent.reconciled(name, matches[0].id);
    return matches[0];
  }
  const previous = await input.intent.get(name);
  if (previous !== undefined) {
    // Even a recorded ID is not sufficient without a fresh Xero read.
    throw new Error('Provisional contact POST may have committed; no exact Xero contact found. Reconciliation required; no repeat POST');
  }
  if (!(await input.intent.claim(name))) throw new Error('Provisional contact intent already claimed; reconciliation required');
  const created = await input.postContact(name);
  await input.intent.reconciled(name, created.id);
  return created;
}
