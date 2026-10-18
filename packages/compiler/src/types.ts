// The compiler's public types (plan §4.3).
import type { A2AGraph, Effect, JsonSchema, WidgetConfig } from '@archable/contracts';
import type { ActionFacts } from './cedar-schema';
import type { Digest } from './digest';
import type { EdgeKind, GNode, RiskRules } from './graph/blast';
import type { BundleLabels } from './labels';
import type { PolicyBound } from './policy-bounds';

export interface RepoTree { files: Record<string, string> }             // path → UTF-8 content; nothing else is read
export interface Lock { compiler: string; templates: Record<string, string>; shell: string }

export interface Bundle {
  apiVersion: 'archable.dev/v3';
  metadata: { id: string; name: string; os_name: string; currency: string; timezone: string; locale: unknown };
  models: Record<'dialogue' | 'vision' | 'patch' | 'decision', { model: string; reasoning?: string; fallback?: string }>;
  deadlines: { route: number; dialogue: number; pre_send: number; tool: number };
  objects: Record<string, { schema: JsonSchema; key: string | null; title: string; app: string; edit_roles: string[]; field_acl: Record<string, string[]> }>;
  tools: Record<string, { app: string; action: string; description: string; input: JsonSchema; output: JsonSchema | null;
                          effect: Effect; reads: string[]; writes: string[]; connection?: string; needsQuote: boolean;
                          idempotency?: string[]; operation_id: string }>;
  agents: Record<string, { app: string; persona: string; tools: string[]; decisions: unknown; context: unknown; display_name: Record<string, string> }>;
  // object/field/values: `on` parsed, so the records trigger in Postgres can match without parsing (P3.D2.3).
  triggers: Record<string, { on: string; call: string; object: string; field: string; values: string[] }>;
  decisions: Record<string, unknown>;                                   // v3 §6 decisions, thresholds included
  policies: { byId: Record<string, string>; schema: unknown; bounds: PolicyBound[]; facts: Record<string, ActionFacts> };
  channels: Record<string, { kind: 'telegram_bot' | 'telegram_business' | 'web'; public?: WidgetConfig }>;   // WidgetConfig incl. embed_origins (Q3)
  apps: Record<string, { template: string; agent: string | null; channels: string[] }>;   // which agent serves which channel
  params: Record<string, unknown>;                                      // apps.*.params, flattened: 'quickshipper.express.surcharge'
  ui: unknown;                                                          // v3 §2.4 UI projection
  risk: RiskRules;                                                      // spec.risk with numeric tiers, for blastRadius
  labels: BundleLabels;                                                 // Q7: node, enum value and context-path labels
  graph: { nodes: GNode[]; edges: { from: string; to: string; kind: EdgeKind }[] };
  a2a: A2AGraph;
  evals: unknown;
  extension_digest: string | null;
}

// The rows registration writes per digest (v3 §8): columns of entity_schemas and apps.
export interface Projections {
  entitySchemas: { entity_type: string; json_schema: JsonSchema; key_field: string | null; title_field: string;
                   edit_roles: string[]; field_acl: Record<string, string[]> }[];
  apps: { app_id: string; template: string; agent_id: string | null; title: string; nav_order: number }[];
}

export interface CompileResult { bundle: Bundle; digest: Digest; projections: Projections }
