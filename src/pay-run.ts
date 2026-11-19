/**
 * Pay run file rules (pure functions: no network, no database).
 *
 * The agent PREPARES a Revolut bulk-transfer file from Xero bills awaiting payment; the owner
 * reviews, removes lines and uploads it himself. The agent never pays, approves or edits contacts.
 * Bank details come from the Xero contact record only, never from an invoice or email.
 *
 * Output of `buildPayRun` is split on purpose:
 *  - `review`: safe to show anywhere. Never contains a sort code or account number.
 *  - `fileLines`: the lines for the Revolut CSV. Contains bank details; only `renderRevolutCsv` uses it.
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
export type XeroCredit = { contactId: string; remaining: number };

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

export type Flag =
  | 'direct_debit_excluded' | 'not_gbp' | 'no_bank_details' | 'bank_details_unrecognised' | 'bank_details_disagree'
  | 'no_account_name' | 'zero_or_negative_total' | 'unapplied_credit' | 'reference_truncated' | 'contact_not_found';
export type ReviewLine = {
  supplier: string; status: 'ready' | 'needs_attention' | 'excluded'; flags: Flag[];
  recipientType: RecipientType | null; accountNamePresent: boolean;
  bills: Array<{ number: string; dueDate: string | null; amountDue: number }>;
  total: number; reference: string; unappliedCredit: number;
};
export type FileLine = { name: string; recipientType: RecipientType; accountNumber: string; sortCode: string; amount: number; reference: string };

const pennies = (n: number) => Math.round(n * 100);
export function buildPayRun(bills: XeroBill[], contacts: XeroContact[], credits: XeroCredit[] = []) {
  const byContact = new Map<string, XeroBill[]>();
  for (const b of bills) (byContact.get(b.contactId) ?? byContact.set(b.contactId, []).get(b.contactId)!).push(b);
  const contactById = new Map(contacts.map(c => [c.contactId, c]));
  const review: ReviewLine[] = [], fileLines: FileLine[] = [];
  for (const [contactId, group] of [...byContact].sort((a, b) => a[1][0]!.contactName.localeCompare(b[1][0]!.contactName))) {
    const contact = contactById.get(contactId);
    const supplier = contact?.name ?? group[0]!.contactName;
    const sorted = [...group].sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? '') || a.number.localeCompare(b.number));
    const total = sorted.reduce((n, b) => n + pennies(b.amountDue), 0) / 100;
    const joined = sorted.map(b => b.number).join(', ');
    const reference = joined.slice(0, REFERENCE_MAX);
    const credit = credits.filter(x => x.contactId === contactId).reduce((n, x) => n + pennies(x.remaining), 0) / 100;
    const flags: Flag[] = [];
    const accountName = (contact?.batchPayments?.BankAccountName ?? '').trim();
    let excluded = false;
    if (isDirectDebitContact(supplier)) { flags.push('direct_debit_excluded'); excluded = true; }
    if (!excluded && sorted.some(b => b.currency !== 'GBP')) { flags.push('not_gbp'); excluded = true; }
    if (!excluded && !contact) flags.push('contact_not_found');
    if (!excluded && total <= 0) flags.push('zero_or_negative_total');
    const bank = !excluded && contact ? parseBankDetails(contact) : null;
    if (bank && !bank.ok) flags.push(bank.problem === 'missing' ? 'no_bank_details' : bank.problem === 'unrecognised_format' ? 'bank_details_unrecognised' : 'bank_details_disagree');
    if (!excluded && contact && !accountName) flags.push('no_account_name');
    if (!excluded && credit > 0) flags.push('unapplied_credit');
    if (!excluded && joined.length > REFERENCE_MAX) flags.push('reference_truncated');
    const blocking = flags.some(f => f !== 'unapplied_credit' && f !== 'reference_truncated');
    const status = excluded ? 'excluded' : blocking ? 'needs_attention' : 'ready';
    const type = accountName ? recipientTypeFor(accountName) : null;
    review.push({ supplier, status, flags, recipientType: type, accountNamePresent: !!accountName,
      bills: sorted.map(b => ({ number: b.number, dueDate: b.dueDate, amountDue: b.amountDue })), total, reference, unappliedCredit: credit });
    if (status === 'ready' && bank?.ok && type) {
      fileLines.push({ name: accountName, recipientType: type, accountNumber: bank.accountNumber, sortCode: bank.sortCode, amount: total, reference });
    }
  }
  const sum = (s: ReviewLine['status']) => review.filter(r => r.status === s).reduce((n, r) => n + pennies(r.total), 0) / 100;
  return { review, fileLines, totals: { ready: sum('ready'), needs_attention: sum('needs_attention'), excluded: sum('excluded'),
    ready_lines: fileLines.length, needs_attention_lines: review.filter(r => r.status === 'needs_attention').length,
    excluded_lines: review.filter(r => r.status === 'excluded').length } };
}

const csvCell = (v: string | number) => {
  let s = String(v);
  // Cells that start with a formula character are neutralised so a hostile supplier name cannot run in a spreadsheet.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** The Revolut bulk-transfer CSV: exactly the template's eight columns, GBP to GB only. */
export function renderRevolutCsv(lines: FileLine[]): string {
  const header = ['Name', 'Recipient type', 'Account number', 'Sort code', 'Recipient bank country', 'Currency', 'Amount', 'Payment reference'];
  const rows = lines.map(l => [l.name, l.recipientType, l.accountNumber, l.sortCode, 'GB', 'GBP', l.amount.toFixed(2), l.reference]);
  return [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
