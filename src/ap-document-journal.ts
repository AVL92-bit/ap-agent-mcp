import type { PoolClient } from 'pg';

/** Persistent, per-source attachment record. Never treats a prior record as proof
 * of Xero completion: every retry still reconciles the original PDF in Xero. */
export function makeApDocumentJournal(client: PoolClient) {
  return {
    /** Outcome of an earlier run for this attachment, if any. */
    async previous(conversationId: string, attachmentId: string): Promise<{status:string; xeroId:string|null}|null> {
      const r = await client.query(`SELECT status, xero_id FROM ap_document_journal WHERE conversation_id=$1 AND attachment_id=$2`,[conversationId,attachmentId]);
      return r.rowCount ? {status:String(r.rows[0].status),xeroId:r.rows[0].xero_id??null} : null;
    },
    async begin(conversationId: string, attachmentId: string, sha256: string): Promise<void> {
      if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid source digest');
      const result = await client.query(`INSERT INTO ap_document_journal
        (conversation_id,attachment_id,source_sha256,status,updated_at)
        VALUES ($1,$2,$3,'processing',now())
        ON CONFLICT (conversation_id,attachment_id) DO UPDATE SET
          status='processing',updated_at=now()
        WHERE ap_document_journal.source_sha256=EXCLUDED.source_sha256
        RETURNING attachment_id`,[conversationId,attachmentId,sha256]);
      if (result.rowCount !== 1) throw new Error('Source attachment changed since prior attempt; manual reconciliation required');
    },
    async claimCreate(conversationId:string,attachmentId:string):Promise<boolean> {
      // Commit this claim before issuing the Xero POST. Never reset it on a retry.
      const result=await client.query(`UPDATE ap_document_journal SET write_intent=true,updated_at=now()
        WHERE conversation_id=$1 AND attachment_id=$2 AND write_intent=false
        RETURNING attachment_id`,[conversationId,attachmentId]);
      return result.rowCount===1;
    },
    async complete(conversationId:string,attachmentId:string,status:string,xeroId?:string):Promise<void> {
      if (!['existing_verified','draft_verified','draft_uncertain','technical_failure'].includes(status)) throw new Error('Invalid journal outcome');
      const result = await client.query(`UPDATE ap_document_journal SET status=$3,xero_id=COALESCE($4,xero_id),updated_at=now()
        WHERE conversation_id=$1 AND attachment_id=$2 RETURNING attachment_id`,[conversationId,attachmentId,status,xeroId??null]);
      if (result.rowCount !== 1) throw new Error('Missing source journal record');
    },
  };
}
export async function ensureApDocumentJournal(client:PoolClient):Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS ap_document_journal (
    conversation_id text NOT NULL, attachment_id text NOT NULL,
    source_sha256 char(64) NOT NULL, status text NOT NULL,
    xero_id text, write_intent boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(conversation_id,attachment_id))`);
  await client.query(`ALTER TABLE ap_document_journal ADD COLUMN IF NOT EXISTS write_intent boolean NOT NULL DEFAULT false`);
}
