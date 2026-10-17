// apps/api/src/db.ts: one pool per plane, through Supavisor transaction mode (port 6543).
// Every unit of work is a transaction that starts by setting the tenant, so RLS applies to every query.
import postgres from 'postgres';

const pool = (url: string) => postgres(url, { prepare: false, max: 5, idle_timeout: 20, connect_timeout: 5 });

export const runtimeDb = pool(process.env.DATABASE_URL_RUNTIME!);   // archable_runtime.<ref>
export const controlDb = pool(process.env.DATABASE_URL_CONTROL!);   // archable_control.<ref>

export type Tx = postgres.TransactionSql;

export function withTenant<T>(db: postgres.Sql, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

// Postgres errors the API maps to HTTP; anything else is a 500 with the turn id in the log.
export function httpStatusOf(e: unknown): number {
  const code = (e as { code?: string } | null)?.code;
  return code === '23514' ? 422 : code === '42501' ? 403 : code === '40001' ? 409 : code === 'P0002' ? 404 : 500;
}
