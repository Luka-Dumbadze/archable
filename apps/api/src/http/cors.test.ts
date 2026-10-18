import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { publicCors, tenantCors } from "./cors";

const app = new Hono();
app.use("/v1/chat/*", tenantCors((h) => h === "os.marani.ge"));
app.post("/v1/chat/messages", (c) => c.json({ ok: true }));
app.use("/v1/widget/config/*", publicCors());
app.get("/v1/widget/config/:slug", (c) => c.json({ ok: true }));

const preflight = (origin: string) =>
  app.request("/v1/chat/messages", {
    method: "OPTIONS",
    headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" },
  });

describe("tenantCors", () => {
  it("echoes a tenant origin, without credentials", async () => {
    const r = await preflight("https://marani.archable.run");
    expect(r.headers.get("access-control-allow-origin")).toBe("https://marani.archable.run");
    expect(r.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it.each(["https://archable.lovable.app", "http://localhost:5173"])("echoes shared frontend origin %s", async (origin) => {
    const r = await preflight(origin);
    expect(r.headers.get("access-control-allow-origin")).toBe(origin);
    expect(r.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("echoes a registered custom domain", async () => {
    const r = await preflight("https://os.marani.ge");
    expect(r.headers.get("access-control-allow-origin")).toBe("https://os.marani.ge");
  });

  it.each(["https://evil.com", "https://archable.lovable.app.evil.com", "https://marani.ge", "https://api.archable.run", "null"])("refuses %s", async (evil) => {
    const r = await preflight(evil);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("publicCors", () => {
  it("allows any origin on widget config", async () => {
    const r = await app.request("/v1/widget/config/marani", { headers: { Origin: "https://marani.ge" } });
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
  });
});
