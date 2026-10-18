import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blastRadius, compile } from '@archable/compiler';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { apply, SPEC_FILE, type Tree } from './apply';

const ROOT = fileURLToPath(new URL('../../../fixtures/marani', import.meta.url));
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const marani = (): Tree => ({ files: Object.fromEntries(walk(ROOT).map((p) => [relative(ROOT, p).replace(/\\/g, '/'), readFileSync(p, 'utf8').replace(/\r\n/g, '\n')])) });
const lock = YAML.parse(marani().files['archable.lock']!);
const base = compile(marani(), lock);

const COD_POLICY = '@id("payment.cod_limit")\nforbid (principal is Agent, action == Action::"order.create", resource)\n'
  + 'when { context.input.payment == "cod" && context.quote.total > 30000 };';
const CASE = 'id: d-14-cod-01\ndesire: D-14\nturns:\n  - customer: "can I pay the courier in cash?"\nexpect:\n'
  + '  - judge: { question: "Does the reply say cash on delivery is available for orders up to 300 GEL?", min: 0.9 }\n';
const persona = marani().files['personas/cellar_master.md']!;
const anchor = persona.split('\n').find((l) => l.includes('handoff.staff'))!;

// The D-14 ChangeSet: six ops.
const D14 = {
  desire: 'D-14', base_digest: base.digest, rationale: 'Owner asked for cash on delivery up to 300 GEL.',
  ops: [
    { op: 'add_enum', path: 'objects.order.fields.payment', value: 'cod', label: 'cash on delivery' },
    { op: 'add_policy', file: 'payment.cedar', id: 'payment.cod_limit', cedar: COD_POLICY, summary: 'Cash on delivery is refused above 300 GEL.' },
    { op: 'edit_persona', agent: 'cellar_master', find: anchor, replace: `${anchor}\n- Customers may pay cash on delivery for orders up to 300 GEL.`,
      summary: 'Cellar Master mentions it when asked how to pay.' },
    { op: 'add_eval', suite: 'regressions', id: 'd-14-cod-01', yaml: CASE },
    { op: 'set', path: 'decisions.send.grounded.pass_at', value: 0.45, expect: 0.4 },
    { op: 'add_field', object: 'order', field: 'cash_collected', type: 'money', optional: true },
  ],
} as const;

describe('spec writer (v3 §4.7)', () => {
  const r = apply(marani(), structuredClone(D14) as never);
  if (r.outcome !== 'applied') throw new Error(JSON.stringify(r));
  const spec = r.tree.files[SPEC_FILE]!;

  it('applies the six D-14 ops, and the head compiles', () => {
    expect(r.touched).toEqual(['enterprise.spec.yaml', 'evals/regressions/d-14-cod-01.yaml', 'personas/cellar_master.md', 'policies/payment.cedar']);
    const head = compile(r.tree, lock);
    expect(head.digest).not.toBe(base.digest);
    expect((head.bundle.objects.order!.schema.properties as Record<string, unknown>).payment).toMatchObject({ enum: ['card_link', 'bank_transfer', 'cod'] });
    expect(head.bundle.labels.values['order.payment.cod']).toEqual({ en: 'cash on delivery' });
    expect(head.bundle.policies.bounds).toContainEqual({ policy: 'payment.cod_limit', action: 'order.create', path: 'context.quote.total',
      max: 30000, when: [{ path: 'context.input.payment', equals: 'cod' }], hasExceptions: false });
    expect(blastRadius(base.bundle.graph, head.bundle.graph, base.bundle.risk).tier).toBe(3);
  });

  it('keeps every comment and changes no unrelated line', () => {
    const before = marani().files[SPEC_FILE]!.split('\n');
    const after = spec.split('\n');
    const comments = (ls: string[]) => ls.filter((l) => l.includes('#'));
    expect(comments(after)).toEqual(expect.arrayContaining(comments(before).filter((l) => !l.includes('pass_at'))));
    const removed = before.filter((l) => !after.includes(l));
    expect(removed.map((l) => l.trim())).toEqual([
      'values: [card_link, bank_transfer]',
      'pass_at: 0.40                       # evals/calibration 2026-10-18, Mkhedruli: true >= 0.56, false <= 0.22 (was 0.90, then 0.75)',
      'files: [policies/orders.cedar, policies/delivery.cedar, policies/messaging.cedar, policies/privacy.cedar]',
    ]);
    const added = after.filter((l) => !before.includes(l)).map((l) => l.trim());
    expect(added).toEqual([
      'values: [card_link, bank_transfer, cod]',
      'cod: { en: cash on delivery }',
      'cash_collected: { type: money, optional: true }',
      'pass_at: 0.45                       # evals/calibration 2026-10-18, Mkhedruli: true >= 0.56, false <= 0.22 (was 0.90, then 0.75)',
      'files: [policies/orders.cedar, policies/delivery.cedar, policies/messaging.cedar, policies/privacy.cedar, policies/payment.cedar]',
    ]);
  });

  it('a dotted spec key resolves greedily: decisions.send.grounded.pass_at', () => {
    expect(YAML.parse(spec).decisions['send.grounded'].pass_at).toBe(0.45);
  });

  const one = (op: object) => apply(marani(), { desire: 'D-1', base_digest: base.digest, rationale: 'x', ops: [op] } as never);
  it.each([
    ['a stale expect', { op: 'set', path: 'decisions.send.grounded.pass_at', value: 0.5, expect: 0.9 }, /is 0.4, expected 0.9/],
    ['a value that already exists', { op: 'add_enum', path: 'objects.order.fields.payment', value: 'card_link', label: 'x' }, /already a value/],
    ['a persona anchor that is missing', { op: 'edit_persona', agent: 'cellar_master', find: 'no such line', replace: 'y' }, /occurs 0 times/],
    ['a policy whose @id differs', { op: 'add_policy', file: 'payment.cedar', id: 'payment.other', cedar: COD_POLICY }, /exactly @id\("payment.other"\)/],
    ['a policy id that exists', { op: 'add_policy', file: 'orders.cedar', id: 'order.discount_cap', cedar: '@id("order.discount_cap")\nforbid (principal, action, resource);' }, /already exists/],
    ['an eval whose id differs', { op: 'add_eval', suite: 'regressions', id: 'other', yaml: CASE }, /must have id: other/],
    ['an existing field', { op: 'add_field', object: 'order', field: 'total', type: 'money', optional: true }, /already exists/],
    ['a path outside the Architect’s reach', { op: 'set', path: 'governance.architect.max_open_prs', value: 9, expect: 3 }, /outside the Architect’s reach/],
  ])('refuses %s, as a conflict', (_name, op, message) => {
    const x = one(op);
    expect(x.outcome).toBe('conflict');
    expect(x.outcome === 'conflict' && x.conflicts[0]!.message).toMatch(message);
  });

  it('applies nothing when one op conflicts', () => {
    const tree = marani();
    const x = apply(tree, { ...structuredClone(D14), ops: [D14.ops[0], { op: 'set', path: 'decisions.send.grounded.pass_at', value: 0.5, expect: 0.9 }] } as never);
    expect(x).toMatchObject({ outcome: 'conflict', conflicts: [{ op: 1 }] });
    expect(tree.files[SPEC_FILE]).toBe(marani().files[SPEC_FILE]);
  });
});
