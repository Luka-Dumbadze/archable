// packages/compiler/src/graph/blast.ts: the blast-radius graph (v3 §3). Edges point the way impact flows,
// one per row of the v3 §3.3 table. buildGraph runs in every compile; blastRadius() compares a base and a head graph.
import type { Tier } from '@archable/contracts';
import type { Field, Spec } from '@archable/schema';
import { digestOf } from '../digest';
import { labelsOf } from '../labels';
import { BUILTIN_TOOLS, fieldPath, refNodes, type Resolved } from '../resolve';

export type EdgeKind = 'read_by' | 'written_by' | 'writes' | 'contract_of' | 'may_invoke' | 'guards'
  | 'configures' | 'informs' | 'fires' | 'calls' | 'rendered_by' | 'transports';

// facets: what a change to a field is (type, required, enum values), so the diff can name its change rule.
export interface FieldFacets { type: string; required: boolean; values: string[] }
export interface GNode { id: string; hash: string; tags: string[]; boundedBy: string[]; facets?: FieldFacets }
export interface GEdge { from: string; to: string; kind: EdgeKind }

// Labels are copy: they never change a node's hash (they are hashed into copy:labels instead).
const behavior = (f: Field): Field => {
  const { label: _l, value_labels: _v, of, ...rest } = f;
  return of ? { ...rest, of: Object.fromEntries(Object.entries(of).map(([k, x]) => [k, behavior(x)])) } : rest;
};
const facetsOf = (f: Field): FieldFacets => ({
  type: f.type, required: !f.optional && f.default === undefined && !f.generated && !f.derived, values: [...(f.values ?? [])],
});

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function buildGraph(r: Resolved): { nodes: GNode[]; edges: GEdge[] } {
  const { spec } = r;
  const nodes = new Map<string, GNode>();
  const edges = new Map<string, GEdge>();
  const node = (id: string, def: unknown, tags: string[] = []) => {
    nodes.set(id, { id, hash: digestOf(def ?? null), tags: [...new Set(tags)].sort(), boundedBy: [] });
  };
  const edge = (from: string, to: string, kind: EdgeKind) => { edges.set(`${from}|${kind}|${to}`, { from, to, kind }); };
  const pii = (fieldNode: string) => {
    const [obj, f] = fieldNode.slice('field:'.length).split('.') as [string, string];
    return spec.objects[obj]?.fields[f]?.pii === true;
  };
  const refs = (list: string[] | undefined) => (list ?? []).flatMap((ref) => refNodes(spec, r.params, ref) ?? []);

  // Objects and fields.
  for (const [id, obj] of Object.entries(spec.objects)) {
    node(`object:${id}`, { key: obj.key, title: obj.title, source: obj.source ?? null, owner: r.objectOwner[id] });
    for (const [name, f] of Object.entries(obj.fields)) {
      const tags = [...(f.type === 'money' ? ['money'] : []), ...(f.pii ? ['pii'] : []), ...(obj.key === name ? ['key'] : [])];
      node(`field:${id}.${name}`, behavior(f), tags);
      nodes.get(`field:${id}.${name}`)!.facets = facetsOf(f);
    }
  }
  // Template parameters.
  for (const [path, value] of Object.entries(r.params)) node(`param:${path}`, value, r.moneyParams.has(path) ? ['money'] : []);

  // Tools, including the built-in message.send.
  for (const [id, t] of Object.entries(spec.tools)) {
    const reads = refs(t.reads);
    const tags = [
      ...(t.effect === 'external' ? ['external'] : []),
      ...(t.effect === 'money' ? ['money'] : []),
      ...(t.effect === 'notify' ? ['notify'] : []),
      ...(t.effect === 'external' && reads.some((n) => n.startsWith('field:') && pii(n)) ? ['pii_egress'] : []),
    ];
    const { label: _label, ...contract } = t;
    node(`tool:${id}`, { ...contract, owner: r.toolOwner[id] }, tags);
    for (const n of reads) edge(n, `tool:${id}`, 'read_by');
    for (const n of refs(t.writes)) {
      edge(n, `tool:${id}`, 'written_by');
      edge(`tool:${id}`, n, 'writes');
    }
    if (t.connection) edge(`connection:${t.connection}`, `tool:${id}`, 'transports');
  }
  for (const [id, b] of Object.entries(BUILTIN_TOOLS)) node(`tool:${id}`, { builtin: true, ...b }, [b.effect]);

  for (const [id, c] of Object.entries(spec.connections)) node(`connection:${id}`, c, ['external', 'secret']);

  // Agents, personas, decisions.
  for (const [id, a] of Object.entries(spec.agents)) {
    node(`agent:${id}`, { ...a, persona: undefined });
    node(`persona:${id}`, r.personas[id] ?? '');
    edge(`persona:${id}`, `agent:${id}`, 'configures');
    for (const p of personaPlaceholders(spec, r.personas[id] ?? '')) edge(p, `persona:${id}`, 'read_by');
    for (const t of new Set([...a.tools, ...Object.keys(BUILTIN_TOOLS)])) {
      edge(`tool:${t}`, `agent:${id}`, 'contract_of');
      edge(`agent:${id}`, `tool:${t}`, 'may_invoke');
    }
    for (const d of [a.decisions.route, a.decisions.signals, ...(a.decisions.pre_send ?? [])]) {
      if (d) edge(`decision:${d}`, `agent:${id}`, 'informs');
    }
  }
  for (const [id, d] of Object.entries(spec.decisions)) node(`decision:${id}`, d);

  // Policies: guards on their action; the fields and decisions their conditions read.
  for (const p of r.policies) {
    node(`policy:${p.id}`, p.json, ['authz']);
    if (!p.action) continue;
    const tool = `tool:${p.action}`;
    edge(`policy:${p.id}`, tool, 'guards');
    const guarded = nodes.get(tool);
    if (guarded && p.json.effect === 'forbid') guarded.boundedBy.push(`policy:${p.id}`);
    for (const path of p.contextPaths) {
      for (const n of contextRefs(spec, p.action, path)) edge(n, `policy:${p.id}`, n.startsWith('decision:') ? 'informs' : 'read_by');
    }
  }

  // Triggers.
  for (const [id, tr] of Object.entries(spec.triggers)) {
    node(`trigger:${id}`, tr);
    const on = r.triggers[id];
    if (on) edge(`field:${on.object}.${on.field}`, `trigger:${id}`, 'fires');
    edge(`trigger:${id}`, `tool:${tr.call}`, 'calls');
  }

  // Views and extensions.
  for (const [id, v] of Object.entries(spec.ui.views)) {
    node(`view:${id}`, v);
    if (!v.object) continue;
    for (const p of [...(v.card ?? []), ...(v.columns ?? []), ...(v.filters ?? []), ...(v.group_by ? [v.group_by] : [])]) {
      for (const n of fieldPath(spec, v.object, p) ?? []) edge(n, `view:${id}`, 'rendered_by');
    }
  }
  for (const ext of spec.ui.extensions ?? []) node(`ext:${ext.component}`, ext);

  // Governance.
  node('gov:approvals', spec.governance, ['governance']);
  node('gov:risk', spec.risk, ['governance']);
  if ([...r.files.keys()].some((p) => p.startsWith('.github/workflows/'))) {
    node('ci:workflows', Object.fromEntries([...r.files].filter(([p]) => p.startsWith('.github/')).sort(([a], [b]) => cmp(a, b))), ['governance']);
  }

  // Eval cases (test selection only).
  for (const [suite, cases] of Object.entries(r.evalCases)) for (const c of cases) node(`eval:${suite}/${c.id}`, c.content);

  // Labels and agent display names (Q7): one copy node, no edges; changing it is ui.copy.
  const { nodes: labelled, values } = labelsOf(r);
  node('copy:labels', { nodes: labelled, values });

  for (const n of nodes.values()) n.boundedBy.sort();
  return {
    nodes: [...nodes.values()].sort((a, b) => cmp(a.id, b.id)),
    edges: [...edges.values()].sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(a.kind, b.kind)),
  };
}

/** `{{object.field}}` placeholders in a persona (v3 §3.3). */
function personaPlaceholders(spec: Spec, text: string): string[] {
  return [...text.matchAll(/\{\{\s*([a-z_]+)\.([a-z_]+)\s*\}\}/g)]
    .filter((m) => spec.objects[m[1]!]?.fields[m[2]!])
    .map((m) => `field:${m[1]}.${m[2]}`);
}

/**
 * What a policy's `context.*` path reads: `context.input.discount_pct` → the field behind that input's type,
 * `context.customer.age_verified` → field:customer.age_verified, `context.signals.grounded` → decision:send.grounded.
 */
export function contextRefs(spec: Spec, action: string, path: string): string[] {
  const [, head, attr] = path.split('.') as [string, string | undefined, string | undefined];
  if (head === 'input' && attr) {
    const expr = spec.tools[action]?.input[attr]?.replace(/\?$/, '');
    const m = expr && /^([a-z_]+)\.([a-z_]+)$/.exec(expr);
    return m && spec.objects[m[1]!]?.fields[m[2]!] ? [`field:${m[1]}.${m[2]}`] : [];
  }
  if (head === 'signals' && attr) return Object.keys(spec.decisions).filter((d) => d.endsWith(`.${attr}`)).map((d) => `decision:${d}`);
  if (head && attr && spec.objects[head]?.fields[attr]) return [`field:${head}.${attr}`];
  return [];
}

// ── blast radius (v3 §3.5) ──

// def: the node's definition changed; run: its runtime behavior or data may change; call: a tool reached only because
// an agent may now call it differently (PROGRESS.md Q8, an amendment to v3 §3.5's table).
type Mode = 'def' | 'run' | 'call';
export type GraphData = { nodes: GNode[]; edges: GEdge[] };
export interface RiskRules { floors: Record<string, Tier>; changeRules: Record<string, Tier>; cutAtBoundedTools: boolean }
export interface Reason { tier: Tier; rule: string; path: string[] }
export interface BlastRadius {
  tier: Tier;
  delta: Record<string, string>;                     // changed node → change kind ('enum.add_value')
  changed: string[];                                 // the keys of delta, sorted
  reached: string[];                                 // `${mode}|${node}` states, in breadth-first order
  why: Reason[];                                     // the witnesses at the deciding tier
}

// The mode an edge produces, given the mode its source was reached in (undefined: no propagation).
const STEP: Record<EdgeKind, Partial<Record<Mode, Mode>>> = {
  read_by: { def: 'run', run: 'run' },
  written_by: { def: 'def' },              // a field's definition changes its writers' contracts
  writes: { run: 'run', call: 'run' },     // only a behavior change alters the values written
  // A tool called differently doesn't change the agents that share it (Q8): `call` stops here, so a persona edit no
  // longer reaches a co-agent's tools through a shared handoff.staff. A tool whose data or definition changed does.
  contract_of: { def: 'run', run: 'run' },
  may_invoke: { run: 'call' },             // LLM-mediated: cut at bounded tools
  guards: { def: 'run', run: 'run' },
  configures: { def: 'run' },
  informs: { def: 'run', run: 'run' },
  fires: { def: 'run', run: 'run' },
  calls: { def: 'run', run: 'run' },
  rendered_by: { def: 'run', run: 'run' },
  transports: { def: 'run', run: 'run' },
};

/** The change rule a node's change falls under (risk.change_rules); kinds the rules don't name are T2. */
export function changeKind(id: string, b: GNode | undefined, h: GNode | undefined): string {
  const kind = id.slice(0, id.indexOf(':'));
  switch (kind) {
    case 'field': {
      if (!b) return h?.facets?.required ? 'field.add_required' : 'field.add_optional';
      if (!h) return 'field.remove';
      const fb = b.facets, fh = h.facets;
      if (fb && fh) {
        if (fb.type !== fh.type || fb.values.some((v) => !fh.values.includes(v))) return 'field.retype';
        if (!fb.required && fh.required) return 'field.add_required';
        if (fh.values.some((v) => !fb.values.includes(v))) return 'enum.add_value';
      }
      return 'field.change';
    }
    case 'object': return !h ? 'object.remove' : !b ? 'object.add' : 'object.change';
    case 'persona': return 'persona.text';
    case 'policy': return 'policy.any';
    case 'eval': return !h ? 'eval.remove' : !b ? 'eval.add' : 'eval.change';
    case 'decision': return 'decision.threshold';
    case 'tool': return 'tool.contract';
    case 'view': return 'ui.layout';
    case 'ext': return 'extension.code';
    case 'connection': return 'connection.any';
    case 'gov': return 'governance.any';
    case 'ci': return 'ci.any';
    case 'copy': return 'ui.copy';
    default: return `${kind}.change`;
  }
}

export function blastRadius(base: GraphData, head: GraphData, risk: RiskRules): BlastRadius {
  const bn = new Map(base.nodes.map((n) => [n.id, n]));
  const hn = new Map(head.nodes.map((n) => [n.id, n]));
  const delta = new Map<string, string>();
  for (const id of [...new Set([...bn.keys(), ...hn.keys()])].sort()) {
    const b = bn.get(id), h = hn.get(id);
    if (b?.hash !== h?.hash) delta.set(id, changeKind(id, b, h));
  }

  // The union: head nodes win, removed nodes keep their old edges.
  const nodes = new Map([...bn, ...hn]);
  const out = new Map<string, { to: string; kind: EdgeKind }[]>();
  const seen = new Set<string>();
  for (const e of [...head.edges, ...base.edges]) {
    const k = `${e.from}|${e.kind}|${e.to}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.set(e.from, [...(out.get(e.from) ?? []), { to: e.to, kind: e.kind }]);
  }
  const isBounded = (tool: GNode | undefined) =>
    risk.cutAtBoundedTools && !!tool && tool.boundedBy.length > 0 && tool.boundedBy.every((p) => !delta.has(p));

  const parent = new Map<string, string | null>();   // state key `${mode}|${id}` → predecessor
  const queue: [string, Mode][] = [];
  for (const id of delta.keys()) { parent.set(`def|${id}`, null); queue.push([id, 'def']); }
  for (let i = 0; i < queue.length; i++) {
    const [id, mode] = queue[i]!;
    for (const e of out.get(id) ?? []) {
      const next = STEP[e.kind][mode];
      if (!next) continue;
      if (e.kind === 'may_invoke' && isBounded(nodes.get(e.to))) continue;
      const key = `${next}|${e.to}`;
      if (parent.has(key)) continue;
      parent.set(key, `${mode}|${id}`);
      queue.push([e.to, next]);
    }
  }

  const reasons: Reason[] = [];
  for (const [id, change] of delta) reasons.push({ tier: risk.changeRules[change] ?? 2, rule: change, path: [id] });
  for (const key of parent.keys()) {
    const [mode, id] = splitKey(key);
    if (mode === 'def' && !delta.has(id)) continue;  // interface-only impact sets no floor
    for (const tag of nodes.get(id)?.tags ?? []) {
      const floor = risk.floors[tag];
      if (floor !== undefined) reasons.push({ tier: floor, rule: tag, path: witness(parent, key) });
    }
  }
  const tier = Math.max(0, ...reasons.map((r) => r.tier)) as Tier;
  return { tier, delta: Object.fromEntries(delta), changed: [...delta.keys()], reached: [...parent.keys()], why: reasons.filter((r) => r.tier === tier) };
}

function splitKey(key: string): [Mode, string] {
  const i = key.indexOf('|');
  return [key.slice(0, i) as Mode, key.slice(i + 1)];
}

function witness(parent: Map<string, string | null>, key: string): string[] {
  const path: string[] = [];
  for (let k: string | null = key; k; k = parent.get(k) ?? null) path.unshift(splitKey(k)[1]);
  return path;
}
