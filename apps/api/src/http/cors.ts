// apps/api/src/http/cors.ts: two CORS policies, nothing else is reachable cross-origin.
// · tenantCors: the shell and the chat iframe, which always run on a tenant origin. Bearer tokens, no cookies.
// · publicCors: /v1/widget/config, read by the loader on any customer website. Public data only.
import { cors } from 'hono/cors';
import { routeOrigin } from './origin';

export function tenantCors(isCustomDomain: (host: string) => boolean) {
  return cors({
    origin: (origin) => {
      const r = routeOrigin(origin);
      if (!r) return null;
      return r.kind === 'tenant' || isCustomDomain(r.host) ? origin : null;   // echoed, never '*'
    },
    allowMethods: ['GET', 'POST'],
    allowHeaders: ['Authorization', 'Content-Type'],
    credentials: false,
    maxAge: 600,
  });
}

export const publicCors = () => cors({ origin: '*', allowMethods: ['GET'], maxAge: 3600 });
