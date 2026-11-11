
import { createSign } from "node:crypto";
import type { Pool } from "pg";

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


/** Append-only exception reporting. Sheet writes are never a prerequisite for a Xero draft. */
export async function syncPilotReviewExceptions(pool: Pool, reviewIds: string[]): Promise<{appended:string[];already_present:string[];skipped:string[]}> {
  if (SPREADSHEET_ID !== EXPECTED_SPREADSHEET_ID || SHEET_NAME !== 'Finance review') throw new Error('Finance review Sheet target mismatch');
  if (!reviewIds.length || reviewIds.length > 20 || reviewIds.some(id=>!/^\d+$/.test(id))) throw new Error('Invalid review IDs');
  const result = await pool.query(`SELECT id::text, created_at, front_conversation_id, supplier_name, invoice_number, document_type,
    assessment_json, xero_draft_id, xero_draft_error, xero_draft_status FROM pilot_invoice_reviews WHERE id::text = ANY($1::text[])`,[reviewIds]);
  const token = await getAccessToken();
  const existing = await sheetsRequest(token, `/values/${encodeURIComponent("'Finance review'!A1:I10000")}`) as {values?:string[][]};
  const rows = existing.values ?? [];
  const expected=['Logged at','Outcome','Xero draft URL','Supplier selected','Invoice / credit note ref','Gross amount','Field / failure','Question or error detail','Front conversation URL'];
  if (expected.some((h,i)=>rows[0]?.[i]!==h)) throw new Error('Finance review Sheet headers do not match');
  const appended:string[]=[], already_present:string[]=[], skipped:string[]=[];
  for(const r of result.rows) {
    const a=r.assessment_json ?? {};
    const uncertainties=(Array.isArray(a.exceptions)?a.exceptions:[]).filter((x:unknown)=>typeof x==='string'&&!/\bvat\b|tax treatment|tax rate/i.test(x));
    const failure=!r.xero_draft_id && !!r.xero_draft_error;
    const hasUncertainty=uncertainties.length>0 || (!!r.xero_draft_error && !!r.xero_draft_id);
    if(!failure && !(r.xero_draft_id && hasUncertainty)){skipped.push(r.id);continue;}
    const key=`review:${r.id}`;
    if(rows.some(row=>row[7]?.includes(key))){already_present.push(r.id);continue;}
    const details=[key,...uncertainties, r.xero_draft_error].filter(Boolean).join(' | ');
    const values=[new Date(r.created_at).toISOString(),failure?'Technical failure':'Draft with uncertainty',
      r.xero_draft_id?`https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=${r.xero_draft_id}`:'',
      String(r.supplier_name??''),String(r.invoice_number??''),String(a.gross_gbp??''),
      failure?'Processing failure':'Uncertain fields',details,
      `https://app.frontapp.com/open/${r.front_conversation_id}`];
    await sheetsRequest(token, `/values/${encodeURIComponent("'Finance review'!A1:I10000")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, 'POST', {values:[values]});
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
  const range=encodeURIComponent("'Finance review'!A1:I10000");
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
  await sheetsRequest(token,`/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,'POST',{values:[row]});
}
