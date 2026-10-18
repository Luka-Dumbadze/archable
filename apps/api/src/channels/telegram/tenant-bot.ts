// apps/api/src/channels/telegram/tenant-bot.ts: a tenant bot's update becomes an Inbound. Text only.
// Plan §6.2, completed: handleTurn and the notice sender are injected (DEV-2's turn engine, send.ts).
import { randomUUID } from 'node:crypto';
import type { Update } from 'grammy/types';
import type { HandleTurn, ReplyTarget } from '@archable/runtime';
import type { BotHook } from '../../routes/webhooks';

export type NoticeKind = 'text_only' | 'greeting';

export interface TenantBotDeps {
  handleTurn: HandleTurn;
  deliverNotice(hook: BotHook, reply: ReplyTarget, kind: NoticeKind): Promise<void>;
}

export function tenantBotDispatcher(d: TenantBotDeps) {
  return async function dispatchTenantUpdate(hook: BotHook, u: Update): Promise<void> {
    const m = u.message;
    if (!m || m.chat.type !== 'private') return;                          // groups and channels are out of scope
    const reply: ReplyTarget = { kind: 'telegram', channelId: hook.channel_id, botId: hook.bot_id,
                                 tokenSecret: hook.token_secret, chatId: m.chat.id };
    if (!m.text) return d.deliverNotice(hook, reply, 'text_only');      // voice, audio, photos: "please type"
    if (m.text.startsWith('/start')) return d.deliverNotice(hook, reply, 'greeting');
    await d.handleTurn({
      turnId: randomUUID(), tenantId: hook.tenant_id, env: 'prod', channel: 'telegram',
      conversationKey: String(m.chat.id), externalMessageId: String(m.message_id), text: m.text,
      customer: { tgUserId: m.from?.id }, reply,
    });
  };
}
