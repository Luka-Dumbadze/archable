// packages/governance/src/github.ts: everything the Archable App does on GitHub.
// One-hour installation tokens only (I5). The App never force-pushes outside archable/* branches.
import { App, RequestError } from 'octokit';

export interface TenantRepo { installationId: number; owner: string; repo: string }
export interface FileChange { path: string; content: string }

export function githubApp(env: { GITHUB_APP_ID: string; GITHUB_APP_PRIVATE_KEY: string; GITHUB_WEBHOOK_SECRET: string }) {
  return new App({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    webhooks: { secret: env.GITHUB_WEBHOOK_SECRET },
  });
}

const is = (e: unknown, ...status: number[]) => e instanceof RequestError && status.includes(e.status);

// Branch + one commit + PR, through the Git Data API: no clone, no working tree.
export async function openChangePR(app: App, t: TenantRepo, c: {
  branch: string; title: string; body: string; message: string; files: FileChange[]; expectBaseSha: string;
}) {
  if (!c.branch.startsWith('archable/')) throw new Error('the App only writes archable/* branches');
  const gh = await app.getInstallationOctokit(t.installationId);
  const { owner, repo } = t;
  const { data: r } = await gh.rest.repos.get({ owner, repo });
  const { data: ref } = await gh.rest.git.getRef({ owner, repo, ref: `heads/${r.default_branch}` });
  if (ref.object.sha !== c.expectBaseSha) {
    return { ok: false as const, reason: 'base_moved' as const, baseSha: ref.object.sha };   // replay ops on the new base (§4.7)
  }
  const { data: base } = await gh.rest.git.getCommit({ owner, repo, commit_sha: ref.object.sha });
  const { data: tree } = await gh.rest.git.createTree({
    owner, repo, base_tree: base.tree.sha,
    tree: c.files.map((f) => ({ path: f.path, mode: '100644' as const, type: 'blob' as const, content: f.content })),
  });
  const { data: commit } = await gh.rest.git.createCommit({ owner, repo, message: c.message, tree: tree.sha, parents: [ref.object.sha] });
  try {
    await gh.rest.git.createRef({ owner, repo, ref: `refs/heads/${c.branch}`, sha: commit.sha });
  } catch (e) {
    if (!is(e, 422)) throw e;                                 // the branch exists from an earlier attempt
    await gh.rest.git.updateRef({ owner, repo, ref: `heads/${c.branch}`, sha: commit.sha, force: true });
  }
  const open = await gh.rest.pulls.list({ owner, repo, head: `${owner}:${c.branch}`, state: 'open' });
  const pr = open.data[0] ?? (await gh.rest.pulls.create({
    owner, repo, head: c.branch, base: r.default_branch, title: c.title, body: c.body,
  })).data;
  return { ok: true as const, prNumber: pr.number, headSha: commit.sha, baseSha: ref.object.sha };
}

// archable/verify and archable/approval: check runs only this App can create (ruleset integration_id pin).
export async function postCheck(app: App, t: TenantRepo, c: {
  name: 'archable/verify' | 'archable/approval'; headSha: string;
  state: 'in_progress' | 'success' | 'failure'; title: string; summary: string; detailsUrl?: string;
}) {
  const gh = await app.getInstallationOctokit(t.installationId);
  const done = c.state !== 'in_progress';
  await gh.rest.checks.create({
    owner: t.owner, repo: t.repo, name: c.name, head_sha: c.headSha, details_url: c.detailsUrl,
    status: done ? 'completed' : 'in_progress',
    ...(done ? { conclusion: c.state as 'success' | 'failure', completed_at: new Date().toISOString() } : {}),
    output: { title: c.title, summary: c.summary },
  });
}

// Merge only the head that was approved. GitHub refuses if the head moved (409) or checks fail (405).
export async function mergeApproved(app: App, t: TenantRepo, c: { prNumber: number; headSha: string; title: string; trailers: string }) {
  const gh = await app.getInstallationOctokit(t.installationId);
  try {
    const { data } = await gh.rest.pulls.merge({
      owner: t.owner, repo: t.repo, pull_number: c.prNumber, sha: c.headSha,
      merge_method: 'squash', commit_title: c.title, commit_message: c.trailers,
    });
    return { merged: true as const, sha: data.sha };
  } catch (e) {
    if (is(e, 409)) return { merged: false as const, reason: 'head_moved' as const };
    if (is(e, 405)) return { merged: false as const, reason: 'not_mergeable' as const };
    throw e;
  }
}
