
import { createSign } from "node:crypto";
import type { Pool } from "pg";
import { applyPaymentIssuePolicy } from "./ap-invoice-review-rules.js";

// Configure a new trial spreadsheet without changing code. Never silently write to the old trial.
const EXPECTED_SPREADSHEET_ID = "1Z33UUJFeUpws0DvqihlqKm01rgTBfIhrnZOqrvABzjo";
const SPREADSHEET_ID = process.env.AP_REVIEW_SPREADSHEET_ID?.trim() || EXPECTED_SPREADSHEET_ID;
const SHEET_NAME = process.env.AP_REVIEW_SHEET_NAME?.trim() || "Finance review";
const BASE = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}`;

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value))
    .toString("base64url");
}

async function getAccessToken(): Promise<string> {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Google credentials not configured");

  const credentials = JSON.parse(raw) as {
    client_email?: string;
    private_key?: string;
    token_uri?: string;
  };

  if (
    !credentials.client_email ||
    !credentials.private_key ||
    credentials.token_uri !== "https://oauth2.googleapis.com/token"
  ) {
    throw new Error("Invalid Google service account credentials");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "RS256", typ: "JWT" });
  const payload = encode({
    iss: credentials.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: credentials.token_uri,
    iat: now,
    exp: now + 3600,
  });

  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();

  const assertion =
    `${signingInput}.${signer.sign(credentials.private_key)
      .toString("base64url")}`;

  const response = await fetch(credentials.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`Google authentication failed: HTTP ${response.status}`);
  }

  const result = await response.json() as {
    access_token?: string;
  };

  if (!result.access_token) {
    throw new Error("Google authentication returned no access token");
  }

  return result.access_token;
}

async function sheetsRequest(
  token: string,
  path: string,
  method = "GET",
  body?: object
): Promise<any> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });

  if (!response.ok) {
    throw new Error(`Google Sheets request failed: HTTP ${response.status}`);
  }

  return response.json();
}


/** Optional column J "Human review complete" (added by finance; checkbox recommended). When
 * present, new rows are written with FALSE so outstanding reviews can be filtered. Columns A-I
 * are unchanged and still checked exactly. */
export const REVIEW_COMPLETE_HEADER = 'Human review complete';
export function withReviewColumn(rows: string[][], values: unknown[]): unknown[] {
  return (rows[0]?.[9] ?? '').trim() === REVIEW_COMPLETE_HEADER ? [...values, false] : values;
}
const isComplete = (v: unknown) => /^(true|yes|y|done|complete|completed|x|✓)$/i.test(String(v ?? '').trim());

/** Read-only view of the Finance review tab: most recent rows first, optionally only those
 * not yet marked complete in column J. */
export async function readFinanceReviewRows(input: { limit?: number; incompleteOnly?: boolean } = {}): Promise<Record<string, unknown>> {
  if (SPREADSHEET_ID !== EXPECTED_SPREADSHEET_ID || SHEET_NAME !== 'Finance review') throw new Error('Finance review Sheet target mismatch');
  const token = await getAccessToken();
  const existing = await sheetsRequest(token, `/values/${encodeURIComponent("'Finance review'!A1:J10000")}`) as {values?:string[][]};
  const rows = existing.values ?? [];
  const header = rows[0] ?? [];
  const hasReviewColumn = (header[9] ?? '').trim() === REVIEW_COMPLETE_HEADER;
  let data = rows.slice(1).map((r, i) => ({ sheet_row: i + 2, logged_at: r[0] ?? '', outcome: r[1] ?? '', xero_draft_url: r[2] ?? '',
    supplier: r[3] ?? '', reference: r[4] ?? '', gross: r[5] ?? '', field_or_failure: r[6] ?? '', detail: r[7] ?? '',
    front_conversation_url: r[8] ?? '', ...(hasReviewColumn ? { human_review_complete: isComplete(r[9]) } : {}) }));
  if (input.incompleteOnly && hasReviewColumn) data = data.filter(d => !(d as any).human_review_complete);
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 200);
  return { read_only: true, total_rows: rows.length ? rows.length - 1 : 0, headers_ok: ['Logged at','Outcome','Xero draft URL','Supplier selected','Invoice / credit note ref','Gross amount','Field / failure','Question or error detail','Front conversation URL'].every((h, i) => header[i] === h),
    human_review_complete_column: hasReviewColumn, rows: data.slice(-limit).reverse() };
}

/** Append-only exception reporting. Sheet writes are never a prerequisite for a Xero draft. */
export async function syncPilotReviewExceptions(pool: Pool, reviewIds: string[]): Promise<{appended:string[];already_present:string[];skipped:string[]}> {
  if (SPREADSHEET_ID !== EXPECTED_SPREADSHEET_ID || SHEET_NAME !== 'Finance review') throw new Error('Finance review Sheet target mismatch');
  if (!reviewIds.length || reviewIds.length > 20 || reviewIds.some(id=>!/^\d+$/.test(id))) throw new Error('Invalid review IDs');
  const result = await pool.query(`SELECT id::text, created_at, front_conversation_id, supplier_name, invoice_number, document_type,
    assessment_json, xero_draft_id, xero_draft_error, xero_draft_status FROM pilot_invoice_reviews WHERE id::text = ANY($1::text[])`,[reviewIds]);
  const token = await getAccessToken();
  const existing = await sheetsRequest(token, `/values/${encodeURIComponent("'Finance review'!A1:J10000")}`) as {values?:string[][]};
  const rows = existing.values ?? [];
  const expected=['Logged at','Outcome','Xero draft URL','Supplier selected','Invoice / credit note ref','Gross amount','Field / failure','Question or error detail','Front conversation URL'];
  if (expected.some((h,i)=>rows[0]?.[i]!==h)) throw new Error('Finance review Sheet headers do not match');
  const appended:string[]=[], already_present:string[]=[], skipped:string[]=[];
  for(const r of result.rows) {
    const a=r.assessment_json ?? {};
    // Stored assessment notes are history only; the Sheet reports issues found at draft time
    // (xero_draft_error), filtered by the payment policy.
    const uncertainties=applyPaymentIssuePolicy(String(r.xero_draft_error??'').split(' | ').filter(Boolean));
    const failure=!r.xero_draft_id && !!r.xero_draft_error;
    const hasUncertainty=uncertainties.length>0 && !!r.xero_draft_id;
    if(!failure && !(r.xero_draft_id && hasUncertainty)){skipped.push(r.id);continue;}
    const key=`review:${r.id}`;
    if(rows.some(row=>row[7]?.includes(key))){already_present.push(r.id);continue;}
    const details=[key,...uncertainties].filter(Boolean).join(' | ');
    const values=[new Date(r.created_at).toISOString(),failure?'Technical failure':'Draft with uncertainty',
      r.xero_draft_id?`https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=${r.xero_draft_id}`:'',
      String(r.supplier_name??''),String(r.invoice_number??''),String(a.gross_gbp??''),
      failure?'Processing failure':'Uncertain fields',details,
      `https://app.frontapp.com/open/${r.front_conversation_id}`];
    await sheetsRequest(token, `/values/${encodeURIComponent("'Finance review'!A1:J10000")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, 'POST', {values:[withReviewColumn(rows,values)]});
    appended.push(r.id);rows.push(values);
  }
  return {appended,already_present,skipped};
}

/** Legacy hold checks are deliberately removed: a Sheet never blocks Xero drafting. */
export async function assertReviewNotHeldInSheet(_reviewId:string,_conversationId:string,_invoiceNumber:string):Promise<void>{}

/** Direct inbox-runner exception rows, deduplicated by stable Front attachment identity.
 * This never controls whether Xero may create a draft. */
export async function appendApInboxException(input: {
  conversationId:string; attachmentId:string; xeroId?:string; reason:string;
  outcome:'draft_uncertain'|'technical_failure'|'not_invoice'|'unclear'; filename?:string; supplier?:string; extractedSupplier?:string; supplierMatchScore?:number; reference?:string; gross?:number;
}):Promise<void> {
  if(SPREADSHEET_ID!==EXPECTED_SPREADSHEET_ID || SHEET_NAME!=='Finance review') throw new Error('Finance review Sheet target mismatch');
  if(!/^cnv_[\w-]+$/.test(input.conversationId)||!/^fil_[\w-]+$/.test(input.attachmentId)) throw new Error('Invalid review source IDs');
  const token=await getAccessToken();
  const range=encodeURIComponent("'Finance review'!A1:J10000");
  const existing=await sheetsRequest(token,`/values/${range}`) as {values?:string[][]};
  const rows=existing.values??[];
  const expected=['Logged at','Outcome','Xero draft URL','Supplier selected','Invoice / credit note ref','Gross amount','Field / failure','Question or error detail','Front conversation URL'];
  if(expected.some((h,i)=>rows[0]?.[i]!==h)) throw new Error('Finance review Sheet headers do not match');
  const key=`inbox:${input.conversationId}:${input.attachmentId}:${input.outcome}`;
  if(rows.some(r=>r[7]?.includes(key))) return;
  const reviewOnly=input.outcome==='not_invoice'||input.outcome==='unclear';
  const row=[new Date().toISOString(),reviewOnly?(input.outcome==='not_invoice'?'Not an invoice':'Unclear document'):(input.outcome==='draft_uncertain'?'Draft with uncertainty':'Technical failure'),
    input.xeroId?`https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=${input.xeroId}`:'',
    input.supplier??'',input.reference??'',input.gross===undefined?'':String(input.gross),reviewOnly?'Document review':(input.outcome==='draft_uncertain'?'Uncertain fields':'Processing failure'),
    `${key} | ${input.filename ? `Document: ${input.filename} | ` : ''}${input.reason}${input.extractedSupplier ? ` | Extracted supplier: ${input.extractedSupplier}` : ''}${input.supplier ? ` | Selected Xero contact: ${input.supplier}` : ''}${input.supplierMatchScore===undefined ? '' : ` | Supplier match: ${(input.supplierMatchScore*100).toFixed(1)}%`}`,`https://app.frontapp.com/open/${input.conversationId}`];
  await sheetsRequest(token,`/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,'POST',{values:[withReviewColumn(rows,row)]});
}
