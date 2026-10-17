# ARCHABLE — Claude Code instructions

Hacktoberfest Georgia 2026. Two developers, one repo, one Claude Code instance each. Read this file, then `PROGRESS.md`, before doing anything.

## 1. Authority

Exactly two documents define the system. Code that contradicts them is wrong, even if it works.

| Document | Role |
|---|---|
| `ARCHABLE_MASTER_BLUEPRINT_v3.md` (cited **v3 §n**) | Architecture: invariants, governance, spec, schema, runtime flows |
| `ARCHABLE_IMPLEMENTATION_PLAN.md` (cited **plan §n**) | v3.1 amendments, the five phases, file paths, tested code, two-minute checks |

- Where they disagree, the plan wins: it amends v3 (plan §1–§2).
- Never invent an alternative pattern. If a task needs something neither document covers, stop and ask the developer. Don't improvise architecture.
- Copy tested code from the plan verbatim. The modules marked ✓ in plan §9.3 typecheck and pass tests as written.

Team rules (ownership, branches, the task loop) are in `TEAM_PROTOCOL.md`. The task list is `PROGRESS.md`.

## 2. Invariants (never break)

| # | Invariant | In practice |
|---|---|---|
| I1 | Git for definitions, Postgres for facts | Spec, policies, personas, evals and UI code live in Git. Orders, customers, prices, messages and approvals live in Postgres. Nothing lives in both, so there's no `widget_settings` column: widget copy is spec. |
| I2 | Deterministic lowering | The compiler is pure: no network, clock, randomness or model. Same tree gives the same digest (RFC 8785 + SHA-256). Sort everything whose order isn't meaningful. |
| I3 | One authority per decision | Cedar (`@cedar-policy/cedar-wasm`) decides every tool call and every outbound message. Jev and Gemini produce evidence only. **Any Cedar evaluation error denies.** |
| I4 | Approvals bind to content | An approval names the head SHA, the delta digest and the digest of the exact text the approver saw. Merges pass `sha = head_sha`. |
| I5 | Zero ambient credentials | No long-lived secret in the browser or in code that doesn't need it. AI Gateway via Vercel OIDC; tenant bot tokens from Vault at the last hop; one-hour GitHub App tokens. Never commit `.env*`. |
| I6 | One writer per artifact type | Gemini writes spec ChangeSets; Lovable writes the web app's React; the compiler writes `contracts/` and generated models; humans may write anything. **Claude Code never edits Lovable-owned files** (see `TEAM_PROTOCOL.md` §2). |
| I7 | Routing fails open, safety fails closed | A slow router lets the dialogue model route itself. A slow, failed or abstaining pre-send check means the draft is not sent: holding reply plus staff handoff. |

## 3. Hard constraints

- **No voice, no audio, no speech-to-text** for owners or customers. Text messages and inline buttons only. Voice notes get a fixed "Please type your message" reply. Never add STT or audio packages (whisper, deepgram, `@google-cloud/speech`…).
- **No Docker**, locally or anywhere: no `Dockerfile`, no `docker-compose`, no `supabase start`. Managed primitives only: Supabase, Vercel, AI Gateway, GitHub. Local API = `tsx` + `@hono/node-server` against the `archable-dev` Supabase project; Telegram uses long polling locally with a separate dev bot.
- **No Temporal, Kafka, Kubernetes, Neo4j or any graph database.** Queues are `pgmq`, schedules `pg_cron`, graphs live inside the bundle.
- **T3/T4 approvals use the typed 4-digit confirmation** (plan §2.1), not the Mini App.
- Owner-facing text never contains Git vocabulary (branch, merge, PR, diff, commit). Money is integer tetri in code and GEL in copy.

## 4. Layout

```
apps/api/                Hono on Vercel Functions: webhooks, turn engine entry, chat, Architect, governance
  src/channels/          telegram/ (archable-bot, tenant-bot, send), web/ (session)        DEV-1
  src/http/              origin.ts, cors.ts                                                DEV-1
  src/routes/            webhooks, chat, widget (DEV-1) · turn, github, cron, manifest, devmode, owner (DEV-2)
  src/db.ts, auth.ts, app.ts
apps/web/                the Lovable shell (Owner Mode, Developer Mode, /chat)             DEV-1 via Lovable
packages/contracts/      API ↔ web types; the web app imports only this                    shared
packages/{schema,compiler,runtime,gateway,architect,governance,spec-writer}/              DEV-2
supabase/migrations/     20261017000000_archable_v3.sql, 20261018000000_archable_v3_1_ingress_rationale.sql
supabase/tests/          SQL behavior suites
fixtures/marani/         the reference tenant repo tree (seed and e2e target)
scripts/                 seed-marani.ts, architect-dry.ts, dev-session.ts
```

If Lovable can't sync into `apps/web/`, the web app lives at the repo root, where Lovable puts it. `TEAM_PROTOCOL.md` §2 lists the file set either way.

## 5. TypeScript

Every package extends `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler", "lib": ["ES2022", "DOM"],
    "strict": true, "noUncheckedIndexedAccess": true, "exactOptionalPropertyTypes": false,
    "noImplicitOverride": true, "noFallthroughCasesInSwitch": true, "forceConsistentCasingInFileNames": true,
    "isolatedModules": true, "verbatimModuleSyntax": false, "skipLibCheck": true, "resolveJsonModule": true,
    "types": ["node"]
  }
}
```

- ESM everywhere (`"type": "module"`). TypeScript 5.9.x.
- No `any` in exported signatures. `as never` is allowed only at postgres.js `tx.json()` boundaries.
- Validate every external input (HTTP bodies, webhook payloads, model output) with zod before use.
- Expected outcomes are data, not exceptions: SQL functions return an `outcome` column, and handlers branch on it.
- Pinned versions are in plan §3.2. Don't upgrade a pinned package without a reason written in the PR.

## 6. Commands

```bash
pnpm install                                   # workspace install
pnpm typecheck                                 # tsc --noEmit across all packages (CI gate)
pnpm test                                      # vitest across all packages (CI gate)
pnpm build
pnpm --filter @archable/api dev                # local API on :8787, Telegram long polling with the dev bot
pnpm --filter @archable/compiler test          # determinism, a2a, policy bounds
supabase link --project-ref <ref> && supabase db push        # managed project only
SEED_OWNER_TG_ID=<id> pnpm tsx scripts/seed-marani.ts         # idempotent seed (plan §4.4)
pnpm tsx scripts/architect-dry.ts --tenant marani --say "…"   # Architect loop without GitHub (plan §7.8)
```

## 7. How to work in this repo

1. Check you're on your own branch (`TEAM_PROTOCOL.md` §3) and pull the latest `main` into it after every handshake.
2. Take the next unchecked task tagged for your developer in `PROGRESS.md`. Implement it from the plan section it cites.
3. Run its two-minute check. Mark it `[x]` only when the check passes, adding a one-line note with what you observed.
4. Touch only files your developer owns (`TEAM_PROTOCOL.md` §2). A change to a shared file goes in its own small commit, explained in the PR.
5. Never commit secrets, never force-push a branch Lovable syncs, never rewrite `main` history.
