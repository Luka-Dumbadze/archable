# ARCHABLE (HACKTOBERFEST GEORGIA 2026) — CLAUDE CODE INSTRUCTIONS

## 🏛️ ARCHITECTURAL AUTHORITY
- Master Specification: `ARCHABLE_MASTER_BLUEPRINT_v3.md`
- Phased Implementation Plan: `ARCHABLE_IMPLEMENTATION_PLAN.md`
- Always adhere strictly to these two documents. Never invent alternative architectural patterns.

## 🛑 STRICT NEGATIVE CONSTRAINTS
- NO DOCKER: Rely exclusively on managed cloud primitives (Supabase, Vercel, AI Gateway).
- NO VOICE / NO STT: Owner and customer interfaces are strictly text and inline buttons.
- NO ENTERPRISE BLOAT: Do NOT introduce Temporal, Kafka, Kubernetes, or dedicated Graph Databases (Neo4j).
- NO PROPRIETARY LOCKS: Lovable generates inspectable React/TypeScript code synced to GitHub.

## ⚡ CORE INVARIANTS (MUST NEVER BREAK)
1. I1 (Definitions vs Facts): Git stores definitions (`enterprise.spec.yaml`, policies, evals, React code); Postgres (Supabase) stores facts (`records`, `conversations`, `messages`, `approvals`).
2. I2 (Deterministic Lowering): The compiler lowers spec → bundle deterministically (same input = same SHA-256 digest).
3. I3 (Single Decision Authority): Cedar Policy Engine (`@cedar-policy/cedar-wasm`) is the ONLY authority that permits/forbids actions. Jev and Gemini produce evidence only. Cedar fails closed on any error.
4. I4 (Content-Bound Approvals): An approval binds cryptographically to head SHA, delta digest, and the summary text digest.
5. I5 (Zero Ambient Credentials): Tokens are injected at egress; no long-lived secrets in client runtimes.
6. I6 (One Writer Per Artifact): Gemini writes spec ChangeSets; Lovable writes React; the compiler writes contracts; humans write code. Machines never author the same file type.
7. I7 (Failure Semantics): Routing fails open (LLM fallback); safety and pre-send fact-grounding fail closed.

## 🛠️ STACK & PACKAGES
- Runtime: Node.js (v22+), TypeScript (strict mode), Hono (`apps/api`)
- Database: Supabase (PostgreSQL 17 with RLS, `pg_jsonschema`, `pgmq`, `pg_cron`)
- AI & Decision Layer: Vercel AI Gateway (`typesafe-ai/jev` for System-1, `google/gemini-3.8-flash` for vision, dialogue, and patching)
- Policy & Guardrails: `@cedar-policy/cedar-wasm`
- Channels & Ingress: `grammY` (Telegram Bot & Business), embeddable iframe Web Widget
- GitOps: `@octokit/rest`
- Frontend: Lovable (`apps/web` with `@archable/shell` Vite/React/Tailwind)

## 📂 REPOSITORY LAYOUT
- `apps/api/`: Hono backend (turn engine, webhooks, Tool Gateway, Architect, governance)
- `apps/web/`: React frontend (Lovable shell, Owner Mode, Developer Mode A2A Graph)
- `packages/compiler/`: AST parsing, validation, lowering, in-memory blast radius DAG
- `packages/schema/`: Zod & JSON Schemas for specs and ChangeSets
- `supabase/migrations/`: PostgreSQL DDL migrations

## 💻 COMMON COMMANDS
- Install: `pnpm install`
- Typecheck: `pnpm typecheck`
- Test: `pnpm test`
- Build: `pnpm build`
- Run API locally: `pnpm --filter @archable/api dev`