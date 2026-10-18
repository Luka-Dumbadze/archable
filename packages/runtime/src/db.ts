// The runtime never opens connections. apps/api passes `(tenantId, fn) => withTenant(runtimeDb, tenantId, fn)`,
// so every query runs as archable_runtime inside a transaction whose RLS context is the tenant.
import type { TransactionSql } from 'postgres';

export type Tx = TransactionSql;
export type InTenant = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) => Promise<T>;
