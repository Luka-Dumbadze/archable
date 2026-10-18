import { describe, expect, it } from 'vitest';
import type { Env, Manifest, UiProjection } from '@archable/contracts';
import { bundleRoutes } from './bundles';
import { manifestRoutes } from './manifest';

const manifest = (slug: string, env: Env, digest: string): Manifest => ({ tenant_id: 't-1', slug, env, digest, epoch: 14, os_name: 'Marani OS',
  branding: { brand: '#7B1E3A', font: 'Noto Sans Georgian', radius: 'md' }, extension_url: null, topic: 'tenant:t-1' });
const asked: string[] = [];
const m = manifestRoutes({
  bySlug: async (slug, env) => { asked.push(`${slug}/${env}`); return slug === 'marani' ? manifest(slug, env, env === 'prod' ? 'sha256:live' : 'sha256:preview') : null; },
  byCustomDomain: async (host) => (host === 'os.marani.ge' ? manifest('marani', 'prod', 'sha256:live') : null),
});
const get = (origin?: string) => m.request('/v1/manifest', { headers: origin ? { origin } : {} });

describe('GET /v1/manifest (plan §8.2)', () => {
  it('the tenant comes from the Origin: production, a preview, a custom domain', async () => {
    expect(await (await get('https://marani.archable.run')).json()).toMatchObject({ slug: 'marani', env: 'prod', digest: 'sha256:live' });
    expect(await (await get('https://pr-58--marani.archable.run')).json()).toMatchObject({ env: 'pr-58', digest: 'sha256:preview' });
    expect(await (await get('https://os.marani.ge')).json()).toMatchObject({ digest: 'sha256:live' });
    expect(asked).toEqual(['marani/prod', 'marani/pr-58']);
  });
  it('uses the shared frontend request query to select a tenant', async () => {
    const r = await m.request('/v1/manifest?biz=kutaisi', { headers: { origin: 'https://archable.lovable.app' } });
    expect(r.status).toBe(404);
    expect(asked.at(-1)).toBe('kutaisi/prod');
  });
  it('cached 5 s at the edge, varied by Origin', async () => {
    const r = await get('https://marani.archable.run');
    expect(r.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=5');
    expect(r.headers.get('vary')).toBe('Origin');
  });
  it('no or a platform origin is 400; an unknown tenant is 404', async () => {
    expect((await get()).status).toBe(400);
    expect((await get('https://api.archable.run')).status).toBe(400);
    expect((await get('http://marani.archable.run')).status).toBe(400);
    expect((await get('https://nobody.archable.run')).status).toBe(404);
  });
});

const DIGEST = 'sha256:' + 'a'.repeat(64);
const projection = { digest: DIGEST, theme: { brand: '#7B1E3A', radius: 'md', font: 'x' }, nav: [], views: {}, apps: [], objects: {},
                     labels: { nodes: {}, values: {} } } satisfies UiProjection;
const b = bundleRoutes({
  memberFromJwt: async (auth, origin) => (auth === 'Bearer ok' && origin === 'https://marani.archable.run' ? { tenantId: 't-1', membershipId: 'm', role: 'owner' } : null),
  uiProjection: async (tenantId, digest) => (tenantId === 't-1' && digest === DIGEST ? projection : null),
});
const ui = (digest: string, auth?: string) => b.request(`/v1/bundles/${digest}/ui`, { headers: { origin: 'https://marani.archable.run', ...(auth ? { authorization: auth } : {}) } });

describe('GET /v1/bundles/:digest/ui (v3 §2.4)', () => {
  it('a member gets the projection, cached forever and privately', async () => {
    const r = await ui(DIGEST, 'Bearer ok');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(projection);
    expect(r.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
  });
  it('no member is 401; a digest of another tenant or a malformed digest is refused', async () => {
    expect((await ui(DIGEST)).status).toBe(401);
    expect((await ui('sha256:' + 'b'.repeat(64), 'Bearer ok')).status).toBe(404);
    expect((await ui('latest', 'Bearer ok')).status).toBe(400);
  });
});
