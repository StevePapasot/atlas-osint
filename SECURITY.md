# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately through GitHub:
**Security → Report a vulnerability** on this repository (private vulnerability reporting). Include the affected
version (shown in the app footer and at `/api/health`), steps to reproduce, and the impact you expect.

You can expect an acknowledgement within 7 days. Fixes are released as a new version and described in
[CHANGELOG.md](CHANGELOG.md) once users have had a chance to update.

## Supported versions

Only the latest release receives security fixes while the project is in 0.x.

## Scope

In scope: the ATLAS application, its API, the Docker image and the deployment files in this repository — for example
authentication or authorisation bypass, access to another user's investigations, server-side request forgery,
injection, unsafe file handling, or secrets exposed to the browser or logs.

Out of scope: vulnerabilities in third-party data sources, findings that require an already-compromised server or
administrator account, and reports about what public information a source returns.

How ATLAS is secured, and what operators must configure, is described in [docs/SECURITY.md](docs/SECURITY.md).
