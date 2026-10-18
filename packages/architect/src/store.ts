// packages/architect/src/store.ts: desires and their evidence on the control plane (v3 §8: desires, desire_chapters).
import type postgres from 'postgres';

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;
const inTenant = <T>(db: Sql, tenantId: string, fn: (tx: Tx) => Promise<T>) =>
  db.begin(async (tx) => { await tx`select set_config('app.tenant_id', ${tenantId}, true)`; return fn(tx); }) as Promise<T>;

export type DesireSource = 'owner_request' | 'failure_cluster' | 'developer_note' | 'kpi_drift';
export interface OpenDesire { id: string; number: number; statement: string; source: DesireSource; occurrences: number }
export interface Evidence { kind: 'owner_message' | 'failure'; at: string; text?: string; membership_id?: string; failure_id?: number; turn_id?: string }

export interface DesireStore {
  open(tenantId: string): Promise<OpenDesire[]>;
  create(tenantId: string, d: { source: DesireSource; statement: string; evidence: Evidence }): Promise<OpenDesire>;
  addEvidence(tenantId: string, desireId: string, e: Evidence): Promise<OpenDesire>;
  linkChapter(tenantId: string, desireId: string, chapterId: string, p: number): Promise<void>;
  assignFailure(tenantId: string, failureId: number, desireId: string): Promise<void>;
  remove(tenantId: string, desireId: string): Promise<void>;
}

export function desireStore(control: Sql): DesireStore {
  const cols = 'id, number, statement, source, occurrences';
  return {
    open: (tenantId) => inTenant(control, tenantId, (tx) => tx<OpenDesire[]>`select ${tx.unsafe(cols)} from public.desires
      where tenant_id = ${tenantId} and status in ('open', 'drafting') order by number`),
    create: (tenantId, d) => inTenant(control, tenantId, async (tx) => (await tx<OpenDesire[]>`
      insert into public.desires (tenant_id, source, statement, evidence)
      values (${tenantId}, ${d.source}, ${d.statement}, ${tx.json([d.evidence] as never)}) returning ${tx.unsafe(cols)}`)[0]!),
    addEvidence: (tenantId, desireId, e) => inTenant(control, tenantId, async (tx) => (await tx<OpenDesire[]>`
      update public.desires set evidence = evidence || ${tx.json([e] as never)}, occurrences = occurrences + 1, updated_at = now()
       where tenant_id = ${tenantId} and id = ${desireId} returning ${tx.unsafe(cols)}`)[0]!),
    linkChapter: (tenantId, desireId, chapterId, p) => inTenant(control, tenantId, async (tx) => {
      await tx`insert into public.desire_chapters (tenant_id, desire_id, chapter_id, linked_by, p)
               values (${tenantId}, ${desireId}, ${chapterId}, 'jev:desire.dedupe', ${p}) on conflict do nothing`;
    }),
    assignFailure: (tenantId, failureId, desireId) => inTenant(control, tenantId, async (tx) => {
      await tx`update public.failures set desire_id = ${desireId} where tenant_id = ${tenantId} and id = ${failureId}`;
    }),
    remove: (tenantId, desireId) => inTenant(control, tenantId, async (tx) => {
      await tx`delete from public.desires where tenant_id = ${tenantId} and id = ${desireId}`;
    }),
  };
}
