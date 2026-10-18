// packages/gateway/src/executors.ts: the in-process implementations of the spec's tools (v3 §6), behind the gateway.
// They run only after Cedar allowed the call, as archable_runtime under the tenant's RLS context. Prices always come
// from records, never from the model: a quote reprices every line from its wine.
import type { Bundle } from '@archable/compiler';
import type { InTenant, Tx } from './db';
import type { Executor, ToolOutput } from './gateway';

type Line = Record<string, unknown> & { qty: number; unit_price?: number };

/**
 * The catalog this bundle sells from: the object catalog.search reads ('wine' for Marani, 'product' for a shop), and
 * the field of an order line that refers to it ('wine', 'product'). Read from the bundle, so no tool names an object.
 */
export function catalogOf(b: Bundle): { object: string; lineField: string } {
  const object = (b.tools['catalog.search']?.reads[0] ?? 'wine.').split('.')[0]!;
  const items = (b.objects.order?.schema.properties as Record<string, { items?: { properties?: Record<string, { 'x-archable'?: { ref?: { object?: string } } }> } }> | undefined)
    ?.lines?.items?.properties ?? {};
  const lineField = Object.entries(items).find(([, p]) => p['x-archable']?.ref?.object === object)?.[0] ?? object;
  return { object, lineField };
}

/** DEV-1's sender (Deliver in @archable/runtime): Telegram bot, Business, web; returns the recorded messages.id. */
export type NotifyDeliver = (target: { kind: 'telegram'; channelId: string; botId: number; tokenSecret: string; chatId: number },
                             text: string, o: { suggestion: string | null }) => Promise<number>;

// customer.notify copy. The spec has none yet, so it is fixed per language like the holding reply; Georgian in Mkhedruli.
const NOTIFY: Record<string, Record<string, (number: string, eta: string | null) => string>> = {
  ka: {
    picked_up: (n, eta) => `კურიერმა თქვენი შეკვეთა ${n} აიღო${eta ? `, მოსალოდნელი მიტანა: ${eta}` : ''}.`,
    delivered: (n) => `თქვენი შეკვეთა ${n} მიტანილია. გმადლობთ!`,
    failed: (n) => `შეკვეთის ${n} მიტანა ვერ მოხერხდა. ჩვენი გუნდი მალე დაგიკავშირდებათ.`,
  },
  en: {
    picked_up: (n, eta) => `The courier has picked up your order ${n}${eta ? `; expected delivery: ${eta}` : ''}.`,
    delivered: (n) => `Your order ${n} has been delivered. Thank you!`,
    failed: (n) => `We couldn't deliver your order ${n}. Our team will contact you shortly.`,
  },
};
const BUSINESS_WINDOW_HOURS = 24;                             // Telegram Business: reply only within 24 h of the customer
type Row = { id: string; natural_key: string | null; attrs: Record<string, unknown> };

// The express surcharge is the `…express.surcharge` param order.quote declares in its reads (v3 §6), in tetri.
const expressSurcharge = (b: Bundle): number => {
  const path = b.tools['order.quote']?.reads.find((r) => r.endsWith('express.surcharge'));
  const enabled = path ? b.params[path.replace(/\.surcharge$/, '.enabled')] : undefined;
  return path && enabled !== false ? Number(b.params[path] ?? 0) : 0;
};

export function createExecutors(inTenant: InTenant, o: { deliver?: NotifyDeliver } = {}): Record<string, Executor> {
  const surchargeOf = expressSurcharge;

  async function price(tx: Tx, tenantId: string, env: string, lines: Line[], delivery: string, discountPct: number, bundle: Bundle) {
    const { object, lineField } = catalogOf(bundle);
    const skus = [...new Set(lines.map((l) => String(l[lineField])))];
    const items = await tx<Row[]>`select id, natural_key, attrs from public.records
                                   where tenant_id = ${tenantId} and env = ${env} and entity_type = ${object} and natural_key in ${tx(skus)}`;
    const bySku = new Map(items.map((w) => [w.natural_key!, w.attrs]));
    const priced = lines.map((l) => {
      const sku = String(l[lineField]);
      const w = bySku.get(sku);
      if (!w) throw new Error(`unknown ${object} ${sku}`);
      if (typeof w.stock === 'number' && w.stock < l.qty) throw new Error(`only ${w.stock} of ${sku} in stock`);
      return { [lineField]: sku, qty: l.qty, unit_price: Number(w.price) };
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
      const { object } = catalogOf(c.bundle);
      const q: string | null = typeof input.query === 'string' && input.query.trim() ? `%${input.query.trim()}%` : null;
      const maxPrice: number | null = typeof input.max_price === 'number' ? input.max_price : null;
      // Every other string input names a field of the catalog object (grape for wine, category for a shop): exact match.
      const exact = Object.entries(input).filter(([k, v]) => k !== 'query' && k !== 'max_price' && typeof v === 'string') as [string, string][];
      const rows: Row[] = await tx<Row[]>`
        select id, natural_key, attrs from public.records
         where tenant_id = ${c.tenantId} and env = ${c.env} and entity_type = ${object}
           and (${q}::text is null or attrs::text ilike ${q} or natural_key ilike ${q})
           and (${maxPrice}::bigint is null or (attrs ->> 'price')::bigint <= ${maxPrice})
         order by attrs ->> 'label' limit 50`;
      return { items: rows.filter((r) => exact.every(([k, v]) => r.attrs[k] === v)).slice(0, 10).map((r) => r.attrs) };
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

    // plan §1.5: the customer's latest conversation, under its channel's rules. Simulated (previews,
    // CONNECTIONS_MODE=simulate) records the message in the conversation but sends nothing outside.
    'customer.notify': Object.assign((input: Record<string, unknown>, c: Parameters<Executor>[1]) => inTenant(c.tenantId, async (tx) => {
      const [job] = await tx<Row[]>`select id, natural_key, attrs from public.records
        where tenant_id = ${c.tenantId} and env = ${c.env} and entity_type = 'delivery_job' and id = ${String(input.job)}`;
      if (!job) return { sent: false, reason: 'unknown_job' };
      const [order] = await tx<Row[]>`select id, natural_key, attrs from public.records
        where tenant_id = ${c.tenantId} and env = ${c.env} and entity_type = 'order' and id::text = ${String(job.attrs.order)}`;
      const customerId = order?.attrs.customer;
      if (!order || typeof customerId !== 'string') return { sent: false, reason: 'no_customer' };
      const [conv] = await tx<{ id: string; channel: string; external_id: string; active_chapter: string | null; last_in: Date | null }[]>`
        select c.id, c.channel, c.external_id, c.active_chapter,
               (select max(m.created_at) from public.messages m where m.tenant_id = c.tenant_id and m.conversation_id = c.id and m.direction = 'in') as last_in
          from public.conversations c
         where c.tenant_id = ${c.tenantId} and c.env = ${c.env} and c.customer_id = ${customerId}
         order by c.last_message_at desc nulls last limit 1`;
      if (!conv) return { sent: false, reason: 'no_conversation' };

      const status = String(job.attrs.status);
      const locale = String((c.bundle.metadata.locale as { primary?: string } | null)?.primary ?? 'en');
      const copy = (NOTIFY[locale] ?? NOTIFY.en!)[status] ?? NOTIFY.en![status];
      if (!copy) return { sent: false, reason: 'no_copy_for_status' };
      const text = copy(String(order.attrs.number ?? order.natural_key), typeof job.attrs.eta === 'string' ? job.attrs.eta : null);

      if (conv.channel === 'telegram_business'
          && !(conv.last_in && Date.now() - conv.last_in.getTime() < BUSINESS_WINDOW_HOURS * 3_600_000)) {
        return { sent: false, channel: conv.channel, reason: 'business_window_closed' };   // a staff task instead (plan §1.5)
      }
      const record = async () => {
        const [m] = await tx<{ id: string }[]>`
          insert into public.messages (tenant_id, conversation_id, chapter_id, turn_id, direction, author, body, spec_digest)
          values (${c.tenantId}, ${conv.id}, ${conv.active_chapter}, ${c.turnId ?? crypto.randomUUID()}, 'out', 'agent:customer.notify', ${text}, ${c.digest})
          returning id`;
        return Number(m!.id);
      };
      if (conv.channel === 'telegram' && !c.simulated) {
        const [bot] = await tx<{ id: string; bot_id: string; token_secret: string }[]>`select id, bot_id, token_secret from public.channel_connections
          where tenant_id = ${c.tenantId} and kind = 'telegram_bot' and status = 'live' limit 1`;
        if (!bot) return { sent: false, channel: conv.channel, reason: 'no_live_bot' };
        if (o.deliver) {
          const id = await o.deliver({ kind: 'telegram', channelId: bot.id, botId: Number(bot.bot_id), tokenSecret: bot.token_secret, chatId: Number(conv.external_id) }, text, { suggestion: null });
          return { sent: true, channel: conv.channel, message_id: id };
        }
        return { sent: false, channel: conv.channel, reason: 'no_sender', message_id: await record() };   // until DEV-1's send.ts is wired
      }
      // web: the message waits in the conversation for the next poll; simulated: recorded, nothing sent outside.
      return { sent: conv.channel === 'web' && !c.simulated, simulated: c.simulated, channel: conv.channel, message_id: await record() };
    }), { simulates: true as const }),
  } satisfies Record<string, (i: Record<string, unknown>, c: Parameters<Executor>[1]) => Promise<ToolOutput>>;
}

/** The quote the gateway puts into context.quote for tools whose policies read it (order.create). */
export function createQuotes(executors: Record<string, Executor>) {
  return {
    price: (tenantId: string, pin: { env: import('@archable/contracts').Env; digest: string }, input: Record<string, unknown>, bundle: Bundle) =>
      executors['order.quote']!({ lines: input.lines, delivery: input.delivery, discount_pct: input.discount_pct }, { tenantId, env: pin.env, digest: pin.digest, bundle, turnId: null, simulated: false }),
  };
}
