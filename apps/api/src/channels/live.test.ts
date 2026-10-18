import { describe, expect, it, vi } from "vitest";
import type { HandleTurn, Inbound } from "@archable/runtime";
import { channelDeps, liveChannelDeps } from "./live";
import { createTelegramDelivery, TEXT_ONLY } from "./telegram/delivery";
import { archableBotDeps as unwiredBot, chatDeps, webhookDeps, widgetDeps as unwiredWidget } from "./unwired";

// A stand-in for DEV-2's channel store: records which functions the live deps call.
function store() {
  const calls: string[] = [];
  const f = <T,>(name: string, v: T) => vi.fn(async (..._a: unknown[]) => { calls.push(name); return v; });
  const s = {
    openSession: f("openSession", { tenant_id: "t", session_id: "s", conversation_id: "c" }),
    resumeSession: f("resumeSession", { tenant_id: "t", session_id: "s", conversation_id: "c", env: "prod" as const, slug: "marani" }),
    recentInbound: f("recentInbound", 0), existingReply: f("existingReply", null), outboundAfter: f("outboundAfter", []),
    resolveBotHook: f("resolveBotHook", null), firstSeen: f("firstSeen", true),
    widgetConfig: f("widgetConfig", { greeting: { en: "Hi" }, launcher: { label: { en: "Chat" }, position: "right" as const }, brand: "#7B1E3A", embed_origins: [] }),
    ownerTenants: f("ownerTenants", []), createLinkIntent: f("createLinkIntent", undefined),
    bindBusinessConnection: f("bindBusinessConnection", { outcome: "bound" as const, tenant_id: "t" }),
    resolveBusinessConnection: f("resolveBusinessConnection", null), bindTenantBot: f("bindTenantBot", "ch"),
    revokeChannel: f("revokeChannel", undefined), pauseAgent: f("pauseAgent", undefined),
  };
  return { calls, s: s as unknown as NonNullable<Parameters<typeof liveChannelDeps>[0]> };
}

describe("channel deps selection", () => {
  it("without both database URLs every channel stays on the fail-closed stand-ins", () => {
    for (const env of [{}, { DATABASE_URL_RUNTIME: "x" }, { DATABASE_URL_CONTROL: "x" }]) {
      const live = vi.fn();
      const d = channelDeps(env, live);
      expect(live).not.toHaveBeenCalled();
      expect(d).toEqual({ chatDeps, webhookDeps, widgetDeps: unwiredWidget, archableBotDeps: unwiredBot });
    }
  });

  it("with both, the live deps are used", () => {
    const live = vi.fn(() => liveChannelDeps(store().s));
    channelDeps({ DATABASE_URL_RUNTIME: "r", DATABASE_URL_CONTROL: "c" }, live);
    expect(live).toHaveBeenCalledTimes(1);
  });
});

describe("live deps: wired only where ready end to end", () => {
  it("widget config and @ArchableBot channel binding go to the channel store", async () => {
    const { s, calls } = store();
    const d = liveChannelDeps(s);
    await d.widgetDeps.widgetConfig("marani");
    await d.archableBotDeps.ownerTenants(1);
    await d.archableBotDeps.createLinkIntent("t", "m", 1);
    await d.archableBotDeps.bindBusinessConnection({ viaBot: 1, connectionId: "bc", user: 1, userChat: 1, canReply: true, enabled: true });
    await d.archableBotDeps.resolveBusinessConnection(1, "bc");
    await d.archableBotDeps.bindTenantBot({ tenantId: "t", membershipId: "m", botId: 1, username: "u", token: "x", hookId: "h", secretHash: Buffer.alloc(32) });
    await d.archableBotDeps.revokeChannel("t", "ch");
    await d.archableBotDeps.pauseAgent("t", "k", 30);
    expect(calls).toEqual(["widgetConfig", "ownerTenants", "createLinkIntent", "bindBusinessConnection", "resolveBusinessConnection", "bindTenantBot", "revokeChannel", "pauseAgent"]);
  });

  it("chat session and message lookups use the SQL-backed channel store", async () => {
    const { s, calls } = store();
    const handleTurn: HandleTurn = async (i) => ({ turnId: i.turnId, text: "ok", allowed: true, outboundMessageId: 1, paused: false });
    const d = liveChannelDeps(s, handleTurn);
    const claims = { tid: "t", sid: "s", cid: "c", env: "prod" as const };
    await d.chatDeps.openSession("marani", "prod", Buffer.alloc(32), null);
    await d.chatDeps.resumeSession(Buffer.alloc(32));
    await d.chatDeps.recentInbound(claims, 60);
    await d.chatDeps.existingReply(claims, "message-id");
    await d.chatDeps.outboundAfter(claims, 0);
    await d.webhookDeps.resolveBotHook("hook");
    await d.webhookDeps.firstSeen(1, 2);
    expect(calls).toEqual(["openSession", "resumeSession", "recentInbound", "existingReply", "outboundAfter", "resolveBotHook", "firstSeen"]);
    expect(await d.chatDeps.handleTurn({ turnId: "u", tenantId: "t" } as Inbound)).toMatchObject({ turnId: "u", text: "ok" });
  });

  it("shares the runtime turn handler with web chat and tenant bot dispatch", async () => {
    const turns: Inbound[] = [];
    const handleTurn: HandleTurn = async (i) => {
      turns.push(i);
      return { turnId: i.turnId, text: "ok", allowed: true, outboundMessageId: 1, paused: false };
    };
    const d = liveChannelDeps(store().s, handleTurn);
    const hook = { tenant_id: "t", channel_id: "c", bot_id: 1, hook_secret_hash: Buffer.alloc(32), token_secret: "marani/tg_bot_token" };
    await d.webhookDeps.dispatchTenantUpdate(hook, { update_id: 1, message: {
      message_id: 42, date: 0, chat: { id: 555, type: "private", first_name: "Nino" },
      from: { id: 555, is_bot: false, first_name: "Nino" }, text: "gamarjoba",
    } } as never);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ tenantId: "t", channel: "telegram", text: "gamarjoba" });
    await d.chatDeps.handleTurn({ ...turns[0]!, channel: "web" });                  // the same engine, from each entry point
    await d.archableBotDeps.runTurn({ ...turns[0]!, channel: "telegram_business" });
    expect(turns.map((t) => t.channel)).toEqual(["telegram", "web", "telegram_business"]);
    expect(await d.archableBotDeps.consume({} as never)).toEqual({ outcome: "unknown", change_request_id: null });
    expect(await d.archableBotDeps.ownerPress(1, "x")).toBeNull();
  });

  it("Telegram replies leave through send.ts: the tenant bot's Vault token, a recorded reply; a voice note gets the text-only notice", async () => {
    const sent: { token: string; chatId: number | string; text: string }[] = [];
    const rows: unknown[] = [];
    const telegram = createTelegramDelivery({
      env: { ARCHABLE_BOT_TOKEN: "platform-token", VERCEL_ENV: "production" },
      store: {
        channelSecret: async (_t, name) => (name === "marani/tg_bot_token" ? "tenant-token" : null),
        turnInbound: async () => ({ conversation_id: "conv", chapter_id: null, spec_digest: "sha256:aaa" }),
        insertOutbound: async (_t, m) => { rows.push(m); return 77; },
        pauseChannel: async () => {},
        bundle: async () => ({ apps: { cc: { template: "t", agent: "cellar_master", channels: ["tg"] } }, channels: { tg: { kind: "telegram_bot" } } }) as never,
      },
      apiFor: ((token: string) => ({ sendMessage: async (chatId: number | string, text: string) => { sent.push({ token, chatId, text }); return { message_id: 5 }; } })) as never,
      log: () => {},
    });
    // Like createHandleTurn: a Telegram target's reply goes out through the engine's deliver.
    const handleTurn: HandleTurn = async (i) => ({ turnId: i.turnId, text: "Saperavi is 38 GEL.", allowed: true, paused: false,
      outboundMessageId: await telegram.deliver(i.reply, "Saperavi is 38 GEL.", { suggestion: "Saperavi is 38 GEL." }) });
    const d = liveChannelDeps(store().s, handleTurn, telegram);
    const hook = { tenant_id: "t", channel_id: "c", bot_id: 1, hook_secret_hash: Buffer.alloc(32), token_secret: "marani/tg_bot_token" };
    const message = { message_id: 42, date: 0, chat: { id: 555, type: "private", first_name: "Nino" }, from: { id: 555, is_bot: false, first_name: "Nino" } };
    await d.webhookDeps.dispatchTenantUpdate(hook, { update_id: 1, message: { ...message, text: "saperavi?" } } as never);
    await d.webhookDeps.dispatchTenantUpdate(hook, { update_id: 2, message: { ...message, voice: { file_id: "v", file_unique_id: "v", duration: 2 } } } as never);
    expect(sent).toEqual([{ token: "tenant-token", chatId: 555, text: "Saperavi is 38 GEL." }, { token: "tenant-token", chatId: 555, text: TEXT_ONLY }]);
    expect(rows).toEqual([expect.objectContaining({ conversationId: "conv", author: "agent:cellar_master", externalId: "5" })]);
  });
});
