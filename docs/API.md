# HTTP API

The web UI is built entirely on this JSON API; it can also be scripted. All endpoints live under `/api`.

## Conventions

- **Authentication:** session cookie `atlas_session` obtained from `POST /api/auth/login` or `/api/auth/register`.
  Unauthenticated requests to protected endpoints return `401`.
- **CSRF:** `POST`, `PATCH`, `PUT` and `DELETE` must be same-origin. Browsers send `Origin` / `Sec-Fetch-Site`
  automatically; scripts must send `Origin: <your ATLAS URL>` (or omit `Origin` entirely). Cross-origin requests
  get `403 csrf_rejected`.
- **Bodies:** `Content-Type: application/json` (uploads use `multipart/form-data`). Other types get `415`.
- **Ownership:** every `/api/investigations/{id}/…` endpoint returns `404` for investigations you do not own —
  the same response as for ones that do not exist.
- **Errors:** `{"error": {"code": "…", "message": "…", "details": …, "requestId": "…"}}`. Common codes:
  `validation_error` (400, `details` = list of `{path, message}`), `invalid_json`, `invalid_targets` (400, `details`
  lists each bad target with its index), `unauthorized` (401), `csrf_rejected` (403), `not_found` (404), `conflict`
  (409), `payload_too_large` (413), `unsupported_media_type` (415), `rate_limited` (429, with `Retry-After`),
  `internal_error` (500).
- **Rate limits:** per IP for login (20/min), registration (10/h), uploads (60/h), exports (60/h), start (30/h),
  AI (20/h), provider health checks (60/h), password changes (10/h); 600 writes/min per user; per-account login
  limit 10 per 15 min.
- **Caching:** all API responses are `Cache-Control: no-store`.

Example:

```bash
B=http://localhost:3000
curl -c jar -H 'content-type: application/json' -d '{"email":"demo@atlas-osint.local","password":"atlas-demo-2026"}' $B/api/auth/login
curl -b jar -H 'content-type: application/json' -H "origin: $B" \
  -d '{"name":"Demo via API","mode":"demo","depth":"standard","targets":[{"type":"domain","value":"northwind-analytics.example"}],"start":true}' \
  $B/api/investigations
```

## Health and account

| Method & path | Description |
| --- | --- |
| `GET /api/health` | Public. `{status, database, dialect, worker: {mode, active}, time}`; `503` when the database is unreachable. Reveals no configuration |
| `POST /api/auth/register` | `{email, name, password}` → `201 {user}` and session cookie. `403 registration_closed`, `400 weak_password`, `409 email_taken` |
| `POST /api/auth/login` | `{email, password}` → `{user}` and session cookie; `401 invalid_credentials` |
| `POST /api/auth/logout` | Ends the session |
| `GET /api/auth/me` | Current user and preferences |
| `GET /api/settings` | Profile, preferences and server capabilities (OCR, target fetch, retention default, AI status) |
| `PATCH /api/settings` | `{name?, preferences?}` — theme, default depth/modules, redact exports, retention days, … |
| `POST /api/settings/password` | `{currentPassword, newPassword}`; revokes your other sessions |
| `GET /api/settings/sessions` | Your active sessions |
| `DELETE /api/settings/sessions` | `{sessionId}` or `{allOthers: true}` |
| `POST /api/settings/retention` | Purge your investigations older than your retention setting → `{deleted}` |
| `GET /api/audit` | Your latest 200 audit events |
| `GET /api/dashboard` | Counts, recent investigations, confidence distribution, findings by category, active jobs |

## Providers

| Method & path | Description |
| --- | --- |
| `GET /api/providers` | All providers: description, operations, required variables with `present` booleans, configuration status, your enablement, last health check; plus `secrets` (presence map) and `ai` status. Never values |
| `PATCH /api/providers/{providerId}` | `{enabled: boolean}` for your account |
| `POST /api/providers/{providerId}/health` | Run the provider's health check now → `{status, message, latencyMs}` |

## Investigations

| Method & path | Description |
| --- | --- |
| `GET /api/investigations?status=&q=&limit=&offset=` | Your investigations |
| `POST /api/investigations` | Create. Body: `name` (2–160), `description?`, `scopeStatement?`, `depth` (`quick`/`standard`/`deep`/`custom`), `mode` (`live`/`demo`), `modules[]` (required for custom), `providers[]` (allow-list, optional), `targets[]` (`{type, value, label?}`, ≤ 50), `defaultCountry?` (ISO-3166 alpha-2 for phone numbers), `start?` → `201 {investigation, jobId}` |
| `GET /api/investigations/{id}` | Detail: targets, counts, latest job |
| `PATCH /api/investigations/{id}` | `{name?, description?, scopeStatement?, depth?, mode?, modules?, providers?}` |
| `DELETE /api/investigations/{id}` | Deletes the investigation, its evidence and uploaded files |
| `POST /api/investigations/{id}/targets` | `{targets[], defaultCountry?}` |
| `DELETE /api/investigations/{id}/targets/{targetId}` | Remove a target |
| `POST /api/investigations/{id}/start` | Queue a collection run (idempotent while one is active) → `{jobId, alreadyRunning}` |
| `POST /api/investigations/{id}/cancel` | Cooperative cancellation; partial results are kept |
| `GET /api/investigations/{id}/progress` | `{status, latestJob, jobs[], tasks[]}` — every task with provider, operation, subject, query, status, attempts, duration, result count, error category/message, notes |

Target types: `person`, `organization`, `username`, `email`, `phone`, `domain`, `ip`, `url`, `crypto`, `keyword`,
`image`, `document`. Investigation / job statuses: `draft`, `queued`, `running`, `partially_completed`,
`completed`, `failed`, `cancelled`. Task statuses: `queued`, `running`, `succeeded`, `failed`, `skipped`,
`cancelled`.

## Findings and review

| Method & path | Description |
| --- | --- |
| `GET /api/investigations/{id}/findings` | Query: `q`, `entityType`, `provider`, `source`, `confidence`, `verification`, `category`, `claimType`, `location`, `dateFrom`, `dateTo`, `dateField` (`collected`/`published`), `bookmarked`, `tag`, `entityId`, `hasGeo`, `includeFalsePositives`, `sort` (`collected_at`, `published_at`, `confidence`, `title`, `source_count`, `category`), `order`, `page`, `pageSize` (≤ 200) → `{total, page, pageSize, items[]}` |
| `GET /api/investigations/{id}/findings/{findingId}` | Finding with entity, observations (provenance), evidence, reviews, notes, tags, timeline events, related findings, confidence rationale |
| `PATCH /api/investigations/{id}/findings/{findingId}` | `{bookmarked?, addTags?[], removeTags?[]}` |
| `POST /api/investigations/{id}/findings/{findingId}/review` | `{status: unreviewed|verified|disputed|false_positive, rationale}` — rationale (≥ 10 characters) required for every status except `unreviewed`; recorded in the audit trail |
| `GET /api/investigations/{id}/tags` | Tags with counts |
| `GET /api/investigations/{id}/notes` · `POST` · `DELETE …/notes/{noteId}` | Analyst notes: `{body, findingId?, entityId?}` |

## Entities, relationships, analysis

| Method & path | Description |
| --- | --- |
| `GET /api/investigations/{id}/entities?q=&type=&limit=` | Entities with finding counts |
| `GET /api/investigations/{id}/entities/{entityId}` | Entity with findings |
| `GET /api/investigations/{id}/relationships` | Relationships |
| `GET /api/investigations/{id}/relationships/{relId}` | Relationship with supporting evidence |
| `PATCH /api/investigations/{id}/relationships/{relId}` | `{status: confirmed|possible|rejected, rationale}` |
| `GET /api/investigations/{id}/graph?entityTypes=&relTypes=&includePossible=&limit=` | `{nodes, edges, truncated}` |
| `GET /api/investigations/{id}/candidates` | Entity-resolution candidates with signals |
| `POST /api/investigations/{id}/candidates/{candidateId}` | `{decision: accept|reject|separate, rationale}` |
| `GET /api/investigations/{id}/contradictions` | Conflicting attribute assertions between sources |
| `GET /api/investigations/{id}/timeline?kind=&entityId=` | Dated events with precision; undated items are never given dates |
| `GET /api/investigations/{id}/geo` | Geographic findings with basis and precision, plus the configured tile URL |
| `GET /api/investigations/{id}/evidence?q=&kind=&provider=&page=&pageSize=` | Evidence items (hash, kind, preview) |
| `GET /api/investigations/{id}/evidence/{evidenceId}` | Full stored evidence content |
| `GET /api/investigations/{id}/sources` | Sources with reliability and counts |
| `GET /api/investigations/{id}/activity` | Investigation audit events |

## Uploads

| Method & path | Description |
| --- | --- |
| `POST /api/investigations/{id}/artifacts` | `multipart/form-data` with `kind` (`image` or `document`) and `file`. Type is detected from content; `415` for unsupported or disguised files, `409` for duplicates, `413` above the size limit. Queues an analysis job → `201 {id, jobId, mime, sha256}` |
| `GET /api/investigations/{id}/artifacts?kind=` | Artifacts with status and analysis (EXIF, GPS, pHash, OCR text, document metadata and text preview) |
| `GET /api/investigations/{id}/artifacts/{artifactId}/thumbnail` | Re-encoded WebP thumbnail without metadata |

## Reports, exports, AI

| Method & path | Description |
| --- | --- |
| `POST /api/investigations/{id}/reports` | `{title?, redact?, includeRawEvidence?, includeAi?}` → frozen snapshot `201 {id, title, stats}` |
| `GET /api/investigations/{id}/reports` | Stored reports |
| `GET /api/investigations/{id}/reports/{reportId}` | Snapshot JSON; with `?format=pdf|markdown|json|csv` a file download rendered from the stored snapshot |
| `DELETE /api/investigations/{id}/reports/{reportId}` | Delete a report |
| `GET /api/investigations/{id}/export?format=pdf|markdown|json|csv&redact=true` | Ad-hoc export of the current state (not stored) |
| `GET /api/investigations/{id}/ai` | AI status and latest analysis |
| `POST /api/investigations/{id}/ai` | Run AI analysis (requires `ANTHROPIC_API_KEY`; `503 ai_not_configured` otherwise) → summary statements with finding citations, discarded-statement count, suggested lawful follow-ups |
