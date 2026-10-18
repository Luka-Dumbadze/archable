// packages/runtime/src/epochs.ts: pin(): one indexed read per turn (v3 §7.3: pinning is a read, not a cache).
// The turn then runs entirely on that digest, even if the epoch flips while it runs.
import type { Env } from '@archable/contracts';
import type { InTenant } from './db';

export interface Pin { tenantId: string; env: Env; digest: string; epoch: number }

export class PinError extends Error {
  constructor(readonly tenantId: string, readonly env: Env, readonly reason: 'not_live' | 'no_active_bundle' | 'preview_unsupported') {
    super(`cannot pin ${tenantId} ${env}: ${reason}`);
    this.name = 'PinError';
  }
}

export function createEpochs(inTenant: InTenant) {
  return {
    async pin(tenantId: string, env: Env): Promise<Pin> {
      // Preview bundles are named by change_requests, which the runtime role can't read; they come with Phase 4.
      if (env !== 'prod') throw new PinError(tenantId, env, 'preview_unsupported');
      const rows = await inTenant(tenantId, (tx) =>
        tx<{ digest: string | null; epoch: string }[]>`
          select active_digest as digest, epoch from public.tenants where id = ${tenantId} and status = 'live'`);
      const row = rows[0];
      if (!row) throw new PinError(tenantId, env, 'not_live');
      if (!row.digest) throw new PinError(tenantId, env, 'no_active_bundle');
      return { tenantId, env, digest: row.digest, epoch: Number(row.epoch) };
    },
  };
}
