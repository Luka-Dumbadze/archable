// scripts/draft-check.ts: P4.D2.8's live check (plan §7.8 "for real", step 1). As the owner would through @ArchableBot:
// ownerMessage → the statement with Draft it / Not this → ownerPress(Draft it), which enqueues the draft job and kicks
// the drain (waitUntil); this script awaits that drain and reports what the job did. The governance deps and the
// Architect are built exactly as apps/api/src/app.ts builds them.
//   pnpm tsx scripts/draft-check.ts --tenant marani --say "customers want to pay the courier in cash, up to 300 lari"
import { createHash, createPrivateKey } from 'node:crypto';
import { parseArgs } from 'node:util';
import { App } from 'octokit';
import { controlDb, runtimeDb, withTenant } from '../apps/api/src/db';
import { createArchitect } from '../apps/api/src/architect-wiring';
import { createGovernanceDeps } from '../apps/api/src/governance-deps';
import { createLanguageModels } from '../apps/api/src/turn-wiring';

const { values } = parseArgs({ options: { tenant: { type: 'string', default: 'marani' }, say: { type: 'string' } } });
const slug = values.tenant!, text = values.say!;
const tg = Number(process.env.SEED_OWNER_TG_ID);
if (!text || !Number.isSafeInteger(tg)) throw new Error('--say and SEED_OWNER_TG_ID are required');
const h = createHash('sha256').update(`archable:tenant:${slug}`).digest('hex');
const tenantId = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
const log = (event: string, data: Record<string, unknown>) => console.log(JSON.stringify({ event, ...data }).slice(0, 400));

const app = new App({ appId: Number(process.env.GITHUB_APP_ID), privateKey: createPrivateKey(process.env.GITHUB_APP_PRIVATE_KEY!).export({ type: 'pkcs8', format: 'pem' }).toString() });
const architect = createArchitect({ app, log });
let kicked: Promise<void> | null = null;
const [active] = await withTenant(controlDb, tenantId, (tx) => tx<{ bundle: { models: { dialogue: { model: string; reasoning?: string } } } }[]>`
  select s.bundle from public.specs s join public.tenants t on t.id = s.tenant_id and t.active_digest = s.digest where t.id = ${tenantId}`);
const deps = createGovernanceDeps({ control: controlDb, app, log, kick: () => { kicked = architect.kick(); },
  intake: { jev: architect.author.jev, lane: { model: createLanguageModels()(active!.bundle.models.dialogue.model) } } });

const t0 = performance.now();
const reply = await deps.ownerMessage(tg, text);
console.log(`ownerMessage → ${JSON.stringify({ text: reply.text, buttons: reply.buttons.map((b) => b.label) })}`);
const draftIt = reply.buttons.find((b) => b.label === 'Draft it');
if (!draftIt || draftIt.action !== 'post') throw new Error('no Draft it button');
const pressed = await deps.ownerPress(tg, String(draftIt.body.ref));
console.log(`ownerPress(Draft it) → ${JSON.stringify(pressed)} · kicked: ${kicked !== null}`);
await kicked;                                                     // the drain the kick started
console.log(`drain finished ${((performance.now() - t0) / 1000).toFixed(0)} s after the owner's message`);
const rows = await withTenant(controlDb, tenantId, (tx) => tx`select d.number, d.status, c.pr_number, c.tier, c.state, left(c.head_sha, 7) as head,
    c.rationale_digest is not null as rationale_frozen
  from public.desires d left join public.change_requests c on c.desire_id = d.id where d.tenant_id = ${tenantId} order by d.number desc limit 1`);
console.log(`result → ${JSON.stringify(rows[0])}`);
await controlDb.end();
await runtimeDb.end();
