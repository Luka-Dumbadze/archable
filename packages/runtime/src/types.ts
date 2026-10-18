// packages/runtime/src/types.ts: the channel-agnostic turn contract. Adapters resolve the tenant;
// the turn engine never sees a channel's wire format, and never sees audio (owner and customer: text only).
import type { Env } from '@archable/contracts';

export type ReplyTarget =
  | { kind: 'telegram'; channelId: string; botId: number; tokenSecret: string; chatId: number }
  | { kind: 'telegram_business'; channelId: string; botId: number; chatId: number; businessConnectionId: string;
      mode: 'reply' | 'suggest'; ownerChatId: number }
  | { kind: 'web'; sessionId: string }                       // the reply is returned to the HTTP caller
  | { kind: 'console' };                                     // /v1/turns: owner or developer trying the agent

export interface Inbound {
  turnId: string;
  tenantId: string;
  env: Env;
  channel: 'telegram' | 'telegram_business' | 'web';
  conversationKey: string;          // conversations.external_id: chat id, business chat id, 'ws_<id>' or 'try_<membership>'
  externalMessageId: string | null; // Telegram message id or the web client's client_msg_id (idempotency)
  text: string;
  customer: { tgUserId?: number; webSessionId?: string; verifiedCustomerId?: string | null };
  reply: ReplyTarget;
}

export interface TurnResult {
  turnId: string;
  text: string;                      // what was sent: the draft, or the holding reply
  allowed: boolean;                  // Cedar message.send verdict
  outboundMessageId: number;         // messages.id
  paused: boolean;                   // a human has taken over this conversation; nothing was sent
}

export type HandleTurn = (inbound: Inbound) => Promise<TurnResult>;

// The sender the turn engine calls (plan §5.4 step 3, signature from plan §6.2). DEV-1 implements it in
// apps/api/src/channels/telegram/send.ts and channels/web; it returns the messages.id of the recorded reply.
// `suggestion` is the checked draft for Business suggest mode, or null when Cedar denied the send.
export type Deliver = (target: ReplyTarget, text: string, o: { suggestion: string | null }) => Promise<number>;
