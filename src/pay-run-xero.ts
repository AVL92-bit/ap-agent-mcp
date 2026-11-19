/**
 * Read-only Xero loading for the pay run. `get` is injected (path relative to the Xero API root,
 * returns parsed JSON), so this is testable without Xero and cannot write: it only ever GETs.
 */
import type { XeroBill, XeroContact } from './pay-run.js';

export type XeroGet = (path: string) => Promise<Record<string, any>>;
const MAX_PAGES = 50;
const ID_CHUNK = 40;

async function paged(get: XeroGet, base: string, key: string): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await get(`${base}${base.includes('?') ? '&' : '?'}page=${page}`);
    const chunk = body[key];
    if (!Array.isArray(chunk)) throw new Error(`Malformed Xero ${key} response`);
    out.push(...chunk);
    if (chunk.length < 100) return out;
  }
  throw new Error(`Xero ${key} pagination incomplete; refusing to build a partial pay run`);
}

/** Bills awaiting payment = approved (AUTHORISED) purchase bills with something still due.
 * Invoices only: credit notes are deliberately not read (the owner checks credit in Xero). */
export async function loadPayRunInputs(get: XeroGet): Promise<{ bills: XeroBill[]; contacts: XeroContact[] }> {
  const where = encodeURIComponent('Type=="ACCPAY"');
  const invoices = await paged(get, `Invoices?Statuses=AUTHORISED&where=${where}&summaryOnly=true`, 'Invoices');
  const bills: XeroBill[] = invoices
    .filter(i => typeof i.AmountDue === 'number' && i.AmountDue !== 0 && i.Contact?.ContactID)
    .map(i => ({ number: String(i.InvoiceNumber ?? i.InvoiceID ?? ''), contactId: i.Contact.ContactID, contactName: String(i.Contact.Name ?? ''),
      amountDue: i.AmountDue, dueDate: typeof i.DueDateString === 'string' ? i.DueDateString.slice(0, 10) : null, currency: String(i.CurrencyCode ?? 'GBP') }));
  const ids = [...new Set(bills.map(b => b.contactId))];
  const contacts: XeroContact[] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const body = await get(`Contacts?IDs=${ids.slice(i, i + ID_CHUNK).join(',')}`);
    if (!Array.isArray(body.Contacts)) throw new Error('Malformed Xero Contacts response');
    for (const c of body.Contacts) contacts.push({ contactId: c.ContactID, name: String(c.Name ?? ''),
      bankAccountDetails: c.BankAccountDetails ?? null, batchPayments: c.BatchPayments ?? null });
  }
  return { bills, contacts };
}
