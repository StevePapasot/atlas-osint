# Deployment

ATLAS is one Node.js application plus a database. Choose the shape that fits:

| Shape | Database | Jobs | Good for |
| --- | --- | --- | --- |
| Single process | SQLite file on a persistent disk | In-process worker | One analyst or a small team on one server |
| Docker (single container) | SQLite in the `/data` volume | In-process worker | Same, containerised |
| Docker Compose | PostgreSQL 16 + Redis | Separate worker service | Teams; the stack in `docker-compose.yml` |
| Your platform | PostgreSQL / Supabase | Web instances + one or more `npm run worker` processes | Larger deployments |

ATLAS needs a long-running Node.js server (jobs, file uploads, native modules such as sharp and better-sqlite3), so
serverless-only platforms are not a good fit for the worker; the web part can run anywhere Next.js runs in Node mode
as long as a worker process runs alongside it.

Requirements: Node.js ≥ 22.19 (the Docker image uses `node:24-bookworm-slim`), ~1 GB RAM per process (OCR is the
heaviest task), persistent storage for `ATLAS_DATA_DIR` (uploads) and, with SQLite, the database file.

## 1. Single process (SQLite)

```bash
npm install
npm run build
NODE_ENV=production ATLAS_APP_URL=https://atlas.example.org npm start      # PORT defaults to 3000
```

Migrations run automatically on first start. Put a TLS-terminating reverse proxy in front (see below), and back up
`data/` (the SQLite database uses WAL mode — back up with `sqlite3 data/atlas.db ".backup backup.db"` or stop the
server first).

## 2. Docker

Released images are published to the GitHub Container Registry for `linux/amd64` and `linux/arm64`:
`ghcr.io/stevepapasot/atlas-osint:latest`, or a pinned version such as `:0.1.0` (recommended for production).

```bash
docker run -d --name atlas -p 3000:3000 -v atlas-data:/data \
  -e ATLAS_APP_URL=https://atlas.example.org \
  --env-file .env ghcr.io/stevepapasot/atlas-osint:0.1.0
```

To build the image from source instead: `docker build -t atlas-osint .`

The image runs as an unprivileged user, stores everything under `/data`, exposes port 3000 and has a health check on
`/api/health`. Build arguments:

- `NODE_IMAGE` — base image (default `node:24-bookworm-slim`; use a mirror such as
  `mirror.gcr.io/library/node:24-bookworm-slim` if Docker Hub rate-limits you).
- `BUILD_TOOLS=true` — install a compiler toolchain, needed only on platforms without prebuilt binaries for
  better-sqlite3 / sharp (prebuilt for linux x64 and arm64).
- Behind a TLS-inspecting proxy: `--secret id=extra_ca,src=/path/to/proxy-ca.pem` (and `--network host` plus
  `--build-arg HTTPS_PROXY=…` if the proxy listens on the host's loopback).

The image runs `npm ci --ignore-scripts` (as the repository's `.npmrc` does for local installs): npm 10 ignores
better-sqlite3's `"gypfile": false` and would try to compile it from source. The build smoke-tests better-sqlite3 and sharp before continuing.

## 3. Docker Compose (PostgreSQL + Redis + worker)

```bash
cp .env.example .env            # add provider keys if you have them; set POSTGRES_PASSWORD for anything non-local
docker compose up -d --build
docker compose exec web npm run db:seed     # optional: fictional demo account + sample investigation
```

Services: `web` (UI + API, `ATLAS_INPROCESS_WORKER=false`), `worker` (`scripts/worker.ts`), `db` (PostgreSQL 16 with
a health check), `redis` (shared rate-limit counters). `web` and `worker` share the `atlas-data` volume, because the
worker analyses files uploaded through the web service. Scale workers with
`docker compose up -d --scale worker=3` — jobs are claimed with `FOR UPDATE SKIP LOCKED`, so workers never run the same
job twice.

Variables read by the Compose file: `ATLAS_PORT` (host port, default 3000), `ATLAS_APP_URL`, `ATLAS_COOKIE_SECURE`
(defaults to `false` for plain-HTTP localhost — set `true` behind HTTPS), `POSTGRES_PASSWORD`, `NODE_IMAGE`,
`POSTGRES_IMAGE`, `REDIS_IMAGE`.

## 4. PostgreSQL / Supabase

Set `DATABASE_URL=postgres://user:password@host:5432/dbname`. ATLAS creates its tables in the `public` schema of that
database.

```bash
ATLAS_AUTO_MIGRATE=false npm run db:migrate     # recommended in CI/CD before rolling out
```

**Supabase:** use the *direct connection* or *session pooler* string of a server-side database role (Project
Settings → Database). The transaction pooler (port 6543) has not been tested with ATLAS. Never put the service-role key or database
credentials in a `NEXT_PUBLIC_*` variable; ATLAS reads `DATABASE_URL` only on the server and does not use Supabase's
client libraries or REST API. After migrating, close the auto-generated REST API to ATLAS tables:

```bash
psql "$DATABASE_URL" -f supabase/rls.sql
```

This enables Row Level Security with no permissive policies and revokes privileges from `anon` / `authenticated`.
Re-run it after future migrations. The script is idempotent and harmless on plain PostgreSQL.

Pool size per process: `ATLAS_PG_POOL_MAX` (default 10). With many web instances and workers, keep the total below the
server's connection limit.

## Workers and scaling

- `ATLAS_INPROCESS_WORKER=true` (default): each web process also runs jobs. Fine for one instance.
- For several web instances, set `ATLAS_INPROCESS_WORKER=false` on them and run `npm run worker` processes (any number).
  Workers lease jobs with a heartbeat; a job whose worker dies is re-queued after 60 seconds by another worker.
- Concurrency: `ATLAS_WORKER_JOB_CONCURRENCY` investigations per worker × `ATLAS_TASK_CONCURRENCY` provider tasks per
  investigation, further limited per provider.
- Set `REDIS_URL` when more than one web instance serves traffic, so rate limits are shared.
- Uploaded files must be on storage shared by web and worker processes (a shared volume or network filesystem).

## Reverse proxy and TLS

Terminate TLS at a reverse proxy and forward to port 3000:

```nginx
server {
  listen 443 ssl http2;
  server_name atlas.example.org;
  client_max_body_size 25m;                       # ≥ ATLAS_MAX_UPLOAD_MB
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;   # overwrite: clients cannot inject addresses
    proxy_set_header X-Forwarded-Proto https;
  }
}
```

Then set `ATLAS_APP_URL=https://atlas.example.org`, `ATLAS_TRUSTED_PROXY_HOPS=1`, `ATLAS_ENABLE_HSTS=true`. Session
cookies are `Secure` automatically in production.

## Production checklist

- [ ] HTTPS, `ATLAS_APP_URL`, `ATLAS_ENABLE_HSTS=true`, `ATLAS_TRUSTED_PROXY_HOPS` matching your proxy chain
- [ ] `ATLAS_IP_HASH_SALT` set to a random value
- [ ] Accounts created, then `ATLAS_ALLOW_REGISTRATION=false`; no demo seed (or a changed `ATLAS_DEMO_PASSWORD`)
- [ ] Persistent, backed-up storage for the database and `ATLAS_DATA_DIR`
- [ ] Provider keys in a secret manager; `npm run providers:check -- --live` from the production network
- [ ] `ATLAS_ALLOW_PRIVATE_EGRESS` unset; `ATLAS_ALLOW_TARGET_FETCH` only if your policy allows contacting targets
- [ ] Supabase: `supabase/rls.sql` applied
- [ ] Map tiles: `NEXT_PUBLIC_MAP_TILE_URL` pointing at a tile service you are allowed to use at your volume
- [ ] Retention policy configured (`ATLAS_DEFAULT_RETENTION_DAYS` and per-user settings)
- [ ] Log shipping from stdout (JSON lines; secrets are redacted before logging)

## Upgrades

1. Back up the database and `ATLAS_DATA_DIR`.
2. Deploy the new version; run `npm run db:migrate` (or let auto-migration run on start).
3. On Supabase, re-run `supabase/rls.sql`.
4. Restart workers after the web processes.

## Verification performed

In the build environment the following were exercised end to end: production build + `next start` with SQLite (full
Playwright suite); the Docker image built from this Dockerfile, run standalone with SQLite (full Playwright suite,
`db:seed` inside the container); the Compose stack with PostgreSQL 16, Redis and a separate worker container (full
Playwright suite; rate-limit keys observed in Redis; jobs executed by the worker); Vitest integration suites against
PostgreSQL 16; `supabase/rls.sql` against PostgreSQL 16 with simulated Supabase roles. A real Supabase project and a
real TLS reverse proxy were not available and were not tested.
