// apps/api/src/http/origin.ts: which tenant a browser origin belongs to. The Origin header is set by the
// browser and can't be changed by page scripts, so it is the input for manifest and CORS decisions.
import type { Env } from '@archable/contracts';

export type OriginRoute =
  | { kind: 'tenant'; slug: string; env: Env }
  | { kind: 'custom'; host: string };

// Platform hostnames under archable.run. tenants.slug carries the same list as a check constraint.
export const RESERVED_SLUGS = new Set(['api', 'www', 'app', 'admin', 'docs', 'status', 'mcp', 'widget', 'chat', 'auth', 'static', 'cdn']);
const TENANT_HOST = /^(?:pr-([1-9][0-9]{0,5})--)?([a-z][a-z0-9-]{1,30}[a-z0-9])\.archable\.run$/;

export function routeOrigin(origin: string | undefined): OriginRoute | null {
  if (!origin) return null;
  let u: URL;
  try { u = new URL(origin); } catch { return null; }
  if (u.protocol !== 'https:' || u.port !== '' || u.origin !== origin) return null;   // exact origin, nothing else
  const m = TENANT_HOST.exec(u.hostname);
  if (m) {
    const [, pr, slug] = m as unknown as [string, string | undefined, string];
    if (slug.includes('--') || RESERVED_SLUGS.has(slug)) return null;   // '--' is reserved for previews
    return { kind: 'tenant', slug, env: pr ? (`pr-${Number(pr)}` as Env) : 'prod' };
  }
  if (u.hostname === 'archable.run' || u.hostname.endsWith('.archable.run')) return null;   // api, www, unknown labels
  return { kind: 'custom', host: u.hostname };
}
