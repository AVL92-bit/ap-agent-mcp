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
    connection.rows[0].tenant_name !==
      "St George's Road Surgery" ||
    connection.rows[0].enabled !== true
  ) {
    throw new Error("Xero pilot connection is not enabled");
  }
}
