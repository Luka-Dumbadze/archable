import { describe, expect, it } from 'vitest';
import { buildChangeRationale, money, rationaleDigest, renderRationale, type ChangeRationaleInput, type Labels } from './rationale';

// The D-14 fixtures of plan §1.3: "enable cash on delivery", the T3 change of v3 §3.6.
const NODES: Record<string, string> = {
  'field:order.payment': 'payment method', 'tool:delivery.dispatch': 'courier booking',
  'tool:payout.compute': 'courier payout', 'field:delivery_job.payout': 'payout amount',
};
const PATHS: Record<string, string> = { 'context.quote.total': 'order total', 'context.input.payment': 'payment method' };
const labels: Labels = {
  node: (id) => NODES[id] ?? id,
  path: (p) => PATHS[p] ?? p,
  value: (p, v) => (p === 'context.input.payment' && v === 'cod' ? 'cash on delivery' : String(v)),
  isMoney: (p) => p === 'context.quote.total',
  currency: 'GEL',
};

const D14: ChangeRationaleInput = {
  changeRequestId: '7d1c0e2a-5b8f-4c3d-9e61-0a4b2c6d8e10',
  desire: { number: 14, source: 'owner_request', statement: 'Customers can pay cash on delivery up to 300 GEL' },
  ownerRequest: { at: '2026-10-17T09:12:00Z', text: 'customers keep asking to pay the courier in cash, allow it up to 300 lari' },
  headSha: '4f9e2c1b8a7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f',
  // D6 of plan §9.3, restricted to the desire's linked chats: 3 chats, 3 customers, 2 quoted (60 + 80 GEL), none ordered.
  impact: { chapters: 3, customers: 3, quoted: 2, abandoned: 2, abandoned_value: 14000, ordered: 0,
            first_seen: '2026-10-15T08:30:00Z', last_seen: '2026-10-17T16:05:00Z' },
  quietHours: 2,
  reasons: [
    { tier: 3, rule: 'external', path: ['field:order.payment', 'tool:delivery.dispatch'] },
    { tier: 3, rule: 'money', path: ['field:order.payment', 'tool:payout.compute', 'field:delivery_job.payout'] },
    { tier: 3, rule: 'policy.add', path: ['policy:payment.cod_limit'] },          // a change rule, no sentence
  ],
  bounds: [{ policy: 'payment.cod_limit', action: 'order.create', path: 'context.quote.total', max: 30000,
             when: [{ path: 'context.input.payment', equals: 'cod' }], hasExceptions: false }],
  ops: ['Customers can choose cash on delivery.', 'Cash on delivery is refused above 300 GEL.',
        'Cellar Master mentions it when asked how to pay.'],
  verification: { suites: { smoke: { passes: 6, runs: 6 }, contact_center: { passes: 38, runs: 38 }, regressions: { passes: 3, runs: 3 } },
                  new_cases: 3, elva_drift: 'none' },
  labels,
  now: '2026-10-17T16:40:00Z',
};

// plan §1.3, verbatim.
const CARD = `What happened
· You asked for this on 17 Oct: “customers keep asking to pay the courier in cash, allow it up to 300 lari”
· 3 customer chats from 3 customers between 15 Oct and 17 Oct were about this.

What it costs
· 2 of 2 customers who got a price did not order: 140 GEL in baskets.
· That is what those customers were quoted, not a forecast.
· 1 of the chats never reached a price, so it adds nothing to that figure.

What limits the risk
· The order total can't exceed 300 GEL when payment method is cash on delivery.
· It reaches an outside company: payment method → courier booking.
· It touches money: payment method → courier payout → payout amount.

What changes
· Customers can choose cash on delivery.
· Cash on delivery is refused above 300 GEL.
· Cellar Master mentions it when asked how to pay.

How it was checked
· 47 of 47 checks passed, 3 of them new.
· What outside agents can call is unchanged.`;

describe('rationale card (plan §7.5)', () => {
  it('the D-14 fixture renders exactly the card in plan §1.3', () => {
    expect(renderRationale(buildChangeRationale(D14))).toBe(CARD);
  });

  it('every sentence names its source', () => {
    const c = buildChangeRationale(D14);
    const all = [...c.trigger, ...c.impact, ...c.risk, ...c.action, ...c.verification];
    expect(all.every((x) => x.source.length > 0)).toBe(true);
    expect(c.risk.map((x) => x.source)).toEqual(['policy payment.cod_limit', 'blast radius, rule external, T3', 'blast radius, rule money, T3']);
    expect(c.subject).toEqual({ kind: 'change', change_request_id: D14.changeRequestId, desire: 'D-14', head_sha: D14.headSha });
  });

  it('the digest is stable across recomputation and independent of computed_at', () => {
    const a = buildChangeRationale(D14);
    const b = buildChangeRationale({ ...D14, now: '2026-10-18T03:00:00Z' });
    expect(b.computed_at).not.toBe(a.computed_at);
    expect(rationaleDigest(b)).toBe(rationaleDigest(a));
    expect(rationaleDigest(JSON.parse(JSON.stringify(a)))).toBe(rationaleDigest(a));   // stored jsonb round trip
    expect(rationaleDigest(a)).toMatch(/^sha256:[0-9a-f]{64}$/);                        // change_requests check
  });

  it('a different fact gives a different digest', () => {
    const a = buildChangeRationale(D14);
    expect(rationaleDigest(buildChangeRationale({ ...D14, impact: { ...D14.impact, abandoned_value: 14050 } }))).not.toBe(rationaleDigest(a));
    expect(rationaleDigest(buildChangeRationale({ ...D14, headSha: 'f'.repeat(40) }))).not.toBe(rationaleDigest(a));
  });

  it('without priced chats there is no sales figure; without chats the statement stands in', () => {
    const none = { chapters: 0, customers: 0, quoted: 0, abandoned: 0, abandoned_value: 0, ordered: 0, first_seen: null, last_seen: null };
    const c = buildChangeRationale({ ...D14, ownerRequest: undefined, impact: none });
    expect(c.trigger.map((x) => x.text)).toEqual(['Customers can pay cash on delivery up to 300 GEL']);
    expect(c.impact.map((x) => x.text)).toEqual(['No sales figure: no linked chat reached a price.']);
  });

  it('counts of one read in the singular, and one day is "on <day>" (Q9)', () => {
    const one = { chapters: 1, customers: 1, quoted: 1, abandoned: 1, abandoned_value: 6000, ordered: 0,
                  first_seen: '2026-10-17T08:00:00Z', last_seen: '2026-10-17T15:00:00Z' };
    const text = renderRationale(buildChangeRationale({ ...D14, impact: one,
      verification: { suites: { regressions: { passes: 1, runs: 1 } }, new_cases: 0, elva_drift: 'none' } }));
    expect(text).toContain('· 1 customer chat from 1 customer on 17 Oct was about this.');
    expect(text).toContain('· 1 of 1 customer who got a price did not order: 60 GEL in baskets.');
    expect(text).toContain('· 1 of 1 check passed.');
    expect(text).not.toMatch(/chats? from 1 customers|never reached a price/);
  });

  it('money is GEL from integer tetri', () => {
    expect([money(14000, 'GEL'), money(3550, 'GEL'), money(5, 'GEL')]).toEqual(['140 GEL', '35.50 GEL', '0.05 GEL']);
  });
});
