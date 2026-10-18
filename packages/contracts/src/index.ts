// packages/contracts/src/index.ts: types shared by the API and the shell. The shell imports only this package.

export type Tier = 0 | 1 | 2 | 3 | 4;
export type Env = 'prod' | `pr-${number}`;
export type Effect = 'none' | 'internal' | 'notify' | 'external' | 'money';
export type JsonSchema = Record<string, unknown>;

// ── Developer Mode: the app-to-app graph (compiled into bundle.a2a) ──

export interface A2ANode {
  id: string;                        // 'app:contact_center' | 'conn:courier_api'
  kind: 'app' | 'external';
  title: string;                     // 'Contact Center'
  template?: string;                 // 'tpl.contact_center@3'
  agent?: string;                    // 'cellar_master'
  tools: string[];                   // tools this node owns
}

export interface A2AEdge {
  id: string;                        // stable: `${kind}:${from}->${to}:${via}`
  kind: 'tool' | 'event' | 'connection';
  from: string;
  to: string;
  via: string;                       // tool id, trigger id or connection id
  label: string;                     // 'A2A tool: delivery.status'
  transport: 'in_process' | 'mcp';   // in_process: Tool Gateway; mcp: an outside server (Elva-hosted)
  effect: Effect;
}

export interface A2AGraph {
  nodes: A2ANode[];
  edges: A2AEdge[];
}

export interface EdgeStats {
  window: '24h';
  calls: number;
  denied: number;
  errors: number;
  p50_ms: number | null;
  p95_ms: number | null;
}

export interface EdgeCall {
  id: number;
  at: string;
  caller: string;
  tool: string;
  decision: 'allow' | 'deny';
  status: 'ok' | 'error' | 'denied' | 'simulated';
  latency_ms: number | null;
  policies: string[];
  turn_id: string | null;            // links to the turn inspector; payloads are never stored
}

export interface EdgeDetail {
  edge: A2AEdge;
  contract: {
    tool: string;
    description: string;
    input: JsonSchema;
    output: JsonSchema | null;
    operation_id: string;            // the operation in contracts/openapi.yaml, which Elva imports
    git_sha: string;
  } | null;                          // null for event edges
  elva: { playground_url: string | null; sync: 'in_sync' | 'drift' | 'unknown' };
  stats: EdgeStats;
  recent: EdgeCall[];
}

// ── Decision rationale ──

export interface RationaleFact {
  text: string;                      // one plain-language sentence
  source: string;                    // where the sentence came from; shown in Developer Mode
}

export interface RationaleCard {
  version: 1;
  subject:
    | { kind: 'change'; change_request_id: string; desire: string; head_sha: string }
    | { kind: 'action'; turn_id: string; tool: string };
  trigger: RationaleFact[];
  impact: RationaleFact[];
  risk: RationaleFact[];
  action: RationaleFact[];
  verification: RationaleFact[];
  computed_at: string;
}

// ── Web chat ──

export interface ChatSessionResponse {
  token: string;                     // 1 h bearer for /v1/chat/*
  secret?: string;                   // only when a new session was opened; the iframe stores it
  session_id: string;
}

export interface ChatMessage {
  id: number;
  author: 'customer' | 'agent' | 'staff';
  text: string;
  at: string;
}

// ── Shell boot ──

export interface Manifest {
  tenant_id: string;
  slug: string;
  env: Env;
  digest: string;
  epoch: number;
  os_name: string;
  branding: { brand: string; font: string; radius: string };
  extension_url: string | null;
  topic: string;                     // 'tenant:<id>'
}

// GET /v1/bundles/:digest/ui (v3 §2.4): what the shell renders for one digest, cached forever (a digest never changes
// meaning). The bundle's ui section itself (theme, nav, views, extensions: DEV-1's spec reads bundle.ui), and beside it
// the per-digest projections (v3 §8 apps, entity_schemas) and the labels (Q7); never personas, policies or prompts.
export interface BundleUi {
  theme: { brand: string; radius: string; font: string };
  nav: string[];
  views: Record<string, { app: string; kind: 'chapters' | 'board' | 'list' | 'table'; object?: string; group_by?: string;
                          card?: string[]; columns?: string[]; filters?: string[] }>;
  extensions?: { slot: string; component: string }[];
}
export interface UiProjection extends BundleUi {
  digest: string;
  apps: { app_id: string; title: string; template: string; agent_id: string | null; nav_order: number }[];
  objects: Record<string, { schema: JsonSchema; key: string | null; title: string; edit_roles: string[]; field_acl: Record<string, string[]> }>;
  labels: { nodes: Record<string, Record<string, string>>; values: Record<string, Record<string, string>> };
}

// ── Desires Feed (Developer Mode; DEV-1's proposal, PROGRESS.md Q9 (4)) ──

export interface DesireImpactView {                // one row of public.desire_impact(); money in tetri
  chapters: number; customers: number; quoted: number; abandoned: number; abandoned_value: number; ordered: number;
  first_seen: string | null; last_seen: string | null;
}
export interface DesireChat {
  chapter_id: string;
  customer: string | null;                         // the customer's display name, if the chat is linked to one
  opened_at: string;
  last_quote_total: number | null;                 // tetri
  ordered: boolean;
  linked_by: string;                               // 'jev:desire.dedupe' | 'owner' | 'developer'
  excerpt: string | null;                          // the chat's first customer message, shortened
}
export interface DesireView {
  id: string; number: number; statement: string; status: string; tier: number | null;
  impact: DesireImpactView;
  chats: DesireChat[];                             // linked chats only; an unlinked chat leaves this list
  rationale_card: RationaleCard | null;
}

// ── Owner conversation (plan §8.4 addition): what a button is, so the web and Telegram render the same choices ──

export type OwnerButton =
  | { label: string; action: 'url'; url: string }
  | { label: string; action: 'post'; path: string; body: Record<string, unknown> };
export interface OwnerReply { text: string; buttons: OwnerButton[] }

// ── Web chat widget (plan §6.5, + embed_origins per decision Q3) ──

export interface WidgetConfig {                 // public projection of spec channels.web_chat + ui.theme
  greeting: Record<string, string>;
  launcher: { label: Record<string, string>; position: 'left' | 'right' };
  brand: string;                                // '#7B1E3A'
  embed_origins: string[];                      // sites allowed to frame /chat (frame-ancestors); [] = only *.archable.run
}
