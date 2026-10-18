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
