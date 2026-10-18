import { randomUUID } from "node:crypto";
import { githubApp } from "@archable/governance";
import { Hono } from "hono";
import { memberFromJwt } from "./auth";
import { controlDb, runtimeDb } from "./db";
import { bundleRoutes } from "./routes/bundles";
import { manifestRoutes } from "./routes/manifest";
import { createShellStore } from "./shell-store";
import { devRoutes } from "./routes/devmode";
import { createDevStore } from "./devmode-store";
import { desireRoutes } from "./routes/desires";
import { createDesireStore } from "./desire-store";
import { registerGithubHandlers } from "./github-handlers";
import { createArchitect } from "./architect-wiring";
import { cronRoutes } from "./routes/cron";
import { githubWebhookRoutes } from "./routes/github";
import { turnRoutes } from "./routes/turn";
import { createTurnEngine } from "./turn-wiring";

// Route mounting is append-only (TEAM_PROTOCOL.md §2): each developer adds the lines for their own routes.
export const app = new Hono();

app.get("/healthz", (c) => c.json({ ok: true }));

// DEV-1: customer channels: web chat, widget, tenant-bot webhooks, @ArchableBot, tenant CORS (plan §6.4).
import { mountChannels } from "./channels/mount";
import { telegramDelivery } from "./channels/telegram/delivery";
const handleTurn = createTurnEngine({ deliver: telegramDelivery().deliver });   // Telegram replies through send.ts
mountChannels(app, process.env, handleTurn);

// DEV-2: console turns (plan §5.6)
app.route("/", turnRoutes({ memberFromJwt, handleTurn, newTurnId: randomUUID }));

// DEV-2: shell boot (v3 §2.4, plan §8.2): the manifest by origin, and a digest's UI projection for a member (P5.D2.1).
const shell = createShellStore(runtimeDb);
app.route("/", manifestRoutes(shell.manifest));
app.route("/", bundleRoutes({ memberFromJwt, uiProjection: shell.uiProjection }));

// DEV-2: Developer Mode, the A2A graph and edge inspector (plan §8.3, P5.D2.2). Owner and developer only.
app.route("/", desireRoutes(createDesireStore(controlDb, memberFromJwt)));   // the Desires Feed (Q9 (4)), before devRoutes
app.route("/", devRoutes(createDevStore(runtimeDb, { memberFromJwt, ...(process.env.ELVA_PLAYGROUND_URL ? { playgroundBase: process.env.ELVA_PLAYGROUND_URL } : {}) })));

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
  // DEV-2: the Architect's queues, drained by Vercel Cron and kicked by enqueuers (P4.D2.8). Needs Jev (TYPESAFE_API_KEY).
  const architect = process.env.TYPESAFE_API_KEY ? createArchitect({ app: github, log }) : null;
  registerGithubHandlers(github, { control: controlDb, log, ...(architect ? { kick: architect.kick } : {}) });   // P4.D2.7
  app.route("/", githubWebhookRoutes({ app: github, log }));
  if (architect) app.route("/", cronRoutes({ secret: process.env.CRON_SECRET, drain: architect.drain }));
}

