# ARCHABLE — Progress

The live task list and checkpoint record. How to use it: `TEAM_PROTOCOL.md` §4. Every task cites the plan section it implements (**plan §n**) and states its check. A box becomes `[x]` only when that check passed, with a one-line note of what was observed appended to the line.

Ids are `P<phase>.D<dev>.<n>`. Each developer edits only their own lines.

**Status:** Phase 0 · next handshake **H1**

---

## Phase 0 — Setup

### DEV-2

- [x] **P0.D2.1** `[DEV-2: Backend]` **Rotate every key from commit `ad4b0d5`**: Supabase service-role key, Telegram bot token (`/revoke` in @BotFather), Gemini key, GitHub token. Then commit the `.gitignore` that ignores `.env*`. Check: old keys are refused (Supabase returns 401 with the old service key; `getMe` with the old token returns 401). — 2026-10-17: old Telegram `getMe` 401, old GitHub token 401, old Gemini key 400; old service key gets 410 "Project removed" from `tvykesojaxrzjoldcbmc` (refused, but not the expected 401); `.env*` ignored since `02ab565`.
- [x] **P0.D2.2** `[DEV-2: Backend]` Workspace scaffold: root `package.json` (`"type": "module"`, `packageManager: pnpm@…`, scripts `typecheck`, `test`, `build` running `pnpm -r --if-present`), `pnpm-workspace.yaml` (`apps/*`, `packages/*`), `tsconfig.base.json` (`CLAUDE.md` §5), empty packages with `typecheck` and `test` scripts, `pnpm-lock.yaml` (plan §3.1). Check: `pnpm install && pnpm typecheck && pnpm test` exits 0 locally, and the CI run on the push is green. — 2026-10-17: all three exit 0 locally over 9 packages (pnpm 12.14.0); CI run 39055137814 on draft PR #1 green, every step incl. Install/Typecheck/Test succeeded. The red X on the PR is the Vercel deploy ("Deployment was blocked"), not CI (see P0.D2.4).
- [x] **P0.D2.3** `[DEV-2: Backend]` Supabase projects `archable-dev` and `archable` in `eu-central-1` with `pg_jsonschema`, `pgmq` and `pg_cron` enabled (plan §4.1, steps 1 and 4). Check: `select extname from pg_extension` lists all three on both projects. — 2026-10-17: **one project only** (`archable`, ref `zgfaxpdnoxlxeuzphtqs`), see Q1; the query lists `pg_cron`, `pg_jsonschema`, `pgmq`; private `media` bucket created; Realtime public access off (reported by DEV-2 from the dashboard).
- [x] **P0.D2.4** `[DEV-2: Backend]` Vercel project for `apps/api` in `fra1`, AI Gateway enabled, env variables per plan §3.3 (using the rotated keys), `vercel env pull` working locally. Check: a deployed `GET /healthz` returns 200, and locally `VERCEL_OIDC_TOKEN` is present after `vercel env pull`. — 2026-10-17: preview `archable-iad6bb6tn` (commit `af88f31`) `GET /healthz` → 200 `{"ok":true}`, `X-Vercel-Id: fra1`; `VERCEL_OIDC_TOKEN` present in `apps/api/.env.local`. Deviations from plan §3.1: `vercel.json` lives in `apps/api` (the Vercel root directory); `api/index.ts` exports `handle(app)` per HTTP method, because Vercel's Node runtime ignores a Response from a default export; `build.mjs` bundles the app with esbuild. **Follow-up:** Vercel env names don't match §3.3 yet (see reply of 2026-10-17).

### DEV-1

- [x] **P0.D1.1** `[DEV-1: Frontend]` Create the Lovable project `archable-web` and connect it to GitHub (Lovable creates the repo `archable-web`), leaving Lovable on its `main` (decision Q2). Check: a trivial Lovable edit appears as a commit on `archable-web`'s `main`; `git ls-remote` on this repo shows no Lovable commits. — `archable-web` (private) exists with Lovable commits on `main` (latest `3fb7467` "Add project README", pushed 18:48); this repo's only Lovable commits are its two creation commits (≤ 16:10, before Q1).
- [x] **P0.D1.2** `[DEV-1: Frontend]` Create @ArchableBot (production) and @ArchableDevBot (local long polling) in @BotFather. Enable business connections ("Secretary Mode") on @ArchableBot. Check: `getMe` on both tokens returns the bot, and @ArchableBot's settings show business connections enabled. — `getMe`: @archable_prod_bot (id 8901689823) `ok: true, can_connect_to_business: true`; @archable_dev_bot (id 8343935929) `ok: true`. Tokens in `.env.local` as `ARCHABLE_BOT_TOKEN` / `ARCHABLE_DEV_BOT_TOKEN`; production is a new bot, not the old leaked `TELEGRAM_BOT_TOKEN`.
- [x] **P0.D1.3** `[DEV-1: Frontend]` **Layout check (TEAM_PROTOCOL §2):** confirm whether Lovable can sync the app into `apps/web/` or only at the repo root. Record the answer under Open questions. Check: the answer and the resulting ownership set are written down, and both developers have read them. — Q2 decided: separate repo `archable-web`; CLAUDE.md and TEAM_PROTOCOL.md updated to match.

---

## Phase 1 — Foundation and database (plan §4)

### DEV-2

- [ ] **P1.D2.1** `[DEV-2: Backend]` `supabase/migrations/20261017000000_archable_v3.sql`, byte-identical to v3 §8. Check: `diff` against the SQL block extracted from the blueprint is empty.
- [ ] **P1.D2.2** `[DEV-2: Backend]` `supabase/migrations/20261018000000_archable_v3_1_ingress_rationale.sql` from plan §4.2. Check: identical to the plan's block.
- [ ] **P1.D2.3** `[DEV-2: Backend]` `supabase link` + `supabase db push` to `archable-dev`; set the plane role passwords; store `DATABASE_URL_RUNTIME` and `DATABASE_URL_CONTROL` (plan §4.1, steps 2, 3 and 5). Check: `select rolname, rolbypassrls from pg_roles where rolname like 'archable_%'` gives two rows, both `false`.
- [ ] **P1.D2.4** `[DEV-2: Backend]` `supabase/tests/v3.sql` and `v3_1.sql` adapted to real Supabase objects (no stubs), run inside `begin … rollback`. Check: both print their PASSED line against `archable-dev`.
- [ ] **P1.D2.5** `[DEV-2: Backend]` `packages/contracts/src/index.ts`, verbatim from plan §4.3. Check: `pnpm --filter @archable/contracts typecheck`.
- [ ] **P1.D2.6** `[DEV-2: Backend]` `packages/schema`: spec zod (v3 §6 + plan §1.5) and ChangeSet (v3 §7.2). Check: `fixtures/marani/enterprise.spec.yaml` parses; a ChangeSet touching `governance.*` is rejected.
- [ ] **P1.D2.7** `[DEV-2: Backend]` `fixtures/marani/`: `enterprise.spec.yaml` (v3 §6 + plan §1.5), `policies/*.cedar` (v3 §6.1 + `privacy.cedar`), `personas/`, `evals/smoke`, `archable.lock`, `seed/wines.json`. Check: every Cedar file parses with cedar-wasm `checkParsePolicySet`.
- [ ] **P1.D2.8** `[DEV-2: Backend]` `packages/compiler`: `digest.ts`, `a2a.ts`, `policy-bounds.ts` verbatim from plan §4.3, plus parse → resolve → lower → graph with `CompileError(path, message)`. Check: `pnpm --filter @archable/compiler test`: same digest twice; `a2a.edges.length === 6` and they match plan §1.2; `bounds` contains `payment.cod_limit` with max 30000.
- [ ] **P1.D2.9** `[DEV-2: Backend]` `apps/api/src/db.ts`, verbatim from plan §4.4. Check: typecheck; `withTenant` against `archable-dev` returns only the context tenant's rows.
- [ ] **P1.D2.10** `[DEV-2: Backend]` `scripts/seed-marani.ts` (plan §4.4). Check: plan §4.5. The first run prints the digest; the second run prints the same digest and adds no rows; `epoch = 1`; wines present.

### DEV-1

- [x] **P1.D1.1** `[DEV-1: Frontend]` Lovable shell bootstrap: Vite + React + TS + Tailwind, brand from the Marani theme (`#7B1E3A`, Noto Sans Georgian), routes `/` (Owner Mode), `/dev` (Developer Mode), `/chat`, Supabase client with the publishable key only. Check: the Lovable preview loads all three routes on a 360 px viewport; no service key appears in any built file (`grep -r service_role dist/` is empty). — passed on `archable-web@7a1727e` (third pass; earlier failures in git history): `/`, `/dev`, `/chat` and `/chat?embed=1` render at 360 px in headless Chrome 154 with no horizontal overflow and no console errors; a chat message send round-trips; wine primary ≈ `#7B1E3A`, Noto Sans Georgian; `src/lib/supabase.ts` publishable key only (env injection verified), no Lovable Cloud; built client has 0 `service_role`/`sb_secret_` hits (output is `.output/`, not `dist/`); no Git words on owner screens, no mic/voice; 3/3 web tests.
- [x] **P1.D1.2** `[DEV-1: Frontend]` Copy `packages/contracts/src/index.ts` to `archable-web/src/contracts.ts` with the source-commit header (TEAM_PROTOCOL §2). Check: a component typed with `Manifest` compiles in Lovable's build, and the header's commit equals this repo's latest `contracts:` commit. — `archable-web@53d0d10`: `src/contracts.ts` = `packages/contracts/src/index.ts` with the header `archable@fe11a07` (this repo's latest `contracts:` commit); `tsc --noEmit` clean under archable-web's stricter flags (`exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`), and a test types a `Manifest` and a `ChatSessionResponse` (no component uses them yet).
- [x] **P1.D1.3** `[DEV-1: Frontend]` Owner sign-in screen that accepts the one-time `/web` link token (plan §1.4), using a stubbed exchange. Check: the stubbed exchange produces a Supabase session in the browser, and a reload keeps it. — passed on `archable-web@0aaeebf`: Lovable's `/signin` (`OwnerSignIn.tsx`) over `src/auth/web-link.ts` (unchanged); 46/46 web tests, tsc clean. Headless Chrome at 360 px, the app's real supabase-js against our project URL, Supabase Auth `/verify` stubbed to accept each token once: the link shows "You're signed in." with the session in localStorage and the token gone from the URL; a reload keeps it with no auth call; "Open Owner Mode" goes to `/`; the reused link says expired; a fresh browser asks for `/web`; Auth down says unavailable; no overflow, no page errors, no technical words. The `/web` link format still needs DEV-2's confirmation (Blocked on).

---

## Phase 2 — Turn runtime and Tool Gateway (plan §5)

### DEV-2

- [ ] **P2.D2.1** `[DEV-2: Backend]` `packages/runtime/src/types.ts`, verbatim from plan §5.3, plus the `deliver` signature for DEV-1. Check: typecheck; announce it to DEV-1 (a `contracts:`-style commit).
- [ ] **P2.D2.2** `[DEV-2: Backend]` `epochs.pin`, `bundles.load` (LRU by digest), `context.load` (plan §5.1). Check: a unit test confirms pin issues one query and a second load of the same digest is a cache hit.
- [ ] **P2.D2.3** `[DEV-2: Backend]` `decisions.ts`: `route()` (plan §5.2) and `preSend()` (v3 §7.1), with decision_log writes. **First verify the `experimental_decide` field names (plan §10.1, item 1).** Check: a test with a forced timeout shows route returns null and preSend returns FAILED.
- [ ] **P2.D2.4** `[DEV-2: Backend]` `packages/gateway`: `cedarDecide` (v3 §7.1), the amended `execute` (plan §5.5) with chapter facts, `CONNECTIONS_MODE`, and trigger caller attribution. Check: unit tests confirm a missing `context.customer` denies `order.create` with `policy_error`; `delivery.status` with the wrong phone is denied by `privacy.status_needs_phone`; `order.quote` writes `chapters.last_quote_total` in the same transaction as `tool_calls`.
- [ ] **P2.D2.5** `[DEV-2: Backend]` `handleTurn` amended (plan §5.4): idempotent inbound, pause check, `ReplyTarget`, holding reply, failure capture. Check: a unit test confirms a duplicate `externalMessageId` returns the first reply without a second model call, and a paused conversation returns `paused: true`.
- [ ] **P2.D2.6** `[DEV-2: Backend]` `apps/api/src/auth.ts` (plan §5.6) and `routes/turn.ts` (verbatim, plan §5.6); mount in `app.ts`. Check: plan §5.8. The seeded wine price comes back exact; the 50% discount request is denied by policy; a broken OIDC token produces a holding reply with `sent: false`.

### DEV-1

- [ ] **P2.D1.1** `[DEV-1: Frontend]` Owner Mode "Try as customer" console: a text box posting to `POST /v1/turns`, showing reply, `sent` and a link to the trace (plan §5.6). Check: against DEV-2's deployed API, a message returns a reply in the UI; with the API down the UI says "unavailable" instead of hanging. — **18 Oct, client done and verified locally, UI with Lovable.** `archable-web`: `src/owner/try-turn.ts` (`tryTurn` → reply/sent/trace or signed_out/rejected/unavailable, 30 s timeout) and `src/owner/use-try-turn.ts` (console state, one thread per session, reset); 10 tests, 56/56 web tests. Headless Chrome on `https://marani.archable.run`, signed in through the stubbed `/web` link, `api.archable.run` served in-process by the plan's `turnRoutes` (§5.6) with this repo's real `tenantCors`: a reply with `sent: true` and its trace path; a blocked draft returns the holding reply with `sent: false`; API down → unavailable in 5 ms; API hanging → unavailable at the timeout; signed out → no request. The server saw the session bearer, the Marani origin, conversation `try_m1_abc123`, ReplyTarget `console`. Open: Lovable's console in Owner Mode (prompt given); the live run needs DEV-2's `routes/turn.ts` and `auth.ts` deployed.
- [x] **P2.D1.2** `[DEV-1: Frontend]` `apps/api/src/http/origin.ts` and `http/cors.ts`, verbatim from plan §6.5, with their tests ported from plan §9.3 (origin and CORS groups). Check: `pnpm --filter @archable/api test` passes the origin and CORS cases, including `https://api.archable.run` being refused. — origin.ts and cors.ts identical to the tested plan code; 20 origin/CORS cases pass (`api.archable.run` refused by `routeOrigin` and by CORS, tenant and custom origins echoed, no credentials header, widget config `*`); workspace typecheck clean, 21/21 API tests. Added `Env` to contracts (`6fb1d07`).

---

## Phase 3 — Client ingress and channels (plan §6)

### DEV-1

- [x] **P3.D1.1** `[DEV-1: Frontend]` `channels/web/session.ts` and `routes/chat.ts`, verbatim (plan §6.5), with the chat tests from plan §9.3. Check: tests pass (open, resume, cross-tenant, idempotent retry, 401, 400, 429). — session.ts verbatim and chat.ts verbatim except its `HandleTurn` import, which points at `channels/runtime-stand-in.ts` until DEV-2 publishes the runtime types; 11 vitest cases pass with in-memory fakes: open (201, 43-char secret), resume by secret (200, no new secret), cross-tenant 404, bad body 400, idempotent retry (one turn), tampered/missing token 401, empty text/bad id 400, rate limit 429, takeover 202, `/events` 401/400/staff reply.
- [ ] **P3.D1.2** `[DEV-1: Frontend]` `routes/widget.ts`, verbatim (plan §6.5), and the `archable.run/widget.js` rewrite. Check: the loader runs in a plain HTML page on another origin and draws the branded launcher; `GET /v1/widget/config/acme` returns 404. — **18 Oct, code done, rewrite pending.** widget.ts verbatim; 5 vitest cases (loader parses, served as nosniff JS with the cache headers, config `*` CORS, `acme` 404). Headless Chrome on `https://shop.example` with the one-line embed (archable.run, api and tenant origins intercepted): wine launcher "მოგვწერეთ" (`lang=ka`), iframe `marani.archable.run/chat?embed=1&lang=ka`, a forged `archable:close` from the host page is ignored, the iframe's close works, `acme` and `Bad--slug` draw nothing. Open: the `archable.run/widget.js` → `api.archable.run/v1/widget.js` rewrite needs the `archable.run` domain on Vercel.
- [x] **P3.D1.3** `[DEV-1: Frontend]` `routes/webhooks.ts`, verbatim (plan §6.2), and `channels/telegram/tenant-bot.ts`. Check: the webhook tests pass (404 for unknown hooks, 401 for a bad secret, retry deduplicated). — webhooks.ts verbatim; tenant-bot.ts completed from the plan excerpt as `tenantBotDispatcher({ handleTurn, deliverNotice })`; 10 vitest cases pass: malformed/unknown hook 404, wrong/missing secret 401, non-update body 400, retry acknowledged 200 and dispatched once, dispatch failure still 200 and logged without the secret; private text → Inbound with a `telegram` ReplyTarget, voice/photo → text-only notice, `/start` → greeting, groups and callbacks ignored, webhook → dispatcher → handleTurn end to end.
- [x] **P3.D1.4** `[DEV-1: Frontend]` `channels/telegram/send.ts`: `deliver()` for bot, Business, suggest mode and web; 429 retry; a 403 pauses the channel (plan §6.2). Check: unit tests with a fake `Api` cover each `ReplyTarget` kind and the 429 path. — completed from the plan excerpt as `createSender(deps) → { deliver, deliverNotice }` (Vault read, messages record and channel pause injected); 12 vitest cases with a fake `Api` pass: `telegram` (token read per send, never recorded), Business reply with `business_connection_id`, suggest mode (owner gets "Suggested reply", customer nothing; blocked draft sends nothing), `web` and `console` record only; 429 waits `retry_after` once (capped at 5 s) then gives up; 403 pauses the bot or Business channel; other errors neither retry nor pause; notices use the tenant bot and aren't recorded.
- [ ] **P3.D1.5** `[DEV-1: Frontend]` `channels/telegram/archable-bot.ts`, verbatim (plan §6.3), Business and binding handlers wired to DEV-2's deps (fakes until P3.D2.1). Register the @ArchableBot webhook with explicit `allowed_updates` (plan §6.1). Check: plan §6.7 steps 1 and 2. A pasted token disappears and the bot connects; Business connect gives "Connected"; an owner reply pauses the agent; turning off reply rights switches to suggest mode. — **18 Oct, code done, live check pending.** archable-bot.ts verbatim (only the `Inbound` import points at the runtime stand-in); the plan had it as typecheck-only, now 21 vitest cases drive the real grammY pipeline with the Telegram API intercepted and DEV-2's deps faked: Business connect/updated/ignored, customer text → turn in reply or suggest mode, owner typing pauses the agent 30 min, voice → text-only reply only with rights, unbound and bot-sent messages ignored; `ch:biz` intent for owner only; pasted token deleted first, bound with a hook id and a secret whose hash matches `setWebhook`, never echoed, revoked if `setWebhook` fails; taps toast before `settle`, T3 typed code (right → "Approved. Deploying…", wrong → refused, no challenge → owner handler); rationale; owner text; voice reply. Open: plan §6.7 steps 1–2 need DEV-2's real deps (P3.D2.1) and the `/v1/webhooks/telegram/archable` mount (P3.D1.7); the @ArchableBot `setWebhook` isn't registered yet, because that URL doesn't serve the bot until then.
- [ ] **P3.D1.6** `[DEV-1: Frontend]` Lovable `/chat` page with `?embed=1` mode and the session contract of plan §6.6; `frame-ancestors` from `channels.web_chat.embed_origins`. Check: plan §6.7 step 3. Chat, reload, and the history is still there; a blocked-storage window still chats with a fresh session. — **18 Oct: local check passed on `archable-web@53c1dea`; two items open.** Lovable's `src/chat/use-chat.ts` drives `/chat` from `session.ts` (unmodified) on `*.archable.run` hosts and keeps demo mode elsewhere; 28/28 web tests, tsc clean. Headless Chrome 154 at 360 px, `https://marani.archable.run/chat` proxied to the dev server and `https://api.archable.run` served in-process by this repo's real `chatRoutes`, `widgetRoutes` and `tenantCors`: greeting from widget config, two messages answered; after a reload the same session shows all 4 messages; a staff message arrives through the long poll with its "Staff" tag; 429 shows the slow-down notice; no overflow, no page errors. Blocked storage + `?embed=1&lang=ka`: Georgian greeting, close button, chat works, a reload starts a fresh session (history empty, as designed); `acme.archable.run` (chat off) shows "Chat is unavailable". CORS: `/v1/chat/*` echoed `https://marani.archable.run`, widget config `*`. Open: `frame-ancestors` (Q3); the live run against the deployed API after P3.D1.7, with DEV-2's `outboundAfter` returning customer messages (Blocked on).
- [x] **P3.D1.7** `[DEV-1: Frontend]` Mount `chatRoutes`, `widgetRoutes`, `telegramWebhookRoutes`, the @ArchableBot `webhookCallback` and `tenantCors` in `app.ts` (plan §6.4). Check: the CORS curl checks in plan §6.7 step 3 give an echo for the tenant origin and nothing for `evil.example`. — `channels/mount.ts` mounts chat, widget, tenant-bot webhooks, @ArchableBot and `tenantCors` (/v1/chat/*, /v1/manifest, /v1/turns, /v1/dev/*); app.ts gains two lines. Plan §6.7 step 3 curls against the built bundle served locally: `evil.example` → no ACAO, `marani.archable.run` → echoed, random hook → 404; also healthz 200, widget.js 200, sessions 404 `chat_unavailable`, @ArchableBot 503 without env. 10 vitest cases on the real `app`; 90/90 API tests. Two fixes vs the plan excerpt: `customDomains.has` is wrapped (unbound it throws, so any custom origin would 500), and the @ArchableBot secret is checked before grammY, whose `webhookCallback` calls `getMe` first. Deps are fail-closed stand-ins in `channels/unwired.ts` (Blocked on); not yet run against the deployed API.

### DEV-2

- [ ] **P3.D2.1** `[DEV-2: Backend]` DB wrappers implementing `ChatDeps`, `WebhookDeps`, `WidgetDeps` and the channel functions of `ArchableBotDeps` (`bindTenantBot`, `bindBusinessConnection`, `resolveBusinessConnection`, `createLinkIntent`, `ownerTenants`, `pauseAgent`, `revokeChannel`) over the plan §4.2 SQL. Check: integration tests against `archable-dev` (rolled back) return the same outcomes as the D2–D4 groups of plan §9.3.
- [ ] **P3.D2.2** `[DEV-2: Backend]` `widgetConfig(slug)` from the active bundle's public projection of `channels.web_chat` + `ui.theme`; Business `getBusinessConnection` recovery path (plan §2.3, step 4). Check: `GET /v1/widget/config/marani` returns the Georgian and English labels and the brand colour.
- [ ] **P3.D2.3** `[DEV-2: Backend]` Simulate path for `customer.notify` and the `notify_on_job_status` trigger (plan §1.5). Check: setting a delivery job to `picked_up` in `archable-dev` produces a customer message on the conversation's channel (simulated where its rules forbid sending).

---

## Phase 4 — Architect and Triad governance (plan §7)

### DEV-2

- [ ] **P4.D2.1** `[DEV-2: Backend]` GitHub App `archable-architect` (permissions and events per plan §7.1); repo `archable-tenants/marani` from `fixtures/marani` with the v3 §4.2 ruleset; `installation_id` stored on the tenant. Check: `gh api repos/archable-tenants/marani/rulesets` shows `archable-governance` with both checks pinned to the App.
- [ ] **P4.D2.2** `[DEV-2: Backend]` `packages/governance/src/github.ts`, verbatim (plan §7.2), plus `routes/github.ts` with `verifyAndReceive`. Check: a test PR is opened on a scratch branch through `openChangePR`; a webhook with a wrong signature gets 401.
- [ ] **P4.D2.3** `[DEV-2: Backend]` `approval-check.ts`, verbatim (plan §7.4), with the 11 cases from plan §9.3. Check: tests pass.
- [ ] **P4.D2.4** `[DEV-2: Backend]` `rationale.ts`, verbatim (plan §7.5), and `freeze-rationale.ts`. Check: the D-14 fixture renders exactly the card in plan §1.3; the digest is stable across recomputation.
- [ ] **P4.D2.5** `[DEV-2: Backend]` `packages/spec-writer` (comment-preserving ops) and `packages/architect` (`intake.ts`, `cluster.ts`, `heal.ts`, per v3 §7.2 and plan §7.7). Check: `scripts/architect-dry.ts` (plan §7.8) prints D-n, 6 ops, tier T3, fail-to-pass ✓ and the rationale card, and pushes nothing.
- [ ] **P4.D2.6** `[DEV-2: Backend]` `cards.ts`: approval rows with nonce, `confirm_mode`, summary digest and rationale digest; card send with `changeCardKeyboard` (plan §7.3). Check: the approval row's `summary_digest` equals sha256 of the text Telegram received.
- [ ] **P4.D2.7** `[DEV-2: Backend]` `settle.ts` (plan §7.6) and the governance deps for DEV-1 (`consume`, `beginTyped`, `completeTyped`, `approvalSummary`, `settle`, `rationaleFor`, `ownerMessage`). Check: calling `settle` twice in a row merges once and flips once.
- [ ] **P4.D2.8** `[DEV-2: Backend]` `routes/cron.ts`: pgmq drain for the `architect` and `verify` queues, plus the Vercel cron. Check: an enqueued draft job is processed within one cron tick, or immediately via the `waitUntil` kick.

### DEV-1

- [ ] **P4.D1.1** `[DEV-1: Frontend]` Wire the approval handlers in `archable-bot.ts` (`a1:`/`r1:`, the 4-digit `hears`, `rv:`) to DEV-2's governance deps, replacing the fakes. Check: with a T3 card, a wrong code gets "That code is not right"; the right code gets "Approved. Deploying…"; a second code gets nothing (single use).
- [ ] **P4.D1.2** `[DEV-1: Frontend]` Owner text intake: the final `message:text` handler → `ownerMessage`, plus the **Draft it** / **Not this** buttons (plan §7.7). Check: "customers want to pay the courier in cash, up to 300 lari" yields the normalized statement with both buttons.
- [ ] **P4.D1.3** `[DEV-1: Frontend]` Card edits for superseded heads ("This change was updated", buttons removed) and the Live + Undo card. Check: a push to the PR branch edits the open card within one webhook round trip.

---

## Phase 5 — Web shell and Developer Mode (plan §8)

### DEV-2

- [ ] **P5.D2.1** `[DEV-2: Backend]` `routes/manifest.ts`, verbatim (plan §8.2), with `bySlug` and `byCustomDomain`; `GET /v1/bundles/:digest/ui` with immutable caching (v3 §2.4). Check: from `https://marani.archable.run` the manifest returns Marani's digest, and `pr-58--marani` returns the preview digest.
- [ ] **P5.D2.2** `[DEV-2: Backend]` `routes/devmode.ts`, verbatim (plan §8.3), with `activeBundle`, `elva.playgroundUrl` (from `ELVA_PLAYGROUND_URL`) and `lastDrift` (`unknown` until CI reports). Check: `GET /v1/dev/a2a` returns 6 edges; staff get 403; the edge detail for `delivery.status` shows its contract and the 24 h stats.
- [ ] **P5.D2.3** `[DEV-2: Backend]` `routes/owner.ts`: `POST /v1/owner/messages` → `OwnerReply`, `GET /v1/owner/changes/:id/rationale` (plan §8.4). Check: the web reply text and buttons equal the Telegram reply for the same message.

### DEV-1

- [ ] **P5.D1.1** `[DEV-1: Frontend]` Shell boot from `/v1/manifest` + the UI projection; Realtime subscription to `tenant:<id>` with `epoch_flip` handling (v3 §2.4). Check: an epoch flip in `archable-dev` swaps the UI at the next navigation with no reload.
- [ ] **P5.D1.2** `[DEV-1: Frontend]` A2A graph (`@xyflow/react` + `elkjs`), from the Lovable prompt in plan §8.3. Check: 3 app nodes, `courier_api` dashed, 6 labelled edges; `Esc` and `/` work.
- [ ] **P5.D1.3** `[DEV-1: Frontend]` Edge inspector with contract trees, stats, the last 20 calls, the Elva badge and the Playground button (plan §8.3). Check: a turn run in another tab pulses the `delivery.status` edge and increments its count.
- [ ] **P5.D1.4** `[DEV-1: Frontend]` `RationaleCard` component (owner and developer modes), from the Lovable prompt in plan §8.4. Check: the D-14 card in Owner Mode reads word for word like Telegram's **ℹ️ View rationale**; developer mode shows a source per sentence.
- [ ] **P5.D1.5** `[DEV-1: Frontend]` `OwnerChat` (text and buttons only) and change cards with **Approve in Telegram** deep links (plan §8.4). Check: plan §8.6 step 5.
- [ ] **P5.D1.6** `[DEV-1: Frontend]` Structured Desires Feed with impact chips, linked chats with **Unlink**, and a Rationale tab (plan §8.5). Check: unlinking a chat lowers the GEL figure on the card after a refresh.

---

## Handshakes

A handshake is a PR from both branches into `main`, titled `H<n>: …`, merged only when every criterion below has been observed by **both** developers and pasted into the PR.

### H1: Data foundation (after Phase 1) · DEV-2 → DEV-1

- [ ] `pnpm typecheck && pnpm test` green on `main` after merging both branches.
- [ ] `archable-dev` has both migrations; `supabase/tests/v3_1.sql` prints its PASSED line.
- [ ] `scripts/seed-marani.ts` run twice gives the same digest; `select epoch from tenants` = 1.
- [ ] DEV-1 signs in to the Lovable preview as the seeded owner and reads `tenants` and `records` through supabase-js under RLS, but not `specs.bundle` (permission denied).
- [ ] `@archable/contracts` resolves in the web app's build.

### H2: First customer turn (after Phases 2 and 3) · both

- [ ] A message to the tenant bot from a second Telegram account gets a grounded reply, with one `route.intent` and two `pre_send` rows in `decision_log` for that `turn_id`.
- [ ] The same question in `https://marani.archable.run/chat` gets the same grounded answer; a reload keeps the conversation.
- [ ] The widget on an outside HTML page opens the chat; the CORS check gives an echo for the tenant origin and nothing for `evil.example`.
- [ ] Business: a customer writing to the owner's account is answered; an owner reply pauses the agent in that chat.
- [ ] Breaking the AI Gateway token gives the customer a holding reply, never an unchecked draft.

### H3: Governed change goes live (after Phase 4) · DEV-2 → DEV-1

- [ ] An owner text request becomes D-n, then PR `archable/d-n` with `archable/verify` green and `archable/approval` in progress.
- [ ] The developer's GitHub approval on the head SHA delivers a card to the owner with Preview, ℹ️ View rationale, Approve… and Reject. The rationale reads like plan §1.3, with that request's own numbers.
- [ ] Approve… → wrong code rejected → right code → merge with `sha` → `epoch` +1 → the customer bot offers cash on delivery up to 300 GEL.
- [ ] A push to the PR branch before approving supersedes the card, and its code stops working.
- [ ] With no developer membership, a T3 change stays "in progress" and the card says a developer is needed.

### H4: Developer Mode (after Phase 5) · DEV-2 → DEV-1

- [ ] `marani.archable.run/dev` shows the 6-edge graph matching plan §1.2, without a reload after an epoch flip.
- [ ] A live turn pulses the right edge; the inspector shows the contract, 24 h stats and the last calls linking to the turn trace.
- [ ] The rationale card on the web matches Telegram's word for word.
- [ ] The Desires Feed shows D-n with impact chips, and unlinking a chat changes the figure.
- [ ] `pnpm typecheck && pnpm test` green on `main`; CI green on the merge commit.

---

## Open questions

<!-- Q<n> (DEV-x, time): question → decision (both initials) -->

- Q1 (DEV-2, 2026-10-17): Plan §4.1 asks for two Supabase projects, `archable-dev` and `archable`. For the hackathon MVP DEV-2 created only `archable` (`zgfaxpdnoxlxeuzphtqs`). Proposal: every task that names `archable-dev` (P1.D2.3–P1.D2.10, P3.D2.*, H1) runs against `archable`; SQL suites stay inside `begin … rollback`; the dev and production Telegram bots stay separate (plan §3.3). → **decision (17 Oct): accepted.** One Supabase project, `archable`. DEV-2 proposed; DEV-1: LD
- **Q2 (DEV-1, 17 Oct 22:10): where does the Lovable web app live?** Context: P0.D1.3.
  - **Findings.** Lovable's docs describe only repo-root projects and say nothing about subdirectories ([Git sync](https://docs.lovable.dev/integrations/git-sync-overview), [GitHub](https://docs.lovable.dev/integrations/github)). A third-party guide (unverified) says Lovable expects a single root `package.json` with no workspaces. Since P0.D2.2, this repo's root `package.json` is the pnpm workspace root.
  - **Proposal (DEV-1).** Create a new Lovable project, `archable-web`, which creates its own repo (Lovable always creates a new repo on connect). Its app lives at that repo's root, and Lovable stays on that repo's `main`. In this repo, `apps/web/` is not created. The web app gets the API types by copying `packages/contracts/src/index.ts` into `src/contracts.ts`, with the source commit noted at the top. DEV-1 re-copies after every `contracts:` commit. P0.D1.1 becomes "connect `archable-web` to GitHub; Lovable stays on its `main`".
  - **Decision (17 Oct 22:20):** accepted, Option C. `archable-web` is a separate Lovable repository; this repo has no `apps/web/`. DEV-1: LD; DEV-2 to initial: __

- **Q3 (DEV-1, 18 Oct): where does the chat page get `frame-ancestors`?** Plan §1.5 puts `channels.web_chat.embed_origins` in the spec, and §6.5's public `WidgetConfig` doesn't carry it, so the chat page (Lovable, TanStack Start SSR) has nothing to build the header from. Proposal: add `embed_origins: string[]` to `WidgetConfig` (already public: a CSP header is visible to anyone) and have the chat page's server response set `Content-Security-Policy: frame-ancestors 'self' https://*.archable.run <embed_origins>` from `/v1/widget/config/:slug`, cached 60 s. → decision: pending. DEV-1: LD; DEV-2 to initial: __

## Blocked on

<!-- <task id> (DEV-x): what is needed, from whom -->

- **P3.D1.6** (DEV-1): `outboundAfter(chat, after)` (DEV-2's SQL wrapper behind `/v1/chat/events`) must return every message in the conversation after `after`, the customer's own included (`ChatMessage.author` = `customer`). The chat page rebuilds its history after a reload from `/v1/chat/events?after=0`; with outbound messages only, the customer's side of the conversation disappears.
- **P3.D1.1, P3.D1.3, P3.D1.4** (DEV-1, not blocking): `packages/runtime/src/types.ts` (plan §5.3) from DEV-2. Until it lands, `apps/api/src/channels/runtime-stand-in.ts` holds a verbatim copy; when it does, DEV-1 deletes the stand-in and restores the `@archable/runtime` imports.
- **P3.D1.7** (DEV-1 → DEV-2, P3.D2.1): replace the exports of `apps/api/src/channels/unwired.ts` (`chatDeps`, `widgetDeps`, `webhookDeps`, `archableBotDeps`) with db-backed implementations, and fill `customDomains` (exported from `channels/mount.ts`) every 60 s. Until then every channel route fails closed. Env for the live run: `WEB_SESSION_KEY` (32 bytes, base64url), `ARCHABLE_BOT_TOKEN`, `ARCHABLE_BOT_WEBHOOK_SECRET`.
- **P1.D1.3** (DEV-1 → DEV-2, the `/web` command): the sign-in URL button should be `https://<slug>.archable.run/signin#token_hash=<properties.hashed_token>&type=magiclink`, from admin `generateLink({ type: 'magiclink', email })`. Not `properties.action_link`: Telegram's link preview fetches URLs and would spend the one-time token; a fragment is never sent to a server. Confirm or propose otherwise.

