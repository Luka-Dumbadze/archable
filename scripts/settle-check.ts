// scripts/settle-check.ts: P4.D2.7's live check on a scratch tenant (zz-settle), never on Marani.
//   1. pnpm tsx scripts/settle-check.ts --phase tenant        tenant row + the owner's membership (SEED_OWNER_TG_ID)
//   2. pnpm tsx scripts/provision-tenant-repo.ts --tenant zz-settle --from fixtures/marani
//   3. pnpm tsx scripts/settle-check.ts --phase run           a T1 change: PR, verify, card, approve, settle twice
//   4. pnpm tsx scripts/settle-check.ts --phase cleanup       deletes the tenant (its rows go with it); the repo stays
// Check: calling settle twice in a row merges once and flips once.
import { createHash, createPrivateKey } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { App } from 'octokit';
import YAML from 'yaml';
import { blastRadius, compile, digestOf, type CompileResult } from '@archable/compiler';
import { controlDb, withTenant } from '../apps/api/src/db';
import { createGovernanceDeps } from '../apps/api/src/governance-deps';
import { issueCards, newNonce, openChangePR, postCheck, renderOps, sha256, settle, type CardMessage, type Sent } from '../packages/governance/src/index';

const { values } = parseArgs({ options: { phase: { type: 'string' }, tenant: { type: 'string', default: 'zz-settle' }, org: { type: 'string', default: 'archable-tenants' } } });
const slug = values.tenant!;
if (!slug.startsWith('zz-')) throw new Error('settle-check runs on scratch tenants only (zz-…)');
const h = createHash('sha256').update(`archable:tenant:${slug}`).digest('hex');
const tenantId = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
const out = (s: string) => console.log(s);
const inT = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(controlDb, tenantId, fn);

if (values.phase === 'tenant') {
  const tg = Number(process.env.SEED_OWNER_TG_ID);
  if (!Number.isSafeInteger(tg)) throw new Error('set SEED_OWNER_TG_ID');
  await inT(async (tx) => {
    await tx`insert into public.tenants (id, slug, name, os_name, status) values (${tenantId}, ${slug}, 'Settle check', 'Settle Check OS', 'live') on conflict (id) do nothing`;
    await tx`insert into public.memberships (tenant_id, role, display_name, tg_user_id) values (${tenantId}, 'owner', 'Owner', ${tg}) on conflict do nothing`;
  });
  out(`tenant ${slug} ${tenantId} with its owner`);
} else if (values.phase === 'cleanup') {
  await inT((tx) => tx`delete from public.tenants where id = ${tenantId}`);
  out(`tenant ${slug} deleted; delete the repository ${values.org}/${slug} on GitHub`);
} else if (values.phase === 'run') {
  await run();
} else throw new Error('--phase tenant | run | cleanup');
await controlDb.end();

async function run() {
  const appId = Number(process.env.GITHUB_APP_ID);
  const token = process.env.ARCHABLE_BOT_TOKEN;
  if (!appId || !process.env.GITHUB_APP_PRIVATE_KEY || !token) throw new Error('set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY and ARCHABLE_BOT_TOKEN');
  const app = new App({ appId, privateKey: createPrivateKey(process.env.GITHUB_APP_PRIVATE_KEY).export({ type: 'pkcs8', format: 'pem' }).toString() });
  const [t] = await inT((tx) => tx<{ installation_id: string; repo_full_name: string }[]>`select installation_id, repo_full_name from public.tenants where id = ${tenantId}`);
  if (!t?.repo_full_name) throw new Error('run phase 2 (provision-tenant-repo) first');
  const [owner, repoName] = t.repo_full_name.split('/') as [string, string];
  const repo = { installationId: Number(t.installation_id), owner, repo: repoName };
  const gh = await app.getInstallationOctokit(repo.installationId);

  // The base: what main holds (fixtures/marani), registered and live for the scratch tenant.
  const ROOT = 'fixtures/marani';
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  const files = Object.fromEntries(walk(ROOT).map((p) => [relative(ROOT, p).split(sep).join('/'), readFileSync(p, 'utf8').replace(/\r\n/g, '\n')]));
  const lock = YAML.parse(files['archable.lock']!);
  const base = compile({ files }, lock);
  const register = (c: CompileResult, gitSha: string) => inT(async (tx) => {
    await tx`insert into public.specs (tenant_id, digest, git_sha, compiler_version, bundle, verified_at)
             values (${tenantId}, ${c.digest}, ${gitSha}, ${lock.compiler}, ${tx.json(c.bundle as never)}, now()) on conflict do nothing`;
    for (const e of c.projections.entitySchemas) await tx`insert into public.entity_schemas ${tx({ tenant_id: tenantId, spec_digest: c.digest, ...e } as never)} on conflict do nothing`;
    for (const a of c.projections.apps) await tx`insert into public.apps ${tx({ tenant_id: tenantId, spec_digest: c.digest, ...a } as never)} on conflict do nothing`;
  });
  const { data: ref } = await gh.rest.git.getRef({ owner, repo: repoName, ref: 'heads/main' });
  await register(base, ref.object.sha);
  const epoch0 = await inT(async (tx) => {
    const [x] = await tx<{ epoch: string; active_digest: string | null }[]>`select epoch, active_digest from public.tenants where id = ${tenantId}`;
    if (x!.active_digest !== base.digest) await tx`select public.flip_epoch(${tenantId}, ${x!.epoch}, ${base.digest})`;
    return Number((await tx<{ epoch: string }[]>`select epoch from public.tenants where id = ${tenantId}`)[0]!.epoch);
  });
  out(`base ${base.digest.slice(0, 15)} live at epoch ${epoch0}; main ${ref.object.sha.slice(0, 7)}`);

  // A T1 change: one persona line.
  const persona = 'personas/cellar_master.md';
  const changed = { ...files, [persona]: `${files[persona]!.trimEnd()}\n- Thank the customer by name when you know it.\n` };
  const head = compile({ files: changed }, lock);
  const radius = blastRadius(base.bundle.graph, head.bundle.graph, base.bundle.risk);
  out(`head ${head.digest.slice(0, 15)} · tier T${radius.tier} (${radius.why.map((w) => w.rule).join(', ')})`);
  const pr = await openChangePR(app, repo, { branch: 'archable/settle-check', title: 'Cellar Master thanks customers by name', body: 'P4.D2.7 settle check (scratch tenant).',
    message: 'persona: thank the customer by name', files: [{ path: persona, content: changed[persona]! }], expectBaseSha: ref.object.sha });
  if (!pr.ok) throw new Error(`base moved: ${pr.baseSha}`);
  await register(head, pr.headSha);
  const crId = await inT(async (tx) => (await tx<{ id: string }[]>`insert into public.change_requests
      (tenant_id, pr_number, title, author_kind, base_sha, head_sha, delta_digest, bundle_digest, tier, blast_radius, state)
    values (${tenantId}, ${pr.prNumber}, 'Cellar Master thanks customers by name', 'architect', ${pr.baseSha}, ${pr.headSha},
            ${digestOf(radius.changed.map((id) => [id, head.bundle.graph.nodes.find((n) => n.id === id)?.hash ?? null]))}, ${head.digest}, ${radius.tier},
            ${tx.json({ changed: radius.changed, reached: radius.reached, why: radius.why } as never)}, 'needs_owner')
    on conflict (tenant_id, pr_number) do update set head_sha = excluded.head_sha, bundle_digest = excluded.bundle_digest returning id`)[0]!.id);
  await postCheck(app, repo, { name: 'archable/verify', headSha: pr.headSha, state: 'success', title: 'Verified (settle check)', summary: 'compile ok; no evals selected for a scratch check' });
  out(`PR #${pr.prNumber} head ${pr.headSha.slice(0, 7)} · archable/verify success · change ${crId}`);

  // The owner's card, then the press the bot would make on Approve.
  const api = async <T>(method: string, body: unknown): Promise<T> => {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = (await r.json()) as { ok: boolean; result: T; description?: string };
    if (!j.ok) throw new Error(`${method}: ${j.description}`);
    return j.result;
  };
  const send = async (c: CardMessage): Promise<Sent> => {
    const m = await api<{ message_id: number; chat: { id: number }; text: string }>('sendMessage', { chat_id: c.chatId, text: c.text, reply_markup: { inline_keyboard: [
      [{ text: 'Preview', url: c.previewUrl }, { text: 'ℹ️ View rationale', callback_data: `rv:c:${c.rationaleRef}` }],
      [{ text: 'Approve…', callback_data: `a1:${c.approveNonce}` }, { text: 'Reject', callback_data: `r1:${c.rejectNonce}` }]] } });
    return { chatId: m.chat.id, messageId: m.message_id, text: m.text };
  };
  let nonce = '';
  const [card] = await issueCards({ control: controlDb, send, nonce: () => (nonce = newNonce()) },
    { tenantId, id: crId, prNumber: pr.prNumber, headSha: pr.headSha, deltaDigest: 'sha256:' + '0'.repeat(64), tier: radius.tier, rationaleDigest: 'sha256:' + '0'.repeat(64), desire: null },
    head.bundle, [{ op: 'edit_persona', agent: 'cellar_master', find: '…', replace: '…', summary: 'Cellar Master thanks customers by name.' }] as never, { slug });
  if (card?.outcome !== 'sent') throw new Error(`card: ${JSON.stringify(card)}`);
  out(`card sent to the owner (message ${card.messageId}); ${renderOps([{ op: 'edit_persona', agent: 'cellar_master', find: '', replace: '', summary: 'Cellar Master thanks customers by name.' }] as never, head.bundle)[0]}`);
  const deps = createGovernanceDeps({ control: controlDb, app, intake: { jev: null as never, lane: null as never } });
  const tap = await deps.consume({ nonceHash: sha256(nonce), tgUserId: Number(process.env.SEED_OWNER_TG_ID), chatId: card.chatId, messageId: card.messageId,
                                   decision: 'approve', evidence: { via: 'settle-check' } });
  out(`consume(approve) → ${tap.outcome}`);

  // settle twice.
  const commits = async () => (await gh.rest.repos.listCommits({ owner, repo: repoName, sha: 'main', per_page: 20 })).data.length;
  const before = { commits: await commits(), epoch: epoch0 };
  const log = (e: string, d: Record<string, unknown>) => out(`  ${e} ${JSON.stringify(d)}`);
  const first = await settle({ control: controlDb, app, log }, crId);
  const second = await settle({ control: controlDb, app, log }, crId);
  const [after] = await inT((tx) => tx<{ epoch: string; active_digest: string }[]>`select epoch, active_digest from public.tenants where id = ${tenantId}`);
  const afterCommits = await commits();
  out(`settle #1 → ${JSON.stringify(first)}`);
  out(`settle #2 → ${JSON.stringify(second)}`);
  out(`main: ${before.commits} → ${afterCommits} commits (merged ${afterCommits - before.commits}) · epoch ${before.epoch} → ${after!.epoch} (flipped ${Number(after!.epoch) - before.epoch}) · active ${after!.active_digest === head.digest ? 'head ✓' : after!.active_digest}`);
  await api('editMessageReplyMarkup', { chat_id: card.chatId, message_id: card.messageId, reply_markup: { inline_keyboard: [] } });
}
