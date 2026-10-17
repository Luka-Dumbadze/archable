// scripts/seed-marani.ts
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { compile } from '@archable/compiler';
import { controlDb, withTenant } from '../apps/api/src/db';

const ROOT = 'fixtures/marani';
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
// POSIX keys on Windows too, so files['seed/wines.json'] resolves.
const files = Object.fromEntries(walk(ROOT).map((p) => [relative(ROOT, p).split(sep).join('/'), readFileSync(p, 'utf8')]));
const lock = YAML.parse(files['archable.lock']!);
const { bundle, digest, projections } = compile({ files }, lock);

const OWNER_TG = Number(process.env.SEED_OWNER_TG_ID);                 // your own Telegram user id
if (!Number.isSafeInteger(OWNER_TG)) throw new Error('set SEED_OWNER_TG_ID');

// The control role sees no tenant before its context is set, so the id is derived from the slug: reruns hit the same row.
const h = createHash('sha256').update('archable:tenant:marani').digest('hex');
const tenantId = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;

await withTenant(controlDb, tenantId, async (tx) => {
  await tx`insert into public.tenants (id, slug, name, os_name, status)
           values (${tenantId}, 'marani', 'Marani', 'Marani OS', 'live') on conflict (id) do nothing`;
  await tx`insert into public.specs (tenant_id, digest, git_sha, compiler_version, bundle, verified_at)
           values (${tenantId}, ${digest}, 'seed', ${lock.compiler}, ${tx.json(bundle as never)}, now())
           on conflict do nothing`;
  for (const e of projections.entitySchemas) {
    await tx`insert into public.entity_schemas ${tx({ tenant_id: tenantId, spec_digest: digest, ...e } as never)}
             on conflict do nothing`;
  }
  for (const a of projections.apps) {
    await tx`insert into public.apps ${tx({ tenant_id: tenantId, spec_digest: digest, ...a } as never)} on conflict do nothing`;
  }
  await tx`insert into public.memberships (tenant_id, role, display_name, tg_user_id)
           values (${tenantId}, 'owner', 'Owner', ${OWNER_TG}) on conflict do nothing`;
  await tx`insert into public.channel_connections (tenant_id, channel_key, kind)
           select ${tenantId}, 'web_chat', 'web'
            where not exists (select 1 from public.channel_connections where tenant_id = ${tenantId} and kind = 'web' and status <> 'revoked')`;
  const [{ active_digest, epoch }] = await tx`select active_digest, epoch from public.tenants where id = ${tenantId}`;
  if (active_digest !== digest) await tx`select public.flip_epoch(${tenantId}, ${epoch}, ${digest})`;
  for (const w of JSON.parse(files['seed/wines.json']!) as Record<string, unknown>[]) {   // mined rows, with provenance
    await tx`insert into public.records (tenant_id, entity_type, attrs, spec_digest, created_by, provenance)
             values (${tenantId}, 'wine', ${tx.json(w as never)}, ${digest}, 'import', ${tx.json({ source: 'fixture' })})
             on conflict do nothing`;
  }
});
console.log(JSON.stringify({ tenantId, digest }));
await controlDb.end();
