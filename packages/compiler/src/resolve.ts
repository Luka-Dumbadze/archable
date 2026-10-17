// resolve: every reference in the spec must resolve (v3 §3.3), and every tool and object gets an owning app,
// from the spec's `app:` or else from the app's template manifest (PROGRESS.md Q4).
import type { Spec } from '@archable/schema';
import YAML from 'yaml';
import { parsePolicies, type ParsedPolicy } from './cedar';
import type { Errors } from './errors';
import type { Files } from './parse';
import { TEMPLATES } from './templates';
import type { Lock } from './types';

export const BUILTIN_TOOLS: Record<string, { effect: 'external' }> = { 'message.send': { effect: 'external' } };

export interface TriggerOn { object: string; field: string; values: string[] }

export interface Resolved {
  spec: Spec;
  files: Files;
  toolOwner: Record<string, string>;
  objectOwner: Record<string, string>;
  params: Record<string, unknown>;                           // 'quickshipper.express.surcharge' → 1000
  moneyParams: Set<string>;
  policies: ParsedPolicy[];
  personas: Record<string, string>;                          // agent → persona text
  triggers: Record<string, TriggerOn>;
  evalCases: Record<string, { id: string; path: string; content: string }[]>;
}

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function flattenParams(prefix: string, v: unknown, out: Record<string, unknown>): void {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) flattenParams(`${prefix}.${k}`, x, out);
  } else out[prefix] = v;
}

/** Node ids a `reads`/`writes` entry stands for: `wine.*`, `order.total`, `quickshipper.express.surcharge`. */
export function refNodes(spec: Spec, params: Record<string, unknown>, ref: string): string[] | null {
  const [head, ...rest] = ref.split('.');
  if (!head || !rest.length) return null;
  const obj = spec.objects[head];
  if (obj) {
    if (rest.length !== 1) return null;
    if (rest[0] === '*') return Object.keys(obj.fields).sort().map((f) => `field:${head}.${f}`);
    return has(obj.fields, rest[0]!) ? [`field:${ref}`] : null;
  }
  if (spec.apps[head]) {
    const leaves = Object.keys(params).filter((p) => p === ref || p.startsWith(`${ref}.`)).sort();
    return leaves.length ? leaves.map((p) => `param:${p}`) : null;
  }
  return null;
}

/** Field nodes along a path from an object through refs: ('order', 'customer.name') → order.customer, customer.name. */
export function fieldPath(spec: Spec, object: string, path: string): string[] | null {
  const nodes: string[] = [];
  let current = object;
  const segments = path.split('.');
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const field = spec.objects[current]?.fields[seg];
    if (!field) return null;
    nodes.push(`field:${current}.${seg}`);
    if (i < segments.length - 1) {
      if (field.type !== 'ref' || !field.to) return null;
      current = field.to;
    }
  }
  return nodes;
}

export function resolve(spec: Spec, files: Files, lock: Lock, errors: Errors): Resolved {
  const toolIds = new Set([...Object.keys(spec.tools), ...Object.keys(BUILTIN_TOOLS)]);

  // Apps and their templates.
  const claimsTool = new Map<string, string[]>();
  const claimsObject = new Map<string, string[]>();
  const moneyParams = new Set<string>();
  const params: Record<string, unknown> = {};
  for (const [id, app] of Object.entries(spec.apps)) {
    const where = `apps.${id}`;
    const manifest = TEMPLATES[app.template];
    const [name, major] = app.template.split('@') as [string, string];
    const pinned = lock.templates[name];
    if (!manifest) errors.add(`${where}.template`, `unknown template "${app.template}"`);
    else if (!pinned) errors.add(`${where}.template`, `"${name}" is not pinned in archable.lock`);
    else if (pinned.split('.')[0] !== major) errors.add(`${where}.template`, `archable.lock pins ${name} ${pinned}, not major ${major}`);
    if (manifest) {
      for (const t of manifest.tools) claimsTool.set(t, [...(claimsTool.get(t) ?? []), id]);
      for (const o of manifest.objects) claimsObject.set(o, [...(claimsObject.get(o) ?? []), id]);
      for (const p of manifest.moneyParams) moneyParams.add(`${id}.${p}`);
    }
    if (app.params) flattenParams(id, app.params, params);
    if (app.agent && spec.agents[app.agent]?.app !== id) errors.add(`${where}.agent`, `agent "${app.agent}" does not belong to this app`);
    app.channels?.forEach((c, i) => { if (!spec.channels[c]) errors.add(`${where}.channels.${i}`, `unknown channel "${c}"`); });
  }

  // Objects: owners and field references.
  const objectOwner: Record<string, string> = {};
  for (const [id, obj] of Object.entries(spec.objects)) {
    const owners = claimsObject.get(id) ?? [];
    if (owners.length === 1) objectOwner[id] = owners[0]!;
    else errors.add(`objects.${id}`, owners.length ? `owned by several apps: ${owners.join(', ')}` : 'no app template owns this object');
    if (!has(obj.fields, obj.key)) errors.add(`objects.${id}.key`, `unknown field "${obj.key}"`);
    if (!has(obj.fields, obj.title)) errors.add(`objects.${id}.title`, `unknown field "${obj.title}"`);
    const checkFields = (fields: typeof obj.fields, where: string) => {
      for (const [name, f] of Object.entries(fields)) {
        const at = `${where}.${name}`;
        if (f.to && !spec.objects[f.to]) errors.add(`${at}.to`, `unknown object "${f.to}"`);
        if (f.to && f.by && !has(spec.objects[f.to]?.fields ?? {}, f.by)) errors.add(`${at}.by`, `unknown field "${f.to}.${f.by}"`);
        f.edit?.forEach((r, i) => { if (!spec.roles[r]) errors.add(`${at}.edit.${i}`, `unknown role "${r}"`); });
        if (f.of) checkFields(f.of, `${at}.of`);
      }
    };
    checkFields(obj.fields, `objects.${id}.fields`);
  }

  for (const [id, role] of Object.entries(spec.roles)) {
    if (Array.isArray(role.edits)) {
      role.edits.forEach((o, i) => { if (!spec.objects[o]) errors.add(`roles.${id}.edits.${i}`, `unknown object "${o}"`); });
    }
  }

  // Tools: owners and references.
  const toolOwner: Record<string, string> = {};
  for (const [id, tool] of Object.entries(spec.tools)) {
    const where = `tools.${id}`;
    if (tool.app) {
      if (spec.apps[tool.app]) toolOwner[id] = tool.app;
      else errors.add(`${where}.app`, `unknown app "${tool.app}"`);
    } else {
      const owners = claimsTool.get(id) ?? [];
      if (owners.length === 1) toolOwner[id] = owners[0]!;
      else errors.add(where, owners.length ? `owned by several apps: ${owners.join(', ')}; set tools.${id}.app` : 'no app template owns this tool; set app');
    }
    for (const key of ['reads', 'writes'] as const) {
      tool[key]?.forEach((ref, i) => {
        if (!refNodes(spec, params, ref)) errors.add(`${where}.${key}.${i}`, `cannot resolve "${ref}"`);
      });
    }
    if (tool.connection && !spec.connections[tool.connection]) errors.add(`${where}.connection`, `unknown connection "${tool.connection}"`);
    tool.idempotency?.forEach((k, i) => { if (!has(tool.input, k)) errors.add(`${where}.idempotency.${i}`, `"${k}" is not an input`); });
  }

  for (const [id, conn] of Object.entries(spec.connections)) {
    for (const [op, tool] of Object.entries(conn.map ?? {})) {
      if (!spec.tools[tool]) errors.add(`connections.${id}.map.${op}`, `unknown tool "${tool}"`);
    }
  }

  // Agents.
  const personas: Record<string, string> = {};
  for (const [id, agent] of Object.entries(spec.agents)) {
    const where = `agents.${id}`;
    if (!spec.apps[agent.app]) errors.add(`${where}.app`, `unknown app "${agent.app}"`);
    agent.tools.forEach((t, i) => { if (!toolIds.has(t)) errors.add(`${where}.tools.${i}`, `unknown tool "${t}"`); });
    const decisions = [agent.decisions.route, agent.decisions.signals, ...(agent.decisions.pre_send ?? [])];
    for (const d of decisions) if (d && !spec.decisions[d]) errors.add(`${where}.decisions`, `unknown decision "${d}"`);
    agent.context?.records?.forEach((o, i) => { if (!spec.objects[o]) errors.add(`${where}.context.records.${i}`, `unknown object "${o}"`); });
    const persona = files.get(agent.persona);
    if (persona === undefined) errors.add(`${where}.persona`, `file not found: ${agent.persona}`);
    else personas[id] = persona;
  }

  // Triggers: `on: "<object>.<field> -> <value>|<value>"`, an enum field and its values.
  const triggers: Record<string, TriggerOn> = {};
  for (const [id, tr] of Object.entries(spec.triggers)) {
    const where = `triggers.${id}`;
    const m = /^([a-z_]+)\.([a-z_]+)\s*->\s*(.+)$/.exec(tr.on);
    if (!spec.tools[tr.call]) errors.add(`${where}.call`, `unknown tool "${tr.call}"`);
    if (!m) {
      errors.add(`${where}.on`, `cannot parse "${tr.on}"`);
      continue;
    }
    const [, object, field, rhs] = m as unknown as [string, string, string, string];
    const f = spec.objects[object]?.fields[field];
    const values = rhs.split('|').map((v) => v.trim());
    if (!f) errors.add(`${where}.on`, `unknown field "${object}.${field}"`);
    else if (f.type !== 'enum') errors.add(`${where}.on`, `"${object}.${field}" is not an enum`);
    else for (const v of values) if (!f.values?.includes(v)) errors.add(`${where}.on`, `unknown enum "${v}" for ${object}.${field}`);
    triggers[id] = { object, field, values };
  }

  // Policies: actions name tools; `context.input.*` names an input of that tool.
  const policies = parsePolicies(files, spec.policies.files, errors);
  for (const p of policies) {
    if (!p.action) continue;
    if (!toolIds.has(p.action)) {
      errors.add(`${p.file}#${p.id}`, `unknown action "${p.action}"`);
      continue;
    }
    const input = spec.tools[p.action]?.input ?? {};
    for (const path of p.contextPaths) {
      const m = /^context\.input\.([a-z_]+)/.exec(path);
      if (m && !has(input, m[1]!)) errors.add(`${p.file}#${p.id}`, `"${m[1]}" is not an input of ${p.action}`);
    }
  }

  // UI.
  spec.ui.nav.forEach((a, i) => { if (!spec.apps[a]) errors.add(`ui.nav.${i}`, `unknown app "${a}"`); });
  for (const [id, view] of Object.entries(spec.ui.views)) {
    const where = `ui.views.${id}`;
    if (!spec.apps[view.app]) errors.add(`${where}.app`, `unknown app "${view.app}"`);
    if (view.object && !spec.objects[view.object]) {
      errors.add(`${where}.object`, `unknown object "${view.object}"`);
      continue;
    }
    for (const key of ['card', 'columns', 'filters'] as const) {
      view[key]?.forEach((p, i) => {
        if (view.object && !fieldPath(spec, view.object, p)) errors.add(`${where}.${key}.${i}`, `cannot resolve "${p}"`);
      });
    }
    if (view.object && view.group_by && !fieldPath(spec, view.object, view.group_by)) {
      errors.add(`${where}.group_by`, `cannot resolve "${view.group_by}"`);
    }
  }

  // Eval cases: the YAML files under each suite's path.
  const evalCases: Resolved['evalCases'] = {};
  for (const [suite, def] of Object.entries(spec.evals.suites)) {
    if (!('path' in def)) continue;
    const cases: Resolved['evalCases'][string] = [];
    for (const [path, content] of files) {
      if (!path.startsWith(`${def.path}/`) || !/\.ya?ml$/.test(path)) continue;
      const doc = YAML.parseDocument(content);
      const id = doc.errors.length ? null : (doc.toJS() as { id?: unknown } | null)?.id;
      if (typeof id !== 'string') errors.add(path, 'eval case needs a string id');
      else cases.push({ id, path, content });
    }
    evalCases[suite] = cases.sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  return { spec, files, toolOwner, objectOwner, params, moneyParams, policies, personas, triggers, evalCases };
}
