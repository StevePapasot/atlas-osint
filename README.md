# ATLAS OSINT

ATLAS is a self-hostable investigation workspace for **lawful, passive open-source intelligence**. An analyst defines
targets (people, organisations, usernames, emails, domains, IPs, URLs, phone numbers, crypto addresses, images and
documents), ATLAS plans and runs collection against public sources, and every result is stored as hashed evidence,
normalised into findings, entities and relationships, scored with an explainable confidence level, and reviewed by
the analyst before it goes into a reproducible report.

> **Use it responsibly.** ATLAS is designed for authorised research, due diligence, threat intelligence and
> journalism. It performs passive collection from public sources only. It contains no credential testing, account
> takeover, exploitation, private-account scraping, or purchasing of stolen data — and none should be added. You are
> responsible for complying with the law, the terms of the sources you configure, and your organisation's policies.

## What it does

| Area | Capabilities |
| --- | --- |
| Investigations | Targets with validation and normalisation, depth presets (Quick / Standard / Deep / Custom), module and provider selection, scope statement, drafts, re-runs that merge rather than duplicate |
| Collection engine | Durable database-backed job queue, per-provider concurrency, rate limits, timeouts, retries with backoff, cancellation, partial results, crash recovery, honest "not configured / unavailable / failed" reporting |
| Sources | 39 source and analysis adapters (plus 8 simulated demo providers): DNS, RDAP, certificate transparency, Wayback, Team Cymru ASN, reverse DNS, Shodan InternetDB, IPinfo, AbuseIPDB, VirusTotal, Shodan, GitHub, GitLab, npm, Reddit, Mastodon, Hacker News, Keybase, YouTube, Bluesky, DEV, Gravatar, HIBP, Brave / SerpApi / Parallel search, Blockstream, Etherscan, Ahmia, Intelligence X, a custom authorised index, Nominatim, opt-in target-page retrieval — see [docs/PROVIDERS.md](docs/PROVIDERS.md) |
| Offline analysis | Image EXIF / GPS / camera / dates, perceptual hashes and near-duplicate detection, OCR (tesseract.js, bundled English model), PDF / DOCX / TXT / HTML / CSV parsing with metadata and entity extraction, phone numbering-plan analysis, crypto address checksums, offline gazetteer |
| Analysis | Evidence → findings with fingerprint deduplication and multi-source corroboration, FACT / SOURCE CLAIM / INFERENCE / UNVERIFIED LEAD, rule-based explainable confidence (Verified / High / Moderate / Low / Unverified), entity-resolution candidates (never auto-merged), contradiction detection, relationship graph, timeline that never invents dates, GEOINT map |
| Review | Verification workflow with mandatory rationale and audit trail, false-positive marking, tags, bookmarks, notes, activity log |
| Reports | 16-section intelligence report frozen as a snapshot, exported to PDF, Markdown, JSON and CSV (formula-safe), optional redaction; ad-hoc exports |
| AI (optional) | Claude-assisted summary in which every statement must cite stored findings (and so their evidence); uncited statements are discarded; documents are treated as untrusted input |
| Platform | Next.js 16 app with API routes, SQLite (zero-config) or PostgreSQL / Supabase, optional Redis, installable PWA, responsive layouts (end-to-end tested at a 390 px phone viewport), light / dark themes, Docker image and Compose stack |

The **demo mode** runs simulated providers with clearly fictional data (reserved `.example` domains, documentation IP
ranges, invented handles). Every simulated record is labelled **SIMULATED** in the UI, exports and reports.

## Quick start (local, no API keys)

Requirements: **Node.js ≥ 22.12** and npm. Nothing else — the database is a local SQLite file.

```bash
npm install                 # use `npm install`, see note below
npm run setup               # create the database and the fictional demo account + sample investigation
npm run dev                 # http://localhost:3000
```

Sign in with the demo account:

| Email | Password |
| --- | --- |
| `demo@atlas-osint.local` | `atlas-demo-2026` |

…or register your own account (the first account becomes admin). Change the demo password with
`ATLAS_DEMO_PASSWORD` before seeding anywhere other than your own machine, or skip seeding entirely.

> `npm ci` with npm 10 ignores `better-sqlite3`'s bundled prebuilt binaries and compiles it from source, which needs
> Python and a C++ toolchain. `npm install` uses the prebuilt binaries. In CI use `npm ci --ignore-scripts && npm rebuild esbuild`
> (what the Dockerfile does).

### Production build

```bash
npm run build
npm start                   # serves on :3000, runs the job worker in-process
```

### Docker

```bash
docker build -t atlas-osint .
docker run -p 3000:3000 -v atlas-data:/data -e ATLAS_COOKIE_SECURE=false atlas-osint
docker exec <container> npm run db:seed        # optional demo account
```

PostgreSQL + Redis + a separate worker:

```bash
cp .env.example .env        # optional: add provider keys
docker compose up --build   # http://localhost:3000
```

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for PostgreSQL / Supabase, reverse proxies, scaling workers and
hardening.

## Configuration

All configuration is via environment variables; [.env.example](.env.example) documents every one. Nothing is
required for local use. Provider API keys unlock additional sources; **Settings → Search providers** and
`npm run providers:check -- --live` show which sources are configured and actually reachable from your network.
Key values are never sent to the browser.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build / server |
| `npm run worker` | Standalone job worker (use with `ATLAS_INPROCESS_WORKER=false`) |
| `npm run db:migrate` | Apply database migrations |
| `npm run db:seed` | Create the demo account and a sample (simulated) investigation |
| `npm run setup` | Migrate + seed |
| `npm run providers:check [-- --live] [-- --json]` | Provider configuration report; `--live` runs real connectivity checks |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript |
| `npm test` | Unit + integration tests (Vitest; SQLite, or PostgreSQL with `TEST_DATABASE_URL`) |
| `npm run test:e2e` | Playwright end-to-end suite against a production build (`npm run build` first) |

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — components, data model, job pipeline, evidence and confidence model
- [docs/PROVIDERS.md](docs/PROVIDERS.md) — every source, what it needs, what was verified, how to add one
- [docs/API.md](docs/API.md) — HTTP API reference
- [docs/SECURITY.md](docs/SECURITY.md) — threat model and controls
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — production deployment
- [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md) — build plan, decisions and verification log
- [CONTRIBUTING.md](CONTRIBUTING.md) — development workflow and conventions

## Project layout

```
src/
  app/                 Next.js routes: (auth) login/register, (app) dashboard/investigations/settings, api/*
  components/          UI: design-system primitives (ui/), workspace views, settings, layout
  server/
    api/               route wrapper (auth, CSRF, rate limit, errors), downloads
    auth/              password hashing, sessions
    db/                Kysely client (SQLite/PostgreSQL), schema types, migrations
    engine/            planner, job runner, persistence, confidence, correlation
    providers/         source adapters + registry, SSRF-guarded HTTP client, DNS client
    analysis/          image/EXIF/pHash, OCR, document parsing, entity extraction
    reports/           snapshot builder and PDF/Markdown/JSON/CSV renderers
    repositories/      data access with ownership checks
    security/          SSRF guard, rate limiting, redaction, hashing
  shared/              domain constants and target validation shared with the browser
scripts/               migrate, seed, worker, providers:check, e2e server
supabase/rls.sql       optional hardening for Supabase-hosted PostgreSQL
tests/                 unit, integration (API, engine, migrations, RLS) and e2e suites
```

## Known limitations

- Live coverage depends on the API keys you configure and on your network's egress policy. Sources that are not
  configured or not reachable are shown as skipped or failed — never silently omitted, never faked.
- No historical DNS / WHOIS (requires commercial passive-DNS data), no social-media scraping beyond documented public
  APIs, no face recognition, no Tor connectivity.
- IP geolocation and phone numbering data describe networks and allocations, not where a person is.
- Image similarity is computed only against images uploaded to the same investigation.
- Single-tenant accounts: investigations belong to one user; there is no team sharing yet.

## License

No license has been chosen yet; all rights reserved by the repository owner until one is added.
