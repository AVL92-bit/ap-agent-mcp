import type { Pool } from "pg";

const PILOT_TENANT_ID =
  "45a1074b-b172-4f49-a192-f0a8e293b54d";

const HELD_ATTACHMENTS = new Set([
  "msg_2ighxw0m:fil_4za3pfva",
  "msg_2ihh8owm:fil_4ze0zmvq",
]);

export async function assertPilotDraftAllowed(
  pool: Pool,
  reviewId: string
): Promise<void> {
  if (process.env.XERO_DRAFT_WRITES_ENABLED !== "true") {
    throw new Error("Xero draft writes are disabled");
  }

  if (process.env.XERO_PILOT_TENANT_ID !== PILOT_TENANT_ID) {
    throw new Error("Unexpected Xero pilot tenant");
  }

  const result = await pool.query(
    `
      SELECT
        front_message_id,
        attachment_id,
        document_type,
        review_status,
        xero_draft_id,
        xero_draft_status
      FROM pilot_invoice_reviews
      WHERE id = $1
    `,
    [reviewId]
  );

  if (result.rowCount !== 1) {
    throw new Error("Invoice review not found");
  }

  const review = result.rows[0];

if (
    HELD_ATTACHMENTS.has(
      `${review.front_message_id}:${review.attachment_id}`
    )
  ) {
    throw new Error("Invoice is subject to a human hold");
  }

  // Check the full saved invoice assessment before
  // permitting any draft-writing operation.
  const readiness = await getPilotDraftReadiness(
    pool,
    reviewId
  );

  if (readiness.status !== "ready_for_further_checks") {
    throw new Error(
      "Invoice failed mandatory draft readiness checks: " +
      readiness.reasons.join("; ")
    );
  }

  if (review.review_status !== "awaiting_review") {
    throw new Error("Invoice is not eligible for drafting");
  }

  if (review.document_type !== "invoice") {
    throw new Error("Document is not a supplier invoice");
  }

  if (
    review.xero_draft_id !== null ||
    review.xero_draft_status !== null
  ) {
    throw new Error(
      "Draft already exists or a creation attempt has been recorded"
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
    connection.rowCount !== 1 ||
    connection.rows[0].tenant_id !== PILOT_TENANT_ID ||
    connection.rows[0].tenant_name !==
      "St George's Road Surgery" ||
    connection.rows[0].enabled !== false
  ) {
    throw new Error(
      "Xero pilot connection is not in the expected supervised state"
    );
  }
}
export async function getPilotDraftReadiness(
  pool: Pool,
  reviewId: string
): Promise<{
  status: "blocked" | "ready_for_further_checks";
  review_id: string;
  reasons: string[];
}> {
  if (!/^[0-9]{1,30}$/.test(reviewId)) {
    throw new Error("Invalid review ID");
  }

  const result = await pool.query(
    `
      SELECT
        front_message_id,
        attachment_id,
        document_type,
        review_status,
        supplier_name,
        invoice_number,
        assessment_json,
        xero_draft_id,
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
    if (
      assessment.billed_to !== "St George's Road Surgery"
    ) {
      reasons.push("Billing entity not verified");
    }

    if (
      !Array.isArray(assessment.exceptions) ||
      assessment.exceptions.length !== 0
    ) {
      reasons.push("Assessment has unresolved exceptions");
    }

    const net = assessment.net_gbp;
    const vat = assessment.vat_gbp;
    const gross = assessment.gross_gbp;

    if (
      typeof net !== "number" ||
      typeof vat !== "number" ||
      typeof gross !== "number" ||
      !Number.isFinite(net) ||
      !Number.isFinite(vat) ||
      !Number.isFinite(gross) ||
      net < 0 ||
      vat < 0 ||
      gross <= 0 ||
      Math.round(net * 100) + Math.round(vat * 100) !==
        Math.round(gross * 100)
    ) {
      reasons.push("Invoice amounts do not reconcile");
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
      reasons.length > 0
        ? "blocked"
        : "ready_for_further_checks",
    review_id: reviewId,
    reasons,
  };
}
