/**
 * Read-only Xero loading for the pay run. `get` is injected (path relative to the Xero API root,
 * returns parsed JSON), so this is testable without Xero and cannot write: it only ever GETs.
 */
import { isDirectDebitContact, type XeroBill, type XeroContact } from './pay-run.js';

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

/**
 * Diagnostic: lays out every unpaid purchase bill Xero returns and why the pay run includes or skips it,
 * so the pay run can be compared line by line with Xero's own "Awaiting payment" list. Reads only; shows
 * supplier names, invoice numbers and amounts, never bank details. Also counts supplier credit notes
 * (which Xero shows in the same list but the pay run deliberately ignores).
 */
export async function explainPayRunCounts(get: XeroGet) {
  const inv = encodeURIComponent('Type=="ACCPAY"');
  const unpaid = await paged(get, `Invoices?Statuses=DRAFT,SUBMITTED,AUTHORISED&where=${inv}`, 'Invoices');
  const summary = await paged(get, `Invoices?Statuses=AUTHORISED&where=${inv}&summaryOnly=true`, 'Invoices');
  const credits = await paged(get, `CreditNotes?Statuses=AUTHORISED&where=${encodeURIComponent('Type=="ACCPAYCREDIT"')}`, 'CreditNotes');
  const row = (i: any) => {
    const supplier = String(i.Contact?.Name ?? '');
    const due = typeof i.AmountDue === 'number' ? i.AmountDue : null;
    const currency = String(i.CurrencyCode ?? 'GBP');
    const reason = i.Status !== 'AUTHORISED' ? `not_approved (${i.Status})`
      : !i.Contact?.ContactID ? 'no_contact'
      : isDirectDebitContact(supplier) ? 'skipped_direct_debit'
      : currency !== 'GBP' ? 'skipped_non_gbp'
      : !(typeof due === 'number' && due > 0) ? 'skipped_zero_or_negative'
      : 'in_pay_run';
    return { supplier, invoice: String(i.InvoiceNumber ?? ''), status: String(i.Status ?? ''), due_date: typeof i.DueDateString === 'string' ? i.DueDateString.slice(0, 10) : null,
      total: i.Total ?? null, amount_due: due, currency, reason };
  };
  const rows = unpaid.map(row).sort((a, b) => a.reason.localeCompare(b.reason) || a.supplier.localeCompare(b.supplier) || a.invoice.localeCompare(b.invoice));
  const count = (reason: string) => rows.filter(r => r.reason === reason).length;
  const withCredit = credits.filter(c => typeof c.RemainingCredit === 'number' && c.RemainingCredit > 0);
  return {
    counts: {
      returned_unpaid_purchase_bills: rows.length,
      in_pay_run: count('in_pay_run'), skipped_direct_debit: count('skipped_direct_debit'), skipped_non_gbp: count('skipped_non_gbp'),
      skipped_zero_or_negative: count('skipped_zero_or_negative'), no_contact: count('no_contact'),
      not_approved: rows.filter(r => r.reason.startsWith('not_approved')).length,
      approved_with_summary_only_flag: summary.length, approved_without_it: rows.filter(r => r.status === 'AUTHORISED').length,
      supplier_credit_notes_with_credit_left: withCredit.length,
    },
    credit_note_suppliers: withCredit.map(c => ({ supplier: String(c.Contact?.Name ?? ''), remaining: c.RemainingCredit })),
    bills: rows,
  };
}
