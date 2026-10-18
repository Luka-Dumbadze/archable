import { describe, expect, it, vi } from "vitest";
import { channelDeps, liveChannelDeps } from "./live";
import { archableBotDeps as unwiredBot, chatDeps, webhookDeps, widgetDeps as unwiredWidget } from "./unwired";

// A stand-in for DEV-2's channel store: records which functions the live deps call.
function store() {
  const calls: string[] = [];
  const f = <T,>(name: string, v: T) => vi.fn(async (..._a: unknown[]) => { calls.push(name); return v; });
  const s = {
    widgetConfig: f("widgetConfig", { greeting: { en: "Hi" }, launcher: { label: { en: "Chat" }, position: "right" as const }, brand: "#7B1E3A", embed_origins: [] }),
    ownerTenants: f("ownerTenants", []), createLinkIntent: f("createLinkIntent", undefined),
    bindBusinessConnection: f("bindBusinessConnection", { outcome: "bound" as const, tenant_id: "t" }),
    resolveBusinessConnection: f("resolveBusinessConnection", null), bindTenantBot: f("bindTenantBot", "ch"),
    revokeChannel: f("revokeChannel", undefined), pauseAgent: f("pauseAgent", undefined),
  };
  return { calls, s: s as unknown as NonNullable<Parameters<typeof liveChannelDeps>[0]> };
}

describe("channel deps selection", () => {
  it("without both database URLs every channel stays on the fail-closed stand-ins", () => {
    for (const env of [{}, { DATABASE_URL_RUNTIME: "x" }, { DATABASE_URL_CONTROL: "x" }]) {
      const live = vi.fn();
      const d = channelDeps(env, live);
      expect(live).not.toHaveBeenCalled();
      expect(d).toEqual({ chatDeps, webhookDeps, widgetDeps: unwiredWidget, archableBotDeps: unwiredBot });
    }
  });

  it("with both, the live deps are used", () => {
    const live = vi.fn(() => liveChannelDeps(store().s));
    channelDeps({ DATABASE_URL_RUNTIME: "r", DATABASE_URL_CONTROL: "c" }, live);
    expect(live).toHaveBeenCalledTimes(1);
  });
});

describe("live deps: wired only where ready end to end", () => {
  it("widget config and @ArchableBot channel binding go to the channel store", async () => {
    const { s, calls } = store();
    const d = liveChannelDeps(s);
    await d.widgetDeps.widgetConfig("marani");
    await d.archableBotDeps.ownerTenants(1);
    await d.archableBotDeps.createLinkIntent("t", "m", 1);
    await d.archableBotDeps.bindBusinessConnection({ viaBot: 1, connectionId: "bc", user: 1, userChat: 1, canReply: true, enabled: true });
    await d.archableBotDeps.resolveBusinessConnection(1, "bc");
    await d.archableBotDeps.bindTenantBot({ tenantId: "t", membershipId: "m", botId: 1, username: "u", token: "x", hookId: "h", secretHash: Buffer.alloc(32) });
    await d.archableBotDeps.revokeChannel("t", "ch");
    await d.archableBotDeps.pauseAgent("t", "k", 30);
    expect(calls).toEqual(["widgetConfig", "ownerTenants", "createLinkIntent", "bindBusinessConnection", "resolveBusinessConnection", "bindTenantBot", "revokeChannel", "pauseAgent"]);
  });

  it("chat, tenant-bot webhooks, turns and governance stay fail-closed", async () => {
    const d = liveChannelDeps(store().s);
    expect(d.chatDeps).toBe(chatDeps);
    expect(d.webhookDeps).toBe(webhookDeps);
    await expect(d.archableBotDeps.runTurn({} as never)).rejects.toThrow(/not wired/);
    expect(await d.archableBotDeps.consume({} as never)).toEqual({ outcome: "unknown", change_request_id: null });
    expect(await d.archableBotDeps.ownerPress(1, "x")).toBeNull();
  });
});
