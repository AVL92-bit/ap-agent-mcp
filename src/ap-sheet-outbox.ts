import type { PoolClient } from 'pg';

export type ReviewRow = {
  conversationId:string; attachmentId:string; xeroId?:string; reason:string;
  outcome:'draft_uncertain'|'technical_failure'|'not_invoice'|'unclear'|'not_posted'|'supplier_missing'|'long_thread'; filename?:string; supplier?:string; extractedSupplier?:string; supplierMatchScore?:number; reference?:string; gross?:number;
  /** Company name for Sheet column L (set by the runner; absent on rows queued before multi-company support). */
  company?:string;
};
const TABLE_NAME=/^[a-z_]{3,40}$/;
const checkedTable=(table:string)=>{ if(!TABLE_NAME.test(table)) throw new Error('Invalid outbox table name'); return table; };
/** Persist before sending; replay pending rows on each runner invocation.
 * The Google Sheet writer's stable source key makes repeats idempotent when its
 * read succeeds. Cross-system exactly-once delivery is not guaranteed.
 * The same queue also carries the Front comments (their own table). */
export async function ensureApSheetOutbox(client:PoolClient, table:string='ap_sheet_outbox'):Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS ${checkedTable(table)} (
    source_key text PRIMARY KEY, payload jsonb NOT NULL,
    delivered_at timestamptz, attempts integer NOT NULL DEFAULT 0,
    last_error text, updated_at timestamptz NOT NULL DEFAULT now())`);
}
/** maxAttempts: after that many failed deliveries a row is given up on (marked done with the error kept), so one
 * permanently undeliverable item (e.g. a deleted conversation) never sits in "pending" forever. Default: never. */
export function makeApSheetOutbox(client:PoolClient, deliver:(row:ReviewRow)=>Promise<void>, table:string='ap_sheet_outbox', maxAttempts:number=Infinity) {
  const t=checkedTable(table);
  const key=(r:ReviewRow)=>`${r.conversationId}:${r.attachmentId}:${r.outcome}`;
  return {
    async enqueue(row:ReviewRow):Promise<void> {
      await client.query(`INSERT INTO ${t}(source_key,payload) VALUES($1,$2::jsonb)
        ON CONFLICT(source_key) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now()
        WHERE ${t}.delivered_at IS NULL`,[key(row),JSON.stringify(row)]);
    },
    async flush(limit=200):Promise<{delivered:number;failed:number;pending:number}> {
      const rows=await client.query(`SELECT source_key,payload,attempts FROM ${t}
        WHERE delivered_at IS NULL ORDER BY updated_at,source_key LIMIT $1`,[limit]);
      let delivered=0,failed=0;
      for (const entry of rows.rows as Array<{source_key:string;payload:ReviewRow;attempts?:number}>) {
        try {
          await deliver(entry.payload);
          await client.query(`UPDATE ${t} SET delivered_at=now(),attempts=attempts+1,last_error=NULL,updated_at=now()
            WHERE source_key=$1 AND delivered_at IS NULL`,[entry.source_key]);
          delivered++;
        } catch (error) {
          failed++;
          const message=String(error).slice(0,2000);
          console.warn(`Outbox delivery failed (${t}, attempt ${Number(entry.attempts??0)+1}): ${message.slice(0,300)}`);
          if (Number(entry.attempts??0)+1>=maxAttempts) {
            await client.query(`UPDATE ${t} SET delivered_at=now(),attempts=attempts+1,last_error=$2,updated_at=now()
              WHERE source_key=$1 AND delivered_at IS NULL`,[entry.source_key,`GAVE UP after ${maxAttempts} attempts: ${message}`.slice(0,2000)]);
          } else {
            await client.query(`UPDATE ${t} SET attempts=attempts+1,last_error=$2,updated_at=now()
              WHERE source_key=$1 AND delivered_at IS NULL`,[entry.source_key,message]);
          }
        }
      }
      const remaining=await client.query(`SELECT count(*)::int AS n FROM ${t} WHERE delivered_at IS NULL`);
      return {delivered,failed,pending:Number(remaining.rows[0]?.n??0)};
    },
  };
}
