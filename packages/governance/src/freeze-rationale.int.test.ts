// freezeRationale against the real database (P4.D2.4): desire_impact on the control plane, the card frozen into
// change_requests. Everything happens in one control transaction on Marani that is rolled back at the end.
// Skipped without DATABASE_URL_CONTROL (CI has none).
import { createHash, randomInt, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import type { RationaleCard } from '@archable/contracts';
import type { Bundle } from '@archable/compiler';
import { freezeRationale, type RationaleText, type VerifyRun } from './freeze-rationale';
import { rationaleDigest, renderRationale } from './rationale';

const live = Boolean(process.env.DATABASE_URL_CONTROL);
const h = createHash('sha256').update('archable:tenant:marani').digest('hex');
const MARANI = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
class Rollback extends Error {}

const text: RationaleText = {
  renderOps: (cs) => cs.ops.map((o) => `op ${o.op}`),
  labelsFrom: (b) => ({ node: (id) => id, path: (p) => p, value: (_p, v) => String(v),
                        isMoney: (p) => p === 'context.quote.total', currency: b.metadata.currency }),
};

describe.skipIf(!live)('freezeRationale against archable', () => {
  const control = postgres(process.env.DATABASE_URL_CONTROL!, { prepare: false, max: 1 });
  afterAll(() => control.end());

  it('reads desire_impact, freezes the card and stores its digest', async () => {
    let seen: { card: RationaleCard; stored: { rationale: RationaleCard; rationale_digest: string } } | undefined;
    await control.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${MARANI}, true)`;
      const [t] = await tx<{ active_digest: string }[]>`select active_digest from public.tenants where id = ${MARANI}`;
      const [s] = await tx<{ bundle: Bundle }[]>`select bundle from public.specs where tenant_id = ${MARANI} and digest = ${t!.active_digest}`;
      const bundle = s!.bundle;

      const customers: string[] = [];
      for (let i = 0; i < 3; i++) {
        const [r] = await tx<{ id: string }[]>`insert into public.records (tenant_id, entity_type, attrs, spec_digest, created_by)
          values (${MARANI}, 'customer', ${tx.json({ name: `D-14 fixture ${i}`, phone: `+9955${randomInt(10_000_000, 99_999_999)}` })},
                  ${t!.active_digest}, 'agent') returning id`;
        customers.push(r!.id);
      }
      // Two quoted and abandoned (60 and 80 GEL, quiet for hours), one that never reached a price.
      const chapters = await tx<{ id: string }[]>`insert into public.chapters (tenant_id, customer_id, kind, opened_at, last_quote_total, last_quote_at)
        values (${MARANI}, ${customers[0]!}, 'order', now() - interval '3 days', 6000, now() - interval '2 days'),
               (${MARANI}, ${customers[1]!}, 'order', now() - interval '2 days', 8000, now() - interval '1 day'),
               (${MARANI}, ${customers[2]!}, 'question', now() - interval '1 day', null, null) returning id`;
      const [d] = await tx<{ id: string; number: number }[]>`insert into public.desires (tenant_id, source, statement)
        values (${MARANI}, 'owner_request', 'Customers can pay cash on delivery up to 300 GEL') returning id, number`;
      for (const c of chapters) {
        await tx`insert into public.desire_chapters (tenant_id, desire_id, chapter_id, linked_by, p) values (${MARANI}, ${d!.id}, ${c.id}, 'jev:desire.dedupe', 0.9)`;
      }
      const cr = { tenant_id: MARANI, id: randomUUID(), desire_id: d!.id, head_sha: 'c'.repeat(40) };
      await tx`insert into public.change_requests (tenant_id, id, desire_id, pr_number, title, author_kind, base_sha, head_sha)
        values (${MARANI}, ${cr.id}, ${cr.desire_id}, ${900_000 + randomInt(99_999)}, 'D-14 fixture', 'architect', ${'b'.repeat(40)}, ${cr.head_sha})`;

      const run: VerifyRun = {
        desire: { number: d!.number, source: 'owner_request', statement: 'Customers can pay cash on delivery up to 300 GEL' },
        radius: { changed: ['field:order.payment'], reached: ['def|field:order.payment', 'run|tool:order.create'],
                  why: [{ tier: 3, rule: 'money', path: ['field:order.payment', 'tool:order.create'] }] },
        changeset: { desire: `D-${d!.number}`, base_digest: t!.active_digest, rationale: 'fixture',
                     ops: [{ op: 'add_enum', path: 'objects.order.fields.payment.values', value: 'cod', label: 'Cash on delivery' }] },
        verification: { suites: { smoke: { passes: 6, runs: 6 } }, new_cases: 1, elva_drift: 'none' },
      };
      const card = await freezeRationale(tx, cr, run, bundle, bundle, text);
      const [stored] = await tx<{ rationale: RationaleCard; rationale_digest: string }[]>`
        select rationale, rationale_digest from public.change_requests where tenant_id = ${MARANI} and id = ${cr.id}`;
      seen = { card, stored: stored! };
      throw new Rollback();
    }).catch((e) => { if (!(e instanceof Rollback)) throw e; });

    const { card, stored } = seen!;
    console.log(renderRationale(card));
    expect(card.trigger.map((x) => x.text)[0]).toMatch(/^3 customer chats from 3 customers between \d+ \w{3} and \d+ \w{3} were about this\.$/);
    expect(card.impact.map((x) => x.text)).toEqual([
      '2 of 2 customers who got a price did not order: 140 GEL in baskets.',
      'That is what those customers were quoted, not a forecast.',
      '1 of the chats never reached a price, so it adds nothing to that figure.',
    ]);
    // run|tool:order.create was reached, so its bounds from Marani's real policies are on the card.
    expect(card.risk.map((x) => x.source)).toEqual(expect.arrayContaining(['policy order.large_needs_staff', 'policy order.discount_cap']));
    expect(card.risk.map((x) => x.text)).toContain("The context.quote.total can't exceed 300 GEL, unless an exception in that rule applies.");
    expect(stored.rationale_digest).toBe(rationaleDigest(card));
    expect(rationaleDigest(stored.rationale)).toBe(rationaleDigest(card));        // the jsonb round trip keeps the digest
  });
});
