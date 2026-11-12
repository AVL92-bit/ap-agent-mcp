/** Background jobs for long inbox runs. A run (dry or live) can take minutes: model
 * extraction and rate-limited Xero reads per document. The tool starts the job and
 * returns its id at once; the caller polls with the id. Results stay in memory for the
 * life of the server process (a redeploy clears them; a live run's writes are durable). */
import { randomUUID } from 'node:crypto';

export type RunJob = {
  id: string; kind: 'dry_run' | 'execute'; status: 'running' | 'completed' | 'failed';
  started_at: string; finished_at?: string; progress?: string; result?: unknown; error?: string;
};
const jobs = new Map<string, RunJob>();
const MAX_JOBS = 20;

export function startRunJob(kind: RunJob['kind'], work: (progress: (p: string) => void) => Promise<unknown>): RunJob {
  if (kind === 'execute' && [...jobs.values()].some(j => j.kind === 'execute' && j.status === 'running'))
    throw new Error('A live inbox run is already in progress');
  const job: RunJob = { id: `job_${randomUUID()}`, kind, status: 'running', started_at: new Date().toISOString() };
  jobs.set(job.id, job);
  while (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value!);
  void work(p => { job.progress = p; })
    .then(result => { job.status = 'completed'; job.result = result; })
    .catch(error => { job.status = 'failed'; job.error = error instanceof Error ? error.message : String(error); })
    .finally(() => { job.finished_at = new Date().toISOString(); });
  return job;
}
export function getRunJob(id: string): RunJob | undefined { return jobs.get(id); }
export function listRunJobs(): RunJob[] { return [...jobs.values()].map(({ result, ...rest }) => rest as RunJob); }
