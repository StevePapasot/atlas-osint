# Security

ATLAS handles sensitive investigative data and makes outbound requests on behalf of users, so it is built around two
concerns: **protecting the data and the server**, and **keeping collection lawful and passive**. This document
describes the controls, how they are tested, and what operators must still do.

Report vulnerabilities privately to the repository owner rather than in a public issue.

## Scope and acceptable use

ATLAS is for authorised, lawful research using public sources. By design it does **not** and must not:

- test, guess, stuff or crack credentials, enumerate accounts through login or password-reset flows, or take over
  accounts;
- exploit vulnerabilities, bypass authentication, rate limits or access controls, or scrape private / authenticated
  content;
- connect to Tor or hidden services, download leaked datasets, or buy, sell or trade data;
- actively scan targets (no port scans, vulnerability probes or crawling). Service data comes only from third-party
  datasets that already collected it. Fetching a target URL (`url.fetch`) is off unless an administrator enables
  `ATLAS_ALLOW_TARGET_FETCH`, and then it is a single GET of that page.

Have I Been Pwned is used only through its documented, authenticated `breachedaccount` API at the operator's
subscription tier. No password data is queried or stored.

Each investigation has a **scope statement** field for the authorisation and purpose; it is printed in reports.

## Authentication and sessions

| Control | Implementation |
| --- | --- |
| Password hashing | scrypt (N = 2¹⁵, r = 8, p = 1, 64-byte key, random 16-byte salt), constant-time comparison (`server/auth/password.ts`) |
| Password policy | ≥ 10 characters (passphrases encouraged), ≤ 200, not a single repeated character |
| Sessions | 32 random bytes; only the SHA-256 hash is stored. Cookie `atlas_session`: HttpOnly, SameSite=Lax, Secure in production, 7-day default lifetime (`ATLAS_SESSION_TTL_HOURS`) |
| Login | Uniform error for unknown user / wrong password, timing equalised with a dummy hash; per-IP and per-account rate limits; failures audited |
| Session management | Settings → Security lists active sessions and revokes them; password change revokes all other sessions; expired sessions purged hourly |
| Registration | First account becomes admin; disable with `ATLAS_ALLOW_REGISTRATION=false` |

## Authorisation and tenant isolation

Every repository function that reads or changes investigation data takes the signed-in user's id and scopes the
query to investigations they own (`getOwnedInvestigation`). Child resources (findings, evidence, reports, artifacts,
notes, relationships…) are always looked up by both their id **and** the owning investigation id. A resource that
exists but belongs to someone else returns **404**, indistinguishable from one that does not exist, so ids cannot be
probed. Integration and end-to-end tests try every read and write endpoint as a second user.

For Supabase deployments, `supabase/rls.sql` enables Row Level Security on every table with no permissive policies
and revokes table privileges from the `anon` and `authenticated` roles, so the project's auto-generated REST API
cannot expose ATLAS data even if the publishable key leaks. ATLAS itself connects only from the server with
`DATABASE_URL`. Never give the browser a service-role key — ATLAS has no code path that would.

## Request handling

| Threat | Control |
| --- | --- |
| CSRF | Session cookie is SameSite=Lax; every POST/PUT/PATCH/DELETE must be same-origin (`Sec-Fetch-Site` / `Origin` checked against the host and `ATLAS_APP_URL`); bodies must be `application/json` (multipart only for uploads) |
| Input validation | Zod schemas on every body and query; target values normalised and validated server-side (the browser check is only a convenience); body size limits; uniform `400 validation_error` responses |
| SQL injection | Kysely parameterised queries throughout; no string-built SQL with user input (the only `sql.raw` is migration enum lists built from constants) |
| XSS | React escaping; no `dangerouslySetInnerHTML`; collected URLs rendered through a safe-link component that only allows http(s) and adds `rel="noopener noreferrer nofollow"`; strict nonce-based CSP (`script-src 'self' 'nonce-…' 'strict-dynamic'`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`) |
| Clickjacking / sniffing | `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, restrictive `Permissions-Policy`, `Cross-Origin-Opener-Policy: same-origin`; HSTS with `ATLAS_ENABLE_HSTS=true` |
| Command injection | No shell or child-process execution anywhere in the server |
| Rate limiting | Fixed-window limits per IP for login, registration, uploads, exports, health checks, plus a global backstop per bucket and per-user write limits; Redis-backed when `REDIS_URL` is set. Client IP is taken from `X-Forwarded-For` only as far as `ATLAS_TRUSTED_PROXY_HOPS` allows, so forged headers cannot select an arbitrary bucket |
| Errors | Internal errors return a generic message with a request id; details are logged server-side only |
| Caching | API responses and downloads are `Cache-Control: no-store`; the service worker caches static assets only, never API responses |

## Outbound requests (SSRF)

All provider traffic goes through `providers/http.ts`:

- only `http`/`https`, standard ports, no embedded credentials, no literal private / loopback / link-local /
  reserved addresses or internal hostnames;
- the hostname must resolve to public addresses; in direct mode the socket's `lookup` is guarded too, which closes
  DNS-rebinding gaps; behind an egress proxy, user- or document-supplied URLs are still resolved and checked locally
  (fail closed);
- redirects are followed manually (max 5) and **each hop is re-validated**; provider headers such as API keys are
  dropped when a redirect leaves the original origin; untrusted URLs are GET-only;
- timeouts, response-size caps and cancellation on every request.

Users cannot make the server fetch arbitrary URLs: provider endpoints are fixed in code, and the only user-URL fetch
(`url.fetch`) is disabled by default and guarded as above. `ATLAS_ALLOW_PRIVATE_EGRESS` exists for local development
and tests only and must never be enabled in production.

## Uploads and untrusted content

- Type is determined from **file content** (magic bytes), not name or browser-supplied MIME. Images: JPEG, PNG, WebP,
  GIF, TIFF, AVIF. Documents: PDF, DOCX, TXT, HTML, CSV. Executables and unknown types are rejected.
- Size limit (`ATLAS_MAX_UPLOAD_MB`, default 20 MB), duplicate detection by SHA-256, random server-side file names,
  storage outside the web root; thumbnails are re-encoded with sharp before being served.
- DOCX archives are checked for zip bombs (total uncompressed size and compression ratio) before extraction; image
  decoding has a pixel limit; PDF parsing is bounded.
- Files are never executed. HTML is parsed with scripts and active content removed. **Text inside documents, web pages
  and OCR output is data, never instructions** — this holds for the optional AI analysis too (content is delimited as
  untrusted and the model is told to ignore embedded instructions; uncited statements are discarded).

## Secrets

- Secrets come only from environment variables; `.env*` files are git-ignored (except `.env.example`, which holds no
  values).
- The UI and API expose only key **presence** (booleans). Provider descriptors list variable names, never values.
- Logs and stored evidence pass through redaction that masks API keys, tokens, passwords, cookies and authorization
  headers (`security/redact.ts`). Passwords, session tokens and API secrets are never logged.
- Audit events store a salted hash of the client IP, not the IP (`ATLAS_IP_HASH_SALT` — set it in production).

## Data protection

- Investigations, evidence and uploads are deleted together (database cascade + file removal).
- Per-user data retention (Settings → Data retention, default from `ATLAS_DEFAULT_RETENTION_DAYS`) purges
  investigations not updated within the window; the worker runs it hourly. Users can also purge on demand.
- Reports can redact email addresses and phone numbers; CSV exports neutralise spreadsheet formulas.
- Simulated demo data is flagged at every layer so it cannot be mistaken for collected intelligence.

## Audit trail

`audit_events` records sign-in (success and failure), registration, investigation create / update / start / cancel /
delete, finding reviews, relationship decisions, uploads, report generation and downloads, exports, provider setting
changes, password changes, session revocations and retention purges. The investigation's activity tab shows its own
events; reviews keep the full before/after history with the analyst's rationale.

## Testing

Security behaviour is covered by automated tests, among them: 401 for anonymous requests and forged tokens; 404 for
another user's investigations across endpoints (API and browser); CSRF rejection for cross-origin and cross-site
requests; validation and content-type enforcement; disguised and executable uploads; zip bombs; prompt-injection text
in documents; CSV formula neutralisation; redaction; secrets never present in API responses; SSRF shape checks,
private-address blocking, redirect re-validation and cross-origin header stripping; rate limiting; client-IP
derivation; Supabase RLS denial for API roles; security headers and absence of CSP violations in the browser.

## Operator checklist

- Serve over HTTPS; set `ATLAS_APP_URL`, `ATLAS_ENABLE_HSTS=true`, and leave `ATLAS_COOKIE_SECURE` at its production
  default.
- Set `ATLAS_TRUSTED_PROXY_HOPS` to match your reverse-proxy chain, and make the proxy overwrite or append
  `X-Forwarded-For`.
- Set `ATLAS_IP_HASH_SALT` to a random value; disable registration after onboarding; do not seed the demo account in
  production (or change `ATLAS_DEMO_PASSWORD`).
- Use `REDIS_URL` when running more than one instance so rate limits are shared.
- On Supabase, apply `supabase/rls.sql` after every migration.
- Keep provider keys in your secret manager; rotate them if logs or backups are exposed.
- Restrict egress at the network level as defence in depth.
