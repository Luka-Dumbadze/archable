// packages/compiler/src/graph/blast.ts: the blast-radius graph (v3 §3). Edges point the way impact flows,
// one per row of the v3 §3.3 table. Phase 1 builds the graph; blastRadius() over base and head comes in Phase 4.
import type { Spec } from '@archable/schema';
import { digestOf } from '../digest';
import { BUILTIN_TOOLS, fieldPath, refNodes, type Resolved } from '../resolve';

export type EdgeKind = 'read_by' | 'written_by' | 'writes' | 'contract_of' | 'may_invoke' | 'guards'
  | 'configures' | 'informs' | 'fires' | 'calls' | 'rendered_by' | 'transports';

export interface GNode { id: string; hash: string; tags: string[]; boundedBy: string[] }
export interface GEdge { from: string; to: string; kind: EdgeKind }

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
      node(`field:${id}.${name}`, f, tags);
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
    node(`tool:${id}`, { ...t, owner: r.toolOwner[id] }, tags);
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
function contextRefs(spec: Spec, action: string, path: string): string[] {
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
