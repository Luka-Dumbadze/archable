// packages/compiler/src/index.ts (public surface): repository tree in, bundle and digest out (plan §4.3).
// A pure function (I2): no network, clock, randomness or model; same tree, same digest.
import { CompileError as A2AError, deriveA2A } from './a2a';
import { digestOf } from './digest';
import { Errors } from './errors';
import { buildGraph } from './graph/blast';
import { lower } from './lower';
import { normalizeTree, parseSpec } from './parse';
import { resolve } from './resolve';
import type { Bundle, CompileResult, Lock, RepoTree } from './types';

export type { Digest } from './digest';
export { digestOf } from './digest';
export { CompileError, CompileFailure } from './errors';
export type { EdgeKind, GEdge, GNode } from './graph/blast';
export type { ActionFacts, FactLoad } from './cedar-schema';
export type { PolicyBound } from './policy-bounds';
export { boundsOf } from './policy-bounds';
export type { Bundle, CompileResult, Lock, Projections, RepoTree } from './types';

export function compile(tree: RepoTree, lock: Lock): CompileResult {
  const errors = new Errors();
  const files = normalizeTree(tree);

  const spec = parseSpec(files, errors);
  errors.throwIfAny();

  const resolved = resolve(spec!, files, lock, errors);
  errors.throwIfAny();

  const { bundle: lowered, projections, appTitles } = lower(resolved, errors);
  errors.throwIfAny();

  let a2a: Bundle['a2a'] = { nodes: [], edges: [] };
  try {
    a2a = deriveA2A({
      apps: Object.fromEntries(Object.entries(spec!.apps).map(([id, a]) => [id, { title: appTitles[id]!, template: a.template, ...(a.agent ? { agent: a.agent } : {}) }])),
      agents: Object.fromEntries(Object.entries(spec!.agents).map(([id, a]) => [id, { app: a.app, tools: a.tools }])),
      tools: Object.fromEntries(Object.entries(lowered.tools).map(([id, t]) => [id, { app: t.app, effect: t.effect, ...(t.connection ? { connection: t.connection } : {}) }])),
      objects: Object.fromEntries(Object.entries(lowered.objects).map(([id, o]) => [id, { app: o.app }])),
      triggers: spec!.triggers,
      connections: spec!.connections,
    });
  } catch (e) {
    if (!(e instanceof A2AError)) throw e;
    errors.add('a2a', e.message);
  }
  errors.throwIfAny();

  const bundle: Bundle = { ...lowered, graph: buildGraph(resolved), a2a };
  return { bundle, digest: digestOf(bundle), projections };
}
