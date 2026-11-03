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
export function pilotDraftWriteState() {
  const configured = process.env.XERO_DRAFT_WRITES_ENABLED?.trim().toLowerCase() === 'true';
  const pilotScope = process.env.FRONT_ENABLED_INBOX_ID === INBOX && process.env.XERO_PILOT_TENANT_ID === TENANT;
  return {draft_writes_enabled: configured && pilotScope, draft_write_switch_configured: configured,
    pilot_scope_verified: pilotScope, connection_enabled_is_oauth_metadata: true};
}
export type DirectDraftPreview = {
  document_type: 'invoice'|'credit_note'; supplier_name?: string; invoice_number?: string;
  invoice_date?: string; gross_gbp?: number; due_date?: string; proposed_account?: string;
  billed_to?: string; exceptions?: string[]; front_conversation_id?: string;
};
function previewFields(data: DirectDraftPreview, linkedId?: string | null, attempt?: string | null) {
  const essential_missing:string[]=[];
  const review_issues:string[]=[...(data.exceptions ?? [])];
  if (!['invoice','credit_note'].includes(data.document_type)) essential_missing.push('Not an invoice or credit note');
  if (!data.supplier_name?.trim()) essential_missing.push('Supplier name not available for Xero contact');
  if (!data.invoice_number?.trim()) essential_missing.push('Document number not available');
  if (!dateOk(data.invoice_date)) essential_missing.push('Valid document date not available');
  if (!money(Math.abs(data.gross_gbp ?? 0))) essential_missing.push('Valid non-zero gross amount not available');
  if (!data.proposed_account?.trim()) review_issues.push('Nominal code needs review; valid Xero fallback account required');
  if (!dateOk(data.due_date) && dateOk(data.invoice_date)) review_issues.push('Due date defaults to invoice date + 30 days');
  if (data.billed_to && data.billed_to !== "St George's Road Surgery") review_issues.push('Billing entity requires review');
  if (linkedId) essential_missing.push('Already linked to an existing Xero document');
  if (attempt && !linkedId) essential_missing.push('Previous draft attempt needs reconciliation');
  return {status:linkedId?'existing_xero_document':essential_missing.length?'requires_source_data_or_reconciliation':'draft_candidate',
    essential_missing,review_issues,document_type:data.document_type,
    ...pilotDraftWriteState(),requires_human_review:true,creates_draft:false,
    duplicate_check_completed:false,
    note:'Preview does not query Xero for duplicates, contacts or account validity. Draft creation performs those checks.'};
}
export function previewDirectDraft(data:DirectDraftPreview):Record<string,unknown> {
  return {...previewFields(data),preview_source:'extracted_fields',review_id:null};
}

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

/** Shared read-only preflight for intake preview and create. Fail closed on ambiguous matches. */
export async function inspectIntakeIdentity(pool:Pool, input:{conversationId:string;messageId:string;attachmentId:string;supplierName:string;invoiceNumber:string;documentType:'invoice'|'credit_note'}):Promise<Record<string,unknown>> {
  const rows=await pool.query(`SELECT id::text, front_message_id, attachment_id, supplier_name, invoice_number,
    document_type, review_status, xero_draft_id, xero_draft_status FROM pilot_invoice_reviews
    WHERE (front_message_id=$1 AND attachment_id=$2)
       OR (front_conversation_id=$3 AND lower(trim(invoice_number))=lower(trim($4)))
    ORDER BY CASE WHEN front_message_id=$1 AND attachment_id=$2 THEN 0 ELSE 1 END, id`,
    [input.messageId,input.attachmentId,input.conversationId,input.invoiceNumber]);
  const reviews=rows.rows;
  if(reviews.length>1) throw new Error('Multiple PostgreSQL reviews match attachment or invoice; reconcile before drafting');
  const review=reviews[0]??null;
  if(review && (String(review.invoice_number??'').trim().toLowerCase()!==input.invoiceNumber.trim().toLowerCase()
      || review.document_type!==input.documentType))
    throw new Error('Existing attachment review has a different invoice identity; reconcile before drafting');
  const issues:string[]=[];
  if(review && String(review.supplier_name??'').trim().toLowerCase()!==input.supplierName.trim().toLowerCase())
    issues.push('PostgreSQL supplier name differs from extracted supplier; verify identity');
  const api=await getPilotXeroReadSessionForLink();
  if(api.tenantId!==TENANT) throw new Error('Wrong Xero tenant for intake preflight');
  const kind=input.documentType==='credit_note'?'CreditNotes':'Invoices';
  const field=kind==='Invoices'?'InvoiceNumber':'CreditNoteNumber';
  const escaped=input.invoiceNumber.replace(/\\/g,'\\\\').replace(/"/g,'\\"');
  const data=await xero(api,`${kind}?where=${encodeURIComponent(`${field}=="${escaped}"`)}`);
  const matches=(data[kind]??[]).filter((d:any)=>d[field]===input.invoiceNumber && !['DELETED','VOIDED'].includes(d.Status));
  if(matches.length>1) throw new Error('Multiple Xero documents share this number; manual reconciliation required');
  const doc=matches[0]??null;
  const id=doc?.[kind==='Invoices'?'InvoiceID':'CreditNoteID']??null;
  if(doc && !id) throw new Error('Existing Xero document lacks an identifier; reconciliation required');
  if(doc && String(doc.Contact?.Name??'').trim().toLowerCase()!==input.supplierName.trim().toLowerCase())
    issues.push('Existing Xero document supplier differs from extracted supplier; verify before linking');
  if(review?.xero_draft_id && doc && review.xero_draft_id!==id)
    throw new Error('PostgreSQL and Xero document IDs conflict; reconcile before drafting');
  if(review?.xero_draft_id && !doc)
    throw new Error('PostgreSQL links a Xero document not found by number; reconcile before drafting');
  return {review_id:review?.id??null,review_status:review?.review_status??null,
    review_match:review?(review.front_message_id===input.messageId && review.attachment_id===input.attachmentId?'attachment':'conversation_invoice'):null,
    postgres_supplier_mismatch:issues.some(i=>i.startsWith('PostgreSQL')),
    existing_xero_document:!!doc,xero_document_id:id,xero_document_status:doc?.Status??null,
    xero_supplier_name:doc?.Contact?.Name??null,duplicate_check_completed:true,
    identity_review_issues:issues,requires_identity_reconciliation:!!doc && issues.some(i=>i.startsWith('Existing Xero')),
    prior_draft_attempt:review?.xero_draft_status??null};
}

export async function previewReviewDraft(pool:Pool, reviewId:string): Promise<Record<string,unknown>> {
  if (!idOk(reviewId)) throw new Error('Invalid review ID');
  const data = await pool.query(`SELECT document_type, supplier_name, invoice_number, assessment_json,
    xero_draft_id, xero_draft_status FROM pilot_invoice_reviews WHERE id=$1`,[reviewId]);
  if (data.rowCount !== 1) throw new Error('Review not found');
  const r = data.rows[0]; const a = r.assessment_json ?? {};
  return {review_id:reviewId,preview_source:'postgres_review',
    ...previewFields({document_type:r.document_type,supplier_name:r.supplier_name || a.xero_supplier,
      invoice_number:r.invoice_number,invoice_date:a.invoice_date,gross_gbp:a.gross_gbp,
      due_date:a.due_date,proposed_account:a.proposed_account,billed_to:a.billed_to,
      exceptions:Array.isArray(a.exceptions)?a.exceptions:[]},r.xero_draft_id,r.xero_draft_status)};
}

export async function createReviewDraft(pool:Pool, reviewId:string): Promise<Record<string,unknown>> {
  if (!idOk(reviewId)) throw new Error('Invalid review ID');
  if (!pilotDraftWriteState().draft_writes_enabled)
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
      const matchedContactName = String(first.Contact?.Name ?? '').trim().toLowerCase();
      if (existing.length === 1 && matchedContactName === supplier.toLowerCase() && first[`${kind === 'Invoices' ? 'Invoice' : 'CreditNote'}ID`]) {
        const existingId = first[kind === 'Invoices' ? 'InvoiceID' : 'CreditNoteID'];
        await pool.query(`UPDATE pilot_invoice_reviews SET xero_draft_id=$2,xero_draft_status='existing_in_xero',xero_draft_updated_at=NOW(),updated_at=NOW() WHERE id=$1`,[reviewId,existingId]);
        let sheetStatus = 'synced';
        try { await syncPilotReviewExceptions(pool,[reviewId]); } catch { sheetStatus = 'sync_failed'; }
        return {status:'existing_in_xero',review_id:reviewId,xero_draft_id:existingId,review_required:true,sheet_status:sheetStatus};
      }
      throw new Error('Same-number Xero document exists under another/ambiguous supplier; reconcile before retry');
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

/** Explicitly link an existing Xero document to a review after verifying it live.
 * No Xero mutation. The write switch also gates PostgreSQL/Sheet linkage.
 */
export async function linkExistingReviewDraft(pool:Pool,reviewId:string,xeroDocumentId:string,verifiedContactId?:string):Promise<Record<string,unknown>> {
  if (!pilotDraftWriteState().draft_writes_enabled) throw new Error('Draft register writes disabled');
  if (!idOk(reviewId) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(xeroDocumentId))
    throw new Error('Invalid review or Xero document ID');
  const result=await pool.query(`SELECT id::text,invoice_number,supplier_name,document_type,xero_draft_id,xero_draft_status
    FROM pilot_invoice_reviews WHERE id=$1`,[reviewId]);
  if (result.rowCount!==1) throw new Error('Review not found');
  const r=result.rows[0];
  if (r.xero_draft_id) return {status:r.xero_draft_id.toLowerCase()===xeroDocumentId.toLowerCase()?'already_linked':'conflicting_existing_link',review_id:reviewId,xero_draft_id:r.xero_draft_id};
  const api=await getPilotXeroReadSessionForLink();
  const kind=r.document_type==='credit_note'?'CreditNotes':r.document_type==='invoice'?'Invoices':null;
  if (!kind) throw new Error('Review is not an invoice or credit note');
  const data=await xero(api,`${kind}/${xeroDocumentId}`);
  const doc=data[kind]?.[0];
  const number=kind==='Invoices'?doc?.InvoiceNumber:doc?.CreditNoteNumber;
  const contactName=String(doc?.Contact?.Name??'').trim().toLowerCase();
  if (!doc || number!==r.invoice_number || !(verifiedContactId ? doc.Contact?.ContactID?.toLowerCase()===verifiedContactId.toLowerCase() : r.supplier_name && contactName===r.supplier_name.trim().toLowerCase()))
    throw new Error('Xero document number or supplier differs from review; manually verify contact before linking');
  if (doc.Status==='DELETED'||doc.Status==='VOIDED') throw new Error('Xero document is deleted or voided');
  const updated=await pool.query(`UPDATE pilot_invoice_reviews SET xero_draft_id=$2,xero_draft_status='existing_in_xero',
    xero_draft_updated_at=NOW(),updated_at=NOW() WHERE id=$1 AND xero_draft_id IS NULL
    AND (xero_draft_status IS NULL OR xero_draft_status IN ('reconcile_required','creating')) RETURNING id`,[reviewId,xeroDocumentId]);
  if (updated.rowCount!==1) throw new Error('Concurrent change to review; recheck before linking');
  let sheet_status='synced';
  try {await syncPilotReviewExceptions(pool,[reviewId]);}catch {sheet_status='sync_failed';}
  return {status:'linked_existing_xero_document',review_id:reviewId,xero_draft_id:xeroDocumentId,
    xero_status:doc.Status,sheet_status,created_xero_document:false};
}

async function getPilotXeroReadSessionForLink():Promise<Api> {
  const {getPilotXeroReadSession}=await import('./xero-pilot-test.js');
  const api=await getPilotXeroReadSession();
  if(api.tenantId!==TENANT) throw new Error('Unexpected Xero tenant');
  return api;
}
