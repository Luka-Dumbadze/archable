# ARCHABLE — Team protocol

Two developers, two Claude Code instances, one repository. The rules exist so that the two of you never edit the same file at the same time, and so that `main` always typechecks, passes tests and matches the plan.

| | DEV-1: Frontend | DEV-2: Backend |
|---|---|---|
| Builds | Lovable web shell, A2A graph UI, Telegram ingress, web chat and widget | Supabase schema and seed, compiler, turn runtime (Hono, Jev, Gemini, Cedar), Architect and governance (Octokit, approvals, epoch flip) |
| Branch | `feat/frontend-ui` | `feat/backend-core` |
| Tasks | `PROGRESS.md` items tagged `[DEV-1: Frontend]` | `PROGRESS.md` items tagged `[DEV-2: Backend]` |

## 1. The two documents decide

`ARCHABLE_MASTER_BLUEPRINT_v3.md` and `ARCHABLE_IMPLEMENTATION_PLAN.md` are the only architectural authorities (`CLAUDE.md` §1). If a task needs a decision neither covers, the developer who hits it writes the question in `PROGRESS.md` under **Open questions**, and both decide in under five minutes. Neither Claude Code instance decides architecture alone.

## 2. Directory ownership

A file has exactly one owner. Only the owner (or the owner's Claude Code) edits it. If you need a change in the other developer's file, ask for it; don't make it.

### DEV-1 owns

| Path | Contents (plan section) |
|---|---|
| `apps/web/**` | the Lovable shell: Owner Mode, Developer Mode, `/chat` (plan §6.6, §8). **Lovable is the only writer of React here (I6)**: Claude Code may write types, hooks and prompts for Lovable, but not components Lovable owns. |
| `apps/api/src/channels/**` | `telegram/archable-bot.ts`, `telegram/tenant-bot.ts`, `telegram/send.ts`, `web/session.ts` (plan §6.2–§6.5) |
| `apps/api/src/http/**` | `origin.ts`, `cors.ts` (plan §6.5) |
| `apps/api/src/routes/webhooks.ts`, `routes/chat.ts`, `routes/widget.ts` | tenant-bot webhooks, chat API, widget loader and config (plan §6.2, §6.5) |

Paths in the brief are mapped onto the plan's:
- *`apps/api/src/telegram/**`* is `apps/api/src/channels/telegram/**`.
- *`public/widget.js`* is served by `apps/api/src/routes/widget.ts` at `/v1/widget.js`, with the `archable.run/widget.js` rewrite (plan §6.5). Serving it from the API keeps one URL for every tenant and keeps it out of Lovable's files.

**If Lovable can't sync into `apps/web/`** (its documentation only describes repo-root projects), the web app is Lovable's root files, and DEV-1 owns exactly these: `src/**`, `public/**`, `index.html`, `vite.config.ts`, `tailwind.config.ts`, `postcss.config.js`, `components.json`, `tsconfig.app.json`, `tsconfig.node.json`, `eslint.config.js`, and Lovable's lockfile. DEV-1 confirms which layout applies as task P0.D1.3 in `PROGRESS.md`.

### DEV-2 owns

| Path | Contents (plan section) |
|---|---|
| `supabase/**` | migrations, SQL test suites, `config.toml` (plan §4.2, §4.4) |
| `packages/**` except `packages/contracts` | schema, compiler, runtime, gateway, architect, governance, spec-writer (plan §4.3, §5, §7) |
| `apps/api/src/db.ts`, `apps/api/src/auth.ts` | pools, `withTenant`, SQLSTATE mapping; JWT → membership (plan §4.4, §5.6) |
| `apps/api/src/routes/turn.ts`, `github.ts`, `cron.ts`, `manifest.ts`, `devmode.ts`, `owner.ts` | console turns, GitHub webhooks, queue drain, shell API (plan §5.6, §7, §8) |
| `fixtures/**`, `scripts/**` | the Marani tenant tree, seed, dry-run Architect, dev sessions |

### Shared: change only in a dedicated commit, announced to the other developer

| Path | Rule |
|---|---|
| `packages/contracts/**` | The API ↔ web contract. **Add fields, never rename or remove**, until a handshake. Each change goes in its own commit `contracts: …`, which the other developer pulls before building on it. |
| `apps/api/src/app.ts` | Route mounting. Append-only: each developer adds the lines that mount their own routes, nothing else. |
| `package.json` (root), `pnpm-workspace.yaml`, `tsconfig.base.json` | DEV-2 creates them in P0. Afterwards, add a dependency only in your own package's `package.json`. |
| `pnpm-lock.yaml` | Never hand-merge. On conflict: take `main`'s version, run `pnpm install`, commit the result. |
| `.github/**`, `CLAUDE.md`, `TEAM_PROTOCOL.md` | Change only with the other developer's agreement, in a PR to `main`. |
| `PROGRESS.md` | Each developer edits **only lines tagged with their own name**, plus their own notes. Tasks are grouped per developer within each phase, so concurrent edits don't touch adjacent lines. |

### The seams

The two halves meet only at typed interfaces. Code against the interface; the other side fills it in.

| Interface | Defined in | Implemented by | Consumed by |
|---|---|---|---|
| `Inbound`, `ReplyTarget`, `TurnResult`, `HandleTurn` | `packages/runtime/src/types.ts` (plan §5.3) | DEV-2 (`handleTurn`) | DEV-1: channel adapters and `routes/chat.ts` |
| `deliver(target, text, opts)` | `packages/runtime/src/types.ts` (signature) | DEV-1 (`channels/telegram/send.ts`, web) | DEV-2: `handleTurn` |
| `ChatDeps`, `WebhookDeps`, `WidgetDeps` | DEV-1's route files (plan §6.2, §6.5) | DEV-2: SQL wrappers in `apps/api/src/db.ts` | DEV-1 |
| `ArchableBotDeps` (consume, beginTyped, completeTyped, settle, approvalSummary, rationaleFor, ownerMessage, the bind functions) | `channels/telegram/archable-bot.ts` (plan §6.3) | DEV-2: `packages/governance`, `packages/architect`, db wrappers | DEV-1: bot handlers |
| `A2AGraph`, `EdgeDetail`, `RationaleCard`, `Manifest`, `ChatSessionResponse`, `OwnerReply` | `packages/contracts` (plan §4.3, §8.4) | DEV-2: API routes | DEV-1: web app |

Until the real implementation lands, the consumer uses an in-memory fake with the same type, as plan §9.3's tests do. No developer waits on the other to start a task.

## 3. Branches and merges

```
main  ◄── PR at H1 ── PR at H2 ── PR at H3 ── PR at H4
  ├── feat/frontend-ui   DEV-1 (Lovable is switched to this branch)
  └── feat/backend-core  DEV-2
```

- **`main` is protected.** Nobody pushes to it directly. It changes only through a PR from a feature branch with green CI, merged with a **merge commit** (no squash, no rebase). Lovable's docs warn against rewriting a synced branch's history, and merge commits let each branch absorb `main` without conflicts.
- **Enforcement.** GitHub refuses branch protection on this repository (private, free plan: `403 Upgrade to GitHub Pro`). Until the owner upgrades, protection is this rule plus CI. After upgrading, run once:

  ```bash
  gh api -X PUT repos/Luka-Dumbadze/archable/branches/main/protection --input - <<'EOF'
  {"required_status_checks":{"strict":true,"contexts":["typecheck-and-test"]},
   "enforce_admins":false,"required_pull_request_reviews":null,"restrictions":null}
  EOF
  ```

  Don't make the repository public as a workaround until every key that was ever committed has been rotated (P0.1).
- **Lovable:** in the Lovable editor, switch the project's branch to `feat/frontend-ui` before the first prompt. Otherwise Lovable writes to `main`, or falls back to `lovable-sync` when it can't.
- **Sync:** after every merge to `main`, both developers run `git pull origin main` on their own branch (a merge, not a rebase) before starting the next task.
- **Commits:** `<scope>: <imperative summary>`, scope ∈ `db`, `compiler`, `runtime`, `gateway`, `api`, `telegram`, `web`, `architect`, `governance`, `contracts`, `ci`, `chore`. Each commit should keep the branch typechecking.
- **Handshake PRs.** Title `H<n>: <name>`. The body pastes the handshake's verification output from `PROGRESS.md`. Either developer may merge once CI is green and the other has run the handshake check on their side.

## 4. The Claude Code task loop

The same three prompts for both developers, every task. Replace `<ID>` with a task id from `PROGRESS.md` (e.g. `P3.D1.4`).

**Step 1: Assign.**

```
Read CLAUDE.md, TEAM_PROTOCOL.md and PROGRESS.md. I am DEV-<1|2>. Implement task <ID> exactly as the plan
section it cites describes. Before writing code, list the files you'll create or change and confirm each is
owned by DEV-<1|2> under TEAM_PROTOCOL.md §2; if one isn't, stop and tell me. Copy ✓-marked code from the
plan verbatim. Use fakes for interfaces the other developer hasn't delivered. Run `pnpm typecheck` and
`pnpm test` before you finish.
```

**Step 2: Verify.**

```
Run the verification for task <ID> from PROGRESS.md (and the plan's two-minute check it cites). Show me the
exact commands and their output. If anything fails, fix it within my files and run the check again; if the fix
needs the other developer's files, stop and write what's needed under "Blocked on" in PROGRESS.md.
```

**Step 3: Record.**

```
The check for <ID> passed. In PROGRESS.md, change its box to [x] and append " — <one line: what was observed>"
to that line only. Commit the task's files and PROGRESS.md as "<scope>: <summary> (<ID>)" on my branch and
push it.
```

Rules for the loop:
- A box is `[x]` only when its check passed and the observation is recorded. Failing or skipped checks stay `[ ]`, with a note.
- One task per loop. Don't let Claude Code start the next task in the same prompt.
- When the last task before a handshake is done, run that handshake's check (`PROGRESS.md` §Handshakes) together, then open the `H<n>` PR.

## 5. When things go wrong

| Situation | Do this |
|---|---|
| CI red on your branch | Fix it before anything else; never merge red to `main`. |
| You need a contract field | Add it (additive only) in a `contracts:` commit, push it, tell the other developer. |
| The other developer's code blocks you | Use a fake with the same interface, note it under **Blocked on**, keep going. |
| A secret got committed | Rotate it first, then remove it. Deleting the file doesn't remove it from history. |
| Lovable pushed to `lovable-sync` | Merge `lovable-sync` into `feat/frontend-ui` with a merge commit (Lovable's docs: never squash or rebase it). |
| The plan looks wrong | Write it under **Open questions**, decide together, record the decision there. Don't silently diverge. |
