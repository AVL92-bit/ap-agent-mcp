/**
 * Read-only diagnostic: describe what Xero returns for a contact WITHOUT exposing sensitive values.
 * Used to find out which fields exist (e.g. whether a bank account name is returned) before any
 * payment-file code relies on them. Digits are always masked, so a sort code or account number can
 * never appear in the output; only a small allowlist of fields shows any value at all.
 */
const SHOW_MASKED = new Set(['Name', 'BankAccountDetails', 'AccountNumber', 'ContactNumber', 'ContactStatus', 'IsSupplier', 'IsCustomer', 'DefaultCurrency']);

export function maskDigits(value: string): string {
  return value.replace(/\d/g, '#').slice(0, 80);
}

export function describeContactFields(contact: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(contact)) {
    if (value === null || value === undefined || value === '') fields[key] = 'empty';
    else if (Array.isArray(value)) fields[key] = value.length ? `present (${value.length} item${value.length === 1 ? '' : 's'})` : 'empty';
    else if (typeof value === 'object') fields[key] = `present (object with keys: ${Object.keys(value as object).join(', ')})`;
    else if (SHOW_MASKED.has(key)) fields[key] = typeof value === 'string' ? maskDigits(value) : value;
    else fields[key] = 'present';
  }
  return fields;
}
