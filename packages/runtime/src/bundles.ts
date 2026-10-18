// packages/runtime/src/bundles.ts: compiled bundles, cached by digest. A digest names immutable content, so the
// cache is never invalidated, only trimmed (least recently used first). Concurrent loads share one fetch.
import type { Bundle } from '@archable/compiler';
import type { InTenant } from './db';

export class BundleNotFound extends Error {
  constructor(readonly tenantId: string, readonly digest: string) {
    super(`bundle ${digest} not found for tenant ${tenantId}`);
    this.name = 'BundleNotFound';
  }
}

export function createBundles(inTenant: InTenant, max = 32) {
  const cache = new Map<string, Promise<Bundle>>();           // insertion order = recency

  return {
    // The tenant is part of the key and of the read: specs are visible only in their tenant's RLS context.
    load(tenantId: string, digest: string): Promise<Bundle> {
      const key = `${tenantId}|${digest}`;
      const hit = cache.get(key);
      if (hit) {
        cache.delete(key);
        cache.set(key, hit);
        return hit;
      }
      const loading = inTenant(tenantId, async (tx) => {
        const [row] = await tx<{ bundle: Bundle }[]>`select bundle from public.specs where tenant_id = ${tenantId} and digest = ${digest}`;
        if (!row) throw new BundleNotFound(tenantId, digest);
        return row.bundle;
      });
      loading.catch(() => { if (cache.get(key) === loading) cache.delete(key); });   // failures are not cached
      cache.set(key, loading);
      while (cache.size > max) cache.delete(cache.keys().next().value!);
      return loading;
    },
    get size() { return cache.size; },
  };
}
