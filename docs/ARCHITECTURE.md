# Architecture

ATLAS is a single Next.js 16 application (App Router, React 19, TypeScript strict) that serves both the UI and a JSON
API, plus a job worker that can run inside the web process or as separate processes. Everything persists in one
relational database accessed through Kysely, with two interchangeable dialects.

```
 Browser (React, TanStack Query, PWA shell)
    │  same-origin fetch, HttpOnly session cookie
    ▼
 Next.js server ── proxy.ts (auth redirect, nonce CSP)
    │   app/(auth), app/(app)      server-rendered pages
    │   app/api/**                 route handlers → authed()/publicRoute() wrapper
    │                                (migrations, CSRF origin check, rate limit, session, error mapping)
    ▼
 repositories/  ── ownership-scoped data access (every query bound to the signed-in user's investigations)
    │
    ├── db/ (Kysely) ── SQLite (better-sqlite3, WAL)  or  PostgreSQL / Supabase (pg)
    │
    └── engine/ ── investigation_jobs + job_tasks (durable queue)
           │  JobRunner: claim → plan → run tasks → pivot → correlate → finish
           ▼
        providers/ (registry) ── SSRF-guarded HTTP client, DNS client, offline analysers
           │
           ▼
        persist.ts: observation → evidence (sha256) → finding (fingerprint) → entities/relationships → timeline/geo
```

## Runtime components

| Component | Location | Notes |
| --- | --- | --- |
| Pages | `src/app/(auth)`, `src/app/(app)` | Server components check the session (`requireSession`) and render client views |
| Proxy | `src/proxy.ts` | Redirects signed-out users to `/login`; sets a per-request nonce Content-Security-Policy |
| API | `src/app/api/**/route.ts` | Thin handlers; validation with Zod; all business logic in `src/server` |
| Route wrapper | `src/server/api/handler.ts` | `authed()` / `publicRoute()`: ensure migrations, start worker, CSRF origin check, per-IP + global rate limits, session resolution, uniform error envelope |
| Worker | `src/server/engine/runner.ts` | `JobRunner` polls the queue, runs `runJob`, recovers stale jobs, purges expired sessions and retention-expired investigations hourly |
| Worker bootstrap | `src/instrumentation.ts`, `engine/bootstrap.ts` | Starts the in-process runner at server boot unless `ATLAS_INPROCESS_WORKER=false` |
| Standalone worker | `scripts/worker.ts` (`npm run worker`) | Same runner, separate process; scale horizontally |

## Data model

All primary keys are UUIDs. Timestamps are ISO-8601 strings in SQLite and `timestamptz` in PostgreSQL (normalised to
ISO strings on read). JSON columns are `TEXT` in SQLite and `jsonb` in PostgreSQL. Check constraints enforce enums
(statuses, depths, claim types, relationship types); foreign keys cascade from investigations.

| Table | Purpose |
| --- | --- |
| `users`, `sessions` | Accounts (scrypt hash, role, preferences); sessions store only a SHA-256 of the token |
| `investigations` | Owner, name, scope statement, depth, mode (live/demo), modules, providers, status, retention |
| `targets` | Raw and normalised identifiers with type-specific metadata |
| `investigation_jobs` | One collection run or artifact analysis: status, stage, progress counters, lease (`locked_by`, heartbeat), cancel flag |
| `job_tasks` | One provider operation on one subject: status, attempts, timing, error category/message, notes, result count |
| `sources` | Distinct sources (provider + name + URL) with reliability |
| `observations` | What a provider returned for a task (normalised record + confidence inputs + limitations) |
| `evidence` | Immutable stored content (redacted, size-limited) with SHA-256 |
| `findings` | Deduplicated claims: fingerprint, category, claim type, confidence + rationale, verification status, provider/source counts, geo, dates |
| `finding_observations`, `finding_evidence` | Provenance links (every observation behind a finding is kept) |
| `finding_reviews` | Verification decisions with rationale (audit trail) |
| `entities` | Typed entities (`investigation_id, type, value` unique), target flag, simulated flag |
| `relationships`, `relationship_evidence` | Typed edges with status (confirmed / possible / rejected), confidence and supporting evidence |
| `entity_match_candidates` | Possible same-entity pairs with signals; analyst accepts / rejects / keeps separate — never auto-merged |
| `timeline_events` | Dated events with precision and kind (source-published, account-created, observed, …) |
| `artifacts` | Uploaded images / documents: stored path, MIME by content, SHA-256, pHash, analysis JSON |
| `analyst_notes`, `tags`, `finding_tags` | Notes (investigation or finding level), tags, bookmarks |
| `reports` | Frozen report snapshots (JSON) and options |
| `ai_analyses` | Optional AI analyses with accepted and rejected statements |
| `provider_configurations`, `provider_health` | Per-user provider enablement; last health-check result per provider |
| `audit_events` | Security-relevant actions with hashed client IP |

Migrations live in `src/server/db/migrations` and are registered statically in `src/server/db/migrate.ts`, so they run
identically under Next.js bundling, `tsx` scripts and tests. They are applied automatically on first use
(`ATLAS_AUTO_MIGRATE=false` to disable) or with `npm run db:migrate`. Up/down migrations are tested on SQLite and
PostgreSQL 16.

## Investigation pipeline

1. **Create.** Targets are validated and normalised (`src/shared/targets.ts`, shared with the browser): emails
   lower-cased, domains IDNA-normalised, IPs canonicalised (non-public addresses flagged), phone numbers parsed to
   E.164, profile URLs split into platform + username, crypto addresses checksum-verified.
2. **Start.** `startInvestigation` enqueues an `investigation_jobs` row (idempotent while a job is active).
3. **Claim.** A runner claims the oldest queued job atomically
   (`UPDATE … WHERE id = (SELECT … LIMIT 1 [FOR UPDATE SKIP LOCKED]) RETURNING *`), then heartbeats every 2 s. Jobs
   whose heartbeat is older than 60 s are re-queued by any runner (crash recovery).
4. **Plan.** `engine/planner.ts` expands targets into derived subjects (e.g. email → domain), selects operations by
   depth / module / provider allow-list / mode, and writes one `job_tasks` row per operation. Providers that are not
   configured, disabled by the user or by the administrator are written as `skipped` with the reason, so coverage gaps
   are visible. Demo mode only plans simulated (and offline) providers; live mode never plans simulated ones.
5. **Collect.** Tasks run with `ATLAS_TASK_CONCURRENCY`, per-provider concurrency gates and minimum intervals, a
   per-task timeout, and retries with exponential backoff for retryable errors (timeouts, 5xx, 429 with
   `Retry-After`). Errors are classified (`auth`, `rate_limited`, `timeout`, `network`, `upstream_error`,
   `parse_error`, `invalid_input`, `cancelled`) and stored on the task.
6. **Pivot (Deep).** One bounded hop of lightweight infrastructure operations on domains/IPs directly linked to a
   target. Pivot results are never pivoted again, so re-runs stay idempotent.
7. **Correlate.** Entity-resolution candidates, shared-infrastructure inferences and contradictions.
8. **Finish.** Final status: `completed`, `partially_completed` (some tasks failed but results exist), `failed`, or
   `cancelled`. Cancellation is cooperative: queued tasks are cancelled immediately and running provider calls receive
   an abort signal; results collected so far are kept.

Uploads create a separate artifact job that runs the offline image or document analyser and then correlation.

## Evidence and confidence model

Every provider returns `NormalizedRecord`s (`src/server/providers/types.ts`). `engine/persist.ts` turns each into:

- a **source** and an **observation** (provenance: provider, task, collected-at, source date if the source states
  one, confidence inputs, limitations);
- an **evidence** item: the raw response snapshot with secrets redacted, size-limited, SHA-256 hashed;
- a **finding**, deduplicated by fingerprint (category + subject + canonical URL/title, or a provider-specific key).
  A repeat observation from another provider increments `provider_count` (corroboration) instead of duplicating;
- **entities** and **relationships** (with supporting evidence), **timeline events** (only when a date is stated by
  the source or observed — collection time is never presented as an event date) and **geo** data with an explicit
  basis and precision.

Each finding carries a claim type — **FACT** (directly observed technical fact), **SOURCE CLAIM** (asserted by a
source), **INFERENCE** (derived by ATLAS or an analyst), **UNVERIFIED LEAD** (possible relevance only).

Confidence (`engine/confidence.ts`) is an ordinal, rule-based assessment — not a probability:

| Factor | Points |
| --- | --- |
| Best source reliability | authoritative +3 · reputable +2 · unknown +1 · low 0 |
| Identifier match | exact/normalised +1 · partial 0 · fuzzy −1 · none −2 |
| Corroboration | +1 per additional independent provider, max +2 |
| Claim type | FACT +1 · INFERENCE −1 |

Score ≥ 5 → **High**, 3–4 → **Moderate**, 1–2 → **Low**, ≤ 0 → **Unverified**. A single-provider unverified lead is
capped at Low. **Verified** is never computed: only an analyst can set it, with a rationale recorded in
`finding_reviews`; *disputed* caps at Low and *false positive* forces Unverified. The rationale lines are stored with
the finding and shown in the UI and reports.

## Reports

`reports/snapshot.ts` builds a self-contained snapshot from stored evidence only. Rendered reports have 16 sections:
executive summary; scope and methodology; target identifiers; key findings; public online presence; infrastructure;
geographic findings; image intelligence; document findings; entity relationships; timeline; contradictions;
confidence and verification; unverified leads; limitations; source references. The snapshot is stored in `reports`; every export format is rendered from it (`reports/render.ts`), so downloading a report
later reproduces it exactly even after the investigation changes. CSV cells that could start a spreadsheet formula are
neutralised; redaction masks email addresses and phone numbers.

## Optional AI analysis

`ai/analysis.ts` sends a bounded digest of findings (titles, claim types, confidence, short excerpts) with their evidence IDs to Claude (structured output via the
Anthropic SDK). Collected text is wrapped as untrusted data and the model is told to ignore instructions in it. Every
returned statement must cite finding references (`F-001`, …) from the report snapshot, each of which links to stored
evidence; statements without a valid citation are discarded server-side and counted. The feature is disabled unless `ANTHROPIC_API_KEY` is set.

## Front end

- Design system primitives in `src/components/ui` (buttons, fields, dialogs, sheets, tables, badges, toasts, tooltips)
  built on Radix where interaction semantics matter; Tailwind v4 tokens with light / dark / system themes.
- TanStack Query for server state; polling while a job is active.
- Workspace views: overview (progress, provider runs), findings table (filters, sort, pagination, bulk-friendly detail
  sheet), entities and match candidates, relationship graph (Cytoscape, with a text "connections list" alternative),
  timeline, GEOINT (Leaflet with an offline Natural Earth basemap fallback), documents, images, dark-web sources,
  evidence browser, reports, activity and notes.
- PWA: web manifest, icons and a service worker that caches only static assets (never API responses or investigation
  data); an offline page explains that collection needs connectivity.
