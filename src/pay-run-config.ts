/** Pay run settings from config/pay-run.json. Fails loudly if the file is missing or malformed. */
import { readFileSync } from 'node:fs';
import type { PayRunOptions } from './pay-run.js';

const file = new URL('../config/pay-run.json', import.meta.url);

export function parsePayRunConfig(raw: unknown): PayRunOptions {
  const list = (raw as { always_business?: unknown })?.always_business;
  if (!Array.isArray(list) || list.length > 200 || list.some(n => typeof n !== 'string' || !n.trim() || n.length > 200))
    throw new Error('config/pay-run.json: always_business must be a list of up to 200 supplier names');
  return { alwaysBusiness: list as string[] };
}
export function loadPayRunConfig(): PayRunOptions {
  try { return parsePayRunConfig(JSON.parse(readFileSync(file, 'utf8'))); }
  catch (error) { throw new Error(`Pay run configuration unavailable or invalid (${String(error).slice(0, 150)})`); }
}

/**
 * The Metro account each company's pay run is paid FROM (field 1 of the Metro file).
 *
 * Set by the owner in Railway as PAY_RUN_DEBIT_ACCOUNTS, a JSON object mapping company key (see
 * config/companies.json) to its 8-digit Metro account number, as TEXT so leading zeros survive, e.g.
 *   {"st-georges":"01234567","lamberhurst":"07654321"}
 * Account numbers are never kept in the repository, in notes, or in any tool output. Error messages never
 * contain a value. A Metro company with no entry cannot go into a payment file.
 */
export function parseDebitAccounts(raw: string | undefined): Record<string, string> {
  if (!raw || !raw.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('PAY_RUN_DEBIT_ACCOUNTS is not valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('PAY_RUN_DEBIT_ACCOUNTS must be a JSON object of company key to account number');
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[a-z0-9-]{2,40}$/.test(key)) throw new Error('PAY_RUN_DEBIT_ACCOUNTS has an invalid company key');
    if (typeof value !== 'string' || !/^\d{8}$/.test(value))
      throw new Error(`PAY_RUN_DEBIT_ACCOUNTS: the account for "${key}" must be exactly 8 digits written as text (keep any leading zeros)`);
    out[key] = value;
  }
  return out;
}

/** The debit account for a company, or null when none is configured. */
export function debitAccountFor(companyKey: string, raw: string | undefined = process.env.PAY_RUN_DEBIT_ACCOUNTS): string | null {
  return parseDebitAccounts(raw)[companyKey] ?? null;
}
