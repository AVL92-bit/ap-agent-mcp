/** Model extraction: Claude reads the original document (PDF pages as text + image, so
 * tables and scans are understood) and returns invoice fields with evidence. The
 * deterministic text rules (invoice-candidates.ts) are a cross-check: agreement makes a
 * field confident, disagreement is a review note. Nothing here ever blocks a draft; if the
 * model is unavailable the text rules are used and that is noted.
 *
 * Railway variables: ANTHROPIC_API_KEY (required for model extraction),
 * AP_EXTRACTION_MODEL (optional, default claude-sonnet-5-5).
 */
import { extractInvoiceCandidates, type CandidateField, type InvoiceCandidates } from './invoice-candidates.js';
import { supplierComparisonKey, legalNameKey, PRACTICE_NAME } from './supplier-evidence.js';

export const DEFAULT_EXTRACTION_MODEL = 'claude-sonnet-5-5';
export type ModelDocumentType = 'invoice' | 'credit_note' | 'receipt' | 'statement' | 'remittance' | 'other';
export type ModelFields = {
  document_type: ModelDocumentType;
  supplier_name: string | null; supplier_evidence: string | null;
  invoice_number: string | null; invoice_number_evidence: string | null;
  invoice_date: string | null; due_date: string | null;
  gross_total: number | null; gross_evidence: string | null;
  net_total: number | null; vat_total: number | null;
  currency: string | null;
  account_balance: number | null;
  billed_to: string | null;
  low_confidence_fields: string[];
  notes: string | null;
};
export type ModelResult = { ok: true; fields: ModelFields; model: string } | { ok: false; reason: string };

const nullable = (t: object) => ({ anyOf: [t, { type: 'null' }] });
const FIELD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    document_type: { type: 'string', enum: ['invoice', 'credit_note', 'receipt', 'statement', 'remittance', 'other'] },
    supplier_name: nullable({ type: 'string' }), supplier_evidence: nullable({ type: 'string' }),
    invoice_number: nullable({ type: 'string' }), invoice_number_evidence: nullable({ type: 'string' }),
    invoice_date: nullable({ type: 'string' }), due_date: nullable({ type: 'string' }),
    gross_total: nullable({ type: 'number' }), gross_evidence: nullable({ type: 'string' }),
    net_total: nullable({ type: 'number' }), vat_total: nullable({ type: 'number' }),
    currency: nullable({ type: 'string' }),
    account_balance: nullable({ type: 'number' }),
    billed_to: nullable({ type: 'string' }),
    low_confidence_fields: { type: 'array', items: { type: 'string', enum: ['document_type', 'supplier_name', 'invoice_number', 'invoice_date', 'due_date', 'gross_total', 'currency'] } },
    notes: nullable({ type: 'string' }),
  },
  required: ['document_type', 'supplier_name', 'supplier_evidence', 'invoice_number', 'invoice_number_evidence', 'invoice_date', 'due_date',
    'gross_total', 'gross_evidence', 'net_total', 'vat_total', 'currency', 'account_balance', 'billed_to', 'low_confidence_fields', 'notes'],
} as const;

const INSTRUCTIONS = `You are an accounts payable clerk for St George's Road Surgery (a GP practice in Coventry, UK). Read the attached supplier document and return its fields as JSON matching the schema. Dates are ISO YYYY-MM-DD. Rules:
- document_type: "invoice" or "credit_note" only if the document requests or credits payment for goods/services. A payment confirmation is "receipt"; an account summary listing several invoices is "statement"; a remittance advice is "remittance".
- supplier_name: the company that ISSUED the document (letterhead, "payable to", registered name). Never the practice, a person at the practice, or the bill-to/customer. Prefer the trading name printed on the document; supplier_evidence quotes the line(s) you used.
- invoice_number: the document's own number exactly as printed (keep dashes/slashes). Not an account number, order number or customer number. If a character is damaged, give your best reading and list invoice_number as low confidence.
- invoice_date / due_date: ISO YYYY-MM-DD. If no due date is printed, null.
- gross_total: the total payable for THIS document's charges including VAT, as a positive number. Never use a brought-forward, carried-forward or account balance as the gross. If the account is in credit, still give this period's charges as gross_total and put the account balance (negative if in credit) in account_balance.
- net_total and vat_total when printed; otherwise null.
- List in low_confidence_fields any field you are not sure of. Quote evidence exactly as printed. Do not guess values that are not on the document: use null.`;

/** Call the model. Never throws: failure returns a reason and the caller uses text rules. */
export async function extractFieldsWithModel(input: { pdf?: Uint8Array; text?: string; filename: string },
  fetchImpl: typeof fetch = fetch): Promise<ModelResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, reason: 'Model extraction unavailable (no ANTHROPIC_API_KEY); text rules used' };
  const model = process.env.AP_EXTRACTION_MODEL?.trim() || DEFAULT_EXTRACTION_MODEL;
  const content: unknown[] = [];
  if (input.pdf) content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(input.pdf).toString('base64') } });
  else if (input.text) content.push({ type: 'text', text: `Document "${input.filename}" (extracted text):\n\n${input.text.slice(0, 100000)}` });
  else return { ok: false, reason: 'No document content for model extraction' };
  content.push({ type: 'text', text: INSTRUCTIONS });
  try {
    const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      // Structured outputs: the response is JSON guaranteed to match FIELD_SCHEMA.
      body: JSON.stringify({ model, max_tokens: 2000,
        output_config: { format: { type: 'json_schema', schema: FIELD_SCHEMA } },
        messages: [{ role: 'user', content }] }),
      signal: AbortSignal.timeout(90000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      // Anthropic error bodies carry a type and message (never the key); show them so a
      // credit, model or request problem can be fixed without reading server logs.
      let message = '';
      try { const e = JSON.parse(detail)?.error; message = [e?.type, e?.message].filter(Boolean).join(': '); } catch { /* not JSON */ }
      if (/authentication|invalid x-api-key/i.test(detail)) message = `API key rejected${message ? ` - ${message}` : ''}`;
      return { ok: false, reason: `Model extraction failed (HTTP ${response.status}${message ? `, ${message.slice(0, 300)}` : ''}); text rules used` };
    }
    const body = await response.json() as { stop_reason?: string; content?: Array<{ type: string; text?: string }> };
    if (body.stop_reason === 'refusal') return { ok: false, reason: 'Model declined to read the document; text rules used' };
    const text = body.content?.filter(c => c.type === 'text').map(c => c.text ?? '').join('') ?? '';
    let fields: ModelFields | undefined;
    try { fields = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as ModelFields; } catch { fields = undefined; }
    if (!fields || typeof fields.document_type !== 'string') return { ok: false, reason: 'Model extraction returned no fields; text rules used' };
    fields.low_confidence_fields = Array.isArray(fields.low_confidence_fields) ? fields.low_confidence_fields : [];
    return { ok: true, fields, model };
  } catch (error) {
    return { ok: false, reason: `Model extraction error (${error instanceof Error ? error.name : 'unknown'}); text rules used` };
  }
}

// ---------- Cross-check model fields against the text rules ----------
const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
/** Text-rule dates in any supported style -> YYYY-MM-DD (UK day-first for numeric). */
export function isoDate(value?: string | null): string | null {
  if (!value) return null;
  const s = value.trim().replace(/(\d)(st|nd|rd|th)\b/i, '$1').replace(/[.,]/g, ' ').replace(/\s+/g, ' ');
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); if (m) return s;
  m = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})$/.exec(s);
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = /^(\d{1,2}) ([A-Za-z]{3})[A-Za-z]* (\d{4})$/.exec(s);
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2, '0')}`;
  m = /^([A-Za-z]{3})[A-Za-z]* (\d{1,2}) (\d{4})$/.exec(s);
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[3]}-${MONTHS[m[1].toLowerCase()]}-${m[2].padStart(2, '0')}`;
  return null;
}
const refKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const amount = (s: string) => Math.abs(Number(s.replace(/[^\d.-]/g, '')));
const money = (n: number) => `£${n.toFixed(2)}`;
function sameSupplier(a: string, b: string): boolean {
  const x = legalNameKey(a), y = legalNameKey(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const ta = new Set(x.split(' ')), tb = new Set(y.split(' '));
  const common = [...ta].filter(t => tb.has(t)).length;
  return common / Math.max(ta.size, tb.size) >= 0.6;
}

export type MergedExtraction = { candidates: InvoiceCandidates; notes: string[]; source: 'model+text' | 'text'; model?: string };

/** Model value wins; agreement with the text rules makes it confident; disagreement or
 * model low confidence makes it uncertain with a note. Without the model, text rules stand. */
export function mergeModelAndText(text: InvoiceCandidates, result: ModelResult): MergedExtraction {
  if (!result.ok) return { candidates: text, notes: [result.reason], source: 'text' };
  const f = result.fields;
  const low = new Set(f.low_confidence_fields);
  const notes: string[] = [];
  const pick = (name: string, modelValue: string | null, modelEvidence: string | null, textField: CandidateField | null,
    same: (m: string, t: string) => boolean, lowKey: string): CandidateField | null => {
    if (!modelValue) {
      if (textField) notes.push(`${name}: model found none; text rules read "${textField.value}" - verify`);
      return textField ? { ...textField, uncertain: true } : null;
    }
    const evidence = `${modelEvidence ?? 'model extraction'} [model]`;
    if (textField && !same(modelValue, textField.value)) {
      notes.push(`${name}: model read "${modelValue}", text rules read "${textField.value}" - verify`);
      return { value: modelValue, evidence, uncertain: true };
    }
    return { value: modelValue, evidence, uncertain: low.has(lowKey) };
  };

  const supplierName = f.supplier_name && !PRACTICE_NAME.test(f.supplier_name) ? f.supplier_name : null;
  const supplier = pick('Supplier', supplierName, f.supplier_evidence, text.supplier, sameSupplier, 'supplier_name');
  // A supplier is never confident from the document alone; Xero contact matching decides.
  if (supplier) supplier.uncertain = supplier.uncertain || !text.supplier;
  const reference = pick('Invoice number', f.invoice_number, f.invoice_number_evidence, text.reference, (m, t) => refKey(m) === refKey(t), 'invoice_number');
  const invoiceDate = pick('Invoice date', f.invoice_date, f.invoice_date ? `Invoice date ${f.invoice_date}` : null,
    text.invoiceDate, (m, t) => isoDate(t) === m, 'invoice_date');
  const dueDate = pick('Due date', f.due_date, f.due_date ? `Due date ${f.due_date}` : null,
    text.dueDate, (m, t) => isoDate(t) === m, 'due_date');
  const grossAmount = pick('Gross total', f.gross_total !== null && f.gross_total > 0 ? money(f.gross_total) : null, f.gross_evidence,
    text.grossAmount, (m, t) => Math.abs(amount(m) - amount(t)) < 0.011, 'gross_total');
  const accountBalance = f.account_balance !== null && f.account_balance !== 0
    ? { value: `${f.account_balance < 0 ? '-' : ''}${money(Math.abs(f.account_balance))}`, evidence: 'Account balance [model]', uncertain: false }
    : text.accountBalance;
  if (accountBalance && grossAmount) grossAmount.uncertain = true; // policy: balance makes the amount a review note
  const modelType = f.document_type;
  const docValue = modelType === 'credit_note' ? 'credit_note' : modelType === 'receipt' ? 'receipt' : modelType === 'invoice' ? 'invoice' : modelType;
  if (text.documentType.value !== docValue && !(text.documentType.uncertain)) notes.push(`Document type: model read "${docValue}", text rules read "${text.documentType.value}" - verify`);
  const documentType = { value: docValue, evidence: 'Document type [model]', uncertain: low.has('document_type') || text.documentType.value !== docValue };
  const currency = { value: (f.currency ?? text.currency.value ?? 'GBP').toUpperCase(), evidence: 'Currency [model]', uncertain: low.has('currency') };

  const critical: Record<string, CandidateField | null> = { documentType, supplier, reference, invoiceDate, dueDate, grossAmount, currency };
  const uncertainFields = Object.entries(critical).filter(([, v]) => !v || v.uncertain).map(([k]) => k);
  if (accountBalance?.uncertain) uncertainFields.push('accountBalance');
  return { candidates: { documentType, supplier, reference, invoiceDate, dueDate, grossAmount, currency, accountBalance,
    amountPaid: text.amountPaid, linkedInvoiceReference: text.linkedInvoiceReference, uncertainFields }, notes, source: 'model+text', model: result.model };
}

/** One extraction for every route: text rules always, model when available, merged. */
export async function extractInvoiceFields(input: { text: string; pdf?: Uint8Array; filename: string }, fetchImpl?: typeof fetch): Promise<MergedExtraction & { text_candidates: InvoiceCandidates }> {
  const textCandidates = extractInvoiceCandidates(input.text);
  const model = await extractFieldsWithModel({ pdf: input.pdf, text: input.pdf ? undefined : input.text, filename: input.filename }, fetchImpl);
  return { ...mergeModelAndText(textCandidates, model), text_candidates: textCandidates };
}
