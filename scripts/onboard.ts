// scripts/onboard.ts: a new business, live in one command. From its tree (fixtures/<slug>) the compiler builds the whole
// backend (objects, tools, Cedar policies, the agent, the impact graph); this registers it on Supabase and goes live:
// tenant, verified bundle, projections, the owner (SEED_OWNER_TG_ID), web chat, epoch flip, the catalog.
//   SEED_OWNER_TG_ID=<id> pnpm tsx scripts/onboard.ts --slug elektro            then: provision-tenant-repo.ts --tenant elektro
// Idempotent, like seed-marani.ts.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parseArgs } from 'node:util';
import YAML from 'yaml';
import { compile } from '@archable/compiler';
import { controlDb, runtimeDb, withTenant } from '../apps/api/src/db';

const { values } = parseArgs({ options: { slug: { type: 'string' }, from: { type: 'string' } } });
const slug = values.slug!;
if (!slug) throw new Error('--slug is required');
const OWNER_TG = Number(process.env.SEED_OWNER_TG_ID);
if (!Number.isSafeInteger(OWNER_TG)) throw new Error('set SEED_OWNER_TG_ID (the owner\'s Telegram id)');
const ROOT = values.from ?? `fixtures/${slug}`;
const step = (s: string) => console.log(`• ${s}`);

const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const files = Object.fromEntries(walk(ROOT).map((p) => [relative(ROOT, p).split(sep).join('/'), readFileSync(p, 'utf8').replace(/\r\n/g, '\n')]));
const lock = YAML.parse(files['archable.lock']!);
const t0 = performance.now();
const { bundle, digest, projections } = compile({ files }, lock);
const m = bundle.metadata;
step(`compiled ${ROOT}: ${m.os_name} (${m.name}) → ${digest.slice(0, 19)}… in ${Math.round(performance.now() - t0)} ms`);
step(`  objects: ${Object.keys(bundle.objects).join(', ')}`);
step(`  tools: ${Object.keys(bundle.tools).length} (${Object.keys(bundle.tools).join(', ')})`);
step(`  agents: ${Object.entries(bundle.agents).map(([id, a]) => `${id} "${(a.display_name as Record<string, string>).en}"`).join(', ')}`);
step(`  Cedar policies: ${Object.keys(bundle.policies.byId).length} · impact graph: ${bundle.graph.nodes.length} nodes, ${bundle.graph.edges.length} edges · A2A: ${bundle.a2a.edges.length} edges`);

const h = createHash('sha256').update(`archable:tenant:${slug}`).digest('hex');
const tenantId = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
const catalog = (bundle.tools['catalog.search']?.reads[0] ?? '').split('.')[0]!;
const seed = Object.entries(files).find(([p]) => p.startsWith('seed/') && p.endsWith('.json'));

const out = await withTenant(controlDb, tenantId, async (tx) => {
  await tx`insert into public.tenants (id, slug, name, os_name, status) values (${tenantId}, ${slug}, ${m.name}, ${m.os_name}, 'live') on conflict (id) do nothing`;
  await tx`insert into public.specs (tenant_id, digest, git_sha, compiler_version, bundle, verified_at)
           values (${tenantId}, ${digest}, 'onboard', ${lock.compiler}, ${tx.json(bundle as never)}, now()) on conflict do nothing`;
  for (const e of projections.entitySchemas) await tx`insert into public.entity_schemas ${tx({ tenant_id: tenantId, spec_digest: digest, ...e } as never)} on conflict do nothing`;
  for (const a of projections.apps) await tx`insert into public.apps ${tx({ tenant_id: tenantId, spec_digest: digest, ...a } as never)} on conflict do nothing`;
  await tx`insert into public.memberships (tenant_id, role, display_name, tg_user_id) values (${tenantId}, 'owner', 'Owner', ${OWNER_TG}) on conflict do nothing`;
  await tx`insert into public.channel_connections (tenant_id, channel_key, kind)
           select ${tenantId}, 'web_chat', 'web'
            where not exists (select 1 from public.channel_connections where tenant_id = ${tenantId} and kind = 'web' and status <> 'revoked')`;
  const [{ active_digest, epoch }] = await tx`select active_digest, epoch from public.tenants where id = ${tenantId}`;
  if (active_digest !== digest) await tx`select public.flip_epoch(${tenantId}, ${epoch}, ${digest})`;
  let items = 0;
  if (seed && catalog) {
    for (const row of JSON.parse(seed[1]) as Record<string, unknown>[]) {
      const r = await tx`insert into public.records (tenant_id, entity_type, attrs, spec_digest, created_by, provenance)
               values (${tenantId}, ${catalog}, ${tx.json(row as never)}, ${digest}, 'import', ${tx.json({ source: seed[0] })}) on conflict do nothing returning id`;
      items += r.length;
    }
  }
  const [t] = await tx`select epoch from public.tenants where id = ${tenantId}`;
  return { epoch: t!.epoch, items };
});
step(`live: tenant ${slug} (${tenantId}) · epoch ${out.epoch} · owner Telegram ${OWNER_TG} · ${out.items} new ${catalog} records`);
step(`shell: https://${slug}.archable.run · API manifest by Origin https://${slug}.archable.run`);
await controlDb.end();
await runtimeDb.end();
