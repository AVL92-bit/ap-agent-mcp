import type { Pool } from "pg";
import { readFile } from "node:fs/promises";
import {
  assessPilotXeroInvoice,
  getPilotXeroWriteSession,
} from "./xero-pilot-test.js";

const PILOT_TENANT_ID =
  "45a1074b-b172-4f49-a192-f0a8e293b54d";
const PILOT_NAME = "St George's Road Surgery";
const PILOT_INBOX = "inb_bys7q";

const HELD_ATTACHMENTS = new Set([
  "msg_2ighxw0m:fil_4za3pfva",
  "msg_2ihh8owm:fil_4ze0zmvq",
]);

type DraftInvoice = {
  reviewId: string;
  conversationId: string;
  messageId: string;
  attachmentId: string;
  supplierName: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  net: number;
  vat: number;
  gross: number;
};

type DraftResult = {
  status: "draft_created" | "attachment_failed";
  review_id: string;
  xero_draft_id: string;
  attachment_verified: boolean;
};

function requirePilotConfiguration(): void {
  if (
    process.env.XERO_DRAFT_WRITES_ENABLED !== "true" ||
    process.env.XERO_PILOT_TENANT_ID !== PILOT_TENANT_ID ||
    process.env.FRONT_ENABLED_INBOX_ID !== PILOT_INBOX ||
    !process.env.DATABASE_URL ||
    !process.env.FRONT_API_TOKEN
  ) {
    throw new Error("Pilot draft writing is disabled or misconfigured");
  }
}

function validId(value: string): boolean {
  return /^[0-9]{1,30}$/.test(value);
}

function validDate(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    return false;
  }

  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}
function defaultDueDate(invoiceDate: string): string {
  if (!validDate(invoiceDate)) {
    throw new Error("Invalid invoice date");
  }

  const date = new Date(`${invoiceDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 30);

  return date.toISOString().slice(0, 10);
}
function amountInPence(value: unknown): number | null {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    return null;
  }

  const pence = Math.round(value * 100);
  return Math.abs(value * 100 - pence) < 0.000001
    ? pence
    : null;
}

export async function getPilotDraftReadiness(
  pool: Pool,
  reviewId: string
): Promise<{
  status: "blocked" | "ready_for_further_checks";
  review_id: string;
  reasons: string[];
}> {
  if (!validId(reviewId)) {
    throw new Error("Invalid review ID");
  }

  const result = await pool.query(
    `
      SELECT front_message_id, attachment_id,
             document_type, review_status,
             supplier_name, invoice_number,
             assessment_json, xero_draft_id,
             xero_draft_status
      FROM pilot_invoice_reviews
      WHERE id = $1
    `,
    [reviewId]
  );

  if (result.rows.length !== 1) {
    throw new Error("Invoice review not found");
  }

  const review = result.rows[0];
  const assessment = review.assessment_json;
  const reasons: string[] = [];

  if (
    HELD_ATTACHMENTS.has(
      `${review.front_message_id}:${review.attachment_id}`
    )
  ) {
    reasons.push("Existing human hold");
  }

  if (review.review_status !== "awaiting_review") {
    reasons.push("Review status blocks drafting");
  }

  if (review.document_type !== "invoice") {
    reasons.push("Document is not a supplier invoice");
  }

  if (
    review.xero_draft_id !== null ||
    review.xero_draft_status !== null
  ) {
    reasons.push("Draft exists or creation was attempted");
  }

  if (
    !assessment ||
    typeof assessment !== "object" ||
    Array.isArray(assessment)
  ) {
    reasons.push("Assessment is invalid");
  } else {
    if (assessment.billed_to !== PILOT_NAME) {
      reasons.push("Billing entity not verified");
    }

    if (
      !Array.isArray(assessment.exceptions) ||
      assessment.exceptions.length !== 0
    ) {
      reasons.push("Assessment has unresolved exceptions");
    }

    const net = amountInPence(assessment.net_gbp);
    const vat = amountInPence(assessment.vat_gbp);
    const gross = amountInPence(assessment.gross_gbp);

    if (
      net === null ||
      vat === null ||
      gross === null ||
      gross <= 0 ||
      net + vat !== gross
    ) {
      reasons.push("Invoice amounts do not reconcile");
    }

    if (!validDate(assessment.invoice_date)) {
      reasons.push("Invoice date requires verification");
    }

    if (
      assessment.due_date !== null &&
      assessment.due_date !== undefined &&
      assessment.due_date !== "" &&
      !validDate(assessment.due_date)
    ) {
      reasons.push("Supplied due date is invalid");
    }
  }

  if (
    typeof review.supplier_name !== "string" ||
    !review.supplier_name.trim() ||
    typeof review.invoice_number !== "string" ||
    !review.invoice_number.trim()
  ) {
    reasons.push("Supplier or invoice number missing");
  }

  return {
    status:
      reasons.length === 0
        ? "ready_for_further_checks"
        : "blocked",
    review_id: reviewId,
    reasons,
  };
}

export async function assertPilotDraftAllowed(
  pool: Pool,
  reviewId: string
): Promise<void> {
  requirePilotConfiguration();

  const readiness = await getPilotDraftReadiness(
    pool,
    reviewId
  );

  if (readiness.status !== "ready_for_further_checks") {
    throw new Error(
      "Invoice failed readiness checks: " +
      readiness.reasons.join("; ")
    );
  }

  const connection = await pool.query(
    `
      SELECT tenant_id, tenant_name, enabled
      FROM xero_oauth_connections
      WHERE tenant_id = $1
    `,
    [PILOT_TENANT_ID]
  );

  if (
    connection.rows.length !== 1 ||
    connection.rows[0].tenant_id !== PILOT_TENANT_ID ||
    connection.rows[0].tenant_name !== PILOT_NAME ||
    connection.rows[0].enabled !== false
  ) {
    throw new Error("Unexpected Xero pilot connection");
  }
}

export async function loadPilotDraftInvoice(
  pool: Pool,
  reviewId: string
): Promise<DraftInvoice> {
  const readiness = await getPilotDraftReadiness(
    pool,
    reviewId
  );

  if (readiness.status !== "ready_for_further_checks") {
    throw new Error(
      "Invoice is not ready: " +
      readiness.reasons.join("; ")
    );
  }

  const result = await pool.query(
    `
      SELECT front_conversation_id,
             front_message_id, attachment_id,
             supplier_name, invoice_number,
             assessment_json
      FROM pilot_invoice_reviews
      WHERE id = $1
    `,
    [reviewId]
  );

  if (result.rows.length !== 1) {
    throw new Error("Invoice review not found");
  }

  const row = result.rows[0];
  const assessment = row.assessment_json;

  return {
    reviewId,
    conversationId: row.front_conversation_id,
    messageId: row.front_message_id,
    attachmentId: row.attachment_id,
    supplierName: row.supplier_name,
    invoiceNumber: row.invoice_number,
    invoiceDate: assessment.invoice_date,
        dueDate: validDate(assessment.due_date)
      ? assessment.due_date
      : defaultDueDate(assessment.invoice_date),
    net: assessment.net_gbp,
    vat: assessment.vat_gbp,
    gross: assessment.gross_gbp,
  };
}

async function xeroGet(
  path: string,
  tenantId: string,
  accessToken: string
): Promise<any> {
  const response = await fetch(
    `https://api.xero.com/api.xro/2.0/${path}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "xero-tenant-id": tenantId,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(20000),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Xero read failed (HTTP ${response.status})`
    );
  }

  return response.json();
}

async function verifiedSupplierContactId(
  tenantId: string,
  accessToken: string,
  supplierName: string
): Promise<string> {
  if (
    !supplierName ||
    supplierName.length > 150 ||
    /["\\\r\n]/.test(supplierName)
  ) {
    throw new Error("Supplier requires manual review");
  }

  const url = new URL(
    "https://api.xero.com/api.xro/2.0/Contacts"
  );

  url.searchParams.set(
    "where",
    `Name=="${supplierName}"`
  );

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "xero-tenant-id": tenantId,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(20000),
  });

  if (!response.ok) {
    throw new Error("Xero supplier lookup failed");
  }

  const data = (await response.json()) as {
    Contacts?: Array<{
      Name?: string;
      ContactID?: string;
      IsSupplier?: boolean;
    }>;
  };

  const exactMatches = Array.isArray(data.Contacts)
    ? data.Contacts.filter(
        (contact) =>
          contact.Name === supplierName &&
          contact.IsSupplier === true &&
          typeof contact.ContactID === "string" &&
          contact.ContactID.length > 0
      )
    : [];

  if (exactMatches.length !== 1) {
    throw new Error(
      "Existing Xero supplier not uniquely verified"
    );
  }

  const contactId = exactMatches[0].ContactID;

  if (typeof contactId !== "string" || !contactId) {
    throw new Error("Verified Xero supplier has no ContactID");
  }

  return contactId;
}

async function originalFrontDocument(
  invoice: DraftInvoice
): Promise<{
  filename: string;
  contentType: string;
  bytes: Buffer;
}> {
  const token = process.env.FRONT_API_TOKEN;

  if (!token) {
    throw new Error("Front token missing");
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };

  // Verify the conversation belongs to the pilot inbox.
  const inboxResponse = await fetch(
    `https://api2.frontapp.com/conversations/${
      encodeURIComponent(invoice.conversationId)
    }/inboxes`,
    {
      headers,
      signal: AbortSignal.timeout(20000),
    }
  );

  if (!inboxResponse.ok) {
    throw new Error("Front inbox verification failed");
  }

  const inboxData = (await inboxResponse.json()) as {
    _results?: Array<{ id?: string }>;
    _pagination?: { next?: string | null };
  };

  if (
    !Array.isArray(inboxData._results) ||
    inboxData._pagination?.next ||
    !inboxData._results.some(
      (item) => item.id === PILOT_INBOX
    )
  ) {
    throw new Error("Conversation is outside pilot inbox");
  }

  // Verify the message and original attachment.
  const messagesResponse = await fetch(
    `https://api2.frontapp.com/conversations/${
      encodeURIComponent(invoice.conversationId)
    }/messages?limit=100`,
    {
      headers,
      signal: AbortSignal.timeout(20000),
    }
  );

  if (!messagesResponse.ok) {
    throw new Error("Front message verification failed");
  }

  const messagesData = (await messagesResponse.json()) as {
    _results?: Array<{
      id?: string;
      attachments?: Array<{
        filename?: string;
        content_type?: string;
        size?: number;
        url?: string;
      }>;
    }>;
    _pagination?: { next?: string | null };
  };

  if (
    !Array.isArray(messagesData._results) ||
    messagesData._pagination?.next
  ) {
    throw new Error("Front message listing is incomplete");
  }

  const messages = messagesData._results.filter(
    (item) => item.id === invoice.messageId
  );

  if (messages.length !== 1) {
    throw new Error("Original Front message not verified");
  }

  const attachments = (
    messages[0].attachments ?? []
  ).filter((item) =>
    item.url?.includes(
      `/download/${invoice.attachmentId}`
    )
  );

  if (attachments.length !== 1) {
    throw new Error("Original Front attachment not verified");
  }

  const attachment = attachments[0];
  const maximumBytes = 10 * 1024 * 1024;

  const filename = attachment.filename;

  if (
    !filename ||
    filename.length > 150 ||
    filename === "." ||
    filename === ".." ||
    !/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(filename)
  ) {
    throw new Error(
      "Original attachment filename requires human review"
    );
  }

  const extension = filename
    .split(".")
    .pop()
    ?.toLowerCase();

  const permittedTypes: Record<string, string> = {
    pdf: "application/pdf",
    doc: "application/msword",
    docx:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    txt: "text/plain",
    csv: "text/csv",
  };

  const contentType = extension
    ? permittedTypes[extension]
    : undefined;

  if (
    !contentType ||
    attachment.content_type !== contentType ||
    (typeof attachment.size === "number" &&
      attachment.size > maximumBytes)
  ) {
    throw new Error(
      "Original attachment format or size requires human review"
    );
  }

  const response = await fetch(
    `https://api2.frontapp.com/messages/${
      encodeURIComponent(invoice.messageId)
    }/download/${encodeURIComponent(invoice.attachmentId)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: contentType,
      },
      signal: AbortSignal.timeout(20000),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Original Front attachment download failed (HTTP ${response.status})`
    );
  }

  const downloadedType = response.headers
    .get("content-type")
    ?.split(";")[0]
    .trim();

  if (downloadedType !== contentType) {
    throw new Error(
      "Downloaded attachment content type is not verified"
    );
  }

  const declaredLength = response.headers.get(
    "content-length"
  );

  if (
    declaredLength !== null &&
    Number(declaredLength) > maximumBytes
  ) {
    throw new Error("Original attachment exceeds size limit");
  }

  const bytes = Buffer.from(
    await response.arrayBuffer()
  );

  if (
    bytes.length === 0 ||
    bytes.length > maximumBytes
  ) {
    throw new Error(
      "Original attachment is empty or exceeds size limit"
    );
  }

  // Check PDF signature when applicable.
  if (
    contentType === "application/pdf" &&
    bytes.subarray(0, 5).toString("ascii") !== "%PDF-"
  ) {
    throw new Error("Original PDF signature is invalid");
  }

  return {
    filename,
    contentType,
    bytes,
  };
}

export async function createPilotXeroDraftBill(
  tenantId: string,
  accessToken: string,
  contactId: string,
  invoice: DraftInvoice,
  accountCode: string,
  taxType: string
): Promise<string> {
  requirePilotConfiguration();

  if (
    tenantId !== PILOT_TENANT_ID ||
    !accessToken ||
    !contactId ||
    !accountCode ||
    taxType !== "NONE" ||
    !validDate(invoice.invoiceDate) ||
    !validDate(invoice.dueDate)
  ) {
    throw new Error(
      "Invoice cannot be drafted with verified coding and VAT"
    );
  }

  const response = await fetch(
    "https://api.xero.com/api.xro/2.0/Invoices",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "xero-tenant-id": tenantId,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        Invoices: [
          {
            Type: "ACCPAY",
            Status: "DRAFT",
            Contact: { ContactID: contactId },
            InvoiceNumber: invoice.invoiceNumber,
            Date: invoice.invoiceDate,
            DueDate: invoice.dueDate,
            CurrencyCode: "GBP",
            LineAmountTypes: "Exclusive",
            LineItems: [
              {
                Description:
                  `Supplier invoice ${invoice.invoiceNumber}`,
                Quantity: 1,
                UnitAmount: invoice.gross,
                AccountCode: accountCode,
                TaxType: taxType,
              },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(20000),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Xero draft creation response HTTP ${response.status}`
    );
  }

  const data = (await response.json()) as {
    Invoices?: Array<{
      InvoiceID?: string;
      Status?: string;
      Type?: string;
      Total?: number;
      HasErrors?: boolean;
      ValidationErrors?: unknown[];
    }>;
  };

  const created = data.Invoices?.[0];

  if (
    data.Invoices?.length !== 1 ||
    !created?.InvoiceID ||
    created.Status !== "DRAFT" ||
    created.Type !== "ACCPAY" ||
    created.HasErrors === true ||
    (created.ValidationErrors?.length ?? 0) > 0 ||
    typeof created.Total !== "number" ||
    amountInPence(Math.abs(created.Total)) !==
      amountInPence(invoice.gross)
  ) {
    throw new Error(
      "Xero draft response requires manual reconciliation"
    );
  }

  return created.InvoiceID;
}

async function attachAndVerifyOriginal(
  tenantId: string,
  accessToken: string,
  draftId: string,
  filename: string,
  contentType: string,
  bytes: Buffer
): Promise<void> {
  const attachmentUrl =
    `https://api.xero.com/api.xro/2.0/Invoices/${
      encodeURIComponent(draftId)
    }/Attachments/${encodeURIComponent(filename)}`;

  const upload = await fetch(attachmentUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "xero-tenant-id": tenantId,
      "Content-Type": contentType,
      Accept: "application/json",
    },
    body: new Uint8Array(bytes),
    signal: AbortSignal.timeout(30000),
  });

  if (!upload.ok) {
    throw new Error(
      `Xero original attachment upload failed (HTTP ${upload.status})`
    );
  }

  const listing = await xeroGet(
    `Invoices/${encodeURIComponent(draftId)}/Attachments`,
    tenantId,
    accessToken
  );

  const matches = (
    listing.Attachments ?? []
  ).filter(
    (item: { FileName?: string; MimeType?: string }) =>
      item.FileName === filename &&
      item.MimeType?.toLowerCase() === contentType.toLowerCase()
  );

  if (matches.length !== 1) {
    throw new Error(
      "Original attachment not confirmed by Xero"
    );
  }
}
type CodingPolicy = {
  organisation_name: string;
  supplier_name: string;
  xero_supplier_name: string;
  service: string;
  account_code: string;
  status: string;
  human_review_required: boolean;
  automatic_bill_creation_allowed: boolean;
  automatic_coding_allowed: boolean;
  excluded_services: string[];
};

type CodingPolicyFile = {
  version: number;
  organisation_name: string;
  practice_rules: {
    xero_purchase_tax_type: string;
    expense_amount_basis: string;
    automatic_draft_creation_allowed: boolean;
  };
  policies: CodingPolicy[];
};

async function loadApprovedCodingPolicy(
  supplierName: string,
  proposedAccount: string,
  taxType: string
): Promise<CodingPolicy> {
  const raw = await readFile(
    new URL("../config/coding-policies.json", import.meta.url),
    "utf8"
  );

  const config = JSON.parse(raw) as CodingPolicyFile;

  if (
    config.version !== 2 ||
    config.organisation_name !== PILOT_NAME ||
    config.practice_rules?.xero_purchase_tax_type !== "NONE" ||
    config.practice_rules?.expense_amount_basis !==
      "gross_invoice_amount" ||
    config.practice_rules?.automatic_draft_creation_allowed !== true ||
    taxType !== "NONE"
  ) {
    throw new Error("Practice coding configuration is invalid");
  }

  const matches = config.policies.filter(
    (policy) =>
      policy.organisation_name === PILOT_NAME &&
      policy.status === "approved" &&
      policy.automatic_bill_creation_allowed === true &&
      policy.automatic_coding_allowed === true &&
      policy.human_review_required === false &&
      policy.account_code === proposedAccount &&
      (
        policy.supplier_name === supplierName ||
        policy.xero_supplier_name === supplierName
      )
  );

  if (matches.length !== 1) {
    throw new Error(
      "No unique approved coding policy for supplier and account"
    );
  }

  return matches[0];
}
export async function createPilotDraftWithPdf(
  pool: Pool,
  reviewId: string,
  _legacyAccountCode?: string,
  _legacyTaxType?: string
): Promise<DraftResult> {
  await assertPilotDraftAllowed(pool, reviewId);

  const invoice = await loadPilotDraftInvoice(
    pool,
    reviewId
  );

  const reviewResult = await pool.query(
    `
      SELECT assessment_json
      FROM pilot_invoice_reviews
      WHERE id = $1
    `,
    [reviewId]
  );

  if (reviewResult.rows.length !== 1) {
    throw new Error("Invoice review not found");
  }

  const proposedAccount =
    reviewResult.rows[0].assessment_json?.proposed_account;

  if (
    typeof proposedAccount !== "string" ||
    !/^[0-9]{3,10}$/.test(proposedAccount)
  ) {
    throw new Error(
      "Invoice has no valid proposed expense account"
    );
  }

  const policy = await loadApprovedCodingPolicy(
    invoice.supplierName,
    proposedAccount,
    "NONE"
  );

  const accountCode = policy.account_code;
  const taxType = "NONE";

  const assessment = await assessPilotXeroInvoice({
    supplier_name: policy.xero_supplier_name,
    invoice_number: invoice.invoiceNumber,
  });

  if (
    assessment.status !== "xero_checks_clear" ||
    assessment.supplier_verified !== true ||
    assessment.duplicate_search_complete !== true ||
    assessment.matching_supplier_bill_count !== 0 ||
    assessment.same_number_other_supplier_bill_count !== 0
  ) {
    throw new Error(
      "Supplier or duplicate checks require human review"
    );
  }

  const session = await getPilotXeroWriteSession();

  const contactId = await verifiedSupplierContactId(
    session.tenantId,
    session.accessToken,
    policy.xero_supplier_name
  );

  // Retrieve and verify the original document BEFORE creating the bill.
  const original = await originalFrontDocument(invoice);

  // Claim the record once. Any uncertain Xero outcome
  // remains recorded and cannot create a second bill.
  const claim = await pool.query(
    `
      UPDATE pilot_invoice_reviews
      SET xero_draft_status = 'creating',
          xero_draft_updated_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
        AND review_status = 'awaiting_review'
        AND document_type = 'invoice'
        AND xero_draft_id IS NULL
        AND xero_draft_status IS NULL
      RETURNING id
    `,
    [reviewId]
  );

  if (claim.rows.length !== 1) {
    throw new Error(
      "Draft creation already claimed or review changed"
    );
  }

  let draftId: string;

  try {
    draftId = await createPilotXeroDraftBill(
      session.tenantId,
      session.accessToken,
      contactId,
      invoice,
      accountCode,
      taxType
    );
  } catch (error) {
    await pool.query(
      `
        UPDATE pilot_invoice_reviews
        SET xero_draft_status = 'creation_uncertain',
            xero_draft_error = $2,
            xero_draft_updated_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
          AND xero_draft_status = 'creating'
      `,
      [
        reviewId,
        error instanceof Error
          ? error.message.slice(0, 500)
          : "Unknown Xero creation error",
      ]
    ).catch(() => {});

    throw error;
  }

  // Save the Xero ID before attempting the attachment.
  await pool.query(
    `
      UPDATE pilot_invoice_reviews
      SET xero_draft_id = $2,
          xero_draft_status = 'attaching_pdf',
          xero_draft_updated_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
        AND xero_draft_status = 'creating'
        AND xero_draft_id IS NULL
    `,
    [reviewId, draftId]
  );

  try {
   await attachAndVerifyOriginal(
      session.tenantId,
      session.accessToken,
      draftId,
      original.filename,
      original.contentType,
      original.bytes
    );

    await pool.query(
      `
        UPDATE pilot_invoice_reviews
        SET xero_draft_status = 'draft_created',
            xero_attachment_verified = TRUE,
            xero_draft_error = NULL,
            xero_draft_updated_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
          AND xero_draft_id = $2
      `,
      [reviewId, draftId]
    );

    return {
      status: "draft_created",
      review_id: reviewId,
      xero_draft_id: draftId,
      attachment_verified: true,
    };
  } catch (error) {
    await pool.query(
      `
        UPDATE pilot_invoice_reviews
        SET xero_draft_status = 'attachment_failed',
            xero_attachment_verified = FALSE,
            xero_draft_error = $3,
            xero_draft_updated_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
          AND xero_draft_id = $2
      `,
      [
        reviewId,
        draftId,
        error instanceof Error
          ? error.message.slice(0, 500)
          : "Unknown attachment error",
      ]
    ).catch(() => {});

    return {
      status: "attachment_failed",
      review_id: reviewId,
      xero_draft_id: draftId,
      attachment_verified: false,
    };
  }
}
