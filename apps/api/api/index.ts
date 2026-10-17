import { handle } from "hono/vercel";
// The bundle built from src/app.ts (see package.json "build"), so Node needs no TS or extensionless resolution.
import { app } from "@archable/api/app";

// Vercel's Node runtime calls a default export as (req, res) and ignores a returned Response, so the
// fetch-style handler is exported once per HTTP method instead of as `export default handle(app)`.
const handler = handle(app);

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
export const HEAD = handler;
