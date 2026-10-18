import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { blastRadius, compile, type RepoTree } from './index';

// The worked examples of v3 §3.6 on Marani OS, plus Q7's rule that labels are copy.
const ROOT = fileURLToPath(new URL('../../../fixtures/marani', import.meta.url));
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const marani = (): RepoTree => ({ files: Object.fromEntries(walk(ROOT).map((p) => [relative(ROOT, p).replace(/\\/g, '/'), readFileSync(p, 'utf8')])) });
const lock = YAML.parse(marani().files['archable.lock']!);
const base = compile(marani(), lock).bundle;

function radiusOf(edit: (files: Record<string, string>) => void) {
  const tree = marani();
  edit(tree.files);
  const head = compile(tree, lock).bundle;
  return blastRadius(base.graph, head.graph, base.risk);
}
const replace = (files: Record<string, string>, path: string, from: string, to: string) => {
  if (!files[path]!.includes(from)) throw new Error(`fixture changed: ${from}`);
  files[path] = files[path]!.replace(from, to);
};

describe('blastRadius (v3 §3.5, §3.6)', () => {
  it('the same tree has an empty delta: T0', () => {
    const r = radiusOf(() => {});
    expect(r).toMatchObject({ tier: 0, changed: [], why: [] });
  });

  it('"make Cellar Master warmer" is T1: may_invoke is cut at bounded tools', () => {
    const r = radiusOf((f) => { f['personas/cellar_master.md'] += '\nBe warm and welcoming.\n'; });
    expect(r.tier).toBe(1);
    expect(r.changed).toEqual(['persona:cellar_master']);
    expect(r.why).toEqual([{ tier: 1, rule: 'persona.text', path: ['persona:cellar_master'] }]);
    expect(r.reached.filter((k) => k.endsWith('|tool:order.create'))).toEqual([]);   // bounded by order.* forbids
    expect(r.reached).toContain('call|tool:handoff.staff');            // called, but its other agent isn't reached (Q8)
    expect(r.reached.filter((k) => k.endsWith('|agent:dispatch_node'))).toEqual([]);
  });

  it('adding optional wine.tasting_notes is T1', () => {
    const r = radiusOf((f) => replace(f, 'enterprise.spec.yaml', '      stock: { type: integer, min: 0, index: range }',
      '      stock: { type: integer, min: 0, index: range }\n      tasting_notes: { type: string, optional: true }'));
    expect(r).toMatchObject({ tier: 1, changed: ['field:wine.tasting_notes'], delta: { 'field:wine.tasting_notes': 'field.add_optional' } });
  });

  it('express surcharge 10 → 12 GEL is T3: the changed node is money', () => {
    const r = radiusOf((f) => replace(f, 'enterprise.spec.yaml', 'surcharge: 1000 }', 'surcharge: 1200 }'));
    expect(r.tier).toBe(3);
    expect(r.why).toContainEqual({ tier: 3, rule: 'money', path: ['param:quickshipper.express.surcharge'] });
  });

  it('"enable cash on delivery" is T3, reaching an outside company and money', () => {
    const r = radiusOf((f) => {
      replace(f, 'enterprise.spec.yaml', 'values: [card_link, bank_transfer]', 'values: [card_link, bank_transfer, cod]');
      replace(f, 'enterprise.spec.yaml', 'policies/privacy.cedar]', 'policies/privacy.cedar, policies/payment.cedar]');
      f['policies/payment.cedar'] = '@id("payment.cod_limit")\nforbid (principal is Agent, action == Action::"order.create", resource)\n'
        + 'when { context.input.payment == "cod" && context.quote.total > 30000 };\n';
    });
    expect(r.tier).toBe(3);
    expect(r.delta).toEqual({ 'field:order.payment': 'enum.add_value', 'policy:payment.cod_limit': 'policy.any' });
    expect(r.why).toContainEqual({ tier: 3, rule: 'external', path: ['field:order.payment', 'tool:delivery.dispatch'] });
    expect(r.why).toContainEqual({ tier: 3, rule: 'money', path: ['field:order.payment', 'tool:delivery.dispatch', 'field:delivery_job.payout'] });
    expect(r.why).toContainEqual({ tier: 3, rule: 'policy.any', path: ['policy:payment.cod_limit'] });
  });

  it('removing an eval case is T3: weakening the yardstick', () => {
    const r = radiusOf((f) => { delete f['evals/smoke/catalog-price-01.yaml']; });
    expect(r).toMatchObject({ tier: 3, delta: { 'eval:smoke/catalog-price-01': 'eval.remove' } });
  });

  it('changing only a label is copy (T1), even on a money field', () => {
    const r = radiusOf((f) => replace(f, 'enterprise.spec.yaml', 'label: { en: order total,', 'label: { en: basket total,'));
    expect(r).toMatchObject({ tier: 1, changed: ['copy:labels'], delta: { 'copy:labels': 'ui.copy' } });
  });

  it('the bundle carries the labels, with context paths mapped to their fields', () => {
    expect(base.labels.nodes['field:order.payment']).toEqual({ en: 'payment method', ka: 'გადახდის მეთოდი' });
    expect(base.labels.values['order.payment.bank_transfer']).toMatchObject({ en: 'bank transfer' });
    expect(base.labels.context).toMatchObject({ 'context.quote.total': 'field:order.total', 'context.input.discount_pct': 'field:order.discount_pct' });
    expect(base.risk).toMatchObject({ floors: { money: 3, governance: 4 }, changeRules: { 'persona.text': 1, 'policy.any': 3 }, cutAtBoundedTools: true });
  });
});
