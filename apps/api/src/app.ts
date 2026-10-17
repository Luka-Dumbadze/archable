import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { memberFromJwt } from "./auth";
import { turnRoutes } from "./routes/turn";
import { createTurnEngine } from "./turn-wiring";

// Route mounting is append-only (TEAM_PROTOCOL.md §2): each developer adds the lines for their own routes.
export const app = new Hono();

app.get("/healthz", (c) => c.json({ ok: true }));

// DEV-2: console turns (plan §5.6)
app.route("/", turnRoutes({ memberFromJwt, handleTurn: createTurnEngine(), newTurnId: randomUUID }));
