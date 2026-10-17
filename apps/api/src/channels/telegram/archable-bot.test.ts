import { createHash } from "node:crypto";
import { Api, Bot } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerArchableBot, type ArchableBotDeps } from "./archable-bot";

// The real grammY update pipeline with Telegram's API intercepted: every outgoing call is recorded and
// answered locally. DEV-2's governance, architect and db functions are in-memory stand-ins.
const OWNER = 1001, CUSTOMER = 2002, OWNER_CHAT = 1001;
const TENANT = "11111111-1111-1111-1111-111111111111", MEMBERSHIP = "22222222-2222-2222-2222-222222222222";
const ME: UserFromGetMe = {
  id: 8901689823, is_bot: true, first_name: "Archable", username: "archable_prod_bot",
  can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: true, has_main_web_app: false,
} as UserFromGetMe;
const sha256 = (s: string) => createHash("sha256").update(s).digest();

type Call = { method: string; payload: Record<string, unknown> };

function setup(over: Partial<ArchableBotDeps> = {}) {
  const calls: Call[] = [];
  const deps: ArchableBotDeps = {
    ownerTenants: vi.fn(async (u: number) => (u === OWNER ? [{ tenant_id: TENANT, slug: "marani", os_name: "Marani OS", membership_id: MEMBERSHIP }] : [])),
    createLinkIntent: vi.fn(async () => {}),
    bindBusinessConnection: vi.fn(async () => ({ outcome: "bound" as const, tenant_id: TENANT })),
    resolveBusinessConnection: vi.fn(async () => ({ tenant_id: TENANT, channel_id: "ch-biz", business_user_id: OWNER, can_reply: true })),
    bindTenantBot: vi.fn(async () => "ch-bot"),
    revokeChannel: vi.fn(async () => {}),
    pauseAgent: vi.fn(async () => {}),
    runTurn: vi.fn(async () => ({})),
    consume: vi.fn(async () => ({ outcome: "approved", change_request_id: "cr-1" })),
    beginTyped: vi.fn(async () => ({ outcome: "challenge_open", approval_id: "ap-1" })),
    completeTyped: vi.fn(async () => ({ outcome: "approved", change_request_id: "cr-1" })),
    approvalSummary: vi.fn(async () => "Marani OS: allow cash on delivery up to 300 GEL."),
    settle: vi.fn(async () => {}),
    rationaleFor: vi.fn(async (ref: string) => (ref === "c:AAAAAAAAAAAAAAAAAAAAAA" ? "Why: 14 customers asked to pay the courier in cash." : null)),
    ownerMessage: vi.fn(async (_u: number, t: string) => `Got it: "${t}". Shall I draft it?`),
    publicApiOrigin: "https://api.archable.run",
    newTurnId: () => "turn-1",
    ...over,
  };
  const bot = new Bot("123456:AA-fake-archable-bot-token-for-tests", { botInfo: ME });
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: (method === "sendMessage" ? { message_id: calls.length, date: 0, chat: { id: 0, type: "private" } } : true) as never };
  });
  registerArchableBot(bot, deps);
  const send = (u: Record<string, unknown>) => bot.handleUpdate({ update_id: Math.floor(Math.random() * 1e9), ...u } as unknown as Update);
  const sent = (method = "sendMessage") => calls.filter((c) => c.method === method).map((c) => c.payload);
  return { deps, calls, send, sent };
}

const privateMsg = (text: string | undefined, from = OWNER, extra: Record<string, unknown> = {}) => ({
  message: { message_id: 50, date: 0, chat: { id: from, type: "private", first_name: "Luka" }, from: { id: from, is_bot: false, first_name: "Luka" }, ...(text === undefined ? {} : { text }), ...extra },
});
const cb = (data: string, from = OWNER) => ({
  callback_query: { id: "cq-1", from: { id: from, is_bot: false, first_name: "Luka" }, chat_instance: "ci", data,
    message: { message_id: 77, date: 0, chat: { id: OWNER_CHAT, type: "private", first_name: "Luka" } } },
});
const bizConn = (over: Record<string, unknown> = {}) => ({
  business_connection: { id: "bc-1", user: { id: OWNER, is_bot: false, first_name: "Luka" }, user_chat_id: OWNER_CHAT, date: 0,
    rights: { can_reply: true }, is_enabled: true, ...over },
});
const bizMsg = (from: number, extra: Record<string, unknown> = {}) => ({
  business_message: { message_id: 9, date: 0, business_connection_id: "bc-1", chat: { id: CUSTOMER, type: "private", first_name: "Nino" },
    from: { id: from, is_bot: false, first_name: "x" }, ...extra },
});

afterEach(() => vi.restoreAllMocks());

describe("Telegram Business: connection lifecycle", () => {
  it("binds a new connection and confirms to the owner", async () => {
    const t = setup();
    await t.send(bizConn());
    expect(t.deps.bindBusinessConnection).toHaveBeenCalledWith({ viaBot: ME.id, connectionId: "bc-1", user: OWNER, userChat: OWNER_CHAT, canReply: true, enabled: true });
    expect(t.sent()).toEqual([{ chat_id: OWNER_CHAT, text: "Connected. Customers who write to you will be answered by your agent." }]);
  });

  it("switches to drafts when reply rights are removed", async () => {
    const t = setup({ bindBusinessConnection: vi.fn(async () => ({ outcome: "updated" as const, tenant_id: TENANT })) });
    await t.send(bizConn({ rights: { can_reply: false } }));
    expect(t.sent()[0]?.text).toBe("Updated: your agent can no longer reply. It will send you drafts here instead.");
  });

  it("says nothing for an ignored connection event", async () => {
    const t = setup({ bindBusinessConnection: vi.fn(async () => ({ outcome: "ignored" as const, tenant_id: null })) });
    await t.send(bizConn());
    expect(t.sent()).toEqual([]);
  });
});

describe("Telegram Business: customer messages", () => {
  it("runs a turn in reply mode for a customer's text", async () => {
    const t = setup();
    await t.send(bizMsg(CUSTOMER, { text: "Do you have Saperavi 2019?" }));
    expect(t.deps.runTurn).toHaveBeenCalledWith({
      turnId: "turn-1", tenantId: TENANT, env: "prod", channel: "telegram_business", conversationKey: `bc_bc-1_${CUSTOMER}`,
      externalMessageId: "9", text: "Do you have Saperavi 2019?", customer: { tgUserId: CUSTOMER },
      reply: { kind: "telegram_business", channelId: "ch-biz", botId: ME.id, chatId: CUSTOMER, businessConnectionId: "bc-1", mode: "reply", ownerChatId: OWNER },
    });
  });

  it("uses suggest mode without reply rights", async () => {
    const t = setup({ resolveBusinessConnection: vi.fn(async () => ({ tenant_id: TENANT, channel_id: "ch-biz", business_user_id: OWNER, can_reply: false })) });
    await t.send(bizMsg(CUSTOMER, { text: "hello" }));
    expect(vi.mocked(t.deps.runTurn).mock.calls[0]?.[0].reply).toMatchObject({ mode: "suggest" });
  });

  it("pauses the agent for 30 minutes when the owner types in the chat", async () => {
    const t = setup();
    await t.send(bizMsg(OWNER, { text: "I'll handle this one" }));
    expect(t.deps.pauseAgent).toHaveBeenCalledWith(TENANT, `bc_bc-1_${CUSTOMER}`, 30);
    expect(t.deps.runTurn).not.toHaveBeenCalled();
  });

  it("asks for text when a customer sends a voice note, only if it may reply", async () => {
    const t = setup();
    await t.send(bizMsg(CUSTOMER, { voice: { file_id: "v", file_unique_id: "v", duration: 2 } }));
    expect(t.sent()).toEqual([{ chat_id: CUSTOMER, text: "I can read text messages only. Please type your question.", business_connection_id: "bc-1" }]);
    expect(t.deps.runTurn).not.toHaveBeenCalled();

    const s = setup({ resolveBusinessConnection: vi.fn(async () => ({ tenant_id: TENANT, channel_id: "ch-biz", business_user_id: OWNER, can_reply: false })) });
    await s.send(bizMsg(CUSTOMER, { voice: { file_id: "v", file_unique_id: "v", duration: 2 } }));
    expect(s.sent()).toEqual([]);
  });

  it("ignores unbound connections and messages a bot sent for the owner", async () => {
    const t = setup({ resolveBusinessConnection: vi.fn(async () => null) });
    await t.send(bizMsg(CUSTOMER, { text: "hi" }));
    const s = setup();
    await s.send(bizMsg(CUSTOMER, { text: "hi", sender_business_bot: { id: 5, is_bot: true, first_name: "b" } }));
    expect(t.deps.runTurn).not.toHaveBeenCalled();
    expect(s.deps.runTurn).not.toHaveBeenCalled();
  });
});

describe("owner: connect customer channels", () => {
  it("creates a link intent for the owner's tenant and explains the next step", async () => {
    const t = setup();
    await t.send(cb(`ch:biz:${TENANT}`));
    expect(t.deps.createLinkIntent).toHaveBeenCalledWith(TENANT, MEMBERSHIP, OWNER);
    expect(String(t.sent()[0]?.text)).toContain("add @archable_prod_bot");
  });

  it("refuses someone who isn't the owner", async () => {
    const t = setup();
    await t.send(cb(`ch:biz:${TENANT}`, CUSTOMER));
    expect(t.sent("answerCallbackQuery")[0]).toMatchObject({ text: "Only the owner can do this" });
    expect(t.deps.createLinkIntent).not.toHaveBeenCalled();
  });

  const TENANT_TOKEN = "7777777777:AAH" + "x".repeat(32);

  it("deletes a pasted bot token first, binds the bot and registers its webhook with a fresh secret", async () => {
    const getMe = vi.spyOn(Api.prototype, "getMe").mockResolvedValue({ ...ME, id: 7777777777, username: "marani_test_bot" });
    const setWebhook = vi.spyOn(Api.prototype, "setWebhook").mockResolvedValue(true);
    const t = setup();
    await t.send(privateMsg(TENANT_TOKEN));
    expect(t.calls[0]?.method).toBe("deleteMessage");
    expect(getMe).toHaveBeenCalledTimes(1);
    const bind = vi.mocked(t.deps.bindTenantBot).mock.calls[0]![0];
    expect(bind).toMatchObject({ tenantId: TENANT, membershipId: MEMBERSHIP, botId: 7777777777, username: "marani_test_bot", token: TENANT_TOKEN });
    const [url, opts] = setWebhook.mock.calls[0]!;
    expect(url).toBe(`https://api.archable.run/v1/webhooks/telegram/b/${bind.hookId}`);
    expect(opts).toMatchObject({ allowed_updates: ["message", "edited_message", "callback_query"], drop_pending_updates: true });
    expect(sha256((opts as { secret_token: string }).secret_token)).toEqual(bind.secretHash);
    expect(t.sent().map((p) => p.text)).toEqual(["Connected @marani_test_bot. Customers can write to t.me/marani_test_bot now."]);
    expect(JSON.stringify(t.calls)).not.toContain(TENANT_TOKEN);
    expect(t.deps.ownerMessage).not.toHaveBeenCalled();
  });

  it("revokes the new channel if Telegram refuses the webhook", async () => {
    vi.spyOn(Api.prototype, "getMe").mockResolvedValue({ ...ME, id: 7777777777, username: "marani_test_bot" });
    vi.spyOn(Api.prototype, "setWebhook").mockRejectedValue(new Error("Bad Request"));
    const t = setup();
    await t.send(privateMsg(TENANT_TOKEN));
    expect(t.deps.revokeChannel).toHaveBeenCalledWith(TENANT, "ch-bot");
    expect(t.sent()[0]?.text).toBe("Telegram refused the webhook. Try again in a minute.");
  });

  it("rejects a token that doesn't work, without binding anything", async () => {
    vi.spyOn(Api.prototype, "getMe").mockRejectedValue(new Error("Unauthorized"));
    const t = setup();
    await t.send(privateMsg(TENANT_TOKEN));
    expect(t.calls[0]?.method).toBe("deleteMessage");
    expect(t.deps.bindTenantBot).not.toHaveBeenCalled();
    expect(t.sent()[0]?.text).toBe("That token did not work. Copy it again from @BotFather.");
  });
});

describe("approvals", () => {
  const NONCE = "N".repeat(22);

  it("T1/T2 tap: answers the callback first, then settles", async () => {
    const t = setup();
    await t.send(cb(`a1:${NONCE}`));
    expect(t.deps.consume).toHaveBeenCalledWith(expect.objectContaining({ nonceHash: sha256(NONCE), tgUserId: OWNER, chatId: OWNER_CHAT, messageId: 77, decision: "approve" }));
    expect(t.sent("answerCallbackQuery")[0]).toMatchObject({ text: "Approved" });
    await vi.waitFor(() => expect(t.deps.settle).toHaveBeenCalledWith("cr-1"));
  });

  it("reject tap and stale card toasts", async () => {
    const t = setup({ consume: vi.fn(async () => ({ outcome: "superseded", change_request_id: null })) });
    await t.send(cb(`r1:${NONCE}`));
    expect(vi.mocked(t.deps.consume).mock.calls[0]?.[0].decision).toBe("reject");
    expect(t.sent("answerCallbackQuery")[0]).toMatchObject({ text: "This change was updated" });
    expect(t.deps.settle).not.toHaveBeenCalled();
  });

  it("T3/T4: a tap opens a typed challenge; the right code approves and settles", async () => {
    const t = setup({ consume: vi.fn(async () => ({ outcome: "step_up_required", change_request_id: null })) });
    await t.send(cb(`a1:${NONCE}`));
    const prompt = String(t.sent()[0]?.text);
    const code = /reply ([0-9]{4}) within 2 minutes/.exec(prompt)?.[1];
    expect(prompt.startsWith("Marani OS: allow cash on delivery up to 300 GEL.")).toBe(true);
    expect(code).toBeDefined();
    expect(vi.mocked(t.deps.beginTyped).mock.calls[0]?.[0].codeHash).toEqual(sha256(code!));

    await t.send(privateMsg(` ${code} `));
    expect(vi.mocked(t.deps.completeTyped).mock.calls[0]?.[0]).toMatchObject({ tgUserId: OWNER, chatId: OWNER, codeHash: sha256(code!) });
    expect(t.sent().at(-1)?.text).toBe("Approved. Deploying…");
    await vi.waitFor(() => expect(t.deps.settle).toHaveBeenCalledWith("cr-1"));
  });

  it("a wrong code is refused and nothing settles", async () => {
    const t = setup({ completeTyped: vi.fn(async () => ({ outcome: "wrong_code", change_request_id: null })) });
    await t.send(privateMsg("1234"));
    expect(t.sent()[0]?.text).toBe("That code is not right. Check the message above.");
    expect(t.deps.settle).not.toHaveBeenCalled();
  });

  it("a number with no open challenge goes to the owner handler", async () => {
    const t = setup({ completeTyped: vi.fn(async () => ({ outcome: "no_challenge", change_request_id: null })) });
    await t.send(privateMsg("2019"));
    expect(t.deps.ownerMessage).toHaveBeenCalledWith(OWNER, "2019");
  });
});

describe("rationale and owner text", () => {
  it("sends the rationale as a new message, or a toast when it isn't available", async () => {
    const t = setup();
    await t.send(cb(`rv:c:${"A".repeat(22)}`));
    expect(t.sent()[0]?.text).toBe("Why: 14 customers asked to pay the courier in cash.");
    const s = setup();
    await s.send(cb(`rv:c:${"B".repeat(22)}`, CUSTOMER));
    expect(s.sent()).toEqual([]);
    expect(s.sent("answerCallbackQuery")[0]).toMatchObject({ text: "Not available" });
  });

  it("treats any other owner text as a request", async () => {
    const t = setup();
    await t.send(privateMsg("customers want to pay the courier in cash, up to 300 lari"));
    expect(t.sent()[0]?.text).toBe('Got it: "customers want to pay the courier in cash, up to 300 lari". Shall I draft it?');
  });

  it("answers voice, audio and video notes with the text-only reply", async () => {
    const t = setup();
    await t.send(privateMsg(undefined, OWNER, { voice: { file_id: "v", file_unique_id: "v", duration: 2 } }));
    expect(t.sent()[0]?.text).toBe("Please type your message. I work with text and buttons only.");
    expect(t.deps.ownerMessage).not.toHaveBeenCalled();
  });
});
