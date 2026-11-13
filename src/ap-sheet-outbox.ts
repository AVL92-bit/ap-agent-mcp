import type { PoolClient } from 'pg';

export type ReviewRow = {
  conversationId:string; attachmentId:string; xeroId?:string; reason:string;
  outcome:'draft_uncertain'|'technical_failure'|'not_invoice'|'unclear'|'not_posted'; filename?:string; supplier?:string; extractedSupplier?:string; supplierMatchScore?:number; reference?:string; gross?:number;
};
/** Persist before sending; replay pending rows on each runner invocation.
 * The Google Sheet writer's stable source key makes repeats idempotent when its
 * read succeeds. Cross-system exactly-once delivery is not guaranteed. */
export async function ensureApSheetOutbox(client:PoolClient):Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS ap_sheet_outbox (
    source_key text PRIMARY KEY, payload jsonb NOT NULL,
    delivered_at timestamptz, attempts integer NOT NULL DEFAULT 0,
    last_error text, updated_at timestamptz NOT NULL DEFAULT now())`);
}
export function makeApSheetOutbox(client:PoolClient, deliver:(row:ReviewRow)=>Promise<void>) {
  const key=(r:ReviewRow)=>`${r.conversationId}:${r.attachmentId}:${r.outcome}`;
  return {
    async enqueue(row:ReviewRow):Promise<void> {
      await client.query(`INSERT INTO ap_sheet_outbox(source_key,payload) VALUES($1,$2::jsonb)
        ON CONFLICT(source_key) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now()
        WHERE ap_sheet_outbox.delivered_at IS NULL`,[key(row),JSON.stringify(row)]);
    },
    async flush(limit=200):Promise<{delivered:number;failed:number;pending:number}> {
      const rows=await client.query(`SELECT source_key,payload FROM ap_sheet_outbox
        WHERE delivered_at IS NULL ORDER BY updated_at,source_key LIMIT $1`,[limit]);
      let delivered=0,failed=0;
      for (const entry of rows.rows as Array<{source_key:string;payload:ReviewRow}>) {
        try {
          await deliver(entry.payload);
          await client.query(`UPDATE ap_sheet_outbox SET delivered_at=now(),attempts=attempts+1,last_error=NULL,updated_at=now()
            WHERE source_key=$1 AND delivered_at IS NULL`,[entry.source_key]);
          delivered++;
        } catch (error) {
          failed++;
          await client.query(`UPDATE ap_sheet_outbox SET attempts=attempts+1,last_error=$2,updated_at=now()
            WHERE source_key=$1 AND delivered_at IS NULL`,[entry.source_key,String(error).slice(0,2000)]);
        }
      }
      const remaining=await client.query('SELECT count(*)::int AS n FROM ap_sheet_outbox WHERE delivered_at IS NULL');
      return {delivered,failed,pending:Number(remaining.rows[0]?.n??0)};
    },
  };
}
