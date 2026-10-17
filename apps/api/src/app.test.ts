import { describe, expect, it } from "vitest";
import { app } from "./app";

describe("app", () => {
  it("GET /healthz returns 200", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
