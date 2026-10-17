import { describe, expect, it } from "vitest";
import { LOADER, widgetRoutes, type WidgetConfig } from "./widget";

const marani: WidgetConfig = {
  greeting: { en: "Hi! Looking for a wine?" },
  launcher: { label: { ka: "მოგვწერეთ", en: "Chat with us" }, position: "right" },
  brand: "#7B1E3A",
};
const app = widgetRoutes({ async widgetConfig(s) { return s === "marani" ? marani : null; } });

describe("widget loader", () => {
  it("parses as JavaScript", () => {
    expect(() => new Function(LOADER)).not.toThrow();
  });

  it("is served as cacheable, nosniff JavaScript", async () => {
    const r = await app.request("/v1/widget.js");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("cache-control")).toBe("public, max-age=300, s-maxage=3600");
    expect(await r.text()).toBe(LOADER);
  });

  it("only talks to the tenant origin and the API, and checks message origin and source", () => {
    expect(LOADER).toContain("'https://' + slug + '.archable.run'");
    expect(LOADER).toContain("'https://api.archable.run/v1/widget/config/' + slug");
    expect(LOADER).toContain("e.origin !== origin || e.source !== frame.contentWindow");
  });
});

describe("widget config", () => {
  it("is public: readable from any site with CORS *", async () => {
    const r = await app.request("/v1/widget/config/marani", { headers: { Origin: "https://marani.ge" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=60");
    expect(await r.json()).toEqual(marani);
  });

  it("returns 404 when the tenant has chat off or doesn't exist", async () => {
    const r = await app.request("/v1/widget/config/acme");
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "chat_unavailable" });
  });
});
