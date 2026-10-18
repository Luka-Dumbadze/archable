// The gateway never opens connections; apps/api passes (tenantId, fn) => withTenant(runtimeDb, tenantId, fn),
// so every query runs as archable_runtime under the tenant's RLS context.
import type { TransactionSql } from 'postgres';

export type Tx = TransactionSql;
export type InTenant = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) => Promise<T>;
