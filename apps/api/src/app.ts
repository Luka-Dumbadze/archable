import { randomUUID } from "node:crypto";
import { githubApp } from "@archable/governance";
import { Hono } from "hono";
import { memberFromJwt } from "./auth";
import { githubWebhookRoutes } from "./routes/github";
import { turnRoutes } from "./routes/turn";
import { createTurnEngine } from "./turn-wiring";

// Route mounting is append-only (TEAM_PROTOCOL.md §2): each developer adds the lines for their own routes.
export const app = new Hono();

app.get("/healthz", (c) => c.json({ ok: true }));

// DEV-1: customer channels: web chat, widget, tenant-bot webhooks, @ArchableBot, tenant CORS (plan §6.4).
import { mountChannels } from "./channels/mount";
mountChannels(app);

// DEV-2: console turns (plan §5.6)
app.route("/", turnRoutes({ memberFromJwt, handleTurn: createTurnEngine(), newTurnId: randomUUID }));

// DEV-2: the archable-architect App's webhook (plan §7.1). Mounted only when the App is configured; the
// pull_request, pull_request_review and push handlers (ledger, card supersede) come with P4.D2.6 and P4.D2.7.
// GITHUB_WEBHOOK_SECRET is the canonical name; GITHUB_SECRET is accepted so existing .env files keep working.
const githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET ?? process.env.GITHUB_SECRET;
if (process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY && githubWebhookSecret) {
  const github = githubApp({ GITHUB_APP_ID: process.env.GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY,
                             GITHUB_WEBHOOK_SECRET: githubWebhookSecret });
  const log = (event: string, data: Record<string, unknown>) => console.log(JSON.stringify({ event, ...data }));
  for (const name of ['pull_request', 'pull_request_review', 'push'] as const) {
    github.webhooks.on(name, ({ id }) => log(`github.${name}`, { delivery: id }));
  }
  app.route("/", githubWebhookRoutes({ app: github, log }));
}

