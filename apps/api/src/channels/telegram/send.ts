// apps/api/src/channels/telegram/send.ts: one sender for tenant bots, Business (reply and suggest) and web.
// Plan §6.2, completed: Vault, the messages table and the channel pause are injected (DEV-2's db wrappers).
// The token is read from Vault at the last hop, per send; it is never cached, returned or logged.
import { Api, GrammyError } from 'grammy';
import type { ReplyTarget } from '../runtime-stand-in';   // TODO(DEV-2 runtime types): '@archable/runtime'
import type { BotHook } from '../../routes/webhooks';
import type { NoticeKind } from './tenant-bot';

type Sender = Pick<Api, 'sendMessage'>;

export interface SendDeps {
  channelToken(tokenSecret: string): Promise<string>;                // private.channel_secret, tenant-scoped
  archableApi: Sender;                                                 // @ArchableBot: Business replies, suggestions
  record(target: ReplyTarget, text: string, telegramMessageId: number | null): Promise<number>;   // → messages.id
  pauseChannel(channelId: string, reason: string): Promise<void>;     // blocked bot, lapsed Business rights
  noticeText(tenantId: string, kind: NoticeKind): Promise<string>;    // greeting from the spec; the text-only reply
  apiFor?(token: string): Sender;                                      // default: new Api(token)
  sleep?(ms: number): Promise<void>;
}

export type Deliver = (target: ReplyTarget, text: string, o: { suggestion: string | null }) => Promise<number>;

export function createSender(d: SendDeps) {
  const apiFor = d.apiFor ?? ((token: string) => new Api(token));
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // 429: wait retry_after once (at most 5 s), then give up.
  async function withRetry<T>(f: () => Promise<T>): Promise<T> {
    try { return await f(); } catch (e) {
      if (e instanceof GrammyError && e.error_code === 429) {
        await sleep(Math.min(5, e.parameters.retry_after ?? 1) * 1000);
        return f();
      }
      throw e;
    }
  }

  // A 403 (the customer blocked the bot, or Business rights lapsed) pauses the channel; the turn still fails.
  async function toCustomer<T>(channelId: string, f: () => Promise<T>): Promise<T> {
    try { return await withRetry(f); } catch (e) {
      if (e instanceof GrammyError && e.error_code === 403) await d.pauseChannel(channelId, e.description);
      throw e;
    }
  }

  const deliver: Deliver = async (target, text, o) => {
    switch (target.kind) {
      case 'telegram': {
        const token = await d.channelToken(target.tokenSecret);
        const m = await toCustomer(target.channelId, () => apiFor(token).sendMessage(target.chatId, text));
        return d.record(target, text, m.message_id);
      }
      case 'telegram_business': {
        if (target.mode === 'suggest') {                                 // no reply rights: draft to the owner
          if (o.suggestion) await withRetry(() => d.archableApi.sendMessage(target.ownerChatId, `Suggested reply:\n\n${o.suggestion}`));
          return d.record(target, text, null);
        }
        const m = await toCustomer(target.channelId, () =>
          d.archableApi.sendMessage(target.chatId, text, { business_connection_id: target.businessConnectionId }));
        return d.record(target, text, m.message_id);
      }
      case 'web':
      case 'console':
        return d.record(target, text, null);                             // the HTTP response carries it
    }
  };

  // Fixed answers outside a turn (tenant-bot.ts): not recorded as messages.
  async function deliverNotice(hook: BotHook, reply: ReplyTarget, kind: NoticeKind): Promise<void> {
    if (reply.kind !== 'telegram') return;
    const [text, token] = await Promise.all([d.noticeText(hook.tenant_id, kind), d.channelToken(reply.tokenSecret)]);
    await toCustomer(reply.channelId, () => apiFor(token).sendMessage(reply.chatId, text));
  }

  return { deliver, deliverNotice };
}
