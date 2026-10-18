// apps/api/src/desire-store.ts: DesireDeps on the control plane (desire_impact is control-only), in the member's tenant.
// The card's trigger and impact sections are rebuilt from desire_impact() after an unlink, so "What it costs" drops
// what the unlinked chat contributed; risk, changes and checks are kept from the change's frozen card, when there is one.
import type { DesireChat, DesireImpactView, DesireView, RationaleCard } from '@archable/contracts';
import { buildChangeRationale, type Labels } from '@archable/governance';
import type postgres from 'postgres';
import { withTenant } from './db';
import type { DesireDeps } from './routes/desires';

type Tx = postgres.TransactionSql;
type ImpactRow = Omit<DesireImpactView, 'abandoned_value' | 'first_seen' | 'last_seen'> & { abandoned_value: string | number; first_seen: Date | null; last_seen: Date | null };
interface DesireRow { id: string; number: number; statement: string; status: string; tier: number | null; source: 'owner_request' | 'failure_cluster' | 'developer_note' | 'kpi_drift';
                      rationale_card: RationaleCard | null; evidence: { kind?: string; at?: string; text?: string }[] }

const impactOf = (r: ImpactRow): DesireImpactView => ({
  chapters: r.chapters, customers: r.customers, quoted: r.quoted, abandoned: r.abandoned, abandoned_value: Number(r.abandoned_value), ordered: r.ordered,
  first_seen: r.first_seen?.toISOString() ?? null, last_seen: r.last_seen?.toISOString() ?? null,
});
// Trigger and impact sentences need no labels; the other sections are copied from the frozen card.
const NO_LABELS: Labels = { node: (id) => id, path: (p) => p, value: (_p, v) => String(v), isMoney: () => false, currency: 'GEL' };

async function view(tx: Tx, tenantId: string, d: DesireRow): Promise<DesireView> {
  const [impact] = await tx<ImpactRow[]>`select * from public.desire_impact(${tenantId}, ${d.id}, interval '2 hours')`;
  const chats = await tx<(Omit<DesireChat, 'opened_at' | 'last_quote_total'> & { opened_at: Date; last_quote_total: string | null })[]>`
    select c.id as chapter_id, coalesce(nullif(r.display_name, ''), r.attrs ->> 'name') as customer, c.opened_at, c.last_quote_total,
           c.order_id is not null as ordered, dc.linked_by,
           (select left(m.body, 140) from public.messages m where m.tenant_id = c.tenant_id and m.chapter_id = c.id and m.direction = 'in'
             order by m.id limit 1) as excerpt
      from public.desire_chapters dc
      join public.chapters c on c.tenant_id = dc.tenant_id and c.id = dc.chapter_id
      left join public.records r on r.tenant_id = c.tenant_id and r.id = c.customer_id
     where dc.tenant_id = ${tenantId} and dc.desire_id = ${d.id} and dc.unlinked_at is null
     order by c.opened_at`;
  return {
    id: d.id, number: d.number, statement: d.statement, status: d.status, tier: d.tier, impact: impactOf(impact!),
    chats: chats.map((x) => ({ ...x, opened_at: x.opened_at.toISOString(), last_quote_total: x.last_quote_total === null ? null : Number(x.last_quote_total) })),
    rationale_card: d.rationale_card,
  };
}

export function createDesireStore(control: postgres.Sql, memberFromJwt: DesireDeps['memberFromJwt']): DesireDeps {
  const cols = 'id, number, statement, status, tier, source, rationale_card, evidence';
  return {
    memberFromJwt,
    list: (tenantId) => withTenant(control, tenantId, async (tx) => {
      const rows = await tx<DesireRow[]>`select ${tx.unsafe(cols)} from public.desires where tenant_id = ${tenantId}
        and status not in ('declined') order by number desc limit 100`;
      const out: DesireView[] = [];
      for (const d of rows) out.push(await view(tx, tenantId, d));
      return out;
    }),
    unlink: (tenantId, desireId, chapterId, role) => withTenant(control, tenantId, async (tx) => {
      const [d] = await tx<DesireRow[]>`select ${tx.unsafe(cols)} from public.desires where tenant_id = ${tenantId} and id = ${desireId}`;
      if (!d) return null;
      const changed = await tx`update public.desire_chapters set unlinked_at = now(), linked_by = ${role}
        where tenant_id = ${tenantId} and desire_id = ${desireId} and chapter_id = ${chapterId} and unlinked_at is null returning chapter_id`;
      if (!changed.length) return null;
      // Recompute the card's numbers: trigger and impact from desire_impact() now; the rest from the frozen card.
      const v = await view(tx, tenantId, d);
      const [cr] = await tx<{ id: string; head_sha: string; rationale: RationaleCard | null }[]>`select id, head_sha, rationale from public.change_requests
        where tenant_id = ${tenantId} and desire_id = ${desireId} order by created_at desc limit 1`;
      const owner = d.evidence.find((e) => e.kind === 'owner_message' && e.at && e.text);
      const fresh = buildChangeRationale({
        changeRequestId: cr?.id ?? '', headSha: cr?.head_sha ?? '', desire: { number: d.number, source: d.source, statement: d.statement },
        ...(owner ? { ownerRequest: { at: owner.at!, text: owner.text! } } : {}), impact: v.impact, quietHours: 2, reasons: [], bounds: [], ops: [],
        verification: { suites: {}, new_cases: 0, elva_drift: 'unknown' }, labels: NO_LABELS, now: new Date().toISOString(),
      });
      const base = cr?.rationale ?? d.rationale_card;
      const card: RationaleCard = base ? { ...base, trigger: fresh.trigger, impact: fresh.impact, computed_at: fresh.computed_at }
                                       : { ...fresh, risk: [], action: [], verification: [] };
      await tx`update public.desires set rationale_card = ${tx.json(card as never)}, updated_at = now() where tenant_id = ${tenantId} and id = ${desireId}`;
      return { ...v, rationale_card: card };
    }),
  };
}
