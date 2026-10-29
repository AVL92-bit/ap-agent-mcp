
import { createSign } from "node:crypto";
import type { Pool } from "pg";

const SPREADSHEET_ID =
  "1J3-MeXhDsRH-X0k39dDFI92rwJot1oQxfvayWYVmAsg";
const SHEET_NAME = "Invoice Reviews";
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
  front_conversation_id: string;
  front_message_id: string;
  attachment_id: string;
  supplier_name: string | null;
  invoice_number: string | null;
  document_type: string | null;
  assessment_json: Assessment;
  review_status: string;
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

function rowFor(review: Review): string[] {
  const a = review.assessment_json;
  return [
    review.id,
    review.created_at.toISOString().slice(0, 10),
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
    text(a.proposed_vat_treatment),
    [
      ...(a.exceptions ?? []),
      ...(a.evidence_notes ? [`Evidence: ${a.evidence_notes}`] : []),
    ].join(" | "),
    review.review_status,
    "",
    "Requires human review; no Xero draft authorised",
    "",
    "No",
    "",
    "",
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
    `SELECT id::text, created_at, front_conversation_id,
            front_message_id, attachment_id, supplier_name,
            invoice_number, document_type, assessment_json,
            review_status
       FROM pilot_invoice_reviews
      WHERE id::text = ANY($1::text[])
      ORDER BY id`,
    [reviewIds]
  );

  const token = await getAccessToken();
  const range = encodeURIComponent(`'${SHEET_NAME}'!A1:Z1000`);

  const existing = await sheetsRequest(
    token,
    `/values/${range}`
  ) as { values?: string[][] };

  const values = existing.values ?? [];
  const header = values[0] ?? [];

  if (
    header[0] !== "Review ID" ||
    header[19] !== "Review status" ||
    header[21] !== "Decision / action" ||
    header.length !== 26
  ) {
    throw new Error("Unexpected Google Sheet column layout");
  }

  const present = new Set(
    values.slice(1).map(row => text(row[0])).filter(Boolean)
  );

  const appended: string[] = [];
  const already_present: string[] = [];
  const skipped: string[] = [];

  for (const review of records.rows) {
    if (present.has(review.id)) {
      already_present.push(review.id);
      continue;
    }

    if (
      review.assessment_json.requires_human_review !== true ||
      !["awaiting_review", "on_hold"].includes(review.review_status)
    ) {
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

    appended.push(review.id);
    present.add(review.id);
  }

  const found = new Set(records.rows.map(row => row.id));
  for (const id of reviewIds) {
    if (!found.has(id)) skipped.push(id);
  }

  return { appended, already_present, skipped };
}
