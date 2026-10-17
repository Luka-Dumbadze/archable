// packages/schema/src/spec.ts: enterprise.spec.yaml v3 (v3 §6) with the v3.1 additions (plan §1.5).
// Shapes only. References between keys (a tool naming an object, an agent naming a tool) are resolved by the compiler.
import { z } from 'zod';

const Key = z.string().regex(/^[a-z_][a-z0-9_]*$/);                      // objects, fields, apps, agents, …
const DottedId = z.string().regex(/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)+$/);   // tools, decisions: 'order.create'
const Tier = z.enum(['T0', 'T1', 'T2', 'T3', 'T4']);
const Localized = z.record(z.string(), z.string());                       // { ka: …, en: … }
const Scalar = z.union([z.string(), z.number(), z.boolean()]);

export const FieldType = z.enum(['string', 'phone', 'date', 'datetime', 'boolean', 'integer', 'enum', 'money', 'ref', 'list']);

export interface Field {
  type: z.infer<typeof FieldType>;
  optional?: boolean;
  default?: string | number | boolean;
  pii?: boolean;
  min?: number;
  max?: number;
  pattern?: string;
  values?: string[];
  to?: string;
  by?: string;
  of?: Record<string, Field>;
  edit?: string[];
  index?: 'range';
  generated?: string;
  derived?: string;
}

export const Field: z.ZodType<Field> = z.lazy(() =>
  z.strictObject({
    type: FieldType,
    optional: z.boolean().optional(),
    default: Scalar.optional(),
    pii: z.boolean().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    pattern: z.string().optional(),
    values: z.array(Key).min(1).optional(),
    to: Key.optional(),                                                   // ref target object
    by: Key.optional(),                                                   // ref by a field other than the key
    of: z.record(Key, Field).optional(),                                  // list item fields
    edit: z.array(Key).optional(),                                        // roles allowed to edit through the shell
    index: z.literal('range').optional(),
    generated: z.string().optional(),                                     // 'M-{seq:5}'
    derived: z.string().optional(),                                       // CEL; never written by a model
  }).superRefine((f, ctx) => {
    if (f.type === 'enum' && !f.values) ctx.addIssue({ code: 'custom', message: 'enum needs values' });
    if (f.type === 'ref' && !f.to) ctx.addIssue({ code: 'custom', message: 'ref needs to' });
    if (f.type === 'list' && !f.of) ctx.addIssue({ code: 'custom', message: 'list needs of' });
  }),
);

const ObjectDef = z.strictObject({
  key: Key,
  title: Key,
  source: z.literal('evidence').optional(),
  fields: z.record(Key, Field),
});

const ModelLane = z.strictObject({
  model: z.string(),
  reasoning: z.enum(['low', 'medium', 'high']).optional(),
  fallback: z.string().optional(),
});

const Runtime = z.strictObject({
  models: z.strictObject({ dialogue: ModelLane, vision: ModelLane, patch: ModelLane, decision: ModelLane }),
  deadlines_ms: z.strictObject({ route: z.number().int(), dialogue: z.number().int(), pre_send: z.number().int(), tool: z.number().int() }),
});

const Role = z.strictObject({
  approves: z.array(Tier).optional(),
  reviews: z.array(Tier).optional(),
  handles: z.array(z.string()).optional(),
  edits: z.union([z.literal('all'), z.array(Key)]),
});

const App = z.strictObject({
  template: z.string().regex(/^tpl\.[a-z_]+@\d+$/),                     // 'tpl.contact_center@3'
  agent: Key.optional(),
  channels: z.array(Key).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});

const Agent = z.strictObject({
  app: Key,
  preset: z.enum(['role_based', 'personal', 'domain_themed']),
  display_name: Localized,
  persona: z.string(),                                                    // path in the repo tree
  lane: z.enum(['dialogue', 'vision', 'patch', 'decision']),
  tools: z.array(DottedId),
  decisions: z.strictObject({
    route: DottedId.optional(),
    signals: DottedId.optional(),
    pre_send: z.array(DottedId).optional(),
  }),
  context: z.strictObject({
    conversation_tail: z.number().int().optional(),
    chapter_summary: z.boolean().optional(),
    records: z.array(Key).optional(),
  }).optional(),
});

export const Effect = z.enum(['none', 'internal', 'notify', 'external', 'money']);

const Tool = z.strictObject({
  app: Key.optional(),                                                    // owner; overrides the template manifest (plan §1.5)
  description: z.string(),
  input: z.record(Key, z.string()),                                       // field → type expression ('order.lines', 'money?')
  output: z.record(Key, z.string()).optional(),
  reads: z.array(z.string()).optional(),
  writes: z.array(z.string()).optional(),
  effect: Effect,
  connection: Key.optional(),
  idempotency: z.array(Key).optional(),
});

const Trigger = z.strictObject({ on: z.string(), call: DottedId });

const Connection = z.strictObject({
  kind: z.literal('mcp'),
  url: z.url(),
  auth: z.strictObject({ scheme: z.literal('bearer'), secret: z.string().regex(/^vault:/) }),
  map: z.record(Key, DottedId).optional(),
});

const Channel = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('telegram_bot') }),
  z.strictObject({ kind: z.literal('telegram_business'), via: z.literal('archable_bot'), without_reply_rights: z.enum(['suggest']) }),
  z.strictObject({
    kind: z.literal('web'),
    greeting: Localized,
    launcher: z.strictObject({ label: Localized, position: z.enum(['left', 'right']) }),
    embed_origins: z.array(z.url()),
  }),
]);

const Escalate = z.strictObject({
  confidence_below: z.number().optional(),
  probability_between: z.tuple([z.number(), z.number()]).optional(),
});

const Decision = z.strictObject({
  kind: z.enum(['choice', 'score', 'boolean']),
  stage: z.enum(['route', 'pre_send']),
  state: z.array(z.string()).optional(),
  instructions: z.string().optional(),
  criteria: z.union([z.record(Key, z.string()), z.array(Key)]).optional(),
  escalate: Escalate.optional(),
  capture_failure_at: Key.optional(),
  pass_at: z.number().optional(),
  block_at: z.number().optional(),
});

const Risk = z.strictObject({
  floors: z.record(Key, Tier),
  change_rules: z.record(z.string(), Tier),
  influence: z.strictObject({ cut_at_bounded_tools: z.boolean() }),
});

const Governance = z.strictObject({
  approvals: z.record(Tier, z.array(z.string())),
  delegation: z.strictObject({ to: Key, up_to: Tier }),
  card_ttl: z.partialRecord(Tier, z.string().regex(/^\d+h$/)),             // T0 needs no card
  preview_required_from: Tier,
  architect: z.strictObject({ max_open_prs: z.number().int(), max_patch_attempts: z.number().int() }),
});

const Suite = z.union([
  z.strictObject({
    path: z.string(),
    runs: z.number().int().min(1),
    gate: z.union([z.literal('all_pass'), z.strictObject({ wilson_lb: z.number() })]),
  }),
  z.strictObject({ source: z.literal('platform'), from_tier: Tier }),
]);

const Evals = z.strictObject({
  suites: z.record(Key, Suite),
  select: z.literal('blast_radius'),
  calibration: z.strictObject({ path: z.string(), refresh: z.string() }),
});

const Ui = z.strictObject({
  theme: z.strictObject({ brand: z.string().regex(/^#[0-9A-Fa-f]{6}$/), radius: z.string(), font: z.string() }),
  nav: z.array(Key),
  views: z.record(Key, z.strictObject({
    app: Key,
    kind: z.enum(['chapters', 'board', 'list', 'table']),
    object: Key.optional(),
    group_by: z.string().optional(),
    card: z.array(z.string()).optional(),
    columns: z.array(z.string()).optional(),
    filters: z.array(z.string()).optional(),
  })),
  extensions: z.array(z.strictObject({ slot: z.string(), component: z.string() })).optional(),
});

export const Spec = z.strictObject({
  apiVersion: z.literal('archable.dev/v3'),
  kind: z.literal('Enterprise'),
  metadata: z.strictObject({
    id: Key,
    name: z.string(),
    os_name: z.string(),
    archetype: z.string(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    timezone: z.string(),
    locale: z.strictObject({ primary: z.string(), also: z.array(z.string()).optional(), scripts: z.array(z.string()).optional() }),
  }),
  runtime: Runtime,
  roles: z.record(Key, Role),
  objects: z.record(Key, ObjectDef),
  apps: z.record(Key, App),
  agents: z.record(Key, Agent),
  tools: z.record(DottedId, Tool),
  triggers: z.record(Key, Trigger).default({}),
  connections: z.record(Key, Connection).default({}),
  channels: z.record(Key, Channel).default({}),
  decisions: z.record(DottedId, Decision).default({}),
  policies: z.strictObject({ files: z.array(z.string().regex(/^policies\/.+\.cedar$/)), default: z.literal('deny') }),
  risk: Risk,
  governance: Governance,
  evals: Evals,
  ui: Ui,
});

export type Spec = z.infer<typeof Spec>;
export type ToolDef = z.infer<typeof Tool>;
export type ChannelDef = z.infer<typeof Channel>;
