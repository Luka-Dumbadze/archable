import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Update } from "grammy/types";
import type { Inbound } from "../channels/runtime-stand-in";
import { tenantBotDispatcher, type NoticeKind } from "../channels/telegram/tenant-bot";
import { telegramWebhookRoutes, type BotHook, type WebhookDeps } from "./webhooks";

const SECRET = "S3cret-token_value";
const HOOK_ID = "e0000000-0000-0000-0000-000000000002";
const hook: BotHook = {
  tenant_id: "11111111-1111-1111-1111-111111111111", channel_id: "c", bot_id: 111,
  hook_secret_hash: createHash("sha256").update(SECRET).digest(), token_secret: "marani/tg_bot_token",
};

function setup(dispatch?: WebhookDeps["dispatchTenantUpdate"]) {
  const seen = new Set<number>();
  const dispatched: number[] = [];
  const log = vi.fn();
  const app = telegramWebhookRoutes({
    async resolveBotHook(id) { return id === HOOK_ID ? hook : null; },
    async firstSeen(_b, u) { if (seen.has(u)) return false; seen.add(u); return true; },
    dispatchTenantUpdate: dispatch ?? (async (_h, u) => { dispatched.push(u.update_id); }),
    log,
  });
  const call = (path: string, secret: string | null, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(secret ? { "X-Telegram-Bot-Api-Secret-Token": secret } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { call, dispatched, log };
}

const good = `/v1/webhooks/telegram/b/${HOOK_ID}`;
const flush = () => new Promise((r) => setTimeout(r, 10));

describe("tenant-bot webhook", () => {
  it("returns 404 for a malformed or unknown (revoked) hook id", async () => {
    const t = setup();
    expect((await t.call("/v1/webhooks/telegram/b/not-a-uuid", SECRET, { update_id: 1 })).status).toBe(404);
    expect((await t.call("/v1/webhooks/telegram/b/e0000000-0000-0000-0000-000000000001", SECRET, { update_id: 1 })).status).toBe(404);
  });

  it("returns 401 for a wrong or missing secret header", async () => {
    const t = setup();
    expect((await t.call(good, "wrong", { update_id: 1 })).status).toBe(401);
    expect((await t.call(good, null, { update_id: 1 })).status).toBe(401);
  });

  it("returns 400 for a body that is not an update", async () => {
    const t = setup();
    expect((await t.call(good, SECRET, "not json")).status).toBe(400);
    expect((await t.call(good, SECRET, { update_id: "7" })).status).toBe(400);
  });

  it("acknowledges a Telegram retry with 200 but dispatches the update once", async () => {
    const t = setup();
    expect((await t.call(good, SECRET, { update_id: 7 })).status).toBe(200);
    expect((await t.call(good, SECRET, { update_id: 7 })).status).toBe(200);
    await flush();
    expect(t.dispatched).toEqual([7]);
  });

  it("still answers 200 when dispatch fails, and logs the failure without the token", async () => {
    const t = setup(async () => { throw new Error("turn engine down"); });
    expect((await t.call(good, SECRET, { update_id: 8 })).status).toBe(200);
    await flush();
    expect(t.log).toHaveBeenCalledWith("telegram.dispatch_failed", expect.objectContaining({ update: 8 }));
    expect(JSON.stringify(t.log.mock.calls)).not.toContain(SECRET);
  });
});

describe("tenant-bot dispatcher", () => {
  function dispatcher() {
    const turns: Inbound[] = [];
    const notices: NoticeKind[] = [];
    const dispatch = tenantBotDispatcher({
      async handleTurn(i) { turns.push(i); return { turnId: i.turnId, text: "ok", allowed: true, outboundMessageId: 1, paused: false }; },
      async deliverNotice(_h, _r, kind) { notices.push(kind); },
    });
    return { dispatch, turns, notices };
  }
  const msg = (over: Record<string, unknown>) =>
    ({ update_id: 1, message: { message_id: 42, date: 0, chat: { id: 555, type: "private", first_name: "Nino" }, from: { id: 555, is_bot: false, first_name: "Nino" }, ...over } }) as unknown as Update;

  it("turns a private text message into an Inbound with a telegram ReplyTarget", async () => {
    const d = dispatcher();
    await d.dispatch(hook, msg({ text: "Do you have Saperavi 2019?" }));
    expect(d.turns).toHaveLength(1);
    expect(d.turns[0]).toMatchObject({
      tenantId: hook.tenant_id, env: "prod", channel: "telegram", conversationKey: "555", externalMessageId: "42",
      text: "Do you have Saperavi 2019?", customer: { tgUserId: 555 },
      reply: { kind: "telegram", channelId: "c", botId: 111, tokenSecret: "marani/tg_bot_token", chatId: 555 },
    });
  });

  it("answers voice, audio and photos with the text-only notice, never a turn", async () => {
    const d = dispatcher();
    await d.dispatch(hook, msg({ voice: { file_id: "v", file_unique_id: "v", duration: 3 } }));
    await d.dispatch(hook, msg({ photo: [], caption: "this one?" }));
    expect(d.notices).toEqual(["text_only", "text_only"]);
    expect(d.turns).toHaveLength(0);
  });

  it("answers /start with the greeting", async () => {
    const d = dispatcher();
    await d.dispatch(hook, msg({ text: "/start" }));
    expect(d.notices).toEqual(["greeting"]);
    expect(d.turns).toHaveLength(0);
  });

  it("ignores groups, channels and non-message updates", async () => {
    const d = dispatcher();
    await d.dispatch(hook, msg({ text: "hi", chat: { id: -100, type: "group", title: "Wine club" } }));
    await d.dispatch(hook, { update_id: 2, callback_query: { id: "q", from: { id: 1, is_bot: false, first_name: "x" }, chat_instance: "i" } } as unknown as Update);
    expect(d.turns).toHaveLength(0);
    expect(d.notices).toHaveLength(0);
  });

  it("runs end to end: webhook → dispatcher → handleTurn", async () => {
    const d = dispatcher();
    const t = setup(d.dispatch);
    expect((await t.call(good, SECRET, msg({ text: "gamarjoba" }))).status).toBe(200);
    await flush();
    expect(d.turns.map((i) => i.text)).toEqual(["gamarjoba"]);
  });
});
