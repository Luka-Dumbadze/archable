// packages/gateway/src/executors.ts: the in-process implementations of the spec's tools (v3 §6), behind the gateway.
// They run only after Cedar allowed the call, as archable_runtime under the tenant's RLS context. Prices always come
// from records, never from the model: a quote reprices every line from its wine.
import type { Bundle } from '@archable/compiler';
import type { InTenant, Tx } from './db';
import type { Executor, ToolOutput } from './gateway';

type Line = { wine: string; qty: number; unit_price?: number };
type Row = { id: string; natural_key: string | null; attrs: Record<string, unknown> };

// The express surcharge is the `…express.surcharge` param order.quote declares in its reads (v3 §6), in tetri.
const expressSurcharge = (b: Bundle): number => {
  const path = b.tools['order.quote']?.reads.find((r) => r.endsWith('express.surcharge'));
  const enabled = path ? b.params[path.replace(/\.surcharge$/, '.enabled')] : undefined;
  return path && enabled !== false ? Number(b.params[path] ?? 0) : 0;
};

export function createExecutors(inTenant: InTenant): Record<string, Executor> {
  const surchargeOf = expressSurcharge;

  async function price(tx: Tx, tenantId: string, env: string, lines: Line[], delivery: string, discountPct: number, bundle: Bundle) {
    const skus = [...new Set(lines.map((l) => l.wine))];
    const wines = await tx<Row[]>`select id, natural_key, attrs from public.records
                                   where tenant_id = ${tenantId} and env = ${env} and entity_type = 'wine' and natural_key in ${tx(skus)}`;
    const bySku = new Map(wines.map((w) => [w.natural_key!, w.attrs]));
    const priced = lines.map((l) => {
      const w = bySku.get(l.wine);
      if (!w) throw new Error(`unknown wine ${l.wine}`);
      if (typeof w.stock === 'number' && w.stock < l.qty) throw new Error(`only ${w.stock} of ${l.wine} in stock`);
      return { wine: l.wine, qty: l.qty, unit_price: Number(w.price) };
    });
    const subtotal = priced.reduce((s, l) => s + l.qty * l.unit_price, 0);
    const surcharge = delivery === 'express' ? surchargeOf(bundle) : 0;
    // order.total: sum(lines.qty * unit_price) * (100 - discount_pct) / 100 + surcharge, in tetri
    return { lines: priced, surcharge, total: Math.round((subtotal * (100 - discountPct)) / 100) + surcharge };
  }

  const quote: Executor = (input, c) => inTenant(c.tenantId, async (tx) => {
    const q = await price(tx, c.tenantId, c.env, input.lines as Line[], String(input.delivery), Number(input.discount_pct ?? 0), c.bundle);
    return { surcharge: q.surcharge, total: q.total };
  });

  return {
    'catalog.search': (input, c) => inTenant(c.tenantId, async (tx) => {
      const q: string | null = typeof input.query === 'string' && input.query.trim() ? `%${input.query.trim()}%` : null;
      const grape: string | null = typeof input.grape === 'string' ? input.grape : null;
      const maxPrice: number | null = typeof input.max_price === 'number' ? input.max_price : null;
      const rows: Row[] = await tx<Row[]>`
        select id, natural_key, attrs from public.records
         where tenant_id = ${c.tenantId} and env = ${c.env} and entity_type = 'wine'
           and (${q}::text is null or attrs ->> 'label' ilike ${q} or natural_key ilike ${q} or attrs ->> 'grape' ilike ${q})
           and (${grape}::text is null or attrs ->> 'grape' = ${grape})
           and (${maxPrice}::bigint is null or (attrs ->> 'price')::bigint <= ${maxPrice})
         order by attrs ->> 'label' limit 10`;
      return { items: rows.map((r) => r.attrs) };
    }),

    'order.quote': quote,

    'order.create': (input, c) => inTenant(c.tenantId, async (tx) => {
      const q = await price(tx, c.tenantId, c.env, input.lines as Line[], String(input.delivery), Number(input.discount_pct ?? 0), c.bundle);
      const seq = await tx<{ n: number }[]>`select count(*)::int + 1 as n from public.records
                                             where tenant_id = ${c.tenantId} and env = ${c.env} and entity_type = 'order'`;
      const n = seq[0]!.n;
      const number = `M-${String(n).padStart(5, '0')}`;                // objects.order.fields.number: generated "M-{seq:5}"
      const attrs = { number, customer: input.customer, lines: q.lines, delivery: input.delivery, payment: input.payment,
                      discount_pct: Number(input.discount_pct ?? 0), surcharge: q.surcharge, total: q.total, status: 'draft' };
      const [row] = await tx<{ id: string }[]>`insert into public.records (tenant_id, env, entity_type, attrs, spec_digest, created_by)
        values (${c.tenantId}, ${c.env}, 'order', ${tx.json(attrs as never)}, ${c.digest}, 'agent') returning id`;
      return { order: { id: row!.id, number, total: q.total, status: 'draft' } };
    }),

    'customer.upsert': (input, c) => inTenant(c.tenantId, async (tx) => {
      const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== null));
      const [existing] = await tx<Row[]>`select id, natural_key, attrs from public.records
        where tenant_id = ${c.tenantId} and env = ${c.env} and entity_type = 'customer' and natural_key = ${String(input.phone)}`;
      if (existing) {
        await tx`update public.records set attrs = ${tx.json({ ...existing.attrs, ...patch } as never)}, spec_digest = ${c.digest}
                  where tenant_id = ${c.tenantId} and id = ${existing.id}`;
        return { customer: { id: existing.id, created: false } };
      }
      const [row] = await tx<{ id: string }[]>`insert into public.records (tenant_id, env, entity_type, attrs, spec_digest, created_by)
        values (${c.tenantId}, ${c.env}, 'customer', ${tx.json({ name: '', ...patch } as never)}, ${c.digest}, 'agent') returning id`;
      return { customer: { id: row!.id, created: true } };
    }),

    'delivery.status': (input, c) => inTenant(c.tenantId, async (tx) => {
      const [job] = await tx<{ attrs: Record<string, unknown> }[]>`
        select j.attrs from public.records o
          join public.records j on j.tenant_id = o.tenant_id and j.env = o.env and j.entity_type = 'delivery_job' and j.attrs ->> 'order' = o.id::text
         where o.tenant_id = ${c.tenantId} and o.env = ${c.env} and o.entity_type = 'order' and o.natural_key = ${String(input.order)}
         order by j.created_at desc limit 1`;
      return job ? { status: job.attrs.status, ...(job.attrs.eta ? { eta: job.attrs.eta } : {}) } : { status: 'queued' };
    }),

    // Staff are told through @ArchableBot in Phase 3; until then the tool_calls row is the handoff record.
    'handoff.staff': async () => ({ queued: true }),
  } satisfies Record<string, (i: Record<string, unknown>, c: Parameters<Executor>[1]) => Promise<ToolOutput>>;
}

/** The quote the gateway puts into context.quote for tools whose policies read it (order.create). */
export function createQuotes(executors: Record<string, Executor>) {
  return {
    price: (tenantId: string, pin: { env: import('@archable/contracts').Env; digest: string }, input: Record<string, unknown>, bundle: Bundle) =>
      executors['order.quote']!({ lines: input.lines, delivery: input.delivery, discount_pct: input.discount_pct }, { tenantId, env: pin.env, digest: pin.digest, bundle }),
  };
}
