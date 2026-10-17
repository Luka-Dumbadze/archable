import { handle } from "hono/vercel";
// The bundle built from src/app.ts (see package.json "build"), so Node needs no TS or extensionless resolution.
import { app } from "@archable/api/app";

export default handle(app);
