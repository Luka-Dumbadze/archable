import { GrammyError } from "grammy";
import { describe, expect, it, vi } from "vitest";
import type { Bundle } from "@archable/compiler";
import type { HandleTurn, Inbound, ReplyTarget } from "@archable/runtime";
import type { BotHook } from "../../routes/webhooks";
import { createTelegramDelivery, TEXT_ONLY, type DeliveryStore } from "./delivery";

const TENANT = "11111111-1111-4111-8111-111111111111";
const TURN = "22222222-2222-4222-8222-222222222222";
const bundle = {
  apps: { contact_center: { template: "tpl.contact_center@3", agent: "cellar_master", channels: ["tg_customers", "tg_business", "web_chat"] } },
  channels: {
    tg_customers: { kind: "telegram_bot" }, tg_business: { kind: "telegram_business" },
    web_chat: { kind: "web", public: { greeting: { ka: "გამარჯობა!", en: "Hi! Looking for a wine?" } } },
  },
} as unknown as Bundle;
const refused = (code: number) =>
  new GrammyError(`Call to 'sendMessage' failed! (${code})`, { ok: false, error_code: code, description: `error ${code}` } as never, "sendMessage", {});

// DEV-2's tables behind a fake store, and Telegram behind a fake Api that records who sent what.
function setup(env: Record<string, string | undefined> = { ARCHABLE_BOT_TOKEN: "platform-token" }, vault: Record<string, string> = { "marani/tg_bot_token": "tenant-token" }) {
  const rows: Parameters<DeliveryStore["insertOutbound"]>[1][] = [];
  const paused: string[] = [];
  const store: DeliveryStore = {
    channelSecret: vi.fn(async (_tenant: string, name: string) => vault[name] ?? null),
    turnInbound: vi.fn(async (_tenant: string, turnId: string) => (turnId === TURN ? { conversation_id: "conv-1", chapter_id: "ch-1", spec_digest: "sha256:aaa" } : null)),
    insertOutbound: vi.fn(async (_tenant: string, m: Parameters<DeliveryStore["insertOutbound"]>[1]) => { rows.push(m); return 900 + rows.length; }),
    pauseChannel: vi.fn(async (_tenant: string, channelId: string) => { paused.push(channelId); }),
    bundle: vi.fn(async () => bundle),
  };
  const sent: { token: string; chatId: number | string; text: string; other?: unknown }[] = [];
  let refuse: number | null = null;
  const apiFor = (token: string) => ({
    sendMessage: async (chatId: number | string, text: string, other?: unknown) => {
      if (refuse) throw refused(refuse);
      sent.push({ token, chatId, text, other });
      return { message_id: 4242 };
    },
  });
  const logs: string[] = [];
  const d = createTelegramDelivery({ env, store, apiFor: apiFor as never, log: (event) => logs.push(event) });
  return { d, store, rows, paused, sent, logs, refuse: (code: number | null) => { refuse = code; } };
}

const tg: ReplyTarget = { kind: "telegram", channelId: "chan-1", botId: 777, tokenSecret: "marani/tg_bot_token", chatId: 555 };
const biz: ReplyTarget = { kind: "telegram_business", channelId: "chan-2", botId: 1, chatId: 556, businessConnectionId: "bc-1", mode: "reply", ownerChatId: 9 };
const inbound = (reply: ReplyTarget, channel: Inbound["channel"]): Inbound =>
  ({ turnId: TURN, tenantId: TENANT, env: "prod", channel, conversationKey: "555", externalMessageId: "10", text: "saperavi?", customer: {}, reply });
// Like createHandleTurn: a Telegram target's reply goes out through deliver, inside the turn.
const engine = (s: ReturnType<typeof setup>): HandleTurn => async (i) => ({
  turnId: i.turnId, text: "Saperavi is 38 GEL.", allowed: true, paused: false,
  outboundMessageId: await s.d.deliver(i.reply, "Saperavi is 38 GEL.", { suggestion: "Saperavi is 38 GEL." }),
});

describe("Telegram delivery on the live database", () => {
  it("a tenant-bot reply: the Vault token in the turn's tenant, sent by the tenant's bot, recorded in the turn's conversation as its agent", async () => {
    const s = setup();
    const r = await s.d.forTurn(engine(s))(inbound(tg, "telegram"));
    expect(s.store.channelSecret).toHaveBeenCalledWith(TENANT, "marani/tg_bot_token");
    expect(s.sent).toEqual([{ token: "tenant-token", chatId: 555, text: "Saperavi is 38 GEL." }]);
    expect(s.rows).toEqual([{ conversationId: "conv-1", chapterId: "ch-1", turnId: TURN, author: "agent:cellar_master",
                              body: "Saperavi is 38 GEL.", specDigest: "sha256:aaa", externalId: "4242" }]);
    expect(r.outboundMessageId).toBe(901);
  });

  it("a Business reply goes through @ArchableBot with the connection id, no Vault read", async () => {
    const s = setup();
    await s.d.forTurn(engine(s))(inbound(biz, "telegram_business"));
    expect(s.sent).toEqual([{ token: "platform-token", chatId: 556, text: "Saperavi is 38 GEL.", other: { business_connection_id: "bc-1" } }]);
    expect(s.rows[0]).toMatchObject({ author: "agent:cellar_master", externalId: "4242" });
    expect(s.store.channelSecret).not.toHaveBeenCalled();
  });

  it("outside a channel turn, deliver refuses instead of guessing a conversation", async () => {
    const s = setup();
    await expect(s.d.deliver(tg, "hi", { suggestion: null })).rejects.toThrow(/outside a channel turn/);
    expect(s.sent).toEqual([]);
  });

  it("in Vercel production a token missing from Vault fails closed: nothing is sent", async () => {
    const s = setup({ ARCHABLE_BOT_TOKEN: "platform-token", VERCEL_ENV: "production" }, {});
    await expect(s.d.forTurn(engine(s))(inbound(tg, "telegram"))).rejects.toThrow("Vault has no secret marani/tg_bot_token");
    expect(s.sent).toEqual([]);
    expect(s.rows).toEqual([]);
  });

  it("outside production, or with TELEGRAM_TOKEN_FALLBACK=1, @ArchableBot's token stands in, and its 403 doesn't pause the tenant's channel", async () => {
    for (const env of [{ ARCHABLE_BOT_TOKEN: "platform-token" }, { ARCHABLE_BOT_TOKEN: "platform-token", VERCEL_ENV: "production", TELEGRAM_TOKEN_FALLBACK: "1" }]) {
      const s = setup(env, {});
      await s.d.forTurn(engine(s))(inbound(tg, "telegram"));
      expect(s.sent).toEqual([{ token: "platform-token", chatId: 555, text: "Saperavi is 38 GEL." }]);
      expect(s.logs).toEqual(["telegram.token_fallback"]);
      s.refuse(403);
      await expect(s.d.forTurn(engine(s))(inbound(tg, "telegram"))).rejects.toBeInstanceOf(GrammyError);
      expect(s.paused).toEqual([]);
      expect(s.logs.at(-1)).toBe("telegram.pause_skipped");
    }
  });

  it("with the tenant's own token, a 403 (the customer blocked the bot) pauses the channel", async () => {
    const s = setup();
    s.refuse(403);
    await expect(s.d.forTurn(engine(s))(inbound(tg, "telegram"))).rejects.toBeInstanceOf(GrammyError);
    expect(s.paused).toEqual(["chan-1"]);
    expect(s.logs).toEqual(["telegram.channel_paused"]);
  });

  it("notices outside a turn: a voice note gets the text-only reply, /start the spec's greeting, from the tenant's bot, unrecorded", async () => {
    const s = setup();
    const hook: BotHook = { tenant_id: TENANT, channel_id: "chan-1", bot_id: 777, hook_secret_hash: Buffer.alloc(32), token_secret: "marani/tg_bot_token" };
    await s.d.deliverNotice(hook, tg, "text_only");
    await s.d.deliverNotice(hook, tg, "greeting");
    expect(s.sent.map((m) => [m.token, m.text])).toEqual([["tenant-token", TEXT_ONLY], ["tenant-token", "Hi! Looking for a wine?"]]);
    expect(s.store.bundle).toHaveBeenCalledWith(TENANT, null);
    expect(s.rows).toEqual([]);
  });
});
