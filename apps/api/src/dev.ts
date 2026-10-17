// apps/api/src/dev.ts: the API locally on :8787 (plan §3.1, CLAUDE.md §6), against the archable database.
// Telegram long polling with the dev bot is added by DEV-1 in Phase 3.
import { serve } from "@hono/node-server";
import { app } from "./app";

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => console.log(`archable api on http://localhost:${port}`));
