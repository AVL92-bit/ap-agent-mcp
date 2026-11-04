import { xeroFetch } from "./xero-rate-limit.js";
import type { Pool } from "pg";
import { readFile } from "node:fs/promises";
import { PDFParse } from "pdf-parse";
import {
  assessPilotXeroInvoice,
  getPilotXeroWriteSession,
  getPilotXeroReadSession,
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
type ReadinessVerification = {
  verification_type: string;
  outcome: string;
  evidence_json: unknown;
  verified_by: string;
};

async function getReadinessVerifications(
  pool: Pool,
  reviewId: string
): Promise<ReadinessVerification[]> {
  const result = await pool.query<ReadinessVerification>(
    `
      SELECT DISTINCT ON (verification_type)
        verification_type,
        outcome,
        evidence_json,
        verified_by
      FROM pilot_invoice_verifications
      WHERE review_id = $1
      ORDER BY
        verification_type,
        verified_at DESC,
        id DESC
    `,
    [reviewId]
  );

  return result.rows;
}

function hasVerifiedResolution(
  verifications: ReadinessVerification[],
  type: string
): boolean {
  return verifications.some(
    (verification) =>
      verification.verification_type === type &&
      verification.outcome === "verified" &&
      typeof verification.verified_by === "string" &&
      verification.verified_by.trim().length > 0 &&
      verification.evidence_json !== null &&
      typeof verification.evidence_json === "object" &&
      !Array.isArray(verification.evidence_json) &&
      Object.keys(verification.evidence_json).length > 0
  );
}

function hasResolvedOriginalExceptions(
  exceptions: unknown,
  verifications: ReadinessVerification[]
): boolean {
  if (!Array.isArray(exceptions)) {
    return false;
  }

  if (exceptions.length === 0) {
    return true;
  }

  const resolved = new Set<string>();

  for (const verification of verifications) {
    if (
      !hasVerifiedResolution(
        verifications,
        verification.verification_type
      )
    ) {
      continue;
    }

    const evidence = verification.evidence_json;

    if (
      !evidence ||
      typeof evidence !== "object" ||
      Array.isArray(evidence)
    ) {
      continue;
    }

    const items = (
      evidence as Record<string, unknown>
    ).resolved_exceptions;

    if (!Array.isArray(items)) {
      continue;
    }

    for (const item of items) {
      if (typeof item === "string") {
        resolved.add(item);
      }
    }
  }

  return exceptions.every(
    (exception) =>
      typeof exception === "string" &&
      resolved.has(exception)
  );
}
type BillingPrecedent = {
  matched: boolean;
  historical_invoice_id?: string;
};

function normaliseBillingLine(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]/g, "");
}
function billingAddressee(billedTo: string): string {
  return normaliseBillingLine(
    billedTo.split(",")[0].trim()
  );
}

function pdfHasBillingAddressee(
  text: string,
  billedTo: string
): boolean {
  const addressee = billingAddressee(billedTo);

  if (addressee.length < 5) {
    return false;
  }

  return text
    .split(/\r?\n/)
    .some(
      (line) =>
        normaliseBillingLine(line.trim()) === addressee
    );
}
function billingAddressFromText(
  text: string,
  billedTo: string
): string[] | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const target = normaliseBillingLine(billedTo);

  if (target.length < 5) {
    return null;
  }

  for (let i = 0; i < lines.length; i++) {
    if (normaliseBillingLine(lines[i]) !== target) {
      continue;
    }

    const following = lines.slice(i + 1, i + 8);

    const postcodeIndex = following.findIndex((line) =>
      /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i.test(line)
    );

    if (postcodeIndex < 1) {
      continue;
    }

    const address = following
      .slice(0, postcodeIndex + 1)
      .map(normaliseBillingLine)
      .filter(Boolean);

    if (address.length >= 2) {
      return address;
    }
  }

  return null;
}

async function pdfText(bytes: Buffer): Promise<string | null> {
  if (
    bytes.length < 5 ||
    bytes.length > 10 * 1024 * 1024 ||
    bytes.subarray(0, 5).toString("ascii") !== "%PDF-"
  ) {
    return null;
  }

  const parser = new PDFParse({
    data: new Uint8Array(bytes),
  });

  try {
    const info = await parser.getInfo();

    if (
      !Number.isInteger(info.total) ||
      info.total < 1 ||
      info.total > 20
    ) {
      return null;
    }

    const result = await parser.getText();
    return typeof result.text === "string"
      ? result.text
      : null;
  } catch {
    return null;
  } finally {
    await parser.destroy();
  }
}

async function historicalBillingPrecedent(
  pool: Pool,
  review: {
    front_conversation_id: string;
    front_message_id: string;
    attachment_id: string;
    supplier_name: string;
    invoice_number: string;
  },
  billedTo: string
): Promise<BillingPrecedent> {
  if (
    !billedTo.trim() ||
    !review.supplier_name?.trim() ||
    !review.invoice_number?.trim()
  ) {
    return { matched: false };
  }

  // Obtain the current original supplier PDF from Front.
  const current = await originalFrontDocument({
    conversationId: review.front_conversation_id,
    messageId: review.front_message_id,
    attachmentId: review.attachment_id,
  });

   if (current.contentType !== "application/pdf") {
    console.info("Historical Xero current PDF check", {
      result: "not_pdf",
      content_type: current.contentType,
    });
    return { matched: false };
  }

  const currentText = await pdfText(current.bytes);

  if (!currentText) {
    console.info("Historical Xero current PDF check", {
      result: "text_extraction_failed",
    });
    return { matched: false };
  }

  const currentAddresseeFound = pdfHasBillingAddressee(
    currentText,
    billedTo
  );

  console.info("Historical Xero current PDF check", {
    result: currentAddresseeFound
      ? "addressee_found"
      : "addressee_not_found",
    billed_to: billedTo,
  });

  if (!currentAddresseeFound) {
    return { matched: false };
  }

  const session = await getPilotXeroReadSession();

  if (session.tenantId !== PILOT_TENANT_ID) {
    throw new Error("Unexpected Xero tenant");
  }

  // Resolve the exact supplier contact, rather than
  // using a partial supplier-name match.

  // Exact supplier verification uses the invoice supplier, not a policy alias.
  const xeroSupplierName = review.supplier_name.trim();
  const contactsUrl = new URL(
    "https://api.xero.com/api.xro/2.0/Contacts"
  );

  contactsUrl.searchParams.set(
    "where",
     `Name=="${xeroSupplierName.replace(/"/g, '\\"')}"`
  );

  const headers = {
    Authorization: `Bearer ${session.accessToken}`,
    "xero-tenant-id": session.tenantId,
    Accept: "application/json",
  };

  const contactsResponse = await xeroFetch(contactsUrl, {
    headers,
    signal: AbortSignal.timeout(20000),
  });

  if (!contactsResponse.ok) {
    throw new Error(
      `Historical supplier lookup failed: HTTP ${contactsResponse.status}`
    );
  }

  const contactsData = await contactsResponse.json() as {
    Contacts?: Array<{
      ContactID?: string;
      Name?: string;
      IsSupplier?: boolean;
    }>;
  };

  const matches = (contactsData.Contacts ?? []).filter(
    (contact) =>
      contact.Name === xeroSupplierName &&
      contact.IsSupplier === true &&
      typeof contact.ContactID === "string"
  );

  if (matches.length !== 1) {
    console.info(
      "Historical Xero supplier contact result",
      {
        supplier_found: matches.length,
        xero_supplier_name: xeroSupplierName,
      }
    );
    return { matched: false };
  }

  const contactId = matches[0].ContactID!;

  const invoicesUrl = new URL(
    "https://api.xero.com/api.xro/2.0/Invoices"
  );

  invoicesUrl.searchParams.set(
    "where",
    `Type=="ACCPAY"&&Contact.ContactID==Guid("${contactId}")`
  );
  invoicesUrl.searchParams.set("order", "Date DESC");
  invoicesUrl.searchParams.set("page", "1");

  const invoicesResponse = await xeroFetch(invoicesUrl, {
    headers,
    signal: AbortSignal.timeout(20000),
  });

  if (!invoicesResponse.ok) {
    throw new Error(
      `Historical bill lookup failed: HTTP ${invoicesResponse.status}`
    );
  }

  const invoicesData = await invoicesResponse.json() as {
    Invoices?: Array<{
      InvoiceID?: string;
      InvoiceNumber?: string;
      Type?: string;
      Status?: string;
      Contact?: { ContactID?: string };
    }>;
  };
  if (!Array.isArray(invoicesData.Invoices)) {
    return { matched: false };
  }
  const candidates = (invoicesData.Invoices ?? [])
    .filter(
      (invoice) =>
        invoice.Type === "ACCPAY" &&
        invoice.Contact?.ContactID === contactId &&
        (invoice.Status === "AUTHORISED" ||
          invoice.Status === "PAID") &&
        invoice.InvoiceNumber !== review.invoice_number &&
        typeof invoice.InvoiceID === "string"
    )
    .slice(0, 5);
  
  console.info(
    "Historical Xero bill candidates",
    {
      supplier: xeroSupplierName,
      invoices_returned: invoicesData.Invoices.length,
      eligible_candidates: candidates.length,
    }
  );
  
  for (const invoice of candidates) {
    const invoiceId = invoice.InvoiceID!;

    const attachmentUrl =
      `https://api.xero.com/api.xro/2.0/Invoices/` +
      `${encodeURIComponent(invoiceId)}/Attachments`;

   const listingResponse = await xeroFetch(attachmentUrl, {
      headers,
      signal: AbortSignal.timeout(20000),
    });

    if (!listingResponse.ok) {
      console.error("Historical Xero attachment", {
        invoice_id: invoiceId,
        stage: "listing",
        http_status: listingResponse.status,
      });
      continue;
    }

    const listing = await listingResponse.json() as {
      Attachments?: Array<{
        FileName?: string;
        MimeType?: string;
      }>;
    };

    const attachments = listing.Attachments ?? [];

    console.info("Historical Xero attachment", {
      invoice_id: invoiceId,
      stage: "listing_received",
      attachment_count: attachments.length,
      pdf_candidates: attachments.filter(
        (item) =>
          item.FileName?.toLowerCase().endsWith(".pdf") ||
          item.MimeType?.toLowerCase() === "application/pdf"
      ).length,
    });

    for (const attachment of attachments) {
      if (
        !attachment.FileName ||
        !(
          attachment.FileName.toLowerCase().endsWith(".pdf") ||
          attachment.MimeType?.toLowerCase() === "application/pdf"
        )
      ) {
        continue;
      }

      const pdfResponse = await xeroFetch(
        `${attachmentUrl}/${encodeURIComponent(attachment.FileName)}`,
        {
          headers: {
            ...headers,
            Accept: "application/pdf",
          },
          signal: AbortSignal.timeout(20000),
        }
      );

      if (!pdfResponse.ok) {
        console.error("Historical Xero attachment", {
          invoice_id: invoiceId,
          stage: "download",
          http_status: pdfResponse.status,
        });
        continue;
      }

      const declaredSize = Number(
        pdfResponse.headers.get("content-length") ?? "0"
      );

      if (declaredSize > 10 * 1024 * 1024) {
        console.info("Historical Xero attachment", {
          invoice_id: invoiceId,
          stage: "oversized",
        });
        continue;
      }

      const historicalBytes = Buffer.from(
        await pdfResponse.arrayBuffer()
      );

      const historicalText = await pdfText(historicalBytes);

      if (!historicalText) {
        console.info("Historical Xero attachment", {
          invoice_id: invoiceId,
          stage: "pdf_text_unavailable",
          bytes: historicalBytes.length,
          pdf_signature:
            historicalBytes.subarray(0, 5).toString("ascii") ===
            "%PDF-",
        });
        continue;
      }

      const historicalAddresseeFound = pdfHasBillingAddressee(
        historicalText,
        billedTo
      );

      console.info("Historical Xero attachment", {
        invoice_id: invoiceId,
        stage: historicalAddresseeFound
          ? "addressee_matched"
          : "addressee_not_matched",
      });

      if (historicalAddresseeFound) {
        return {
          matched: true,
          historical_invoice_id: invoiceId,
        };
      }
    }
  }

  return { matched: false };
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
   SELECT front_conversation_id,
       front_message_id, attachment_id,
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

  // Draft-first: review holds and routine exceptions remain recorded, never veto drafts.
  // This legacy readiness check is informational; the supported creation tool performs
  // independent live Xero identity/duplicate checks and validates the original PDF.
  if (review.xero_draft_id || review.xero_draft_status) {
    reasons.push("Existing Xero link or previous attempt requires reconciliation");
  }
  if (!["invoice", "credit_note"].includes(review.document_type)) {
    reasons.push("Not a supplier invoice or credit note");
  }
  if (!assessment || typeof assessment !== "object" || Array.isArray(assessment)) {
    reasons.push("Assessment is invalid");
  } else {
    if (!validDate(assessment.invoice_date)) reasons.push("Valid invoice date missing");
    const gross = amountInPence(Math.abs(assessment.gross_gbp));
    if (gross === null || gross <= 0) reasons.push("Valid gross amount missing");
  }
  if (!review.supplier_name?.trim() || !review.invoice_number?.trim()) {
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
  const response = await xeroFetch(
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

  const response = await xeroFetch(url, {
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

export async function originalFrontDocument(
  invoice: Pick<
    DraftInvoice,
    "conversationId" | "messageId" | "attachmentId"
  >
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
  const inboxResponse = await xeroFetch(
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
  const messagesResponse = await xeroFetch(
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

  const originalFilename=attachment.filename;
  if (!originalFilename || originalFilename.length > 250 || originalFilename === "." || originalFilename === "..")
    throw new Error("Original attachment filename missing or invalid");
  // Front may supply filenames with apostrophes, brackets or Unicode. These are
  // not evidence of an unsafe invoice. Sanitize the Xero attachment display name,
  // but preserve and verify the original bytes and extension below.
  const filename=originalFilename.replace(/[^A-Za-z0-9._ -]/g,"_").replace(/^[^A-Za-z0-9]+/,"file_").slice(0,150);
  if (!filename || filename === "." || filename === "..")
    throw new Error("Original attachment filename cannot be safely represented");

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

  const response = await xeroFetch(
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

  const response = await xeroFetch(
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

export async function attachAndVerifyOriginal(
  tenantId: string,
  accessToken: string,
  draftId: string,
  filename: string,
  contentType: string,
  bytes: Buffer,
  documentKind: "Invoices" | "CreditNotes" = "Invoices"
): Promise<void> {
  const attachmentUrl =
    `https://api.xero.com/api.xro/2.0/${documentKind}/${
      encodeURIComponent(draftId)
    }/Attachments/${encodeURIComponent(filename)}`;

  const upload = await xeroFetch(attachmentUrl, {
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
    `${documentKind}/${encodeURIComponent(draftId)}/Attachments`,
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
// Supplier-specific approved policies have been removed. Automated drafts
// must remain blocked until historical coding evidence can be validated.
export async function createPilotDraftWithPdf(
  _pool: Pool,
  _reviewId: string,
  _legacyAccountCode?: string,
  _legacyTaxType?: string
): Promise<DraftResult> {
  throw new Error(
    "Automated draft creation blocked: historical coding validation is not implemented"
  );
}
