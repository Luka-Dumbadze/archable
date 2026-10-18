// packages/architect/src/eval-host.ts: an eval environment on the database (v3 §2.4 preview environments).
// Evals run against `env = 'pr-<n>'` rows seeded from the tenant's fixtures, with the bundle under test pinned and
// external tools simulated (the gateway simulates outside prod). The control plane registers and cleans up; turns
// run through the real turn engine on the runtime plane. Nothing here touches prod rows.
import { randomUUID } from 'node:crypto';
import type { Bundle, Projections } from '@archable/compiler';
import type { Env } from '@archable/contracts';
import type { Experimental_DecisionModelV4 } from '@ai-sdk/provider';
import { displayMoney, type HandleTurn } from '@archable/runtime';
import { experimental_decide } from 'ai';
import type postgres from 'postgres';
import type { EvalHost } from './evals';

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;
const inTenant = <T>(db: Sql, tenantId: string, fn: (tx: Tx) => Promise<T>) =>
  db.begin(async (tx) => { await tx`select set_config('app.tenant_id', ${tenantId}, true)`; return fn(tx); }) as Promise<T>;

export interface Registered { digest: string; bundle: Bundle; projections: Projections }

/** Registers bundles as candidates (if new) and seeds the env's catalog from the tree's fixtures. */
export async function openEvalEnv(control: Sql, o: { tenantId: string; env: Env; gitSha: string; compiler: string;
                                                   bundles: Registered[]; seedDigest: string; files: Record<string, string> }) {
  const inserted: string[] = [];
  await inTenant(control, o.tenantId, async (tx) => {
    for (const b of o.bundles) {
      const rows = await tx`insert into public.specs (tenant_id, digest, git_sha, compiler_version, bundle)
        values (${o.tenantId}, ${b.digest}, ${o.gitSha}, ${o.compiler}, ${tx.json(b.bundle as never)}) on conflict do nothing returning digest`;
      if (!rows.length) continue;
      inserted.push(b.digest);
      for (const e of b.projections.entitySchemas) await tx`insert into public.entity_schemas ${tx({ tenant_id: o.tenantId, spec_digest: b.digest, ...e } as never)}`;
      for (const a of b.projections.apps) await tx`insert into public.apps ${tx({ tenant_id: o.tenantId, spec_digest: b.digest, ...a } as never)}`;
    }
    await cleanEnv(tx, o.tenantId, o.env, []);                              // a crashed earlier run leaves nothing behind
    for (const w of JSON.parse(o.files['seed/wines.json'] ?? '[]') as Record<string, unknown>[]) {
      await tx`insert into public.records (tenant_id, env, entity_type, attrs, spec_digest, created_by, provenance)
               values (${o.tenantId}, ${o.env}, 'wine', ${tx.json(w as never)}, ${o.seedDigest}, 'import', ${tx.json({ source: 'eval fixture' })})`;
    }
  });
  return { inserted };
}

async function cleanEnv(tx: Tx, tenantId: string, env: Env, turnIds: string[]) {
  if (turnIds.length) {
    await tx`delete from public.failures where tenant_id = ${tenantId} and turn_id in ${tx(turnIds)}`;
    await tx`delete from public.decision_log where tenant_id = ${tenantId} and turn_id in ${tx(turnIds)}`;
  }
  await tx`delete from public.tool_calls where tenant_id = ${tenantId} and env = ${env}`;
  await tx`delete from public.conversations where tenant_id = ${tenantId} and env = ${env}`;    // messages cascade
  await tx`delete from public.chapters where tenant_id = ${tenantId} and env = ${env}`;
  await tx`delete from public.records where tenant_id = ${tenantId} and env = ${env}`;
}

/** Deletes every row the env's turns wrote, then the candidate bundles this run registered. */
export async function closeEvalEnv(control: Sql, o: { tenantId: string; env: Env; turnIds: string[]; unregister: string[] }) {
  await inTenant(control, o.tenantId, async (tx) => {
    await cleanEnv(tx, o.tenantId, o.env, o.turnIds);
    if (o.unregister.length) {
      await tx`delete from public.specs where tenant_id = ${o.tenantId} and digest in ${tx(o.unregister)} and state = 'candidate'`;
    }
  });
}

export interface HostDeps {
  control: Sql;
  tenantId: string;
  env: Env;
  digest: string;                                      // the pinned bundle; fixture rows are written against it
  bundle: Bundle;
  handleTurn: HandleTurn;                              // a turn engine pinned to that bundle in this env
  observed: Map<string, { tool: string; output: Record<string, unknown> }[]>;   // the engine's tool results, by turn
  judgeModel: Experimental_DecisionModelV4;            // Jev
  turnIds: string[];                                   // collected for cleanup
}

export function evalHost(d: HostDeps): EvalHost {
  return {
    async customer(f) {
      return inTenant(d.control, d.tenantId, async (tx) => {
        const attrs = { name: f.name ?? 'Eval customer', phone: f.phone, age_verified: f.age_verified ?? false };
        const [r] = await tx<{ id: string }[]>`insert into public.records (tenant_id, env, entity_type, attrs, spec_digest, created_by)
          values (${d.tenantId}, ${d.env}, 'customer', ${tx.json(attrs)}, ${d.digest}, 'import')
          on conflict (tenant_id, env, entity_type, natural_key) where natural_key is not null
          do update set attrs = excluded.attrs returning id`;
        return r!.id;
      });
    },
    async turn(key, text, customerId) {
      await inTenant(d.control, d.tenantId, (tx) => tx`insert into public.conversations (tenant_id, env, channel, external_id, customer_id)
        values (${d.tenantId}, ${d.env}, 'web', ${key}, ${customerId}) on conflict do nothing`);
      const turnId = randomUUID();
      d.turnIds.push(turnId);
      const r = await d.handleTurn({ turnId, tenantId: d.tenantId, env: d.env, channel: 'web', conversationKey: key,
                                     externalMessageId: null, text, customer: {}, reply: { kind: 'console' } });
      // Money as the customer reads it, as the pre-send check sees it (drafts.ts).
      const evidence = (d.observed.get(turnId) ?? []).map((e) =>
        `${e.tool} returned ${JSON.stringify(displayMoney(e.output, d.bundle.tools[e.tool]?.output as never))}`);
      return { turnId, text: r.text, allowed: r.allowed, evidence };
    },
    async toolsCalled(turnIds) {
      const rows = await inTenant(d.control, d.tenantId, (tx) =>
        tx<{ tool: string }[]>`select distinct tool from public.tool_calls where tenant_id = ${d.tenantId} and turn_id in ${tx(turnIds)}`);
      return rows.map((r) => r.tool);
    },
    async judge(state, questions) {
      const r = await experimental_decide({
        model: d.judgeModel, state, maxRetries: 1,
        questions: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, { type: 'boolean' as const, instructions: q }])),
      });
      return Object.fromEntries(Object.entries(r.answers).map(([id, a]) => [id, (a as { probability: number }).probability]));
    },
  };
}
