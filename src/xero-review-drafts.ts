/** Supervised AP draft creation. Uncertainty is recorded for review, not an approval gate.
 * All external writes require XERO_DRAFT_WRITES_ENABLED=true and the fixed pilot tenant.
 * An indeterminate Xero POST is never automatically retried: manual reconciliation first.
 */
import type { Pool } from 'pg';
import { getPilotXeroWriteSession } from './xero-pilot-test.js';
import { syncPilotReviewExceptions } from './google-sheets-review.js';
import { originalFrontDocument, attachAndVerifyOriginal } from './xero-draft-bills.js';

const TENANT = '45a1074b-b172-4f49-a192-f0a8e293b54d';
const INBOX = 'inb_bys7q';
const API = 'https://api.xero.com/api.xro/2.0/';
const dateOk = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0,10) === s;
const due30 = (s: string) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate()+30); return d.toISOString().slice(0,10); };
const money = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0 && Math.abs(n*100-Math.round(n*100)) < 0.00001;
const idOk = (s: string) => /^[1-9]\d{0,17}$/.test(s);

type Api = { tenantId: string; accessToken: string };
async function xero(api: Api, path: string, method = 'GET', body?: unknown): Promise<any> {
  const response = await fetch(API + path, { method, headers: {
    Authorization: `Bearer ${api.accessToken}`, 'xero-tenant-id': api.tenantId,
    Accept: 'application/json', ...(body ? {'Content-Type':'application/json'} : {})
  }, ...(body ? {body:JSON.stringify(body)} : {}), signal:AbortSignal.timeout(25000) });
  if (!response.ok) throw new Error(`Xero ${method} ${path.split('?')[0]} HTTP ${response.status}; reconcile Xero before retry`);
  return response.json();
}

async function supplierContact(api: Api, supplier: string): Promise<{id:string; created:boolean; issue?:string}> {
  // Search across all contact types; an existing contact need not already have IsSupplier=true.
  const where = encodeURIComponent(`Name=="${supplier.replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`);
  const result = await xero(api, `Contacts?where=${where}`);
  const contacts = (result.Contacts ?? []).filter((c:any) => typeof c.ContactID === 'string' && c.Name?.trim().toLowerCase() === supplier.toLowerCase());
  if (contacts.length === 1) return {id:contacts[0].ContactID, created:false};
  if (contacts.length > 1) throw new Error('Multiple exact Xero contacts; reconcile before creating duplicate supplier');
  // New contact name is explicitly marked for review; never fabricate tax or bank details.
  const created = await xero(api,'Contacts','POST',{Contacts:[{Name:supplier}]});
  const contact = created.Contacts?.[0];
  if (!contact?.ContactID || contact.HasErrors || (contact.ValidationErrors?.length ?? 0)>0)
    throw new Error('Xero contact creation uncertain; reconcile Xero before retry');
  return {id:contact.ContactID,created:true,issue:'New Xero supplier contact created; verify identity and possible aliases'};
}

async function accountCode(api: Api, proposed: unknown): Promise<{code:string;issue?:string}> {
  const preferred = typeof proposed === 'string' ? proposed.match(/^\s*([A-Za-z0-9_-]{1,20})(?:\s|$)/)?.[1] : undefined;
  const fallback = process.env.XERO_REVIEW_FALLBACK_ACCOUNT_CODE?.trim();
  const data = await xero(api,'Accounts');
  const accounts = (data.Accounts ?? []).filter((a:any)=>a.Status === 'ACTIVE' && typeof a.Code === 'string');
  if (preferred && accounts.some((a:any)=>a.Code === preferred)) return {code:preferred};
  if (fallback && accounts.some((a:any)=>a.Code === fallback)) return {code:fallback,issue:`Coding uncertain; used configured review fallback account ${fallback}`};
  const suspense = accounts.filter((a:any)=>/^(suspense|unallocated|uncategorised|uncategorized)( costs| expenses)?$/i.test(a.Name ?? ''));
  if (suspense.length === 1) return {code:suspense[0].Code,issue:`Coding uncertain; used Xero suspense account ${suspense[0].Code}`};
  throw new Error('No valid proposed or review fallback Xero account; configure XERO_REVIEW_FALLBACK_ACCOUNT_CODE');
}

export async function previewReviewDraft(pool:Pool, reviewId:string): Promise<Record<string,unknown>> {
  if (!idOk(reviewId)) throw new Error('Invalid review ID');
  const data = await pool.query(`SELECT document_type, supplier_name, invoice_number, assessment_json,
    xero_draft_id, xero_draft_status FROM pilot_invoice_reviews WHERE id=$1`,[reviewId]);
  if (data.rowCount !== 1) throw new Error('Review not found');
  const r = data.rows[0]; const a = r.assessment_json ?? {};
  const reasons:string[]=[]; const issues:string[] = Array.isArray(a.exceptions) ? a.exceptions.filter((x:unknown):x is string=>typeof x==='string') : [];
  if (!['invoice','credit_note'].includes(r.document_type)) reasons.push('Not an invoice or credit note');
  if (!(r.supplier_name || a.xero_supplier)) reasons.push('No supplier name extracted');
  if (!r.invoice_number) reasons.push('No document number extracted');
  if (!dateOk(a.invoice_date)) reasons.push('No valid invoice date extracted');
  if (!money(Math.abs(a.gross_gbp ?? 0))) reasons.push('No positive gross amount extracted');
  if (!a.proposed_account) issues.push('No historical nominal code; Xero review fallback account required');
  if (!dateOk(a.due_date) && dateOk(a.invoice_date)) issues.push('Due date will default to invoice date + 30 days');
  if (r.xero_draft_id) reasons.push('Already linked to Xero document');
  if (r.xero_draft_status && !r.xero_draft_id) reasons.push('Previous Xero attempt needs reconciliation');
  return {review_id:reviewId,status:reasons.length?'requires_source_data_or_reconciliation':'draft_candidate',
    essential_missing:reasons,review_issues:issues,document_type:r.document_type,
    draft_writes_enabled:process.env.XERO_DRAFT_WRITES_ENABLED==='true',
    requires_human_review:true,creates_draft:false};
}

export async function createReviewDraft(pool:Pool, reviewId:string): Promise<Record<string,unknown>> {
  if (!idOk(reviewId)) throw new Error('Invalid review ID');
  if (process.env.XERO_DRAFT_WRITES_ENABLED !== 'true' || process.env.FRONT_ENABLED_INBOX_ID !== INBOX || process.env.XERO_PILOT_TENANT_ID !== TENANT)
    throw new Error('Pilot Xero draft writes disabled or tenant/inbox mismatch');
  const found = await pool.query(`SELECT id::text, front_conversation_id, front_message_id, attachment_id,
    supplier_name, invoice_number, document_type, assessment_json, review_status,
    xero_draft_id, xero_draft_status FROM pilot_invoice_reviews WHERE id=$1`,[reviewId]);
  if (found.rowCount !== 1) throw new Error('Review not found');
  const r = found.rows[0];
  if (!['invoice','credit_note'].includes(r.document_type)) throw new Error('Not an invoice or credit note');
  if (r.xero_draft_id) return {status:'already_drafted',review_id:reviewId,xero_draft_id:r.xero_draft_id};
  if (r.xero_draft_status) throw new Error(`Previous draft attempt ${r.xero_draft_status}; reconcile before retry`);
  const a = r.assessment_json ?? {};
  const supplier = String(r.supplier_name || a.xero_supplier || '').trim();
  const number = String(r.invoice_number || '').trim();
  if (!supplier || !number || !dateOk(a.invoice_date) || !money(Math.abs(a.gross_gbp ?? 0)))
    throw new Error('Document cannot be represented in Xero: supplier, number, date or gross amount missing');
  if (supplier.length > 150 || number.length > 100) throw new Error('Supplier or document number too long');
  const gross = Math.abs(a.gross_gbp as number);
  const issues:string[] = [...(Array.isArray(a.exceptions) ? a.exceptions.filter((x:unknown):x is string=>typeof x==='string') : [])];
  if (a.gross_gbp < 0) issues.push('Negative source amount represented as positive supplier credit note');
  if (a.billed_to !== "St George's Road Surgery") issues.push(`Billing entity requires review: ${String(a.billed_to ?? 'not extracted')}`);
  const due = dateOk(a.due_date) ? a.due_date : due30(a.invoice_date);
  if (!dateOk(a.due_date)) issues.push('Due date defaulted to invoice date + 30 days');
  if (a.proposed_vat_treatment && !/NONE/i.test(a.proposed_vat_treatment)) issues.push('Practice uses gross expense and tax NONE; review source VAT');
  // Fetch and validate original attachment before any Xero write.
  const original = await originalFrontDocument({conversationId:r.front_conversation_id,
    messageId:r.front_message_id,attachmentId:r.attachment_id});
  // Reserve the review BEFORE any Xero write. A failed/indeterminate request must be reconciled,
  // not blindly retried. Unique review record prevents concurrent draft creation.
  const claim = await pool.query(`UPDATE pilot_invoice_reviews SET xero_draft_status='creating',
    xero_draft_updated_at=NOW(),updated_at=NOW() WHERE id=$1 AND xero_draft_id IS NULL
    AND xero_draft_status IS NULL RETURNING id`,[reviewId]);
  if (claim.rowCount !== 1) throw new Error('Draft already claimed or attempted');
  let createdId:string|undefined;
  let kind = r.document_type === 'credit_note' ? 'CreditNotes' : 'Invoices';
  try {
    const api = await getPilotXeroWriteSession();
    if (api.tenantId !== TENANT) throw new Error('Wrong Xero tenant');
    // Check document number globally before contact creation. A same-number record under a
    // different supplier is an exception requiring reconciliation, not a reason to duplicate.
    const field = kind === 'Invoices' ? 'InvoiceNumber' : 'CreditNoteNumber';
    const matches = await xero(api,`${kind}?where=${encodeURIComponent(`${field}=="${number.replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`)}`);
    const existing = (matches[kind] ?? []).filter((x:any)=>x[field] === number && x.Status !== 'DELETED' && x.Status !== 'VOIDED');
    if (existing.length) {
      const first = existing[0];
      if (existing.length === 1 && first[`${kind === 'Invoices' ? 'Invoice' : 'CreditNote'}ID`]) {
        const existingId = first[kind === 'Invoices' ? 'InvoiceID' : 'CreditNoteID'];
        await pool.query(`UPDATE pilot_invoice_reviews SET xero_draft_id=$2,xero_draft_status='existing_in_xero',xero_draft_updated_at=NOW() WHERE id=$1`,[reviewId,existingId]);
        let sheetStatus = 'synced';
        try { await syncPilotReviewExceptions(pool,[reviewId]); } catch { sheetStatus = 'sync_failed'; }
        return {status:'existing_in_xero',review_id:reviewId,xero_draft_id:existingId,review_required:true,sheet_status:sheetStatus};
      }
      throw new Error('Multiple same-number Xero documents; reconcile before retry');
    }
    const coding = await accountCode(api,a.proposed_account);
    if (coding.issue) issues.push(coding.issue);
    const contact = await supplierContact(api,supplier);
    if (contact.issue) issues.push(contact.issue);
    if (!a.proposed_account) issues.push('No historically supported nominal code supplied');
    const common = {
      Status:'DRAFT',Contact:{ContactID:contact.id},Date:a.invoice_date,
      CurrencyCode:'GBP',LineAmountTypes:'Exclusive',
      LineItems:[{Description:`${r.document_type === 'credit_note' ? 'Supplier credit note' : 'Supplier invoice'} ${number} — check source attachment and review notes`,
        Quantity:1,UnitAmount:gross,AccountCode:coding.code,TaxType:'NONE'}]
    };
    const payload = kind === 'Invoices' ? {...common,Type:'ACCPAY',InvoiceNumber:number,DueDate:due}
      : {...common,Type:'ACCPAYCREDIT',CreditNoteNumber:number};
    const result = await xero(api,kind,'POST',{[kind]:[payload]});
    const doc = result[kind]?.[0];
    createdId = doc?.[kind === 'Invoices' ? 'InvoiceID' : 'CreditNoteID'];
    // Store ID immediately, even if response validation or Sheets sync fails.
    if (createdId) await pool.query(`UPDATE pilot_invoice_reviews SET xero_draft_id=$2,xero_draft_status='draft_created',
      xero_draft_updated_at=NOW(),updated_at=NOW() WHERE id=$1`,[reviewId,createdId]);
    if (!createdId || doc.Status !== 'DRAFT' || doc.HasErrors || (doc.ValidationErrors?.length ?? 0)>0)
      throw new Error('Xero response requires reconciliation; draft may exist');
    if (typeof doc.Total === 'number' && Math.abs(Math.abs(doc.Total)-gross)>0.011)
      issues.push(`Xero returned total ${doc.Total}; source gross ${gross}; review required`);
    try {
      await attachAndVerifyOriginal(api.tenantId,api.accessToken,createdId,original.filename,
        original.contentType,original.bytes,kind as 'Invoices'|'CreditNotes');
      await pool.query(`UPDATE pilot_invoice_reviews SET xero_attachment_verified=TRUE WHERE id=$1`,[reviewId]);
    } catch(e) { issues.push(`Original attachment needs attention: ${e instanceof Error?e.message:String(e)}`); }
    // Preserve original assessment and human decisions. Add draft-specific issues separately.
    await pool.query(`UPDATE pilot_invoice_reviews SET xero_draft_error=$2,updated_at=NOW() WHERE id=$1`,
      [reviewId, issues.join(' | ').slice(0,4000) || null]);
    let sheetStatus:'synced'|'sync_failed'='synced';
    try { await syncPilotReviewExceptions(pool,[reviewId]); }
    catch(e) {sheetStatus='sync_failed';issues.push(`Sheet sync failed: ${e instanceof Error?e.message:String(e)}`);}
    return {status:'draft_created',review_id:reviewId,xero_draft_id:createdId,
      document_type:r.document_type,xero_contact_id:contact.id,new_contact_created:contact.created,
      account_code:coding.code,tax_type:'NONE',gross_gbp:gross,review_required:true,
      review_issues:issues,sheet_status:sheetStatus,approved:false,submitted:false};
  } catch(e) {
    const reason = e instanceof Error ? e.message : String(e);
    await pool.query(`UPDATE pilot_invoice_reviews SET xero_draft_status=CASE WHEN xero_draft_id IS NULL THEN 'reconcile_required' ELSE xero_draft_status END,
      xero_draft_error=$2,xero_draft_updated_at=NOW() WHERE id=$1`,[reviewId,reason.slice(0,4000)]).catch(()=>{});
    throw new Error(`${reason}. Do not retry without checking Xero and the review register.`);
  }
}
