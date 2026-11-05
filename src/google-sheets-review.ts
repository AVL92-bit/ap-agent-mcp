
import { createSign } from "node:crypto";
import type { Pool } from "pg";

// Configure a new trial spreadsheet without changing code. Never silently write to the old trial.
const EXPECTED_SPREADSHEET_ID = "1OkGJeNAKIdAVM_GLDm_9euaG86wWIlr3HHvZkFbbQYg";
const SPREADSHEET_ID = process.env.AP_TRIAL_SPREADSHEET_ID?.trim() || EXPECTED_SPREADSHEET_ID;
const SHEET_NAME = process.env.AP_TRIAL_SHEET_NAME?.trim() || "Invoice Reviews";
const BASE = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}`;

type Assessment = {
  invoice_date?: string | null;
  due_date?: string | null;
  billed_to?: string | null;
  net_gbp?: number | null;
  vat_gbp?: number | null;
  gross_gbp?: number | null;
  xero_supplier?: string | null;
  duplicate_check?: string | null;
  proposed_account?: string | null;
  proposed_vat_treatment?: string | null;
  exceptions?: string[];
  evidence_notes?: string | null;
  requires_human_review?: boolean;
};

type Review = {
  id: string;
  created_at: Date;
  updated_at: Date;
  front_conversation_id: string;
  front_message_id: string;
  attachment_id: string;
  supplier_name: string | null;
  invoice_number: string | null;
  document_type: string | null;
  assessment_json: Assessment;
  review_status: string;
  xero_draft_id: string | null;
  xero_draft_status: string | null;
  xero_draft_error: string | null;
};

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

function text(value: unknown): string {
  return value == null ? "" : String(value);
}

/** Stable UK wall-clock display; historical times are sourced only from PostgreSQL. */
export function ukTimestamp(value:Date):string {
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(value);
  const get=(type:string)=>parts.find(p=>p.type===type)?.value??'';
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

/** VAT is settled by inbox policy; legacy assessments must not create VAT review questions. */
function reviewQueries(assessment: Assessment, draftError: string | null): string[] {
  return [
    ...(assessment.exceptions ?? []),
    ...(assessment.evidence_notes ? [`Evidence: ${assessment.evidence_notes}`] : []),
    ...(draftError ? [`Draft review: ${draftError}`] : []),
  ].filter(note => !/\bvat\b|tax treatment|tax rate/i.test(note));
}
function rowFor(review: Review): string[] {
  const a = review.assessment_json;
  return [
    review.id,
    ukTimestamp(review.created_at),
    review.front_conversation_id,
    review.front_message_id,
    review.attachment_id,
    text(review.supplier_name),
    text(a.xero_supplier),
    text(review.document_type),
    text(review.invoice_number),
    text(a.invoice_date),
    text(a.due_date),
    text(a.billed_to),
    text(a.net_gbp),
    text(a.vat_gbp),
    text(a.gross_gbp),
    text(a.duplicate_check),
    text(a.proposed_account),
    reviewQueries(a, review.xero_draft_error).join(" | "),
    review.review_status,
    "",
    "Review required", // Column U: valid dropdown default; human-owned thereafter.
    "", // Column V: reviewer notes; never overwritten on existing rows.
    "No", // A Xero draft is not evidence of visual PDF verification.
    text(review.xero_draft_id),
    text(review.xero_draft_status),
    ukTimestamp(review.updated_at),
  ];
}

export async function syncPilotReviewExceptions(
  pool: Pool,
  reviewIds: string[]
): Promise<{
  appended: string[];
  already_present: string[];
  skipped: string[];
}> {
  if (
    reviewIds.length === 0 ||
    reviewIds.length > 20 ||
    reviewIds.some(id => !/^[1-9]\d{0,17}$/.test(id)) ||
    new Set(reviewIds).size !== reviewIds.length
  ) {
    throw new Error("Provide 1–20 distinct numeric review IDs");
  }

  const records = await pool.query<Review>(
    `SELECT id::text, created_at, updated_at, front_conversation_id,
            front_message_id, attachment_id, supplier_name,
            invoice_number, document_type, assessment_json,
            review_status, xero_draft_id, xero_draft_status, xero_draft_error
       FROM pilot_invoice_reviews
      WHERE id::text = ANY($1::text[])
      ORDER BY id`,
    [reviewIds]
  );

  if (SPREADSHEET_ID !== EXPECTED_SPREADSHEET_ID || SHEET_NAME !== "Invoice Reviews")
    throw new Error(`Sheet target mismatch: expected ${EXPECTED_SPREADSHEET_ID}/Invoice Reviews; check Railway AP_TRIAL_SPREADSHEET_ID and AP_TRIAL_SHEET_NAME`);
  const token = await getAccessToken();
  const range = encodeURIComponent(`'${SHEET_NAME}'!A1:Z1000`);

  const existing = await sheetsRequest(
    token,
    `/values/${range}`
  ) as { values?: string[][] };

  const values = existing.values ?? [];
  // Read-only on existing rows unless draft-tracking or evidence actually changes.
  // In particular, do not apply timestamp formatting on every sync: even a
  // repeatCell formatting request makes a nominal no-op sync a Sheet write.

  const header = values[0] ?? [];

  if (
    header.length !== 26 ||
    header[0] !== "Review ID" ||
    header[1] !== "Assessment timestamp" ||
    header[18] !== "Review status" ||
    header[20] !== "Decision / action" ||
    header[21] !== "Reviewer notes" ||
    header[25] !== "Last updated timestamp"
  ) {
    throw new Error("Unexpected Google Sheet column layout");
  }


  // Legacy rows sometimes use TEST-001 instead of the PostgreSQL review ID.
  // Match them only by BOTH conversation and document number, uniquely.
  // Never change human-entered review status, decisions, holds or notes.
  function sheetRowIndex(review: Review): number {
    const exactMatches=values.map((row,i)=>({row,i})).filter(({row,i})=>i>0 && text(row[0])===review.id);
    if(exactMatches.length>1) throw new Error(`Duplicate Sheet review ID ${review.id}; reconcile manually`);
    if(exactMatches.length===1) return exactMatches[0].i;
    const matches = values.map((row,i)=>({row,i})).filter(({row,i})=>i>0 &&
      text(row[2])===review.front_conversation_id &&
      text(row[8]).trim().toLowerCase()===text(review.invoice_number).trim().toLowerCase() &&
      !!text(review.invoice_number).trim());
    if(matches.length>1) throw new Error(`Multiple Sheet rows match review ${review.id}; manual reconciliation required`);
    return matches.length===1 ? matches[0].i : -1;
  }

  const appended: string[] = [];
  const already_present: string[] = [];
  const skipped: string[] = [];

  for (const review of records.rows) {
    const rowIndex = sheetRowIndex(review);
    if (rowIndex > 0) {
      // Update only draft-tracking cells on an existing row; never overwrite
      // a colleague's review status, decision, notes or hold.
      if (review.xero_draft_id) {
        const rowNumber = rowIndex + 1;
        const current = values[rowIndex] ?? [];
        // Correct a known document-type mislabel, never touch review decisions.
        if (review.document_type === 'invoice' && text(current[7]).trim().toLowerCase() === 'sales invoice') {
          await sheetsRequest(token,
            `/values/${encodeURIComponent(`'${SHEET_NAME}'!H${rowNumber}`)}?valueInputOption=RAW`,
            "PUT", { values: [["invoice"]] });
        }
        const desired = [text(review.xero_draft_id), text(review.xero_draft_status)];
        if (desired.some((v,i) => v !== text(current[23+i]))) {
          await sheetsRequest(token,
            `/values/${encodeURIComponent(`'${SHEET_NAME}'!X${rowNumber}:Y${rowNumber}`)}?valueInputOption=RAW`,
            "PUT", { values: [desired] });
        }
        const xeroUrl = review.document_type === 'credit_note'
          ? `https://go.xero.com/AccountsPayable/ViewCreditNote.aspx?creditNoteID=${encodeURIComponent(review.xero_draft_id)}`
          : `https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=${encodeURIComponent(review.xero_draft_id)}`;
        const issueNote = [...reviewQueries(review.assessment_json, review.xero_draft_error), `Xero document: ${xeroUrl}`].filter(Boolean).join(' | ');
        if (issueNote && !text(current[17]).includes(issueNote)) {
          const updatedNotes = [text(current[17]), issueNote].filter(Boolean).join(' | ');
          await sheetsRequest(token,
            `/values/${encodeURIComponent(`'${SHEET_NAME}'!R${rowNumber}`)}?valueInputOption=RAW`,
            "PUT", { values: [[updatedNotes]] });
        }
      }
      // B (assessment timestamp) and Z (last updated timestamp) are historical
      // register values. Never backfill or normalise them during an existing-row
      // sync. New rows still receive PostgreSQL timestamps via rowFor().
      const verified=await sheetsRequest(token,`/values/${encodeURIComponent(`'${SHEET_NAME}'!A${rowIndex+1}:Z${rowIndex+1}`)}`) as {values?:string[][]};
      const persisted=verified.values?.[0]??[];
      if(review.xero_draft_id && (text(persisted[23])!==text(review.xero_draft_id)||text(persisted[24])!==text(review.xero_draft_status)))
        throw new Error(`Sheet Xero reference not persisted for review ${review.id}`);
      already_present.push(review.id);
      continue;
    }

    if (!review.xero_draft_id && review.assessment_json.requires_human_review !== true) {
      skipped.push(review.id);
      continue;
    }

    // Re-read the ID column immediately before appending.
    // Never replace an existing row or human decision.
    const latest = await sheetsRequest(
      token,
      `/values/${encodeURIComponent(`'${SHEET_NAME}'!A1:A1000`)}`
    ) as { values?: string[][] };

    if ((latest.values ?? []).some(row => text(row[0]) === review.id)) {
      already_present.push(review.id);
      continue;
    }

    await sheetsRequest(
      token,
      `/values/${encodeURIComponent(`'${SHEET_NAME}'!A1:Z1000`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      "POST",
      { values: [rowFor(review)] }
    );

    const confirmed=await sheetsRequest(token,`/values/${encodeURIComponent(`'${SHEET_NAME}'!A1:Z1000`)}`) as {values?:string[][]};
    if((confirmed.values??[]).filter(row=>text(row[0])===review.id).length!==1)
      throw new Error(`Sheet append not verified for review ${review.id}`);
    appended.push(review.id);

  }

  const found = new Set(records.rows.map(row => row.id));
  for (const id of reviewIds) {
    if (!found.has(id)) skipped.push(id);
  }

  return { appended, already_present, skipped };
}
