/**
 * Daily scheduled inbox run inside the server (no second service). Enabled by
 * AP_SCHEDULE_LONDON_TIME=HH:MM (UK local time, follows GMT/BST) plus AP_INBOX_RUNNER_ENABLED=true.
 * Optional AP_SCHEDULE_DAYS, e.g. "Mon,Tue,Wed,Thu,Fri" (default: every day).
 * Each London date runs at most once: the date is claimed in PostgreSQL before starting, so
 * restarts and multiple instances cannot double-run. A server that was down at the scheduled
 * time runs when it comes back, the same day.
 */
import type { Pool } from 'pg';

export type LondonNow = { date: string; time: string; weekday: string };
export function londonNow(at: Date = new Date()): LondonNow {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(at).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, weekday: String(parts.weekday) };
}
export function isDue(now: LondonNow, scheduled: string, days?: string): boolean {
  if (!/^\d{2}:\d{2}$/.test(scheduled)) return false;
  if (days && !days.split(',').map(d => d.trim().slice(0, 3).toLowerCase()).includes(now.weekday.slice(0, 3).toLowerCase())) return false;
  return now.time >= scheduled;
}

export async function ensureScheduleTable(pool: Pool): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS ap_scheduled_runs (
    run_date date PRIMARY KEY, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
    status text NOT NULL DEFAULT 'running', summary jsonb)`);
}
export async function recentScheduledRuns(pool: Pool, limit = 14): Promise<unknown[]> {
  await ensureScheduleTable(pool);
  return (await pool.query('SELECT run_date::text, started_at, finished_at, status, summary FROM ap_scheduled_runs ORDER BY run_date DESC LIMIT $1', [limit])).rows;
}

/** Summary kept for each scheduled run (counts only, no document contents). */
export function summariseRun(result: Record<string, any>): Record<string, unknown> {
  const items: any[] = Array.isArray(result.items) ? result.items : [];
  return { conversations: result.conversations ?? items.length, documents: result.documents ?? null, archived: result.archived ?? null,
    left_open: items.filter(i => !i.archived).length, failures: items.reduce((n, i) => n + (i.failures?.length ?? 0), 0),
    stopped_early: result.stoppedEarly ?? null, sheet_outbox: result.sheet_outbox ?? null };
}

export function startDailySchedule(deps: { pool: () => Pool; run: (progress: (m: string) => void) => Promise<Record<string, any>> }): void {
  const scheduled = process.env.AP_SCHEDULE_LONDON_TIME?.trim();
  if (!scheduled) { console.log('Daily AP schedule off (AP_SCHEDULE_LONDON_TIME not set)'); return; }
  if (process.env.AP_INBOX_RUNNER_ENABLED !== 'true') { console.log('Daily AP schedule off (AP_INBOX_RUNNER_ENABLED is not true)'); return; }
  if (!/^\d{2}:\d{2}$/.test(scheduled)) { console.error(`Daily AP schedule off: AP_SCHEDULE_LONDON_TIME "${scheduled}" is not HH:MM`); return; }
  const days = process.env.AP_SCHEDULE_DAYS?.trim() || undefined;
  console.log(`Daily AP schedule on: ${scheduled} UK time${days ? ` on ${days}` : ' every day'}`);
  let busy = false;
  const tick = async () => {
    if (busy) return;
    const now = londonNow();
    if (!isDue(now, scheduled, days)) return;
    busy = true;
    const pool = deps.pool();
    try {
      await ensureScheduleTable(pool);
      const claim = await pool.query('INSERT INTO ap_scheduled_runs(run_date) VALUES($1) ON CONFLICT DO NOTHING RETURNING run_date', [now.date]);
      if (!claim.rowCount) return; // already ran (or is running) today
      console.log(`Scheduled AP run started for ${now.date}`);
      try {
        const result = await deps.run(m => console.log(`Scheduled AP run: ${m}`));
        const summary = summariseRun(result);
        await pool.query(`UPDATE ap_scheduled_runs SET finished_at=now(), status=$2, summary=$3 WHERE run_date=$1`,
          [now.date, summary.stopped_early ? 'stopped_early' : 'completed', JSON.stringify(summary)]);
        console.log(`Scheduled AP run finished ${JSON.stringify(summary)}`);
      } catch (error) {
        await pool.query(`UPDATE ap_scheduled_runs SET finished_at=now(), status='failed', summary=$2 WHERE run_date=$1`,
          [now.date, JSON.stringify({ error: String(error).slice(0, 500) })]).catch(() => {});
        console.error('Scheduled AP run failed', String(error));
      }
    } catch (error) {
      console.error('Scheduled AP run check failed', String(error));
    } finally { busy = false; }
  };
  setInterval(() => { void tick(); }, 60_000).unref?.();
  setTimeout(() => { void tick(); }, 30_000).unref?.();
}
