// apps/api/src/queue-drain.ts: the pgmq drain behind /v1/cron/drain (v3 §8, plan §3.3). Each tick reads the
// 'architect' and 'verify' queues on the control plane and the 'triggers' queue on the runtime plane, handles each
// job and archives it. Enqueuers also start a drain right away (kick, inside waitUntil), so the first job doesn't
// wait for the tick; one drain runs per instance, and pgmq's visibility timeout keeps instances off each other's jobs.
import { runDraftJob, runVerifyJob, type AuthorDeps, type DraftJob, type VerifyJob } from '@archable/architect';
import type postgres from 'postgres';

type Sql = postgres.Sql;
export const VISIBILITY_S = 900;                     // longer than a draft can take (reproduce, 2 patch attempts, evals)
export const MAX_READS = 3;                          // a job that failed this often is archived as dead

export interface DrainDeps {
  control: Sql;
  author: AuthorDeps;
  triggers?(qty: number): Promise<unknown[]>;        // P3.D2.3's trigger drain
  log(event: string, data: Record<string, unknown>): void;
}
export interface DrainReport { architect: unknown[]; verify: unknown[]; triggers: number }

type Row = { msg_id: string; read_ct: number; message: Record<string, unknown> };

// A dropped connection (database, GitHub, a model) during a long draft: retried at once, not after the visibility
// timeout. Expected outcomes never throw, so only infrastructure errors reach here.
const TRANSIENT = /ECONNRESET|ETIMEDOUT|EPIPE|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|other side closed/i;
const isTransient = (e: unknown) => TRANSIENT.test(`${String(e)} ${String((e as { code?: unknown })?.code ?? '')} ${String((e as { cause?: unknown })?.cause ?? '')}`);
const IMMEDIATE_RETRIES = 2;

export function createQueueDrainer(d: DrainDeps) {
  let running: Promise<DrainReport> | null = null;

  async function queue(name: 'architect' | 'verify', handle: (job: Record<string, unknown>) => Promise<{ outcome: string; retry?: boolean }>) {
    const out: unknown[] = [];
    for (;;) {
      const [job] = await d.control<Row[]>`select * from private.queue_read(${name}, 1, ${VISIBILITY_S})`;
      if (!job) return out;
      const archive = () => d.control`select private.queue_archive(${name}, ${job.msg_id})`;
      const attempt = async () => {
        for (let i = 0; ; i++) {
          try { return await handle(job.message); } catch (e) {
            if (i >= IMMEDIATE_RETRIES || !isTransient(e)) throw e;
            d.log('queue.job_retry', { queue: name, msg: job.msg_id, attempt: i + 1, error: String(e), stack: (e as Error)?.stack?.split('\n').slice(0, 6).join(' | ') });
          }
        }
      };
      try {
        const r = await attempt();
        d.log('queue.job', { queue: name, msg: job.msg_id, kind: job.message.kind, ...r });
        if (!r.retry) await archive();                               // a retry comes back after the visibility timeout
        out.push({ msg: Number(job.msg_id), ...r });
      } catch (e) {
        const dead = job.read_ct >= MAX_READS;
        d.log('queue.job_failed', { queue: name, msg: job.msg_id, kind: job.message.kind, reads: job.read_ct, dead, error: String(e),
                                    stack: (e as Error)?.stack?.split('\n').slice(0, 6).join(' | ') });
        if (dead) await archive();
        out.push({ msg: Number(job.msg_id), outcome: dead ? 'dead' : 'failed', error: String(e) });
        if (!dead) return out;                                       // leave the rest for the next tick
      }
    }
  }

  async function drainOnce(): Promise<DrainReport> {
    const architect = await queue('architect', (j) => j.kind === 'draft' ? runDraftJob(d.author, j as unknown as DraftJob)
      : Promise.resolve({ outcome: 'unknown_kind' }));
    const verify = await queue('verify', (j) => j.kind === 'verify' ? runVerifyJob(d.author, j as unknown as VerifyJob)
      : Promise.resolve({ outcome: 'unknown_kind' }));
    const triggers = d.triggers ? (await d.triggers(10)).length : 0;
    return { architect, verify, triggers };
  }

  /** One drain per instance: a kick during a drain joins it. */
  return function drain(): Promise<DrainReport> {
    running ??= drainOnce().finally(() => { running = null; });
    return running;
  };
}
