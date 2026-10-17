// apps/api/src/channels/telegram/archable-bot.ts: @ArchableBot, the owner's and staff's bot.
// Owner input is text and inline buttons only. Customers reach it only through Telegram Business.
import { Bot, InlineKeyboard, type Context } from 'grammy';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import type { OwnerButton, OwnerReply } from '@archable/contracts';
import type { Inbound } from '../runtime-stand-in';   // TODO(DEV-2 runtime types): '@archable/runtime'

type Outcome = string;
export interface ArchableBotDeps {
  // channels
  ownerTenants(tgUserId: number): Promise<{ tenant_id: string; slug: string; os_name: string; membership_id: string }[]>;
  createLinkIntent(tenantId: string, membershipId: string, tgUserId: number): Promise<void>;
  bindBusinessConnection(a: { viaBot: number; connectionId: string; user: number; userChat: number; canReply: boolean; enabled: boolean }):
    Promise<{ outcome: 'bound' | 'updated' | 'disconnected' | 'no_intent' | 'not_owner' | 'ignored'; tenant_id: string | null }>;
  resolveBusinessConnection(viaBot: number, connectionId: string):
    Promise<{ tenant_id: string; channel_id: string; business_user_id: number; can_reply: boolean } | null>;
  bindTenantBot(a: { tenantId: string; membershipId: string; botId: number; username: string; token: string; hookId: string; secretHash: Buffer }): Promise<string>;
  revokeChannel(tenantId: string, channelId: string): Promise<void>;
  pauseAgent(tenantId: string, conversationKey: string, minutes: number): Promise<void>;   // human takeover
  // turns
  runTurn(inbound: Inbound): Promise<unknown>;
  // approvals
  consume(a: TapArgs & { decision: 'approve' | 'reject' }): Promise<{ outcome: Outcome; change_request_id: string | null }>;
  beginTyped(a: TapArgs & { codeHash: Buffer }): Promise<{ outcome: Outcome; approval_id: string | null }>;
  completeTyped(a: { tgUserId: number; chatId: number; codeHash: Buffer; evidence: object }):
    Promise<{ outcome: Outcome; change_request_id: string | null }>;
  approvalSummary(approvalId: string): Promise<string>;       // the exact text whose digest is in the approval
  settle(changeRequestId: string): Promise<void>;             // recompute archable/approval, merge with sha, flip
  rationaleFor(ref: string, tgUserId: number): Promise<string | null>;   // null: not a member, or unknown ref
  ownerMessage(tgUserId: number, text: string): Promise<OwnerReply>;     // owner request → normalized statement + Draft it / Not this (§7.7)
  ownerPress(tgUserId: number, ref: string): Promise<OwnerReply | null>; // a tapped post button, by its body.ref; null: expired or not theirs
  publicApiOrigin: string;                                    // 'https://api.archable.run'
  newTurnId(): string;
}
interface TapArgs { nonceHash: Buffer; tgUserId: number; chatId: number | null; messageId: number | null; evidence: object }

const sha256 = (s: string) => createHash('sha256').update(s).digest();
const BOT_TOKEN = /^([0-9]{5,16}):[A-Za-z0-9_-]{30,}$/;
const TOAST: Record<string, string> = {
  approved: 'Approved', rejected: 'Rejected', expired: 'This request expired', superseded: 'This change was updated',
  wrong_person: 'Only the person asked can answer this', wrong_message: 'Use the latest message', unknown: 'Unknown request',
  not_typed: 'Use the buttons on the card',
};

export function registerArchableBot(bot: Bot, d: ArchableBotDeps) {
  // ── Telegram Business: connection lifecycle ──
  bot.on('business_connection', async (ctx) => {
    const bc = ctx.businessConnection;
    const r = await d.bindBusinessConnection({
      viaBot: ctx.me.id, connectionId: bc.id, user: bc.user.id, userChat: bc.user_chat_id,
      canReply: bc.rights?.can_reply ?? false, enabled: bc.is_enabled,
    });
    const text = {
      bound: 'Connected. Customers who write to you will be answered by your agent.',
      updated: bc.rights?.can_reply ? 'Updated: your agent can reply.' : 'Updated: your agent can no longer reply. It will send you drafts here instead.',
      disconnected: 'Disconnected. Your agent no longer sees your chats.',
      no_intent: 'To connect, first tap “Connect Telegram Business” in the menu, then connect me again in Settings → Business.',
      not_owner: 'Only the owner of the business can connect it.',
      ignored: null,
    }[r.outcome];
    if (text) await ctx.api.sendMessage(bc.user_chat_id, text);
  });

  // ── Telegram Business: customer messages in the owner's own chats ──
  bot.on('business_message', async (ctx) => {
    const m = ctx.businessMessage;
    const route = await d.resolveBusinessConnection(ctx.me.id, m.business_connection_id!);
    if (!route) return;                                          // not bound (yet), paused or revoked
    const key = `bc_${m.business_connection_id}_${m.chat.id}`;
    if (m.from?.id === route.business_user_id) {                 // the owner typed in this chat: step back
      await d.pauseAgent(route.tenant_id, key, 30);
      return;
    }
    if (m.sender_business_bot) return;                           // a message a bot sent on the owner's behalf
    if (!m.text) {
      if (route.can_reply) {
        await ctx.api.sendMessage(m.chat.id, 'I can read text messages only. Please type your question.',
          { business_connection_id: m.business_connection_id });
      }
      return;
    }
    await d.runTurn({
      turnId: d.newTurnId(), tenantId: route.tenant_id, env: 'prod', channel: 'telegram_business',
      conversationKey: key, externalMessageId: String(m.message_id), text: m.text,
      customer: { tgUserId: m.from?.id },
      reply: { kind: 'telegram_business', channelId: route.channel_id, botId: ctx.me.id, chatId: m.chat.id,
               businessConnectionId: m.business_connection_id!, mode: route.can_reply ? 'reply' : 'suggest',
               ownerChatId: route.business_user_id },
    });
  });

  // ── Owner: connect customer channels (buttons, then text) ──
  bot.callbackQuery(/^ch:biz:([0-9a-f-]{36})$/, async (ctx) => {
    const tenants = await d.ownerTenants(ctx.from.id);
    const t = tenants.find((x) => x.tenant_id === ctx.match[1]);
    if (!t) return ctx.answerCallbackQuery({ text: 'Only the owner can do this' });
    await d.createLinkIntent(t.tenant_id, t.membership_id, ctx.from.id);
    await ctx.answerCallbackQuery();
    await ctx.reply(`Open Telegram Settings → Business → Chatbots, add @${ctx.me.username} and choose which chats it may answer. ` +
      `You have 15 minutes. ${t.os_name} will confirm here.`);
  });

  bot.chatType('private').hears(BOT_TOKEN, async (ctx) => {
    await ctx.deleteMessage().catch(() => {});                   // the token must not stay in the chat history
    const tenants = await d.ownerTenants(ctx.from.id);
    if (tenants.length !== 1) return ctx.reply('Send the token from the business you are connecting: open its menu first.');
    const t = tenants[0]!;
    const token = ctx.match[0];
    const tenantBot = new Bot(token);
    const me = await tenantBot.api.getMe().catch(() => null);
    if (!me) return ctx.reply('That token did not work. Copy it again from @BotFather.');
    const hookId = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const channelId = await d.bindTenantBot({ tenantId: t.tenant_id, membershipId: t.membership_id, botId: me.id,
      username: me.username, token, hookId, secretHash: sha256(secret) });
    try {
      await tenantBot.api.setWebhook(`${d.publicApiOrigin}/v1/webhooks/telegram/b/${hookId}`, {
        secret_token: secret, allowed_updates: ['message', 'edited_message', 'callback_query'], drop_pending_updates: true,
      });
    } catch {
      await d.revokeChannel(t.tenant_id, channelId);
      return ctx.reply('Telegram refused the webhook. Try again in a minute.');
    }
    await ctx.reply(`Connected @${me.username}. Customers can write to t.me/${me.username} now.`);
  });

  // ── Approvals: tap → (T3/T4) typed code → settle ──
  bot.callbackQuery(/^([ar])1:([A-Za-z0-9_-]{22})$/, async (ctx) => {
    const [, action, nonce] = ctx.match;
    const msg = ctx.callbackQuery.message;
    const tap: TapArgs = {
      nonceHash: sha256(nonce!), tgUserId: ctx.from.id, chatId: msg?.chat.id ?? null, messageId: msg?.message_id ?? null,
      evidence: { update_id: ctx.update.update_id, callback_query_id: ctx.callbackQuery.id },
    };
    const res = await d.consume({ ...tap, decision: action === 'a' ? 'approve' : 'reject' });
    if (res.outcome === 'step_up_required') {
      const code = String(randomInt(0, 10_000)).padStart(4, '0');
      const b = await d.beginTyped({ ...tap, codeHash: sha256(code) });
      await ctx.answerCallbackQuery();
      if (b.outcome !== 'challenge_open' || !b.approval_id) return ctx.reply(TOAST[b.outcome] ?? 'Try again');
      const summary = await d.approvalSummary(b.approval_id);
      return ctx.reply(`${summary}\n\nTo approve, reply ${code} within 2 minutes. To cancel, do nothing.`,
        { reply_markup: { force_reply: true, input_field_placeholder: code } });
    }
    await ctx.answerCallbackQuery({ text: TOAST[res.outcome] ?? res.outcome });   // before any GitHub call
    if ((res.outcome === 'approved' || res.outcome === 'rejected') && res.change_request_id) {
      waitUntil(d.settle(res.change_request_id));
    }
  });

  bot.chatType('private').hears(/^\s*([0-9]{4})\s*$/, async (ctx, next) => {
    const res = await d.completeTyped({ tgUserId: ctx.from.id, chatId: ctx.chat.id, codeHash: sha256(ctx.match[1]!),
      evidence: { update_id: ctx.update.update_id, message_id: ctx.message?.message_id } });
    if (res.outcome === 'no_challenge') return next();         // just a number: let the owner handler read it
    const reply: Record<string, string> = {
      approved: 'Approved. Deploying…', wrong_code: 'That code is not right. Check the message above.',
      challenge_expired: 'The code expired. Tap Approve on the card again.', wrong_chat: 'Reply in the chat where you got the code.',
    };
    await ctx.reply(reply[res.outcome] ?? TOAST[res.outcome] ?? res.outcome);
    if (res.outcome === 'approved' && res.change_request_id) waitUntil(d.settle(res.change_request_id));
  });

  // ── Rationale: "ℹ️ View rationale" on cards, desires and agent actions ──
  bot.callbackQuery(/^rv:([a-z]):([A-Za-z0-9_-]{22})$/, async (ctx) => {
    const text = await d.rationaleFor(`${ctx.match[1]}:${ctx.match[2]}`, ctx.from.id);
    await ctx.answerCallbackQuery(text ? undefined : { text: 'Not available' });
    if (text) await ctx.reply(text);                            // a new message: the approval card stays untouched
  });

  // ── Owner choices: a post button from an OwnerReply, pressed in Telegram (§7.7, §8.4) ──
  bot.callbackQuery(/^op:([A-Za-z0-9_-]{22})$/, async (ctx) => {
    const r = await d.ownerPress(ctx.from.id, ctx.match[1]!);
    if (!r) return ctx.answerCallbackQuery({ text: 'This choice is no longer available' });
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup().catch(() => {});        // one tap per question: the buttons go away
    await replyOwner(ctx, r);
  });

  // ── Everything else the owner types is a request ──
  bot.chatType('private').on('message:text', async (ctx) => {
    await replyOwner(ctx, await d.ownerMessage(ctx.from.id, ctx.message.text));
  });
  bot.chatType('private').on(['message:voice', 'message:audio', 'message:video_note'], (ctx) =>
    ctx.reply('Please type your message. I work with text and buttons only.'));
}

// An OwnerReply in Telegram: url buttons open links; post buttons become `op:<body.ref>` callbacks (callback_data
// holds 64 bytes, so the server mints a 22-char ref per button and resolves it in ownerPress). A post button
// without a ref can't be pressed in Telegram and is left out. All buttons share one row.
const OWNER_REF = /^[A-Za-z0-9_-]{22}$/;
export function ownerKeyboard(buttons: OwnerButton[]): InlineKeyboard | null {
  const kb = new InlineKeyboard();
  let n = 0;
  for (const b of buttons) {
    if (b.action === 'url') { kb.url(b.label, b.url); n++; continue; }
    const ref = b.body['ref'];
    if (typeof ref === 'string' && OWNER_REF.test(ref)) { kb.text(b.label, `op:${ref}`); n++; }
  }
  return n ? kb : null;
}

function replyOwner(ctx: Context, r: OwnerReply) {
  const kb = ownerKeyboard(r.buttons);
  return ctx.reply(r.text, kb ? { reply_markup: kb } : {});
}

export const changeCardKeyboard = (c: { approveNonce: string; rejectNonce: string; rationaleRef: string; previewUrl: string }) =>
  new InlineKeyboard()
    .url('Preview', c.previewUrl).text('ℹ️ View rationale', `rv:c:${c.rationaleRef}`).row()
    .text('Approve…', `a1:${c.approveNonce}`).text('Reject', `r1:${c.rejectNonce}`);

export type { Context };
