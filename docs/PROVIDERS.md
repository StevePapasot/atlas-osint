# Providers

A provider is an adapter that turns one operation on one subject (e.g. "RDAP lookup for `example.com`") into
`NormalizedRecord`s. Providers never write to the database; the engine persists their output as observations,
evidence, findings, entities and relationships. All providers live in `src/server/providers/` and are registered in
`src/server/providers/registry.ts`.

Kinds:

- **live** — queries an external public source or API over the network.
- **local** — runs offline on data you supplied or on bundled reference data.
- **simulated** — demo data only. Planned only in demo-mode investigations, labelled SIMULATED everywhere, never
  mixed into live investigations.

Run `npm run env:check` to check `.env` for formatting mistakes (it never prints values), `npm run providers:check` for
the configuration status of every provider, and `npm run providers:check -- --live`
to run real connectivity checks from your network. **Settings → Search providers** shows the same information in the
UI (key presence only — values are never sent to the browser), lets each user disable providers, and runs health
checks on demand.

Every provider that needs a key has a health check that proves the service accepts it. When a service refuses a
request, the message includes the service's own error code and text (for example Brave's `SUBSCRIPTION_TOKEN_INVALID`),
with keys and personal data removed. Most checks are free; these use a little quota each time they run:

| Provider | Health check | Cost |
| --- | --- | --- |
| `brave` | one web search for `iana` | one search |
| `parallel` | one search with one result | one search request |
| `virustotal` | lookup of 8.8.8.8 | one of the daily lookups |
| `abuseipdb` | check of 8.8.8.8 (reports the checks left today) | one of the daily checks |
| `youtube` | list of interface languages | one quota unit |
| `serpapi`, `shodan`, `hibp`, `intelx`, `etherscan`, `github`, `ipinfo` | account, plan or rate-limit information | free |

## Verification status

"Live-verified" means the adapter was exercised against the real service during development. Most other adapters are
implemented against the provider's published API documentation and covered by fixture tests
(`tests/unit/providers.test.ts`, `tests/unit/url-fetch.test.ts`) that replay documented response shapes — but they
were **not** exercised live, because the build environment's egress proxy blocked those hosts or no API key was
available. Treat them as untested against the live service until `providers:check -- --live` and a real investigation
confirm them in your environment.

| Status | Providers |
| --- | --- |
| Live-verified | `dns` (A/AAAA/MX/NS/TXT/CAA/SOA, mail policy), `dns.ptr`, `cymru`, `gitlab`, `npm`, `url.fetch`, all `local.*` analysers |
| Health check passed on a user's network (9 October 2026, Docker Desktop on Windows): the endpoint answered, results not yet confirmed in an investigation | `github`, `mastodon`, `hackernews`, `keybase`, `bluesky`, `devto`, `gravatar`, `rdap`, `wayback`, `shodan.internetdb`, `ipinfo`, `blockstream` |
| Fixture-tested, not live-verified (host blocked or key unavailable in the build environment) | `brave`, `serpapi`, `parallel`, `hibp`, `crtsh`, `abuseipdb`, `virustotal`, `intelx` |
| Implemented, no fixture test of results yet | `youtube`, `bluesky`, `devto`, `shodan`, `etherscan`, `ahmia`, `darkweb.custom`, `nominatim` |
| Known not to work without credentials | `reddit` — Reddit has refused unauthenticated requests to its JSON endpoints since 2026 (HTTP 403 on the same user network); opt-in with `ATLAS_ENABLE_REDDIT=true` |

Observed in that first user check and not yet resolved: `brave` answered HTTP 422 (0.1.1 shows Brave's error code, which
tells an invalid key from a request problem); `crtsh` did not answer within 20 s (crt.sh is often overloaded; the check
now waits 30 s like investigations); `dns.ptr` got no PTR answer from Docker Desktop's resolver (set
`ATLAS_DNS_SERVERS`).
| Simulated (demo) | `demo.search`, `demo.search-alt`, `demo.profiles`, `demo.infrastructure`, `demo.ipintel`, `demo.breach`, `demo.darkweb`, `demo.unstable` (always fails, to exercise partial completion) |

## Catalogue

Depth is the minimum preset at which an operation runs automatically (Custom depth selects modules explicitly).

### Search

| Id | Source | Needs | Operations | Notes |
| --- | --- | --- | --- | --- |
| `brave` | Brave Search API | `BRAVE_SEARCH_API_KEY` | web search (all target types, ≥ quick) | Results are unverified leads until reviewed |
| `serpapi` | SerpApi (Google) | `SERPAPI_API_KEY` | web search (≥ quick), reverse image by public URL (≥ standard) | Uploaded images are never published to obtain a URL |
| `parallel` | Parallel Search API | `PARALLEL_API_KEY` | web search (≥ quick) | Same fingerprinting as other search providers, so duplicates merge |

The query planner (`engine/query-planner.ts`) builds exact-phrase and operator queries per target type and records the
query on each task.

### Usernames and accounts

| Id | Source | Needs | Operations |
| --- | --- | --- | --- |
| `github` | GitHub REST API | optional `GITHUB_TOKEN_OSINT` (higher limits; required for email search) | profile (≥ quick), users with that public email (≥ standard) |
| `gitlab` | GitLab.com users API | — | profile (≥ quick); unauthenticated API exposes name/state/avatar only |
| `npm` | npm registry search | — | packages maintained by the username (≥ standard) |
| `reddit` | Reddit public JSON | `ATLAS_ENABLE_REDDIT=true` (opt-in) | account (≥ quick); Reddit refuses unauthenticated requests from most networks (HTTP 403) |
| `mastodon` | Mastodon account lookup | `ATLAS_MASTODON_INSTANCES` (has a default) | lookup on configured instances (≥ standard) |
| `hackernews` | Hacker News Firebase API | — | profile (≥ standard) |
| `keybase` | Keybase lookup API | — | proofs become confirmed links between accounts (≥ standard) |
| `youtube` | YouTube Data API v3 | `YOUTUBE_API_KEY` | channel by handle (≥ standard) |
| `bluesky` | Bluesky public AppView | — | profile (≥ standard) |
| `devto` | DEV (Forem) API | — | profile (≥ deep) |

A matching username on two platforms is reported as an entity-resolution **candidate** with its signals; ATLAS never
merges accounts on its own.

### Email and breach exposure

| Id | Source | Needs | Notes |
| --- | --- | --- | --- |
| `hibp` | Have I Been Pwned API v3 `breachedaccount` | `HIBP_API_KEY` (paid) | Lists breached services that included the address. Uses only the documented, authenticated endpoint at your subscription tier. No password lookups, no account enumeration via login flows, nothing about credentials is retrieved or stored |
| `gravatar` | Gravatar profiles API | — | Public profiles only (SHA-256 of the address) |
| `dns` → `email_domain` | DNS | — | MX / SPF / DMARC of the email's domain |

### Domains, IPs and infrastructure

| Id | Source | Needs | Operations / notes |
| --- | --- | --- | --- |
| `dns` | System or configured resolvers | optional `ATLAS_DNS_SERVERS` | records (≥ quick), mail policy (≥ standard); answers reflect collection time |
| `rdap` | RDAP via rdap.org bootstrap | — (`ATLAS_RDAP_BASE_URL` to override) | domain (≥ quick) and IP network (≥ standard) registration; registrant data is usually redacted |
| `crtsh` | crt.sh Certificate Transparency | — | certificates and hostnames (≥ standard); frequently rate-limited |
| `wayback` | Internet Archive CDX API | — | first/last capture and capture history (≥ standard) |
| `cymru` | Team Cymru IP-to-ASN over DNS | — | origin ASN, prefix, registry country (≥ quick) |
| `dns.ptr` | Reverse DNS | — | PTR with forward confirmation (≥ quick) |
| `shodan.internetdb` | Shodan InternetDB | — | open ports, hostnames, tags, version-inferred CVEs from Shodan's own scans (≥ standard) |
| `ipinfo` | IPinfo | optional `IPINFO_TOKEN` | network geolocation, ASN, hosting flags (≥ standard) |
| `abuseipdb` | AbuseIPDB check | `ABUSEIPDB_API_KEY` | abuse confidence and report counts (≥ standard) |
| `shodan` | Shodan host API | `SHODAN_API_KEY` | services and banners (≥ deep) |
| `virustotal` | VirusTotal v3 | `VIRUSTOTAL_API_KEY` | IP, domain and URL reputation (≥ standard); public quota 4/min |
| `url.fetch` | The target URL itself | `ATLAS_ALLOW_TARGET_FETCH=true` | One GET of a URL target: title, metadata, published emails, linked domains, profile links (≥ standard). Off by default because it contacts the target's server |
| `local.url` | — (offline) | — | URL structure and phishing-style indicators |

ATLAS performs **no active scanning**: no port scans, no vulnerability probes, no crawling. Port and service data come
only from third-party datasets (Shodan / InternetDB) that already collected it.

### Phone, crypto, geography

| Id | Source | Needs | Notes |
| --- | --- | --- | --- |
| `local.phone` | libphonenumber (offline) | — | Validity, type, region of allocation. No subscriber or carrier lookup |
| `local.crypto` | Offline checksum validation | — | Bitcoin, Litecoin, Dogecoin (base58check / bech32) and EVM addresses (EIP-55 checksum) |
| `blockstream` | Blockstream Esplora | — | Bitcoin address activity |
| `etherscan` | Etherscan v2 API | `ETHERSCAN_API_KEY` | Ethereum balance / activity |
| `local.gazetteer` | Bundled GeoNames data (4,519 cities ≥ 100k population or capitals; all countries) | — | Place names → city/country centroid; ambiguous names resolve to the most populous match and are flagged |
| `nominatim` | OpenStreetMap Nominatim | `ATLAS_ENABLE_NOMINATIM=true` | Online geocoding (≥ deep); follow the Nominatim usage policy |

Geographic findings always carry a basis (e.g. "self-reported profile location", "embedded EXIF GPS", "IP network
geolocation") and a precision. None of them establishes where a person is.

### Images and documents (offline)

| Id | What it does |
| --- | --- |
| `local.image` | Validates the file by content, extracts EXIF (camera, dates, GPS, software), computes pHash/dHash and near-duplicates within the investigation, runs OCR (tesseract.js, English model bundled), extracts entities from OCR text |
| `local.document` | PDF (unpdf), DOCX (mammoth + zip-bomb checks), TXT, HTML (scripts removed), CSV: metadata (author, organisation, tool, dates), text, links and entities (emails, domains, IPs, phones, crypto, people, organisations, places, dates) |

Uploaded files are stored outside the web root, never executed, and their contents are treated as untrusted data —
instructions inside documents are never followed.

### Dark-web research (authorised, clearnet-indexed sources only)

| Id | Source | Needs | Notes |
| --- | --- | --- | --- |
| `ahmia` | Ahmia clearnet search | `ATLAS_ENABLE_AHMIA=true` | Parses Ahmia's public results page; returns mentions as unverified leads |
| `intelx` | Intelligence X search API | `INTELX_API_KEY` | Search metadata only |
| `darkweb.custom` | Your organisation's authorised index | `ATLAS_DARKWEB_INDEX_URL`, optional `ATLAS_DARKWEB_INDEX_TOKEN` | Contract below |

ATLAS never connects to Tor or hidden services, never downloads leaked datasets, and never buys, sells or trades data.
Every dark-web result is an UNVERIFIED LEAD with low source reliability, and absence of results is not evidence of
absence.

**Custom index contract.** `GET {ATLAS_DARKWEB_INDEX_URL}?q=<term>` with `Authorization: Bearer <token>` when a token
is set, returning:

```json
{ "results": [ { "title": "…", "snippet": "…", "url": "https://…", "published": "2026-01-31", "source": "…" } ] }
```

Only `https://` result URLs are kept; at most 30 results per query are used.

### Analysis

`atlas.correlation` runs after collection: entity-resolution candidates between accounts (signals such as a shared
website or email, same display name, similar biography, same username or location — each weighted and explained), shared-infrastructure inferences (targets resolving to the same IP or ASN) and
contradictions between sources' attribute assertions.

## Error handling and limits

Every provider declares a timeout, retry count, concurrency and minimum interval. The HTTP client
(`providers/http.ts`):

- validates every destination and **every redirect hop** (http/https only, standard ports, no embedded credentials,
  public addresses only) and drops provider headers such as API keys when a redirect leaves the original origin;
- limits response sizes and classifies failures: `auth` (401/403 — check key or tier), `rate_limited` (429, honours
  `Retry-After`), `timeout`, `network` (including "blocked by egress proxy"), `upstream_error`, `parse_error`;
- retries only retryable errors, with exponential backoff.

A failed provider never fails the whole investigation: the job finishes as `partially_completed` and the failure is
shown in the provider-runs panel, the methodology section of reports and the activity log.

## Adding a provider

1. Create `src/server/providers/<area>/<name>.ts` exporting a `Provider` (see `providers/types.ts`): id, name,
   category, kind, reliability prior, operations (target types, module, minimum depth), config requirements
   (environment variable names — never values), limits, limitations, optional `healthCheck`, and `run()`.
2. In `run()`, use only `ctx.http` / `ctx.dns` (never `fetch` directly) so SSRF protection, proxies, timeouts and
   cancellation apply. Return records with an honest claim type, category, entities, relationships, source dates
   only when the source states them, and `limitations`.
3. Register it in `registry.ts`. If it needs a key, add the variable to `config/env.ts` (and `SECRET_KEYS` if
   secret) and to `.env.example`.
4. Add fixture tests to `tests/unit/providers.test.ts` with `fakeHttp` / `fakeDns` from
   `tests/helpers/provider-harness.ts`, covering success, "not found", and error classification.
5. Document it in this file, including its verification status.

Do not add providers that require logging in as someone else, scraping private or authenticated content, bypassing
rate limits or access controls, testing credentials, or acquiring leaked or stolen data.
