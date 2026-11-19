/**
 * Pay run file rules (pure functions: no network, no database).
 *
 * The agent PREPARES the Revolut bulk-transfer template from Xero bills awaiting payment; the owner
 * opens it, fills any gaps, removes lines and uploads it himself. The agent never pays, approves or
 * edits contacts. Bank details come from the Xero contact record only, never from an invoice or email.
 *
 * Owner decisions (2026-11-19):
 *  - ONE file: the Revolut template. No separate review file.
 *  - One payment line PER INVOICE; the reference is the invoice number (last 18 characters if longer).
 *  - Every awaiting invoice gets a row, filled with whatever Xero reliably holds; missing details are
 *    left BLANK for the owner to complete (which also prompts him to fix Xero).
 *  - Skipped entirely: direct debit "(DD)" suppliers, non-GBP bills, zero or negative amounts.
 *  - Credit notes and credit on account are not considered: the owner checks those in Xero.
 *
 * `buildPayRun` returns lines that contain bank details (for the CSV only) and a masked summary
 * (`summarise`) that is safe to show anywhere: it never contains a sort code or account number.
 */

export type XeroBill = {
  number: string; contactId: string; contactName: string;
  amountDue: number; dueDate: string | null; currency: string;
};
export type XeroContact = {
  contactId: string; name: string;
  bankAccountDetails?: string | null;
  batchPayments?: { BankAccountNumber?: string; BankAccountName?: string } | null;
};

/** Words in a bank account name that make it a business account. Extend as edge cases appear. */
export const BUSINESS_NAME_WORDS = ['limited', 'ltd', 'llp', 'plc', 'lp', 'cic', 'llc', 'inc', 'trust', 'partnership', 'foundation'];
/** UK Faster Payments references are short; confirm Revolut's real limit in the test batch. */
export const REFERENCE_MAX = 18;

export type RecipientType = 'BUSINESS' | 'INDIVIDUAL';
export function recipientTypeFor(accountName: string): RecipientType {
  const words = accountName.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  return words.some(w => BUSINESS_NAME_WORDS.includes(w)) ? 'BUSINESS' : 'INDIVIDUAL';
}

/** Direct debit suppliers (Xero contact named "(DD)") are collected by the supplier: never paid by transfer. */
export function isDirectDebitContact(name: string): boolean {
  return /\(\s*dd\s*\)|direct\s*debit/i.test(name);
}

/** Characters kept in a payment reference: letters, digits, space, hyphen and slash. Everything else
 * (for example * # & % " ' . , : ; ( ) + _ @) is removed because banks reject or garble them.
 * Widen this only after a Revolut test batch shows more is accepted. */
const REFERENCE_UNSAFE = /[^A-Za-z0-9 \/-]/g;

/** The invoice number as the payment reference: unsafe characters removed first, then, if still too long,
 * the LAST 18 characters are kept (owner decision 2026-11-19). A separator left at the front by the cut is dropped. */
export function referenceFor(invoiceNumber: string): string {
  const cleaned = invoiceNumber.replace(REFERENCE_UNSAFE, '').replace(/\s+/g, ' ').trim();
  const cut = cleaned.length > REFERENCE_MAX ? cleaned.slice(-REFERENCE_MAX) : cleaned;
  return cut.replace(/^[ \/-]+/, '');
}

export type BankParse =
  | { ok: true; sortCode: string; accountNumber: string }
  | { ok: false; problem: 'missing' | 'unrecognised_format' | 'details_disagree' };
const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');
/** Sort code (6) and account number (8) from BankAccountDetails (14 digits). If Xero's batch-payment
 * account number is also present it must agree, otherwise a typo in one of the two is caught here. */
export function parseBankDetails(c: XeroContact): BankParse {
  const main = digits(c.bankAccountDetails);
  const batch = digits(c.batchPayments?.BankAccountNumber);
  if (!main && !batch) return { ok: false, problem: 'missing' };
  if (main.length !== 14) return { ok: false, problem: main ? 'unrecognised_format' : 'missing' };
  const sortCode = main.slice(0, 6), accountNumber = main.slice(6);
  if (batch && batch !== accountNumber && batch !== main) return { ok: false, problem: 'details_disagree' };
  return { ok: true, sortCode, accountNumber };
}

/** What is blank on a line, and why. Never contains the values themselves. */
export type Missing = 'account_name' | 'bank_details' | 'bank_details_unrecognised' | 'bank_details_disagree' | 'contact_not_found';
export type PayLine = {
  /** Xero contact name: for the masked summary only, never written to the CSV. */
  supplier: string; billNumber: string; dueDate: string | null;
  // The eight template columns' variable values (blank string when Xero has no reliable value):
  name: string; recipientType: RecipientType | ''; accountNumber: string; sortCode: string; amount: number; reference: string;
  missing: Missing[];
};

const pennies = (n: number) => Math.round(n * 100);
const normName = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
export type PayRunOptions = {
  /** Suppliers that are businesses although the bank account name has no Ltd/Limited etc. (config/pay-run.json). */
  alwaysBusiness?: string[];
};
export function buildPayRun(bills: XeroBill[], contacts: XeroContact[], options: PayRunOptions = {}) {
  const forcedBusiness = new Set((options.alwaysBusiness ?? []).map(normName));
  const contactById = new Map(contacts.map(c => [c.contactId, c]));
  const supplierName = (b: XeroBill) => contactById.get(b.contactId)?.name ?? b.contactName;
  const skipped = { direct_debit: 0, non_gbp: 0, zero_or_negative: 0 };
  const lines: PayLine[] = [];
  const bankCache = new Map<string, BankParse>();
  for (const b of bills) {
    const supplier = supplierName(b);
    if (isDirectDebitContact(supplier)) { skipped.direct_debit++; continue; }
    if (b.currency !== 'GBP') { skipped.non_gbp++; continue; }
    if (!(b.amountDue > 0)) { skipped.zero_or_negative++; continue; }
    const contact = contactById.get(b.contactId);
    const missing: Missing[] = [];
    let name = '', accountNumber = '', sortCode = '';
    if (!contact) missing.push('contact_not_found');
    else {
      name = (contact.batchPayments?.BankAccountName ?? '').trim();
      if (!name) missing.push('account_name');
      const bank = bankCache.get(b.contactId) ?? bankCache.set(b.contactId, parseBankDetails(contact)).get(b.contactId)!;
      if (bank.ok) { accountNumber = bank.accountNumber; sortCode = bank.sortCode; }
      // Numbers that cannot be trusted are left blank, never guessed.
      else missing.push(bank.problem === 'missing' ? 'bank_details' : bank.problem === 'unrecognised_format' ? 'bank_details_unrecognised' : 'bank_details_disagree');
    }
    const isForcedBusiness = forcedBusiness.has(normName(supplier)) || (name !== '' && forcedBusiness.has(normName(name)));
    lines.push({ supplier, billNumber: b.number, dueDate: b.dueDate, name,
      recipientType: isForcedBusiness ? 'BUSINESS' : name ? recipientTypeFor(name) : '',
      accountNumber, sortCode, amount: b.amountDue, reference: referenceFor(b.number), missing });
  }
  // Incomplete lines first so they are noticed; then by supplier, due date, invoice number.
  lines.sort((a, b) => Number(b.missing.length > 0) - Number(a.missing.length > 0) || a.supplier.localeCompare(b.supplier)
    || (a.dueDate ?? '').localeCompare(b.dueDate ?? '') || a.billNumber.localeCompare(b.billNumber));
  const incomplete = lines.filter(l => l.missing.length > 0);
  return { lines, skipped, totals: {
    lines: lines.length, complete_lines: lines.length - incomplete.length, incomplete_lines: incomplete.length,
    amount: lines.reduce((n, l) => n + pennies(l.amount), 0) / 100 } };
}

/** Masked summary for chat: what is blank and why. Never any sort code, account number or account name. */
export function summarise(run: ReturnType<typeof buildPayRun>) {
  return {
    totals: run.totals,
    skipped: run.skipped,
    lines: run.lines.map(l => ({ supplier: l.supplier, invoice: l.billNumber, due: l.dueDate, amount: l.amount,
      reference: l.reference, recipient_type: l.recipientType || null, blank: l.missing })),
  };
}

const csvCell = (v: string | number) => {
  let s = String(v);
  // Cells that start with a formula character are neutralised so a hostile supplier name cannot run in a spreadsheet.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** The Revolut bulk-transfer template: exactly its eight columns, GBP to GB only. Gaps are left blank. */
export function renderRevolutCsv(lines: PayLine[]): string {
  const header = ['Name', 'Recipient type', 'Account number', 'Sort code', 'Recipient bank country', 'Currency', 'Amount', 'Payment reference'];
  const rows = lines.map(l => [l.name, l.recipientType, l.accountNumber, l.sortCode, 'GB', 'GBP', l.amount.toFixed(2), l.reference]);
  return [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
