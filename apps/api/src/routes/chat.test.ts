import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage, ChatSessionResponse } from "@archable/contracts";
import { chatRoutes, type ChatDeps } from "./chat";

// In-memory fakes for DEV-2's SQL wrappers and handleTurn (TEAM_PROTOCOL.md §2, "The seams").
const TENANT = "11111111-1111-1111-1111-111111111111";

function setup(over: Partial<ChatDeps> = {}) {
  const sessions = new Map<string, { tenant_id: string; session_id: string; conversation_id: string; env: "prod"; slug: string }>();
  const replies = new Map<string, ChatMessage>();
  const state = { turns: 0 };
  const deps: ChatDeps = {
    key: new TextEncoder().encode("k".repeat(32)),
    async openSession(slug, _env, h) {
      if (slug !== "marani") return null;
      const s = { tenant_id: TENANT, session_id: randomUUID(), conversation_id: randomUUID(), env: "prod" as const, slug };
      sessions.set(h.toString("hex"), s);
      return s;
    },
    async resumeSession(h) { return sessions.get(h.toString("hex")) ?? null; },
    async recentInbound() { return state.turns; },
    async existingReply(_c, id) { return replies.get(id) ?? null; },
    async outboundAfter() { return []; },
    async handleTurn(i) {
      state.turns++;
      const r = { turnId: i.turnId, text: `echo: ${i.text}`, allowed: true, outboundMessageId: 100 + state.turns, paused: false };
      replies.set(i.externalMessageId!, { id: r.outboundMessageId, author: "agent", text: r.text, at: "now" });
      return r;
    },
    newTurnId: () => randomUUID(),
    ...over,
  };
  const app = chatRoutes(deps);
  const post = (path: string, body: unknown, token?: string) =>
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  const get = (path: string, token?: string) =>
    app.request(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { post, get, state };
}

describe("chat sessions", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => { t = setup(); });

  it("returns 404 for an unknown tenant", async () => {
    expect((await t.post("/v1/chat/sessions", { tenant: "nope" })).status).toBe(404);
  });

  it("opens a session with a 43-char secret, then resumes it by secret without issuing a new one", async () => {
    const r1 = await t.post("/v1/chat/sessions", { tenant: "marani" });
    expect(r1.status).toBe(201);
    const s1 = (await r1.json()) as ChatSessionResponse;
    expect(s1.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const r2 = await t.post("/v1/chat/sessions", { tenant: "marani", secret: s1.secret });
    expect(r2.status).toBe(200);
    const s2 = (await r2.json()) as ChatSessionResponse;
    expect(s2.session_id).toBe(s1.session_id);
    expect(s2.secret).toBeUndefined();
  });

  it("does not resume a session under another tenant", async () => {
    const s1 = (await (await t.post("/v1/chat/sessions", { tenant: "marani" })).json()) as ChatSessionResponse;
    expect((await t.post("/v1/chat/sessions", { tenant: "acme", secret: s1.secret })).status).toBe(404);
  });

  it("rejects a malformed body with 400", async () => {
    expect((await t.post("/v1/chat/sessions", { tenant: "Bad Slug" })).status).toBe(400);
    expect((await t.post("/v1/chat/sessions", { tenant: "a--b" })).status).toBe(400);
  });
});

describe("chat messages", () => {
  let t: ReturnType<typeof setup>;
  let token: string;
  beforeEach(async () => {
    t = setup();
    token = ((await (await t.post("/v1/chat/sessions", { tenant: "marani" })).json()) as ChatSessionResponse).token;
  });

  it("runs a turn and returns the reply", async () => {
    const r = await t.post("/v1/chat/messages", { text: "gamarjoba", client_msg_id: randomUUID() }, token);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { messages: ChatMessage[] };
    expect(body.messages[0]?.text).toBe("echo: gamarjoba");
  });

  it("answers a retried POST with the same reply and no second turn", async () => {
    const id = randomUUID();
    const m1 = (await (await t.post("/v1/chat/messages", { text: "gamarjoba", client_msg_id: id }, token)).json()) as { messages: ChatMessage[] };
    const m2 = (await (await t.post("/v1/chat/messages", { text: "gamarjoba", client_msg_id: id }, token)).json()) as { messages: ChatMessage[] };
    expect(m2.messages[0]?.id).toBe(m1.messages[0]?.id);
    expect(t.state.turns).toBe(1);
  });

  it("returns 401 for a tampered or missing token", async () => {
    const tampered = token.slice(0, -2) + "xx";
    expect((await t.post("/v1/chat/messages", { text: "x", client_msg_id: randomUUID() }, tampered)).status).toBe(401);
    expect((await t.post("/v1/chat/messages", { text: "x", client_msg_id: randomUUID() })).status).toBe(401);
  });

  it("returns 400 for empty text or a non-UUID client_msg_id", async () => {
    expect((await t.post("/v1/chat/messages", { text: "", client_msg_id: randomUUID() }, token)).status).toBe(400);
    expect((await t.post("/v1/chat/messages", { text: "hi", client_msg_id: "1" }, token)).status).toBe(400);
  });

  it("returns 429 when the session is over its rate limit", async () => {
    t.state.turns = 12;
    expect((await t.post("/v1/chat/messages", { text: "spam", client_msg_id: randomUUID() }, token)).status).toBe(429);
  });
});

describe("human takeover and events", () => {
  const open = async (t: ReturnType<typeof setup>) =>
    ((await (await t.post("/v1/chat/sessions", { tenant: "marani" })).json()) as ChatSessionResponse).token;

  it("returns 202 pending with no agent text when a person has taken over", async () => {
    const t = setup({ handleTurn: async (i) => ({ turnId: i.turnId, text: "", allowed: true, outboundMessageId: 0, paused: true }) });
    const r = await t.post("/v1/chat/messages", { text: "hello?", client_msg_id: randomUUID() }, await open(t));
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ messages: [], pending: true });
  });

  it("delivers staff replies through /v1/chat/events and checks the token and cursor", async () => {
    const staff: ChatMessage = { id: 7, author: "staff", text: "Nino here, yes we deliver to Vake", at: "now" };
    const t = setup({ outboundAfter: async (_c, after) => (after < 7 ? [staff] : []) });
    const token = await open(t);
    expect((await t.get("/v1/chat/events?after=0")).status).toBe(401);
    expect((await t.get("/v1/chat/events?after=-1", token)).status).toBe(400);
    const r = await t.get("/v1/chat/events?after=0", token);
    expect(await r.json()).toEqual({ messages: [staff] });
  });
});
