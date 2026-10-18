import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { app } from "../app";
import { customDomains, mountChannels } from "./mount";

// Plan §6.7 step 3, run against the real app (app.ts → mountChannels) with the fail-closed stand-in deps.
const preflight = (origin: string, path = "/v1/chat/messages") =>
  app.request(path, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST" } });

describe("app.ts: customer channels mounted (plan §6.7 step 3)", () => {
  it("CORS: evil.example gets no Access-Control-Allow-Origin", async () => {
    const r = await preflight("https://evil.example");
    expect(r.status).toBeLessThan(500);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("CORS: the tenant origin is echoed, with no credentials", async () => {
    const r = await preflight("https://marani.archable.run");
    expect(r.headers.get("access-control-allow-origin")).toBe("https://marani.archable.run");
    expect(r.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("an unknown tenant-bot hook is 404", async () => {
    const r = await app.request(`/v1/webhooks/telegram/b/${randomUUID()}`, { method: "POST", body: "{}" });
    expect(r.status).toBe(404);
  });

  it("CORS covers the other shell endpoints and the custom-domain path doesn't throw", async () => {
    for (const p of ["/v1/manifest", "/v1/turns", "/v1/dev/graph", "/v1/bundles/sha256:abc/ui"]) {
      expect((await preflight("https://marani.archable.run", p)).headers.get("access-control-allow-origin")).toBe("https://marani.archable.run");
    }
    expect((await preflight("https://os.marani.ge")).headers.get("access-control-allow-origin")).toBeNull();
    customDomains.add("os.marani.ge");
    expect((await preflight("https://os.marani.ge")).headers.get("access-control-allow-origin")).toBe("https://os.marani.ge");
    customDomains.delete("os.marani.ge");
  });

  it("CORS: the shell's plain GET of the UI projection carries the header too (Q8)", async () => {
    const get = (origin: string) => app.request("/v1/bundles/sha256:abc/ui", { headers: { Origin: origin } });
    expect((await get("https://marani.archable.run")).headers.get("access-control-allow-origin")).toBe("https://marani.archable.run");
    expect((await get("https://evil.example")).headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("stand-in deps fail closed", () => {
  it("chat: no session opens", async () => {
    const r = await app.request("/v1/chat/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tenant: "marani" }) });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "chat_unavailable" });
  });

  it("chat: messages and events need a token", async () => {
    expect((await app.request("/v1/chat/messages", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await app.request("/v1/chat/events?after=0")).status).toBe(401);
  });

  it("widget: the loader is served, every config is 404", async () => {
    const js = await app.request("/v1/widget.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    const cfg = await app.request("/v1/widget/config/marani", { headers: { Origin: "https://marani.ge" } });
    expect(cfg.status).toBe(404);
    expect(cfg.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("healthz still answers", async () => {
    expect((await app.request("/healthz")).status).toBe(200);
  });
});

describe("@ArchableBot webhook", () => {
  it("is 503 without ARCHABLE_BOT_TOKEN and ARCHABLE_BOT_WEBHOOK_SECRET", async () => {
    const a = new Hono();
    mountChannels(a, {});
    expect((await a.request("/v1/webhooks/telegram/archable", { method: "POST", body: "{}" })).status).toBe(503);
  });

  it("with them, refuses a request without the right secret header", async () => {
    const a = new Hono();
    mountChannels(a, { ARCHABLE_BOT_TOKEN: "123456:AA-not-a-real-token-for-tests-only", ARCHABLE_BOT_WEBHOOK_SECRET: "s3cret_value" });
    const call = (secret?: string) => a.request("/v1/webhooks/telegram/archable", {
      method: "POST", headers: { "Content-Type": "application/json", ...(secret ? { "X-Telegram-Bot-Api-Secret-Token": secret } : {}) },
      body: JSON.stringify({ update_id: 1 }),
    });
    expect((await call()).status).toBe(401);
    expect((await call("wrong")).status).toBe(401);
  });
});
