// packages/compiler/src/a2a.ts: the app-to-app graph, derived from the spec like the blast-radius graph.
// Pure and deterministic (I2): sorted output, no clock, no I/O.
import type { A2AEdge, A2AGraph, A2ANode, Effect } from '@archable/contracts';

export interface A2AInput {
  apps: Record<string, { title: string; template: string; agent?: string }>;
  agents: Record<string, { app: string; tools: string[] }>;
  tools: Record<string, { app: string; effect: Effect; connection?: string }>;   // app: owner, from the template manifest
  objects: Record<string, { app: string }>;                                       // owner, from the template manifest
  triggers: Record<string, { on: string; call: string }>;                         // on: 'delivery_job.status -> delivered'
  connections: Record<string, { kind: string }>;
}

export class CompileError extends Error {}

export function deriveA2A(s: A2AInput): A2AGraph {
  const nodes = new Map<string, A2ANode>();
  const edges = new Map<string, A2AEdge>();
  const appNode = (app: string) => {
    const a = s.apps[app];
    if (!a) throw new CompileError(`unknown app "${app}"`);
    return `app:${app}`;
  };
  const toolOf = (id: string) => {
    const t = s.tools[id];
    if (!t) throw new CompileError(`unknown tool "${id}"`);
    return t;
  };
  const add = (e: Omit<A2AEdge, 'id'>) => {
    const id = `${e.kind}:${e.from}->${e.to}:${e.via}`;
    edges.set(id, { id, ...e });
  };

  for (const [id, a] of Object.entries(s.apps)) {
    nodes.set(`app:${id}`, { id: `app:${id}`, kind: 'app', title: a.title, template: a.template, agent: a.agent, tools: [] });
  }
  for (const [id, t] of Object.entries(s.tools)) {
    nodes.get(appNode(t.app))!.tools.push(id);
    if (t.connection) {                                   // a tool that leaves the system through an outside server
      if (!s.connections[t.connection]) throw new CompileError(`unknown connection "${t.connection}"`);
      const conn = `conn:${t.connection}`;
      nodes.set(conn, { id: conn, kind: 'external', title: t.connection, tools: [] });
      add({ kind: 'connection', from: appNode(t.app), to: conn, via: id, label: `MCP: ${id}`, transport: 'mcp', effect: t.effect });
    }
  }
  for (const a of Object.values(s.agents)) {              // an agent calling a tool another app owns
    for (const id of a.tools) {
      const t = toolOf(id);
      if (t.app === a.app) continue;
      add({ kind: 'tool', from: appNode(a.app), to: appNode(t.app), via: id, label: `A2A tool: ${id}`,
            transport: 'in_process', effect: t.effect });
    }
  }
  for (const [id, tr] of Object.entries(s.triggers)) {    // a fact changing in one app wakes another
    const m = /^([a-z_]+)\.([a-z_]+)\s*->\s*(.+)$/.exec(tr.on);
    if (!m) throw new CompileError(`trigger "${id}": cannot parse "${tr.on}"`);
    const [, object, field, value] = m as unknown as [string, string, string, string];
    const owner = s.objects[object];
    if (!owner) throw new CompileError(`trigger "${id}": unknown object "${object}"`);
    const t = toolOf(tr.call);
    if (owner.app === t.app) continue;
    add({ kind: 'event', from: appNode(owner.app), to: appNode(t.app), via: id,
          label: `A2A event: ${object}.${field} → ${value.trim()}`, transport: 'in_process', effect: t.effect });
  }

  const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const n of nodes.values()) n.tools.sort();
  return { nodes: [...nodes.values()].sort(byId), edges: [...edges.values()].sort(byId) };
}
