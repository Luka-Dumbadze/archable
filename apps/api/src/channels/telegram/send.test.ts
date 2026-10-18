import { createHash } from "node:crypto";
import { GrammyError } from "grammy";
import { describe, expect, it, vi } from "vitest";
import type { ReplyTarget } from "@archable/runtime";
import type { BotHook } from "../../routes/webhooks";
import { createSender, type SendDeps } from "./send";

const TOKEN = "123456:AA-fake-tenant-token";
const tg: ReplyTarget = { kind: "telegram", channelId: "ch-bot", botId: 111, tokenSecret: "marani/tg_bot_token", chatId: 555 };
const biz = (mode: "reply" | "suggest"): ReplyTarget =>
  ({ kind: "telegram_business", channelId: "ch-biz", botId: 222, chatId: 777, businessConnectionId: "bc-1", mode, ownerChatId: 999 });
const hook: BotHook = { tenant_id: "t-1", channel_id: "ch-bot", bot_id: 111, hook_secret_hash: createHash("sha256").update("s").digest(), token_secret: "marani/tg_bot_token" };

const tgError = (code: number, extra: Record<string, unknown> = {}) =>
  new GrammyError(`Call to 'sendMessage' failed! (${code})`, { ok: false, error_code: code, description: `error ${code}`, ...extra } as never, "sendMessage", {});

function setup(over: Partial<SendDeps> = {}) {
  const tenantApi = { sendMessage: vi.fn(async () => ({ message_id: 42 })) };
  const archableApi = { sendMessage: vi.fn(async () => ({ message_id: 43 })) };
  const deps = {
    channelToken: vi.fn(async () => TOKEN),
    archableApi: archableApi as unknown as SendDeps["archableApi"],
    record: vi.fn(async () => 9001),
    pauseChannel: vi.fn(async () => {}),
    noticeText: vi.fn(async (_t: string, kind: string) => (kind === "greeting" ? "Hi! Looking for a wine?" : "Please type your message.")),
    apiFor: vi.fn(() => tenantApi as unknown as SendDeps["archableApi"]),
    sleep: vi.fn(async () => {}),
    ...over,
  };
  return { ...createSender(deps), deps, tenantApi, archableApi };
}

describe("deliver", () => {
  it("telegram: reads the token from Vault per send, sends with the tenant bot and records the message", async () => {
    const s = setup();
    expect(await s.deliver(tg, "We have it.", { suggestion: "We have it." })).toBe(9001);
    expect(s.deps.channelToken).toHaveBeenCalledWith("marani/tg_bot_token");
    expect(s.deps.apiFor).toHaveBeenCalledWith(TOKEN);
    expect(s.tenantApi.sendMessage).toHaveBeenCalledWith(555, "We have it.");
    expect(s.deps.record).toHaveBeenCalledWith(tg, "We have it.", 42);
    expect(JSON.stringify(vi.mocked(s.deps.record).mock.calls)).not.toContain(TOKEN);
  });

  it("telegram_business reply: sends through @ArchableBot with the business_connection_id", async () => {
    const s = setup();
    await s.deliver(biz("reply"), "Yes, until 20:00.", { suggestion: "Yes, until 20:00." });
    expect(s.archableApi.sendMessage).toHaveBeenCalledWith(777, "Yes, until 20:00.", { business_connection_id: "bc-1" });
    expect(s.deps.channelToken).not.toHaveBeenCalled();
    expect(s.deps.record).toHaveBeenCalledWith(biz("reply"), "Yes, until 20:00.", 43);
  });

  it("telegram_business suggest: the customer gets nothing, the owner gets the suggested reply", async () => {
    const s = setup();
    await s.deliver(biz("suggest"), "Yes, until 20:00.", { suggestion: "Yes, until 20:00." });
    expect(s.archableApi.sendMessage).toHaveBeenCalledTimes(1);
    expect(s.archableApi.sendMessage).toHaveBeenCalledWith(999, "Suggested reply:\n\nYes, until 20:00.");
    expect(s.deps.record).toHaveBeenCalledWith(biz("suggest"), "Yes, until 20:00.", null);
  });

  it("telegram_business suggest with a blocked draft: nothing is sent to anyone", async () => {
    const s = setup();
    await s.deliver(biz("suggest"), "One moment, a colleague will reply.", { suggestion: null });
    expect(s.archableApi.sendMessage).not.toHaveBeenCalled();
    expect(s.deps.record).toHaveBeenCalledWith(biz("suggest"), "One moment, a colleague will reply.", null);
  });

  it.each<ReplyTarget>([{ kind: "web", sessionId: "ws-1" }, { kind: "console" }])("$kind: records only, sends nothing", async (target) => {
    const s = setup();
    expect(await s.deliver(target, "hi", { suggestion: "hi" })).toBe(9001);
    expect(s.tenantApi.sendMessage).not.toHaveBeenCalled();
    expect(s.archableApi.sendMessage).not.toHaveBeenCalled();
    expect(s.deps.record).toHaveBeenCalledWith(target, "hi", null);
  });
});

describe("Telegram errors", () => {
  it("429: waits retry_after seconds once, then succeeds", async () => {
    const s = setup();
    s.tenantApi.sendMessage.mockRejectedValueOnce(tgError(429, { parameters: { retry_after: 3 } }));
    expect(await s.deliver(tg, "hi", { suggestion: "hi" })).toBe(9001);
    expect(s.deps.sleep).toHaveBeenCalledWith(3000);
    expect(s.tenantApi.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("429: caps the wait at 5 s and gives up after the one retry", async () => {
    const s = setup();
    s.tenantApi.sendMessage.mockRejectedValue(tgError(429, { parameters: { retry_after: 30 } }));
    await expect(s.deliver(tg, "hi", { suggestion: "hi" })).rejects.toBeInstanceOf(GrammyError);
    expect(s.deps.sleep).toHaveBeenCalledWith(5000);
    expect(s.tenantApi.sendMessage).toHaveBeenCalledTimes(2);
    expect(s.deps.record).not.toHaveBeenCalled();
  });

  it("403 on a tenant bot: pauses the channel and fails the send", async () => {
    const s = setup();
    s.tenantApi.sendMessage.mockRejectedValueOnce(tgError(403));
    await expect(s.deliver(tg, "hi", { suggestion: "hi" })).rejects.toBeInstanceOf(GrammyError);
    expect(s.deps.pauseChannel).toHaveBeenCalledWith("ch-bot", "error 403");
    expect(s.deps.record).not.toHaveBeenCalled();
  });

  it("403 on a Business reply: pauses the Business channel", async () => {
    const s = setup();
    s.archableApi.sendMessage.mockRejectedValueOnce(tgError(403));
    await expect(s.deliver(biz("reply"), "hi", { suggestion: "hi" })).rejects.toBeInstanceOf(GrammyError);
    expect(s.deps.pauseChannel).toHaveBeenCalledWith("ch-biz", "error 403");
  });

  it("other errors: no retry, no pause", async () => {
    const s = setup();
    s.tenantApi.sendMessage.mockRejectedValueOnce(tgError(400));
    await expect(s.deliver(tg, "hi", { suggestion: "hi" })).rejects.toBeInstanceOf(GrammyError);
    expect(s.tenantApi.sendMessage).toHaveBeenCalledTimes(1);
    expect(s.deps.sleep).not.toHaveBeenCalled();
    expect(s.deps.pauseChannel).not.toHaveBeenCalled();
  });
});

describe("deliverNotice", () => {
  it("sends the tenant's notice text through the tenant bot without recording a message", async () => {
    const s = setup();
    await s.deliverNotice(hook, tg, "greeting");
    await s.deliverNotice(hook, tg, "text_only");
    expect(s.deps.noticeText).toHaveBeenCalledWith("t-1", "greeting");
    expect(s.tenantApi.sendMessage.mock.calls).toEqual([[555, "Hi! Looking for a wine?"], [555, "Please type your message."]]);
    expect(s.deps.record).not.toHaveBeenCalled();
  });
});
