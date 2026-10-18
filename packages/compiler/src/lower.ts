// lower: resolved spec → bundle sections. Money lowers to integer tetri with
// `x-archable: {semantics: "money", currency, scale: 2}` (plan §4.3); everything unordered is sorted (I2).
import type { JsonSchema, Tier } from '@archable/contracts';
import { labelsOf } from './labels';
import type { Field, Spec } from '@archable/schema';
import { cedarArtifacts } from './cedar-schema';
import { digestOf } from './digest';
import { boundsOf } from './policy-bounds';
import type { Errors } from './errors';
import type { Resolved } from './resolve';
import { refNodes } from './resolve';
import type { Bundle, Projections } from './types';

const sorted = <T>(xs: Iterable<T>) => [...xs].sort();
const strip = (id: string) => id.slice(id.indexOf(':') + 1);

const money = (currency: string): JsonSchema => ({ type: 'integer', 'x-archable': { semantics: 'money', currency, scale: 2 } });

const PRIMITIVES: Record<string, (currency: string) => JsonSchema> = {
  string: () => ({ type: 'string' }),
  phone: () => ({ type: 'string', 'x-archable': { semantics: 'phone' } }),
  date: () => ({ type: 'string', format: 'date' }),
  datetime: () => ({ type: 'string', format: 'date-time' }),
  boolean: () => ({ type: 'boolean' }),
  integer: () => ({ type: 'integer' }),
  money,
};

export function fieldSchema(f: Field, currency: string): JsonSchema {
  const x: Record<string, unknown> = {};
  let s: JsonSchema;
  switch (f.type) {
    case 'enum': s = { type: 'string', enum: [...(f.values ?? [])] }; break;
    case 'ref': s = { type: 'string' }; x.ref = f.by ? { object: f.to, by: f.by } : { object: f.to }; break;
    case 'list': s = { type: 'array', items: fieldsSchema(f.of ?? {}, currency) }; break;
    default: s = PRIMITIVES[f.type]!(currency);
  }
  const base = (s['x-archable'] as Record<string, unknown> | undefined) ?? {};
  if (f.type === 'string' && f.max !== undefined) s.maxLength = f.max;
  if (f.type === 'list') {
    if (f.min !== undefined) s.minItems = f.min;
    if (f.max !== undefined) s.maxItems = f.max;
  } else if (f.type !== 'string') {
    if (f.min !== undefined) s.minimum = f.min;
    if (f.max !== undefined) s.maximum = f.max;
  }
  if (f.pattern !== undefined) s.pattern = f.pattern;
  if (f.default !== undefined) s.default = f.default;
  if (f.pii) x.pii = true;
  if (f.generated) { s.readOnly = true; x.generated = f.generated; }
  if (f.derived) { s.readOnly = true; x.derived = f.derived; }
  if (f.index) x.index = f.index;
  const merged = { ...base, ...x };
  if (Object.keys(merged).length) s['x-archable'] = merged;
  return s;
}

export function fieldsSchema(fields: Record<string, Field>, currency: string): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const [name, f] of Object.entries(fields)) properties[name] = fieldSchema(f, currency);
  const required = sorted(Object.entries(fields).filter(([, f]) => !f.optional && f.default === undefined && !f.generated && !f.derived).map(([n]) => n));
  return { type: 'object', additionalProperties: false, properties, required };
}

/**
 * A tool's input or output type expression: 'string', 'money?', 'enum<normal,urgent>', 'list<wine>',
 * 'order{number,total,status}', 'customer' (a record, by key), 'order.lines' or 'wine.grape?' (a field's type).
 */
function typeSchema(spec: Spec, expr: string, where: string, errors: Errors): JsonSchema | null {
  const currency = spec.metadata.currency;
  const prim = PRIMITIVES[expr];
  if (prim) return prim(currency);
  let m = /^enum<([a-z_]+(?:,[a-z_]+)*)>$/.exec(expr);
  if (m) return { type: 'string', enum: m[1]!.split(',') };
  m = /^list<([a-z_]+)>$/.exec(expr);
  if (m) {
    const obj = spec.objects[m[1]!];
    if (obj) return { type: 'array', items: fieldsSchema(obj.fields, currency) };
  }
  m = /^([a-z_]+)\{([a-z_]+(?:,[a-z_]+)*)\}$/.exec(expr);
  if (m) {
    const obj = spec.objects[m[1]!];
    const names = m[2]!.split(',');
    if (obj && names.every((n) => obj.fields[n])) {
      return fieldsSchema(Object.fromEntries(names.map((n) => [n, { ...obj.fields[n]!, optional: false, default: undefined, generated: undefined, derived: undefined }])), currency);
    }
  }
  if (spec.objects[expr]) return { type: 'string', 'x-archable': { ref: { object: expr } } };
  m = /^([a-z_]+)\.([a-z_]+)$/.exec(expr);
  if (m) {
    const f = spec.objects[m[1]!]?.fields[m[2]!];
    if (f) {
      const s = fieldSchema(f, currency);
      delete s.default;
      return s;
    }
  }
  errors.add(where, `cannot resolve type "${expr}"`);
  return null;
}

function signatureSchema(spec: Spec, sig: Record<string, string>, where: string, errors: Errors): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [name, raw] of Object.entries(sig)) {
    const optional = raw.endsWith('?');
    const s = typeSchema(spec, optional ? raw.slice(0, -1) : raw, `${where}.${name}`, errors);
    if (s) properties[name] = s;
    if (!optional) required.push(name);
  }
  return { type: 'object', additionalProperties: false, properties, required: sorted(required) };
}

const tierOf = (t: string) => Number(t.slice(1)) as Tier;

const titleOf = (id: string) => id.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

export type Lowered = Omit<Bundle, 'graph' | 'a2a'>;

export function lower(r: Resolved, errors: Errors): { bundle: Lowered; projections: Projections; appTitles: Record<string, string> } {
  const { spec } = r;
  const currency = spec.metadata.currency;

  const objects: Bundle['objects'] = {};
  for (const [id, obj] of Object.entries(spec.objects)) {
    const editRoles = sorted(Object.entries(spec.roles).filter(([, role]) => role.edits === 'all' || role.edits.includes(id)).map(([n]) => n));
    const fieldAcl: Record<string, string[]> = {};
    for (const [name, f] of Object.entries(obj.fields)) if (f.edit) fieldAcl[name] = sorted(f.edit);
    objects[id] = { schema: fieldsSchema(obj.fields, currency), key: obj.key, title: obj.title, app: r.objectOwner[id]!, edit_roles: editRoles, field_acl: fieldAcl };
  }

  const tools: Bundle['tools'] = {};
  for (const [id, t] of Object.entries(spec.tools)) {
    const where = `tools.${id}`;
    const expand = (refs: string[] | undefined) =>
      sorted(new Set((refs ?? []).flatMap((ref) => refNodes(spec, r.params, ref) ?? []).map(strip)));
    tools[id] = {
      app: r.toolOwner[id]!,
      action: id,
      description: t.description,
      input: signatureSchema(spec, t.input, `${where}.input`, errors),
      output: t.output ? signatureSchema(spec, t.output, `${where}.output`, errors) : null,
      effect: t.effect,
      reads: expand(t.reads),
      writes: expand(t.writes),
      ...(t.connection ? { connection: t.connection } : {}),
      needsQuote: r.policies.some((p) => p.action === id && p.contextPaths.some((c) => c.startsWith('context.quote.'))),
      ...(t.idempotency ? { idempotency: sorted(t.idempotency) } : {}),
      operation_id: id.replace(/\./g, '_'),
    };
  }

  const agents: Bundle['agents'] = {};
  for (const [id, a] of Object.entries(spec.agents)) {
    agents[id] = { app: a.app, persona: r.personas[id]!, tools: sorted(a.tools), decisions: a.decisions, context: a.context ?? {}, display_name: a.display_name };
  }

  const channels: Bundle['channels'] = {};
  for (const [id, c] of Object.entries(spec.channels)) {
    channels[id] = c.kind === 'web'
      ? { kind: 'web', public: { greeting: c.greeting, launcher: c.launcher, brand: spec.ui.theme.brand, embed_origins: sorted(c.embed_origins) } }
      : { kind: c.kind };
  }

  const cedar = cedarArtifacts(spec, r.policies, errors);
  const bounds = r.policies
    .flatMap((p) => boundsOf(p.json))
    .sort((a, b) => (a.policy + a.path < b.policy + b.path ? -1 : a.policy + a.path > b.policy + b.path ? 1 : 0));

  const m = spec.runtime.models;
  const bundle: Lowered = {
    apiVersion: 'archable.dev/v3',
    metadata: { id: spec.metadata.id, name: spec.metadata.name, os_name: spec.metadata.os_name, currency, timezone: spec.metadata.timezone, locale: spec.metadata.locale },
    models: { dialogue: m.dialogue, vision: m.vision, patch: m.patch, decision: m.decision },
    deadlines: spec.runtime.deadlines_ms,
    objects,
    tools,
    agents,
    triggers: Object.fromEntries(Object.entries(spec.triggers).map(([id, t]) => [id, { ...t, ...r.triggers[id]!, values: [...r.triggers[id]!.values].sort() }])),
    decisions: spec.decisions,
    // byId: the policy files plus the generated permits; schema and facts: the context the gateway builds (cedar-schema.ts).
    policies: { byId: { ...Object.fromEntries(r.policies.map((p) => [p.id, p.text])), ...cedar.permits }, schema: cedar.schema, bounds, facts: cedar.facts },
    channels,
    apps: Object.fromEntries(Object.entries(spec.apps).map(([id, a]) => [id, { template: a.template, agent: a.agent ?? null, channels: [...(a.channels ?? [])] }])),
    params: Object.fromEntries(Object.entries(r.params).sort(([a], [b]) => (a < b ? -1 : 1))),
    ui: spec.ui,
    risk: {
      floors: Object.fromEntries(Object.entries(spec.risk.floors).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, t]) => [k, tierOf(t)])),
      changeRules: Object.fromEntries(Object.entries(spec.risk.change_rules).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, t]) => [k, tierOf(t)])),
      cutAtBoundedTools: spec.risk.influence.cut_at_bounded_tools,
    },
    governance: {
      approvals: Object.fromEntries(Object.entries(spec.governance.approvals).sort(([a], [b]) => (a < b ? -1 : 1))),
      delegation: { to: spec.governance.delegation.to, upTo: tierOf(spec.governance.delegation.up_to) },
      cardTtlHours: Object.fromEntries(Object.entries(spec.governance.card_ttl).sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([t, h]) => [tierOf(t), Number(String(h).slice(0, -1))])),
      previewRequiredFrom: tierOf(spec.governance.preview_required_from),
      architect: { maxOpenPrs: spec.governance.architect.max_open_prs, maxPatchAttempts: spec.governance.architect.max_patch_attempts },
    },
    labels: labelsOf(r),
    evals: {
      suites: spec.evals.suites,
      select: spec.evals.select,
      calibration: spec.evals.calibration,
      cases: Object.fromEntries(Object.entries(r.evalCases).map(([s, cs]) => [s, cs.map((c) => ({ id: c.id, path: c.path, digest: digestOf(c.content) }))])),
    },
    extension_digest: null,
  };

  const appTitles = Object.fromEntries(Object.keys(spec.apps).map((id) => [id, titleOf(id)]));
  const navIndex = (id: string) => { const i = spec.ui.nav.indexOf(id); return i < 0 ? spec.ui.nav.length : i; };
  const projections: Projections = {
    entitySchemas: sorted(Object.keys(objects)).map((id) => ({
      entity_type: id,
      json_schema: objects[id]!.schema,
      key_field: objects[id]!.key,
      title_field: objects[id]!.title,
      edit_roles: objects[id]!.edit_roles,
      field_acl: objects[id]!.field_acl,
    })),
    apps: sorted(Object.keys(spec.apps)).map((id) => ({
      app_id: id,
      template: spec.apps[id]!.template,
      agent_id: spec.apps[id]!.agent ?? null,
      title: appTitles[id]!,
      nav_order: navIndex(id),
    })),
  };
  return { bundle, projections, appTitles };
}
