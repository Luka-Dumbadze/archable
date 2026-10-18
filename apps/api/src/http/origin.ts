// apps/api/src/http/origin.ts: which tenant a browser request belongs to. The Origin header is set by the
// browser and can't be changed by page scripts; the two shared frontends use a tenant query hint instead.
import type { Env } from '@archable/contracts';

export type OriginRoute =
  | { kind: 'tenant'; slug: string; env: Env }
  | { kind: 'custom'; host: string };

// Platform hostnames under archable.run. tenants.slug carries the same list as a check constraint.
export const RESERVED_SLUGS = new Set(['api', 'www', 'app', 'admin', 'docs', 'status', 'mcp', 'widget', 'chat', 'auth', 'static', 'cdn']);
const TENANT_HOST = /^(?:pr-([1-9][0-9]{0,5})--)?([a-z][a-z0-9-]{1,30}[a-z0-9])\.archable\.run$/;
const TENANT_SLUG = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const SHARED_FRONTENDS = new Set(['https://archable.lovable.app', 'http://localhost:5173']);

function queryTenant(requestUrl: string | URL | undefined): string | null {
  if (!requestUrl) return 'marani';
  let params: URLSearchParams;
  try {
    params = new URL(requestUrl).searchParams;
  } catch {
    return null;
  }
  const slug = params.has('biz') ? params.get('biz') : params.get('tenant');
  if (slug === null) return 'marani';
  if (!TENANT_SLUG.test(slug) || slug.includes('--') || RESERVED_SLUGS.has(slug)) return null;
  return slug;
}

export function routeOrigin(origin: string | undefined, requestUrl?: string | URL): OriginRoute | null {
  if (!origin) return null;
  // Lovable and local development host several tenants under one frontend origin. Only these exact
  // origins may select a tenant by query string; normal tenant and custom-domain routing is unchanged.
  if (SHARED_FRONTENDS.has(origin)) {
    const slug = queryTenant(requestUrl);
    return slug ? { kind: 'tenant', slug, env: 'prod' } : null;
  }
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
