-- ATLAS OSINT — optional hardening for Supabase-hosted PostgreSQL.
--
-- ATLAS talks to PostgreSQL only from the server, through DATABASE_URL, and enforces ownership in its own
-- data-access layer (every query is scoped to the signed-in user's investigations). Supabase additionally
-- exposes the `public` schema through its REST/GraphQL APIs to the `anon` and `authenticated` roles, which
-- anyone holding the project's publishable (anon) key can use. ATLAS never needs those APIs, so this script
-- closes them: Row Level Security is enabled on every ATLAS table with NO permissive policies, and table
-- privileges are revoked from the API roles. The server role in DATABASE_URL (table owner / `postgres`)
-- is unaffected.
--
-- Apply after `npm run db:migrate`, and again after future migrations add tables:
--   psql "$DATABASE_URL" -f supabase/rls.sql
-- Idempotent. Safe to run on plain PostgreSQL: the role-specific statements are skipped when the
-- Supabase roles do not exist.

DO $$
DECLARE
  t text;
  atlas_tables text[] := ARRAY[
    'users', 'sessions', 'investigations', 'targets', 'investigation_jobs', 'job_tasks', 'sources',
    'observations', 'artifacts', 'evidence', 'entities', 'findings', 'finding_observations',
    'finding_evidence', 'finding_reviews', 'relationships', 'relationship_evidence',
    'entity_match_candidates', 'timeline_events', 'provider_configurations', 'provider_health',
    'analyst_notes', 'tags', 'finding_tags', 'reports', 'ai_analyses', 'audit_events',
    'kysely_migration', 'kysely_migration_lock'
  ];
  api_role text;
BEGIN
  FOREACH t IN ARRAY atlas_tables LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
          EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, api_role);
        END IF;
      END LOOP;
    END IF;
  END LOOP;
END
$$;
