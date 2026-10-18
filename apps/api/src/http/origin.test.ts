import { describe, expect, it } from "vitest";
import { routeOrigin } from "./origin";

describe("routeOrigin", () => {
  it("routes tenant, preview and custom-domain origins", () => {
    expect(routeOrigin("https://marani.archable.run")).toEqual({ kind: "tenant", slug: "marani", env: "prod" });
    expect(routeOrigin("https://pr-58--marani.archable.run")).toEqual({ kind: "tenant", slug: "marani", env: "pr-58" });
    expect(routeOrigin("https://os.marani.ge")).toEqual({ kind: "custom", host: "os.marani.ge" });
  });

  it("routes shared frontend origins to Marani by default and supports tenant query hints", () => {
    expect(routeOrigin("https://archable.lovable.app")).toEqual({ kind: "tenant", slug: "marani", env: "prod" });
    expect(routeOrigin("http://localhost:5173")).toEqual({ kind: "tenant", slug: "marani", env: "prod" });
    expect(routeOrigin("https://archable.lovable.app", "https://archable.vercel.app/v1/manifest?biz=kutaisi"))
      .toEqual({ kind: "tenant", slug: "kutaisi", env: "prod" });
    expect(routeOrigin("http://localhost:5173", "http://localhost:5173/v1/turns?tenant=tbilisi"))
      .toEqual({ kind: "tenant", slug: "tbilisi", env: "prod" });
    expect(routeOrigin("https://archable.lovable.app", "https://archable.vercel.app/v1/manifest?biz=kutaisi&tenant=tbilisi"))
      .toEqual({ kind: "tenant", slug: "kutaisi", env: "prod" });
  });

  it.each([
    "http://marani.archable.run",
    "https://marani.archable.run:8443",
    "https://api.archable.run.evil.com.archable.run",
    "https://a--b.archable.run",
    "https://api.archable.run",
    "https://www.archable.run",
    "https://pr-3--api.archable.run",
    "https://pr-0--marani.archable.run",
    "https://archable.run",
    "null",
    undefined,
    "https://marani.archable.run/x",
    "http://localhost:5174",
  ])("rejects %s", (bad) => {
    expect(routeOrigin(bad)).toBeNull();
  });

  it.each(["?biz=api", "?tenant=bad--slug", "?biz=", "?biz=has%20space"])("rejects invalid shared frontend tenant query %s", (query) => {
    expect(routeOrigin("https://archable.lovable.app", `https://archable.vercel.app/v1/manifest${query}`)).toBeNull();
  });
});
