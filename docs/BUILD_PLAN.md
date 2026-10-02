# ATLAS OSINT — Build Plan

_Living document. Updated as milestones complete._

## Environment findings (2026-10-02)

| Item | Finding | Consequence |
| --- | --- | --- |
| Repository | Empty, branch `claude/atlas-osint-platform-119cbb` | Clean scaffold |
| Runtime | Node 22.22, npm 10.9, Python 3.11 | Next.js 16 + TypeScript |
| Databases | PostgreSQL 16 + Redis binaries installed, not running | SQLite default for local dev; PostgreSQL supported and integration-tested against a local cluster |
| Docker | CLI only; daemon unavailable | Compose file provided but cannot be executed here |
| Browser | Playwright Chromium 1194 at `/opt/pw-browsers` | `@playwright/test@1.56.1` pinned to match |
| Egress | HTTPS proxy with strict allow-list; most OSINT APIs blocked (RDAP, crt.sh, GitHub API, Reddit, Shodan, Brave…) | Adapters implemented against documented APIs and fixture-tested; live verification limited to reachable sources |
| Reachable live sources | System DNS resolver (A/AAAA/MX/NS/TXT/CAA/SOA/PTR), Team Cymru DNS ASN service, GitLab public users API, npm registry, PyPI | These providers are live-verified |
| OCR | `tesseract.js` + `@tesseract.js-data/eng` works fully offline | OCR enabled by default |

## Architecture decisions

- **Single Next.js 16 app (App Router, TypeScript strict)** for UI + API route handlers. No separate Python service: all
  processing (EXIF, pHash, OCR, PDF/DOCX parsing) has mature JS libraries.
- **Kysely** query builder with two dialects: SQLite (`better-sqlite3`) for zero-config local mode and PostgreSQL (`pg`)
  for production/Supabase. One set of dialect-aware migrations.
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

- [ ] M1 Foundation
- [ ] M2 Engine
- [ ] M3 Modules
- [ ] M4 Analysis
- [ ] M5 Reporting/polish
- [ ] M6 Verification
