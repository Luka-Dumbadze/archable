// scripts/provision-tenant-repo.ts: a tenant's Business Monorepo on GitHub (plan §7.1, v3 §4.2, §5.1), as the App:
//   create <org>/<slug> from fixtures/<slug> (one commit on main), apply the archable-governance ruleset with both
//   checks pinned to the App, and record installation_id and repo_full_name on the tenant. Every step checks first,
//   so a second run changes nothing.
//   GITHUB_APP_ID=… GITHUB_APP_PRIVATE_KEY=… pnpm tsx scripts/provision-tenant-repo.ts [--tenant marani] [--org archable-tenants]
import { createHash, createPrivateKey } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { App } from 'octokit';
import { controlDb, withTenant } from '../apps/api/src/db';

// --from: the fixture tree to provision from (default fixtures/<tenant>); scratch tenants reuse fixtures/marani.
const { values } = parseArgs({ options: { tenant: { type: 'string', default: 'marani' }, org: { type: 'string', default: 'archable-tenants' },
                                          from: { type: 'string' }, resync: { type: 'boolean', default: false } } });
const slug = values.tenant!, org = values.org!;
const appId = Number(process.env.GITHUB_APP_ID);
if (!appId || !process.env.GITHUB_APP_PRIVATE_KEY) throw new Error('set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY');
const privateKey = createPrivateKey(process.env.GITHUB_APP_PRIVATE_KEY).export({ type: 'pkcs8', format: 'pem' }).toString();
const app = new App({ appId, privateKey });

// v3 §4.2, verbatim except the App's id as integration_id.
const RULESET = {
  name: 'archable-governance',
  target: 'branch',
  enforcement: 'active',
  conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
  bypass_actors: [],
  rules: [
    { type: 'deletion' },
    { type: 'non_fast_forward' },
    { type: 'pull_request', parameters: {
        required_approving_review_count: 0, dismiss_stale_reviews_on_push: true, require_code_owner_review: false,
        require_last_push_approval: false, required_review_thread_resolution: false } },
    { type: 'required_status_checks', parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: [
          { context: 'archable/verify', integration_id: appId },
          { context: 'archable/approval', integration_id: appId } ] } },
  ],
} as const;

const step = (s: string) => console.log(`• ${s}`);

const { data: installation } = await app.octokit.request('GET /orgs/{org}/installation', { org });
step(`installation ${installation.id} on ${org}`);
const gh = await app.getInstallationOctokit(installation.id);       // one-hour installation token (I5)

// 1. The repository.
let repo = await gh.request('GET /repos/{owner}/{repo}', { owner: org, repo: slug }).then((r) => r.data).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
if (!repo) {
  repo = (await gh.request('POST /orgs/{org}/repos', { org, name: slug, visibility: 'public', auto_init: true, has_wiki: false,
    description: `${slug}: Archable Business Monorepo (spec, policies, personas, evals)` })).data;
  step(`created ${repo.full_name}`);
} else step(`${repo.full_name} exists`);

// 2. The tree: fixtures/<slug> as one commit on main, unless main already has exactly this tree.
const root = values.from ?? `fixtures/${slug}`;
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const files = walk(root).map((p) => ({ path: relative(root, p).split(sep).join('/'), content: readFileSync(p, 'utf8').replace(/\r\n/g, '\n') }));
const blobSha = (s: string) => { const b = Buffer.from(s, 'utf8'); return createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex'); };
const ref = await gh.request('GET /repos/{owner}/{repo}/git/ref/{ref}', { owner: org, repo: slug, ref: 'heads/main' }).then((r) => r.data);
const headTree = (await gh.request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', { owner: org, repo: slug, tree_sha: ref.object.sha, recursive: '1' })).data;
const have = new Map(headTree.tree.filter((e) => e.type === 'blob').map((e) => [e.path!, e.sha!]));
const same = have.size === files.length && files.every((f) => have.get(f.path) === blobSha(f.content));
const writeTree = async (parents: string[], message: string, force: boolean) => {
  const tree = (await gh.request('POST /repos/{owner}/{repo}/git/trees', { owner: org, repo: slug,
    tree: files.map((f) => ({ path: f.path, mode: '100644' as const, type: 'blob' as const, content: f.content })) })).data;
  const commit = (await gh.request('POST /repos/{owner}/{repo}/git/commits', { owner: org, repo: slug, tree: tree.sha, parents, message })).data;
  await gh.request('PATCH /repos/{owner}/{repo}/git/refs/{ref}', { owner: org, repo: slug, ref: 'heads/main', sha: commit.sha, force });
  return commit.sha;
};
const existingRulesets = (await gh.request('GET /repos/{owner}/{repo}/rulesets', { owner: org, repo: slug })).data;
const governed = existingRulesets.find((r) => r.name === 'archable-governance');
if (same) step(`main already holds ${root} (${files.length} files)`);
else if (!governed) {
  // A new repository: the tree is its first commit (before the ruleset forbids writing main directly).
  const sha = await writeTree([], `${slug}: initial tenant tree from ${root}\n\nProvisioned by archable-architect (plan §7.1).`, true);
  step(`main = ${sha.slice(0, 7)} (${files.length} files)`);
} else if (!values.resync) {
  throw new Error(`main differs from ${root} and the repository is governed: changes go through a PR. A reference tenant can be ` +
                  `re-synced with --resync, which disables the ruleset for one commit (record it in PROGRESS.md).`);
} else {
  // Reference-tenant resync: one commit on top of main (history kept, no force), the ruleset disabled only around it.
  const id = governed.id;
  await gh.request('PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}', { owner: org, repo: slug, ruleset_id: id, enforcement: 'disabled' } as never);
  step(`ruleset ${id} disabled for the resync`);
  try {
    const sha = await writeTree([ref.object.sha], `${slug}: resync with ${root}\n\nReference-tenant resync by archable-architect: the ruleset was ` +
                                `disabled for this commit only (PROGRESS.md).`, false);
    step(`main ${ref.object.sha.slice(0, 7)} → ${sha.slice(0, 7)} (${files.length} files)`);
  } finally {
    await gh.request('PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}', { owner: org, repo: slug, ruleset_id: id, enforcement: 'active' } as never);
    step(`ruleset ${id} active again`);
  }
}

// 3. The ruleset (after the tree: it forbids force-pushes to main).
const rulesets = (await gh.request('GET /repos/{owner}/{repo}/rulesets', { owner: org, repo: slug })).data;
const existing = rulesets.find((r) => r.name === RULESET.name);
const current = existing && (await gh.request('GET /repos/{owner}/{repo}/rulesets/{ruleset_id}', { owner: org, repo: slug, ruleset_id: existing.id })).data;
// GitHub returns its defaults too (allowed_merge_methods, …), so compare only what RULESET specifies.
const covers = (have: unknown, want: unknown): boolean =>
  Array.isArray(want) ? Array.isArray(have) && have.length === want.length && want.every((w, i) => covers(have[i], w))
  : want && typeof want === 'object' ? !!have && typeof have === 'object' && Object.entries(want).every(([k, v]) => covers((have as Record<string, unknown>)[k], v))
  : have === want;
if (current && covers(current, RULESET)) step(`ruleset ${RULESET.name} (${existing!.id}) already as specified`);
else {
  const saved = existing
    ? (await gh.request('PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}', { owner: org, repo: slug, ruleset_id: existing.id, ...RULESET } as never)).data
    : (await gh.request('POST /repos/{owner}/{repo}/rulesets', { owner: org, repo: slug, ...RULESET } as never)).data;
  step(`ruleset ${(saved as { name: string; id: number }).name} (${(saved as { id: number }).id}) ${existing ? 'updated' : 'created'}`);
}

// 4. The tenant row (the control plane derives the tenant id from the slug, as the seed does).
const h = createHash('sha256').update(`archable:tenant:${slug}`).digest('hex');
const tenantId = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
await withTenant(controlDb, tenantId, (tx) => tx`update public.tenants set installation_id = ${installation.id}, repo_full_name = ${repo!.full_name},
  updated_at = now() where id = ${tenantId} and (installation_id is distinct from ${installation.id} or repo_full_name is distinct from ${repo!.full_name})`);
step(`tenant ${slug}: installation_id ${installation.id}, repo_full_name ${repo.full_name}`);
await controlDb.end();
