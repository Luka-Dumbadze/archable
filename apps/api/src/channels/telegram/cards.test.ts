import { Bot, GrammyError } from "grammy";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { changeCardKeyboard } from "./archable-bot";
import { cardText, createCardEditor, type CardRef } from "./cards";

// grammY's real Api with the Telegram transport intercepted: tests see the exact editMessageText payloads.
type Call = { method: string; payload: Record<string, unknown> };
function telegram(fail: (c: Call, nth: number) => GrammyError | null = () => null) {
  const calls: Call[] = [];
  const bot = new Bot("123456:AA-fake-archable-bot-token-for-tests");
  bot.api.config.use(async (_prev, method, payload) => {
    const c = { method, payload: payload as Record<string, unknown> };
    calls.push(c);
    const err = fail(c, calls.length);
    if (err) throw err;
    return { ok: true, result: true as never };
  });
  return { api: bot.api, calls };
}
const tgError = (code: number, description: string, extra: Record<string, unknown> = {}) =>
  new GrammyError(`Call to 'editMessageText' failed! (${code}: ${description})`, { ok: false, error_code: code, description, ...extra } as never, "editMessageText", {});

const OWNER_CARD: CardRef = { chatId: 1001, messageId: 77 };
const STAFF_CARD: CardRef = { chatId: 3003, messageId: 12 };
const TITLE = "cash on delivery up to 300 GEL";
const UNDO_REF = "uNd0cR58xxxxxxxxxxxxxx";

describe("card edits", () => {
  it("supersede: every open card says it was updated and loses its buttons", async () => {
    const tg = telegram();
    const n = await createCardEditor({ api: tg.api }).supersede([OWNER_CARD, STAFF_CARD], TITLE);
    expect(n).toBe(2);
    expect(tg.calls).toEqual([
      { method: "editMessageText", payload: { chat_id: 1001, message_id: 77, text: cardText.superseded(TITLE), reply_markup: { inline_keyboard: [] } } },
      { method: "editMessageText", payload: { chat_id: 3003, message_id: 12, text: cardText.superseded(TITLE), reply_markup: { inline_keyboard: [] } } },
    ]);
    expect(cardText.superseded(TITLE)).toBe("This change was updated: cash on delivery up to 300 GEL.\n\nI'll send you the new version to approve.");
  });

  it("live: the card says Live in Marani OS and has one Undo button", async () => {
    const tg = telegram();
    await createCardEditor({ api: tg.api }).live([OWNER_CARD], "Marani OS", TITLE, UNDO_REF);
    expect(tg.calls[0]?.payload).toEqual({
      chat_id: 1001, message_id: 77,
      text: "Live in Marani OS: cash on delivery up to 300 GEL.\n\nYou can undo this for 24 hours.",
      reply_markup: { inline_keyboard: [[{ text: "Undo", callback_data: `ud:${UNDO_REF}` }]] },
    });
  });

  it("live refuses an undo ref that isn't a 22-char token", () => {
    expect(() => createCardEditor({ api: telegram().api }).live([OWNER_CARD], "Marani OS", TITLE, "short")).toThrow();
  });

  it("undone: the card says so and the Undo button goes away", async () => {
    const tg = telegram();
    await createCardEditor({ api: tg.api }).undone([OWNER_CARD], "Marani OS", TITLE);
    expect(tg.calls[0]?.payload).toMatchObject({ text: "Undone: cash on delivery up to 300 GEL.\n\nMarani OS is back to the previous version.", reply_markup: { inline_keyboard: [] } });
  });

  it("owner-facing card text has no Git words", () => {
    const all = [cardText.superseded(TITLE), cardText.live("Marani OS", TITLE), cardText.undone("Marani OS", TITLE)].join(" ");
    expect(all).not.toMatch(/\b(branch|merge|merged|pull request|PR|diff|commit|push|head)\b/i);
  });
});

describe("card edit failures", () => {
  it("a deleted card is logged and skipped; the others are still edited", async () => {
    const log = vi.fn();
    const tg = telegram((c) => (c.payload["chat_id"] === 1001 ? tgError(400, "Bad Request: message to edit not found") : null));
    expect(await createCardEditor({ api: tg.api, log }).supersede([OWNER_CARD, STAFF_CARD], TITLE)).toBe(1);
    expect(log).toHaveBeenCalledWith("telegram.card_edit_failed", expect.objectContaining({ chat: 1001, message: 77, code: 400 }));
  });

  it("'message is not modified' (a retried webhook) counts as done", async () => {
    const tg = telegram(() => tgError(400, "Bad Request: message is not modified"));
    expect(await createCardEditor({ api: tg.api }).supersede([OWNER_CARD], TITLE)).toBe(1);
  });

  it("429 waits retry_after once (capped at 5 s), then edits", async () => {
    const sleep = vi.fn(async () => {});
    const tg = telegram((_c, nth) => (nth === 1 ? tgError(429, "Too Many Requests: retry after 9", { parameters: { retry_after: 9 } }) : null));
    expect(await createCardEditor({ api: tg.api, sleep }).supersede([OWNER_CARD], TITLE)).toBe(1);
    expect(sleep).toHaveBeenCalledWith(5000);
    expect(tg.calls).toHaveLength(2);
  });
});

// The check: a push to the change edits the open card within one webhook round trip. DEV-2's routes/github.ts and
// governance are stand-ins here with the plan's behaviour (§7.3: a new push supersedes the open approvals).
describe("P4.D1.3 check: push → card edited before the webhook answers", () => {
  function githubStub() {
    const tg = telegram();
    const editor = createCardEditor({ api: tg.api });
    const cr = { id: "cr-58", title: TITLE, headSha: "a1b2c3d", approvals: [{ status: "pending", card: OWNER_CARD }, { status: "pending", card: STAFF_CARD }] };
    const app = new Hono();
    app.post("/v1/webhooks/github", async (c) => {
      const ev = (await c.req.json()) as { action: string; pull_request: { head: { sha: string } } };
      if (ev.action !== "synchronize" || ev.pull_request.head.sha === cr.headSha) return c.json({ edited: 0 });
      cr.headSha = ev.pull_request.head.sha;                                      // approvals name the old head: void them
      const open = cr.approvals.filter((a) => a.status === "pending");
      for (const a of open) a.status = "superseded";
      const edited = await editor.supersede(open.map((a) => a.card), cr.title);  // awaited inside the request
      return c.json({ edited });
    });
    return { app, tg, cr };
  }
  const push = (app: Hono, sha: string) => app.request("/v1/webhooks/github", { method: "POST", body: JSON.stringify({ action: "synchronize", pull_request: { head: { sha } } }) });

  it("edits both open cards before the response, removing Approve/Reject", async () => {
    const s = githubStub();
    const before = changeCardKeyboard({ approveNonce: "A".repeat(22), rejectNonce: "R".repeat(22), rationaleRef: "V".repeat(22), previewUrl: "https://pr-58--marani.archable.run" });
    expect(before.inline_keyboard.flat().map((b) => b.text)).toEqual(["Preview", "ℹ️ View rationale", "Approve…", "Reject"]);
    const r = await push(s.app, "e4f5a6b");
    expect(await r.json()).toEqual({ edited: 2 });
    expect(s.tg.calls.map((c) => [c.method, c.payload["reply_markup"]])).toEqual([
      ["editMessageText", { inline_keyboard: [] }], ["editMessageText", { inline_keyboard: [] }],
    ]);
    expect(s.cr.approvals.every((a) => a.status === "superseded")).toBe(true);
  });

  it("a redelivered webhook for the same head edits nothing", async () => {
    const s = githubStub();
    await push(s.app, "e4f5a6b");
    const r = await push(s.app, "e4f5a6b");
    expect(await r.json()).toEqual({ edited: 0 });
    expect(s.tg.calls).toHaveLength(2);
  });
});
