// packages/governance/src/rationale.ts: "Why did the system do this?"
// Every sentence is rendered from a typed fact with a named source. No model writes any part of a card:
// numbers come from SQL (desire_impact), risk from the compiler (blast radius, policy bounds),
// verification from the verify run. Same inputs, same card, same digest.
import type { RationaleCard, RationaleFact, Tier } from '@archable/contracts';
import { digestOf, type PolicyBound } from '@archable/compiler';

export interface DesireImpact {                       // one row of public.desire_impact()
  chapters: number;
  customers: number;
  quoted: number;
  abandoned: number;
  abandoned_value: number;                            // tetri
  ordered: number;
  first_seen: string | null;
  last_seen: string | null;
}

export interface BlastReason { tier: Tier; rule: string; path: string[] }

export interface VerificationResult {
  suites: Record<string, { passes: number; runs: number }>;
  new_cases: number;
  elva_drift: 'none' | 'non_breaking' | 'breaking' | 'unknown';
}

export interface ChangeRationaleInput {
  changeRequestId: string;
  desire: { number: number; source: 'owner_request' | 'failure_cluster' | 'developer_note' | 'kpi_drift'; statement: string };
  ownerRequest?: { at: string; text: string };
  headSha: string;
  impact: DesireImpact;
  quietHours: number;                                 // the p_quiet passed to desire_impact
  reasons: BlastReason[];                             // blastRadius().why
  bounds: PolicyBound[];                              // bounds of policies in Δ or bounding a reached tool
  ops: string[];                                      // typed ops rendered with spec labels (§4.6 templates)
  verification: VerificationResult;
  labels: Labels;
  now: string;
}

export interface Labels {
  node(id: string): string;                           // 'field:order.payment' → 'payment method'
  path(p: string): string;                            // 'context.quote.total' → 'order total'
  value(path: string, v: string | number | boolean): string;   // ('context.input.payment', 'cod') → 'cash on delivery'
  isMoney(path: string): boolean;
  currency: string;                                   // 'GEL'
}

const TIER_WORDS: Record<string, string> = {
  money: 'touches money', external: 'reaches an outside company', pii_egress: 'sends personal data outside',
  authz: 'changes who may do what', governance: 'changes how changes are approved',
};

export function money(tetri: number, currency: string) {
  const v = tetri / 100;
  return `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(2)} ${currency}`;
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Tbilisi' });

// Deviation from plan §7.5's text (PROGRESS.md Q9): counts of one take the singular, and a span within one day is
// "on <day>". Every plural sentence renders exactly as the plan's.
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function buildChangeRationale(i: ChangeRationaleInput): RationaleCard {
  const f = (text: string, source: string): RationaleFact => ({ text, source });
  const L = i.labels;

  const trigger: RationaleFact[] = [];
  if (i.ownerRequest) {
    trigger.push(f(`You asked for this on ${day(i.ownerRequest.at)}: “${i.ownerRequest.text}”`, `desire D-${i.desire.number}, owner message`));
  }
  if (i.impact.chapters > 0) {
    const [from, to] = [i.impact.first_seen && day(i.impact.first_seen), i.impact.last_seen && day(i.impact.last_seen)];
    const span = from && to ? (from === to ? ` on ${from}` : ` between ${from} and ${to}`) : '';
    trigger.push(f(`${count(i.impact.chapters, 'customer chat', 'customer chats')} from ${count(i.impact.customers, 'customer', 'customers')}${span} `
      + `${i.impact.chapters === 1 ? 'was' : 'were'} about this.`,
      'desire_chapters: linked by Jev, unlinkable by owner or developer'));
  } else if (!i.ownerRequest) {
    trigger.push(f(i.desire.statement, `desire D-${i.desire.number} (${i.desire.source})`));
  }

  const impact: RationaleFact[] = [];
  if (i.impact.quoted > 0) {
    impact.push(f(`${i.impact.abandoned} of ${count(i.impact.quoted, 'customer', 'customers')} who got a price did not order: ` +
      `${money(i.impact.abandoned_value, L.currency)} in baskets.`,
      `chapters.last_quote_total, no order ${i.quietHours} h after the quote`));
    impact.push(f('That is what those customers were quoted, not a forecast.', 'rendering rule'));
  }
  const unpriced = i.impact.chapters - i.impact.quoted;
  if (unpriced > 0) {
    impact.push(f(`${unpriced} of the chats never reached a price, so ${unpriced === 1 ? 'it adds' : 'they add'} nothing to that figure.`,
      'chapters without a quote'));
  }
  if (impact.length === 0) impact.push(f('No sales figure: no linked chat reached a price.', 'desire_impact'));

  const risk: RationaleFact[] = [];
  for (const b of i.bounds) {
    const cap = L.isMoney(b.path) ? money(b.max, L.currency) : String(b.max);
    const cond = b.when.length ? ` when ${b.when.map((w) => `${L.path(w.path)} is ${L.value(w.path, w.equals)}`).join(' and ')}` : '';
    const exc = b.hasExceptions ? ', unless an exception in that rule applies' : '';
    risk.push(f(`The ${L.path(b.path)} can't exceed ${cap}${cond}${exc}.`, `policy ${b.policy}`));
  }
  const top = Math.max(0, ...i.reasons.map((r) => r.tier));
  for (const r of i.reasons.filter((x) => x.tier === top && TIER_WORDS[x.rule])) {
    risk.push(f(`It ${TIER_WORDS[r.rule]}: ${r.path.map((n) => L.node(n)).join(' → ')}.`, `blast radius, rule ${r.rule}, T${r.tier}`));
  }

  const action = i.ops.map((text) => f(text, 'typed ChangeSet'));

  const s = Object.values(i.verification.suites);
  const passes = s.reduce((a, x) => a + x.passes, 0);
  const runs = s.reduce((a, x) => a + x.runs, 0);
  const verification: RationaleFact[] = [
    f(`${passes} of ${count(runs, 'check', 'checks')} passed${i.verification.new_cases ? `, ${i.verification.new_cases} of them new` : ''}.`,
      'archable/verify on this version'),
    f({ none: 'What outside agents can call is unchanged.', non_breaking: 'Outside agents gain new options; nothing they use changes.',
        breaking: 'Outside agents that call this business must be updated.', unknown: 'The outside-agent contract was not checked.' }[i.verification.elva_drift],
      'Elva contract drift'),
  ];

  return {
    version: 1,
    subject: { kind: 'change', change_request_id: i.changeRequestId, desire: `D-${i.desire.number}`, head_sha: i.headSha },
    trigger, impact, risk, action, verification,
    computed_at: i.now,
  };
}

export function renderRationale(card: RationaleCard): string {
  const sec = (title: string, facts: RationaleFact[]) =>
    facts.length ? `${title}\n${facts.map((x) => `· ${x.text}`).join('\n')}` : '';
  return [
    sec('What happened', card.trigger),
    sec('What it costs', card.impact),
    sec('What limits the risk', card.risk),
    sec('What changes', card.action),
    sec('How it was checked', card.verification),
  ].filter(Boolean).join('\n\n');
}

// computed_at is excluded so that recomputing the same facts gives the same digest.
export const rationaleDigest = (card: RationaleCard) => digestOf({ ...card, computed_at: null });
