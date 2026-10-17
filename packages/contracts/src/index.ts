// packages/contracts/src/index.ts: types shared by the API and the shell. The shell imports only this package.

export type Env = 'prod' | `pr-${number}`;

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
