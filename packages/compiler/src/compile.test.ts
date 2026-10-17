import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkParsePolicySet, policyToJson } from '@cedar-policy/cedar-wasm/nodejs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { boundsOf, compile, CompileFailure, type RepoTree } from './index';

const ROOT = fileURLToPath(new URL('../../../fixtures/marani', import.meta.url));
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const marani = (): RepoTree => ({
  files: Object.fromEntries(walk(ROOT).map((p) => [relative(ROOT, p).replace(/\\/g, '/'), readFileSync(p, 'utf8')])),
});
const lock = () => YAML.parse(marani().files['archable.lock']!);
const withSpec = (edit: (spec: string) => string): RepoTree => {
  const tree = marani();
  tree.files['enterprise.spec.yaml'] = edit(tree.files['enterprise.spec.yaml']!);
  return tree;
};
const errorsOf = (tree: RepoTree) => {
  try {
    compile(tree, lock());
  } catch (e) {
    if (e instanceof CompileFailure) return e.errors.map((x) => x.message);
    throw e;
  }
  return [];
};

describe('compile fixtures/marani', () => {
  it('gives the same digest twice, and for CRLF line endings', () => {
    const a = compile(marani(), lock());
    const b = compile(marani(), lock());
    expect(a.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(b.digest).toBe(a.digest);
    const crlf = marani();
    for (const k of Object.keys(crlf.files)) crlf.files[k] = crlf.files[k]!.replace(/\r?\n/g, '\r\n');
    expect(compile(crlf, lock()).digest).toBe(a.digest);
  });

  it('derives the six A2A edges of plan §1.2', () => {
    const { a2a } = compile(marani(), lock()).bundle;
    expect(a2a.edges.length).toBe(6);
    expect(a2a.edges.map((e) => `${e.from} ──[${e.label}]──▶ ${e.to} (${e.transport})`).sort()).toEqual([
      'app:contact_center ──[A2A event: order.status → confirmed]──▶ app:quickshipper (in_process)',
      'app:contact_center ──[A2A tool: customer.upsert]──▶ app:customer_center (in_process)',
      'app:contact_center ──[A2A tool: delivery.status]──▶ app:quickshipper (in_process)',
      'app:quickshipper ──[A2A event: delivery_job.status → picked_up|delivered|failed]──▶ app:contact_center (in_process)',
      'app:quickshipper ──[A2A tool: handoff.staff]──▶ app:contact_center (in_process)',
      'app:quickshipper ──[MCP: delivery.dispatch]──▶ conn:courier_api (mcp)',
    ]);
    expect(a2a.nodes.map((n) => n.id)).toEqual(['app:contact_center', 'app:customer_center', 'app:quickshipper', 'conn:courier_api']);
  });

  it('reads payment.cod_limit as a 30000-tetri bound on order.create (v3 §6.1, D-14)', () => {
    const r = policyToJson(`@id("payment.cod_limit")
forbid (principal, action == Action::"order.create", resource)
when { context.input.payment == "cod" && context.quote.total > 30000 };`);
    if (r.type !== 'success') throw new Error('cod_limit did not parse');
    const bounds = boundsOf(r.json as unknown as Record<string, unknown>);
    expect(bounds).toContainEqual({
      policy: 'payment.cod_limit', action: 'order.create', path: 'context.quote.total', max: 30000,
      when: [{ path: 'context.input.payment', equals: 'cod' }], hasExceptions: false,
    });
  });

  it('carries the fixture’s own bounds', () => {
    const { bounds } = compile(marani(), lock()).bundle.policies;
    expect(bounds.map((b) => `${b.policy} ${b.path} ≤ ${b.max}${b.hasExceptions ? ' (unless)' : ''}`)).toEqual([
      'order.discount_cap context.input.discount_pct ≤ 10',
      'order.large_needs_staff context.quote.total ≤ 30000 (unless)',
    ]);
  });

  it('lowers money to integer tetri and projects entity schemas', () => {
    const { bundle, projections } = compile(marani(), lock());
    const price = (bundle.objects.wine!.schema.properties as Record<string, Record<string, unknown>>).price;
    expect(price).toEqual({ type: 'integer', 'x-archable': { semantics: 'money', currency: 'GEL', scale: 2 } });
    expect(bundle.tools['order.create']!.needsQuote).toBe(true);
    expect(bundle.tools['delivery.status']!.app).toBe('quickshipper');
    expect(projections.entitySchemas.find((e) => e.entity_type === 'courier')!.field_acl).toEqual({ payout_rate: ['owner'] });
    expect(projections.apps.map((a) => [a.app_id, a.nav_order])).toEqual([['contact_center', 0], ['customer_center', 2], ['quickshipper', 1]]);
  });

  it('tags the graph and bounds order.create by its forbid policies (v3 §3)', () => {
    const { nodes } = compile(marani(), lock()).bundle.graph;
    const n = (id: string) => nodes.find((x) => x.id === id)!;
    expect(n('tool:delivery.dispatch').tags).toEqual(['external', 'pii_egress']);
    expect(n('param:quickshipper.express.surcharge').tags).toEqual(['money']);
    expect(n('tool:order.create').boundedBy).toEqual(['policy:order.age_gate', 'policy:order.discount_cap', 'policy:order.large_needs_staff']);
    expect(n('tool:message.send').boundedBy).toEqual(['policy:send.requires_grounding']);
  });

  it('parses every fixture Cedar file (P1.D2.7)', () => {
    for (const [path, text] of Object.entries(marani().files)) {
      if (path.endsWith('.cedar')) expect(checkParsePolicySet({ staticPolicies: text }), path).toEqual({ type: 'success' });
    }
  });
});

describe('compile errors carry a path', () => {
  it('rejects a trigger on an unknown enum value', () => {
    expect(errorsOf(withSpec((s) => s.replace('order.status -> confirmed', 'order.status -> shipped'))))
      .toContain('triggers.dispatch_on_confirm.on: unknown enum "shipped" for order.status');
  });

  it('rejects an agent listing an unknown tool', () => {
    expect(errorsOf(withSpec((s) => s.replace('delivery.status, handoff.staff]', 'delivery.track, handoff.staff]'))))
      .toContain('agents.cellar_master.tools.4: unknown tool "delivery.track"');
  });

  it('rejects a policy reading an input its action does not have', () => {
    const tree = marani();
    tree.files['policies/delivery.cedar'] += '\n@id("delivery.no_gifts")\nforbid (principal, action == Action::"delivery.dispatch", resource)\nwhen { context.input.gift };\n';
    expect(errorsOf(tree)).toContain('policies/delivery.cedar#delivery.no_gifts: "gift" is not an input of delivery.dispatch');
  });

  it('rejects a template the lock does not pin', () => {
    const l = lock();
    delete l.templates['tpl.crm'];
    expect(() => compile(marani(), l)).toThrow('apps.customer_center.template: "tpl.crm" is not pinned in archable.lock');
  });
});
