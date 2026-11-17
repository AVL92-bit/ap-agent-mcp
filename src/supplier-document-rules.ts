/** Supplier-specific document rules from config/coding-policies.json.
 * statement_is_invoice_suppliers: suppliers whose statements are their invoices (e.g. Lantum's
 * consolidated statements carry the number finance pays against). */
import { readFileSync } from 'node:fs';

const policyFile = new URL('../config/coding-policies.json', import.meta.url);
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function statementIsInvoiceSuppliers(): string[] {
  try {
    const raw = JSON.parse(readFileSync(policyFile, 'utf8')) as { statement_is_invoice_suppliers?: { suppliers?: unknown } };
    const list = raw.statement_is_invoice_suppliers?.suppliers;
    return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string' && key(s).length >= 3) : [];
  } catch { return []; }
}

/** The configured supplier this statement comes from, if its statements count as invoices.
 * Matched on the extracted supplier name first, then on the document text. */
export function statementInvoiceSupplier(supplierName: string | null | undefined, text: string, suppliers = statementIsInvoiceSuppliers()): string | null {
  const name = key(supplierName ?? '');
  const body = key(text);
  for (const s of suppliers) {
    const k = key(s);
    if ((name && name.includes(k)) || body.includes(k)) return s;
  }
  return null;
}
