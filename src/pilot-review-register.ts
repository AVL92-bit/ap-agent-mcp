import type { Pool, PoolClient } from "pg";

export type PilotReviewStatus =
  | "awaiting_review"
  | "on_hold"
  | "approved_for_manual_entry"
  | "rejected"
  | "completed";

export interface PilotReviewRecord {
  frontConversationId: string;
  frontMessageId: string;
  attachmentId: string;
  supplierName?: string;
  invoiceNumber?: string;
  documentType?: string;
  assessmentJson: Record<string, unknown>;
}

export async function ensurePilotReviewRegister(
  pool: Pool
): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pilot_invoice_reviews (
      id BIGSERIAL PRIMARY KEY,
      front_conversation_id TEXT NOT NULL,
      front_message_id TEXT NOT NULL,
      attachment_id TEXT NOT NULL,
      supplier_name TEXT,
      invoice_number TEXT,
      document_type TEXT,
      assessment_json JSONB NOT NULL,
      review_status TEXT NOT NULL DEFAULT 'awaiting_review',
      reviewed_by TEXT,
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT pilot_invoice_reviews_attachment_unique
        UNIQUE (front_message_id, attachment_id),

      CONSTRAINT pilot_invoice_reviews_status_check
        CHECK (
          review_status IN (
            'awaiting_review',
            'on_hold',
            'approved_for_manual_entry',
            'rejected',
            'completed'
          )
        )
    )
`);

  // Add draft-tracking fields to existing pilot databases.
  // Existing assessments and review statuses are preserved.
  await pool.query(`
    ALTER TABLE pilot_invoice_reviews
      ADD COLUMN IF NOT EXISTS xero_draft_id TEXT,
      ADD COLUMN IF NOT EXISTS xero_draft_status TEXT,
      ADD COLUMN IF NOT EXISTS xero_attachment_verified BOOLEAN
        NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS xero_draft_error TEXT,
      ADD COLUMN IF NOT EXISTS xero_draft_updated_at TIMESTAMPTZ
  `);
  // Preserve existing human holds from the pilot Google Sheet.
  // These attachments must not be processed into Xero drafts.
  await pool.query(
    `
      UPDATE pilot_invoice_reviews
      SET review_status = 'on_hold',
          updated_at = NOW()
      WHERE (front_message_id, attachment_id) IN (
        ('msg_2ighxw0m', 'fil_4za3pfva'),
        ('msg_2ihh8owm', 'fil_4ze0zmvq')
      )
        AND review_status = 'awaiting_review'
    `
  );
  // One Xero draft must never be linked to multiple assessments.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
      pilot_invoice_reviews_xero_draft_unique
    ON pilot_invoice_reviews (xero_draft_id)
    WHERE xero_draft_id IS NOT NULL
  `);
  // Store subsequent verification separately from the original
  // assessment. Never overwrite the original evidence or decisions.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pilot_invoice_verifications (
      id BIGSERIAL PRIMARY KEY,
      review_id BIGINT NOT NULL
        REFERENCES pilot_invoice_reviews(id),
      verification_type TEXT NOT NULL
        CHECK (
          verification_type IN (
            'supplier',
            'duplicate',
            'billing_entity',
            'invoice_dates',
            'amounts',
            'coding'
          )
        ),
      outcome TEXT NOT NULL
        CHECK (outcome IN ('verified', 'blocked')),
      evidence_json JSONB NOT NULL,
      verified_by TEXT NOT NULL,
      verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
      pilot_invoice_verifications_review_idx
    ON pilot_invoice_verifications (
      review_id,
      verification_type,
      verified_at DESC,
      id DESC
    )
  `);
}

export async function findExistingPilotReview(
  pool: Pool,
  frontMessageId: string,
  attachmentId: string
): Promise<{
  id: string;
  review_status: PilotReviewStatus;
} | null> {
  const result = await pool.query<{
    id: string;
    review_status: PilotReviewStatus;
  }>(
    `
      SELECT id::text, review_status
      FROM pilot_invoice_reviews
      WHERE front_message_id = $1
        AND attachment_id = $2
      LIMIT 1
    `,
    [frontMessageId, attachmentId]
  );

  return result.rows[0] ?? null;
}

export async function recordPilotAssessment(
  pool: Pool | PoolClient,
  record: PilotReviewRecord
): Promise<{
  id: string;
  created: boolean;
  review_status: PilotReviewStatus;
}> {
  const result = await pool.query<{
    id: string;
    review_status: PilotReviewStatus;
  }>(
    `
      INSERT INTO pilot_invoice_reviews (
        front_conversation_id,
        front_message_id,
        attachment_id,
        supplier_name,
        invoice_number,
        document_type,
        assessment_json
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (front_message_id, attachment_id)
      DO NOTHING
      RETURNING id::text, review_status
    `,
    [
      record.frontConversationId,
      record.frontMessageId,
      record.attachmentId,
      record.supplierName ?? null,
      record.invoiceNumber ?? null,
      record.documentType ?? null,
      JSON.stringify(record.assessmentJson),
    ]
  );

  if (result.rows[0]) {
    return {
      ...result.rows[0],
      created: true,
    };
  }

  const existing = await pool.query<{
    id: string;
    review_status: PilotReviewStatus;
  }>(
    `
      SELECT id::text, review_status
      FROM pilot_invoice_reviews
      WHERE front_message_id = $1
        AND attachment_id = $2
      LIMIT 1
    `,
    [record.frontMessageId, record.attachmentId]
  );

  if (!existing.rows[0]) {
    throw new Error(
      "Assessment was not inserted and no existing record was found."
    );
  }

  return {
    ...existing.rows[0],
    created: false,
  };
}
export async function claimPilotDraft(
  pool: Pool,
  reviewId: string
): Promise<boolean> {
  const result = await pool.query(
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

  return result.rowCount === 1;
}
export type PilotVerificationType =
  | "supplier"
  | "duplicate"
  | "billing_entity"
  | "invoice_dates"
  | "amounts"
  | "coding";

export interface PilotVerification {
  id: string;
  verification_type: PilotVerificationType;
  outcome: "verified" | "blocked";
  evidence_json: Record<string, unknown>;
  verified_by: string;
  verified_at: Date;
}

export async function getLatestPilotVerifications(
  pool: Pool,
  reviewId: string
): Promise<PilotVerification[]> {
  if (!/^[0-9]{1,30}$/.test(reviewId)) {
    throw new Error("Invalid review ID");
  }

  const result = await pool.query<PilotVerification>(
    `
      SELECT DISTINCT ON (verification_type)
        id::text AS id,
        verification_type,
        outcome,
        evidence_json,
        verified_by,
        verified_at
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
