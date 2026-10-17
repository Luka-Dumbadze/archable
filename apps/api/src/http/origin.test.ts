import { describe, expect, it } from "vitest";
import { routeOrigin } from "./origin";

describe("routeOrigin", () => {
  it("routes tenant, preview and custom-domain origins", () => {
    expect(routeOrigin("https://marani.archable.run")).toEqual({ kind: "tenant", slug: "marani", env: "prod" });
    expect(routeOrigin("https://pr-58--marani.archable.run")).toEqual({ kind: "tenant", slug: "marani", env: "pr-58" });
    expect(routeOrigin("https://os.marani.ge")).toEqual({ kind: "custom", host: "os.marani.ge" });
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
  ])("rejects %s", (bad) => {
    expect(routeOrigin(bad)).toBeNull();
  });
});
