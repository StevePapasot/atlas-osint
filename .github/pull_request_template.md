## What and why

<!-- What does this change, and why is it needed? Link related issues. -->

## How it was tested

<!-- Commands you ran and what you checked by hand. -->

- [ ] `npm run lint`, `npm run typecheck` and `npm test` pass
- [ ] UI changes checked in light and dark mode and at phone width (and `npm run test:e2e` where relevant)

## Checklist

- [ ] New configuration is documented in `.env.example` and the docs
- [ ] New or changed data sources are documented in `docs/PROVIDERS.md`, including whether they were tested against the live service
- [ ] Database changes include a migration that works on SQLite and PostgreSQL (and new tables are added to `supabase/rls.sql`)
- [ ] No secrets, real personal data or collected intelligence in code, tests or screenshots
- [ ] Collection stays passive and lawful, as required by `docs/ACCEPTABLE_USE.md`
