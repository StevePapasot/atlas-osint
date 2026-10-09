# Contributing

Thanks for helping improve ATLAS. Please read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first, and
[docs/SECURITY.md](docs/SECURITY.md) for the boundaries every change must respect.

## Ground rules

- **Lawful, passive collection only.** Do not add features for credential testing, account enumeration via login or
  reset flows, account takeover, exploitation, bypassing access controls or rate limits, scraping private content,
  connecting to hidden services, or acquiring leaked / stolen data. Active techniques against targets need an explicit
  opt-in flag, a clear warning, and SSRF-safe implementation (see `url.fetch`).
- **Honesty over coverage.** A provider that is not configured, blocked or failing must show up as skipped or failed —
  never fake or silently drop results. Simulated data must stay labelled. Do not claim a provider works until it has
  been exercised against the real service; record its status in [docs/PROVIDERS.md](docs/PROVIDERS.md).
- **Evidence first.** Every finding must trace to stored evidence; set claim types honestly; never invent dates
  (collection time is not an event date); AI output must cite findings.
- **No secrets in code, logs, fixtures or the browser.** Read keys through `server/config/env.ts`; expose presence
  only.

## Development setup

```bash
npm install          # .npmrc skips install scripts; no compiler needed
npm run setup        # migrate + seed the fictional demo account
npm run dev
```

Useful variables while developing: `ATLAS_DEMO_FAST=true` (no simulated latency), `ATLAS_LOG_LEVEL=debug`.

## Checks

Run before every push:

```bash
npm run lint
npm run typecheck
npm test                                   # unit + integration on SQLite
npm run build && npm run test:e2e          # Playwright against the production build
```

To run the integration suites against PostgreSQL, point `TEST_DATABASE_URL` at a server where the user may create
databases; each test file creates its own database:

```bash
TEST_DATABASE_URL=postgres://atlas@localhost:5432/postgres npm test
```

This also runs `tests/integration/supabase-rls.test.ts`, which is skipped on SQLite.

Playwright uses the Chromium it finds (set `PLAYWRIGHT_CHROMIUM_PATH` to use a specific binary) and starts
`scripts/e2e-server.mjs`, which serves the production build on port 3100 with a fresh database in `data/e2e`. To run
the suite against an already running deployment: `E2E_BASE_URL=http://host:port npm run test:e2e`.

## Conventions

- TypeScript strict; no `any` without a comment explaining why. Validate every external input with Zod.
- Server-only modules import `server-only`; anything imported by client components lives in `src/shared` or
  `src/lib` and must not touch secrets.
- Data access goes through `src/server/repositories/*`, always scoped to the signed-in user's investigations; return
  404 (not 403) for resources the user does not own.
- Outbound HTTP only through `ctx.http` / `createHttpClient` (SSRF guard, redirects, limits, proxies). Pass
  `untrustedUrl: true` for URLs that came from users or collected content.
- New tables or columns: add a migration in `src/server/db/migrations`, register it in `db/migrate.ts`, update
  `db/schema.ts`, and make it work on both SQLite and PostgreSQL (`tests/integration/migrations.test.ts`).
  Add new tables to `supabase/rls.sql`.
- UI: use the primitives in `src/components/ui`; keep views keyboard-accessible, labelled, and usable at phone width;
  every chart or graph needs a text alternative.
- Tests: unit tests for pure logic and providers (fixtures via `tests/helpers/provider-harness.ts`; fixtures are
  generated at test time and contain only fictional data), integration tests for repositories and routes,
  Playwright for user journeys.

## Commits and pull requests

- Small, focused commits with descriptive messages (what and why).
- Describe user-visible changes, migrations, new configuration and security implications in the pull request.
- Update `.env.example` and the relevant docs in the same change, and add a line under `[Unreleased]` in
  `CHANGELOG.md` for anything users will notice.

## Releasing

Releases are cut from `main` once CI is green:

1. Move the `[Unreleased]` entries in `CHANGELOG.md` under a new `## [X.Y.Z] — <date>` heading and update the
   comparison links at the bottom.
2. Set the same version in `package.json` (and the root `version` fields in `package-lock.json`).
3. Commit, then tag and push: `git tag vX.Y.Z && git push origin main vX.Y.Z`.

The **Release** workflow checks that the tag matches `package.json`, publishes `ghcr.io/<owner>/atlas-osint` as
`X.Y.Z`, `X.Y` and `latest` for linux/amd64 and linux/arm64, and creates a GitHub release from the changelog
section. Run the workflow manually (Actions → Release → Run workflow) for a dry run that builds both images without
publishing anything.
