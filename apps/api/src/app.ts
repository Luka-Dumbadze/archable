import { Hono } from "hono";

// Route mounting is append-only (TEAM_PROTOCOL.md §2): each developer adds the lines for their own routes.
export const app = new Hono();

app.get("/healthz", (c) => c.json({ ok: true }));

// DEV-1: customer channels: web chat, widget, tenant-bot webhooks, @ArchableBot, tenant CORS (plan §6.4).
import { mountChannels } from "./channels/mount";
mountChannels(app);
