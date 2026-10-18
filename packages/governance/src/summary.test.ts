import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blastRadius, compile, type RepoTree } from '@archable/compiler';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { buildChangeRationale, renderRationale } from './rationale';
import { boundSentence, businessTerms, labelsFrom, renderOps, witnesses } from './summary';

// summary.ts over real compiled Marani bundles: base, and the cash-on-delivery head (Q7).
const ROOT = fileURLToPath(new URL('../../../fixtures/marani', import.meta.url));
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const marani = (): RepoTree => ({ files: Object.fromEntries(walk(ROOT).map((p) => [relative(ROOT, p).replace(/\\/g, '/'), readFileSync(p, 'utf8')])) });
const lock = YAML.parse(marani().files['archable.lock']!);
const base = compile(marani(), lock).bundle;
const tree = marani();
tree.files['enterprise.spec.yaml'] = tree.files['enterprise.spec.yaml']!
  .replace('values: [card_link, bank_transfer]', 'values: [card_link, bank_transfer, cod]')
  .replace('bank_transfer: { en: bank transfer, ka: საბანკო გადარიცხვა }', 'bank_transfer: { en: bank transfer, ka: საბანკო გადარიცხვა }\n          cod: { en: cash on delivery }')
  .replace('policies/privacy.cedar]', 'policies/privacy.cedar, policies/payment.cedar]');
tree.files['policies/payment.cedar'] = '@id("payment.cod_limit")\nforbid (principal is Agent, action == Action::"order.create", resource)\n'
  + 'when { context.input.payment == "cod" && context.quote.total > 30000 };\n';
const head = compile(tree, lock).bundle;

const ops = [
  { op: 'add_enum', path: 'objects.order.fields.payment', value: 'cod', label: 'cash on delivery' },
  { op: 'add_policy', file: 'payment.cedar', id: 'payment.cod_limit', cedar: '…', summary: 'Cash on delivery is refused above 300 GEL.' },
  { op: 'edit_persona', agent: 'cellar_master', find: 'a', replace: 'b', summary: 'Cellar Master mentions it when asked how to pay.' },
  { op: 'add_eval', suite: 'regressions', id: 'd-14-cod-01', yaml: 'id: d-14-cod-01' },
] as const;

describe('summary.ts (Q7)', () => {
  const L = labelsFrom(head, base);

  it('labels nodes, context paths and enum values from the spec', () => {
    expect([L.node('field:order.payment'), L.node('tool:delivery.dispatch'), L.node('field:delivery_job.payout')])
      .toEqual(['payment method', 'courier booking', 'payout amount']);
    expect([L.path('context.quote.total'), L.path('context.input.payment')]).toEqual(['order total', 'payment method']);
    expect(L.value('context.input.payment', 'cod')).toBe('cash on delivery');
    expect([L.isMoney('context.quote.total'), L.isMoney('context.input.payment')]).toEqual([true, false]);
  });

  it('falls back to words from the id where the spec has no label', () => {
    expect(L.node('tool:catalog.search')).toBe('catalog search');
    expect(L.node('field:customer.age_verified')).toBe('age verified');
    expect(labelsFrom({ ...head, labels: undefined } as never, { ...base, labels: undefined } as never).node('field:order.payment')).toBe('payment');
  });

  it('renders one sentence per behavior op, in ChangeSet order; eval cases are not sentences', () => {
    expect(renderOps(ops as never, head)).toEqual([
      'Payment method can now be cash on delivery.',
      'Cash on delivery is refused above 300 GEL.',
      'Cellar Master mentions it when asked how to pay.',
    ]);
    expect(renderOps([{ op: 'edit_persona', agent: 'cellar_master', find: 'a', replace: 'b' }] as never, head))
      .toEqual(['Changes how Cellar Master talks to customers.']);
  });

  it('business terms (Q10): the head states cash on delivery and its cap; the base states neither', () => {
    const head14 = businessTerms(head, 'cellar_master');
    expect(head14).toContain('Payment method: card payment link, bank transfer or cash on delivery.');
    expect(head14).toContain("The order total can't exceed 300 GEL when payment method is cash on delivery.");
    expect(head14).toContain('Delivery: standard or express.');
    const before = businessTerms(base, 'cellar_master');
    expect(before).toContain('Payment method: card payment link or bank transfer.');
    expect(before.join(' ')).not.toMatch(/cash on delivery/);
    expect(businessTerms(head, 'dispatch_node').join(' ')).not.toMatch(/Payment method/);   // its tools take no payment input
  });

  it('a cap reads the same in the terms and on the rationale card', () => {
    const b = head.policies.bounds.find((x) => x.policy === 'payment.cod_limit')!;
    const card = buildChangeRationale({
      changeRequestId: 'cr', desire: { number: 14, source: 'owner_request', statement: 's' }, headSha: 'a'.repeat(40),
      impact: { chapters: 0, customers: 0, quoted: 0, abandoned: 0, abandoned_value: 0, ordered: 0, first_seen: null, last_seen: null },
      quietHours: 2, reasons: [], bounds: [b], ops: [], verification: { suites: {}, new_cases: 0, elva_drift: 'none' }, labels: L, now: 'x',
    });
    expect(boundSentence(b, L)).toBe(card.risk[0]!.text);
  });

  it('the D-14 card from the real blast radius: one witness per rule, in plain words', () => {
    const radius = blastRadius(base.graph, head.graph, base.risk);
    const bounds = head.policies.bounds.filter((b) => b.policy === 'payment.cod_limit');
    const card = buildChangeRationale({
      changeRequestId: 'cr', desire: { number: 14, source: 'owner_request', statement: 's' }, headSha: 'a'.repeat(40),
      impact: { chapters: 0, customers: 0, quoted: 0, abandoned: 0, abandoned_value: 0, ordered: 0, first_seen: null, last_seen: null },
      quietHours: 2, reasons: witnesses(radius), bounds, ops: renderOps(ops as never, head),
      verification: { suites: {}, new_cases: 1, elva_drift: 'none' }, labels: L, now: '2026-10-18T00:00:00Z',
    });
    const text = renderRationale(card);
    expect(text).toContain("· The order total can't exceed 300 GEL when payment method is cash on delivery.");
    expect(text).toContain('· It reaches an outside company: payment method → courier booking.');
    expect(text).toContain('· It touches money: payment method → courier booking → payout amount.');
    expect(card.risk.filter((x) => x.text.startsWith('It touches money'))).toHaveLength(1);
  });
});
