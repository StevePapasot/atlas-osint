# ATLAS OSINT — Build Plan

_Living document. Updated as milestones complete._

## Environment findings (2026-10-02)

| Item | Finding | Consequence |
| --- | --- | --- |
| Repository | Empty, branch `claude/atlas-osint-platform-119cbb` | Clean scaffold |
| Runtime | Node 22.22, npm 10.9, Python 3.11 | Next.js 16 + TypeScript |
| Databases | PostgreSQL 16 + Redis binaries installed, not running | SQLite default for local dev; PostgreSQL supported and integration-tested against a local cluster |
| Docker | CLI installed, daemon not running at start; `dockerd` could be started manually; Docker Hub rate-limited (429), `mirror.gcr.io` reachable | Image and Compose stack built and exercised end to end |
| Browser | Playwright Chromium 1194 at `/opt/pw-browsers` | `@playwright/test@1.56.1` pinned to match |
| Egress | HTTPS proxy with strict allow-list; most OSINT APIs blocked (RDAP, crt.sh, GitHub API, Reddit, Shodan, Brave…) | Adapters implemented against documented APIs and fixture-tested; live verification limited to reachable sources |
| Reachable live sources | System DNS resolver (A/AAAA/MX/NS/TXT/CAA/SOA/PTR), Team Cymru DNS ASN service, GitLab (API and web pages), npm registry | These providers are live-verified (`npm run providers:check -- --live`) |
| OCR | `tesseract.js` + `@tesseract.js-data/eng` works fully offline | OCR enabled by default |

## Architecture decisions

- **Single Next.js 16 app (App Router, TypeScript strict)** for UI + API route handlers. No separate Python service: all
  processing (EXIF, pHash, OCR, PDF/DOCX parsing) has mature JS libraries.
- **Kysely** query builder with two dialects: SQLite (`better-sqlite3`) for zero-config local mode and PostgreSQL (`pg`)
  for production/Supabase. One set of dialect-aware migrations, tested up/down on both.
- **DB-backed durable job queue** (`investigation_jobs` + `job_tasks`). An in-process worker starts via
  `instrumentation.ts`; a standalone worker (`npm run worker`) can run instead. Redis is optional (rate limiting store),
  not required — the database already provides durability, leasing and crash recovery.
- **Provider framework** with typed adapters, registry, timeouts, retries, concurrency + rate limits, error
  classification, health checks and honest "not configured / unavailable" reporting.
- **Evidence model**: observations → evidence (hashed) → findings (deduplicated by fingerprint) → entities and
  relationships → timeline / geo / reports. Claim types FACT / SOURCE_CLAIM / INFERENCE / UNVERIFIED_LEAD.
- **Own authentication** (scrypt hashes, hashed session tokens, HttpOnly cookies, origin-checked mutations).

## Milestones

1. Foundation — scaffold, design system, DB + migrations, auth, dashboard, investigation CRUD, demo provider.
2. Investigation engine — provider interfaces, query planning, job orchestration, progress, normalization, dedupe.
3. Intelligence modules — username, email, IP, domain, phone, crypto, documents, images, OCR, GEOINT, dark-web framework.
4. Analysis — entity resolution, confidence, evidence review, graph, timeline, notes, verification workflow.
5. Reporting & polish — PDF/MD/JSON/CSV, settings, PWA, responsive/mobile, accessibility.
6. Verification — migrations, unit/integration (SQLite + PostgreSQL), Playwright e2e, lint, typecheck, build.

## Progress log

- [x] **M1 Foundation** — Next.js 16 scaffold, design system (light/dark), Kysely + migrations (SQLite/PostgreSQL),
  scrypt auth with hashed sessions, dashboard, investigation CRUD, demo providers.
- [x] **M2 Engine** — provider framework and registry, query planner, durable job queue with leasing/heartbeat/crash
  recovery, retries, cancellation, partial completion, normalisation, fingerprint dedupe, corroboration.
- [x] **M3 Modules** — username, email, breach (HIBP), IP, domain/DNS/RDAP/CT/Wayback, phone, crypto, documents,
  images (EXIF/GPS, pHash, OCR), GEOINT (gazetteer, map), dark-web framework (Ahmia, IntelX, custom index), opt-in
  target page retrieval.
- [x] **M4 Analysis** — entity-resolution candidates (never auto-merged), explainable confidence, contradictions,
  verification workflow with rationale and audit trail, graph, timeline, notes, tags, bookmarks.
- [x] **M5 Reporting/polish** — 16-section reproducible reports (PDF/Markdown/JSON/CSV), redaction, settings, PWA,
  responsive layouts, optional AI analysis with citation enforcement.
- [x] **M6 Verification** — see log below.

## Verification log (final run, 2026-10-02)

| Check | Result |
| --- | --- |
| `npm run lint` | clean |
| `npm run typecheck` | clean |
| `npm test` (SQLite) | 17 files: 137 passed, 3 skipped (the Supabase RLS suite runs only on PostgreSQL) |
| `npm test` with `TEST_DATABASE_URL` (PostgreSQL 16) | 17 files: 140 passed |
| `npm run build` | succeeds, 0 warnings |
| `npm run test:e2e` (production build) | 16/16 passing |
| Playwright suite against the Docker image (SQLite, in-process worker) | 16/16 passing |
| Playwright suite against Docker Compose (PostgreSQL + Redis + worker container) | 16/16 passing |
| `npm run providers:check -- --live` | healthy: dns, dns.ptr, cymru, gitlab, npm; blocked by the environment's egress proxy: rdap, crtsh, wayback, reddit, mastodon, hackernews, keybase, bluesky, devto, gravatar, shodan.internetdb, ipinfo, blockstream; GitHub API refused by the proxy (403) |

## Decisions made during the build

- Pivots in Deep mode are restricted to entities one hop from a target so re-runs are idempotent and bounded.
- `X-Forwarded-For` is trusted only as far as `ATLAS_TRUSTED_PROXY_HOPS`; rate-limited buckets also have a global
  backstop.
- Redirects are followed manually so every hop is SSRF-validated and credentials never cross origins.
- `ATLAS_ALLOW_TARGET_FETCH` became a real, opt-in provider (`url.fetch`) instead of an unused flag; an unimplemented
  `SENTRY_DSN` setting was removed rather than shipped as a placebo.
- Installing from the lockfile makes npm 10 ignore better-sqlite3's `gypfile: false` and compile it from source
  (needs Python + C++). A project `.npmrc` sets `ignore-scripts=true`; all native modules use bundled prebuilt
  binaries. Verified with a fresh clone: install, setup, dev server and sign-in.
