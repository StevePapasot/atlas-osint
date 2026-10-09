# Changelog

All notable changes to ATLAS OSINT are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/)
(0.x: minor versions may contain breaking changes).

## [Unreleased]

### Fixed

- Command-line scripts (`providers:check`, `worker`, `db:migrate`, `db:seed`) now read `.env` like the web app, so
  API keys in `.env` are used everywhere.
- A `.env` copied from `.env.example` no longer breaks the Docker image when passed with `--env-file`: the example
  no longer sets `DATABASE_URL` / `ATLAS_DATA_DIR`, which overrode the image's `/data` paths.

### Changed

- Settings → API configuration explains how to add API keys.

## [0.1.0] — 2026-10-09

### Added

- Investigation workspace: targets with validation and normalisation, Quick / Standard / Deep / Custom depth,
  overview, findings, entities, relationship graph, timeline, GEOINT map, documents, images, dark-web sources,
  evidence, reports, activity and notes.
- Durable job engine with retries, rate limits, cancellation, partial results and crash recovery; in-process or
  separate workers.
- 39 source and analysis adapters plus 8 simulated demo providers (see `docs/PROVIDERS.md` for which were verified
  against live services).
- Offline analysis: image EXIF/GPS, perceptual hashing, OCR, PDF/DOCX/TXT/HTML/CSV parsing, entity extraction,
  phone and crypto-address checks, gazetteer.
- Explainable confidence levels, claim types, verification workflow with audit trail, contradiction detection,
  entity-resolution candidates that are never merged automatically.
- Reproducible 16-section reports in PDF, Markdown, JSON and CSV; optional citation-checked AI summary.
- SQLite or PostgreSQL / Supabase, optional Redis, Docker image and Compose stack, PWA.
- `npm run doctor` installation check; refusal of unsupported Node.js versions with a clear message.
- AGPL-3.0 licence, acceptable-use policy accepted at registration, source-code link in every page footer.

### Known limitations

- Several adapters have not been exercised against their live services yet; untested ones are listed in
  `docs/PROVIDERS.md`.
- No email verification or password reset (intended for self-hosted use by known accounts), no team sharing.

[Unreleased]: https://github.com/StevePapasot/atlas-osint/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/StevePapasot/atlas-osint/releases/tag/v0.1.0
