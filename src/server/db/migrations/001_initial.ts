import { sql, type Kysely, type CreateTableBuilder } from 'kysely';
import { PostgresAdapter } from 'kysely';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyDb = Kysely<any>;

function t(db: AnyDb) {
  const pg = db.getExecutor().adapter instanceof PostgresAdapter;
  return {
    pg,
    id: (pg ? 'uuid' : 'text') as 'uuid' | 'text',
    ts: (pg ? 'timestamptz' : 'text') as 'timestamptz' | 'text',
    json: (pg ? 'jsonb' : 'text') as 'jsonb' | 'text',
    real: (pg ? 'double precision' : 'real') as 'double precision' | 'real',
  };
}

function inList(values: readonly string[]) {
  return sql.raw(values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', '));
}

const INVESTIGATION_STATUSES = ['draft', 'queued', 'running', 'partially_completed', 'completed', 'failed', 'cancelled'];
const JOB_STATUSES = ['queued', 'running', 'partially_completed', 'completed', 'failed', 'cancelled'];
const TASK_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'skipped', 'cancelled'];
const CLAIM_TYPES = ['FACT', 'SOURCE_CLAIM', 'INFERENCE', 'UNVERIFIED_LEAD'];
const CONFIDENCE = ['verified', 'high', 'moderate', 'low', 'unverified'];
const VERIFICATION = ['unreviewed', 'verified', 'disputed', 'false_positive'];

export async function up(db: AnyDb): Promise<void> {
  const T = t(db);
  const idCol = <B extends CreateTableBuilder<any, any>>(b: B) =>
    b.addColumn('id', T.id, (c) => c.primaryKey()) as B;

  await idCol(db.schema.createTable('users'))
    .addColumn('email', 'text', (c) => c.notNull().unique())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('password_hash', 'text', (c) => c.notNull())
    .addColumn('role', 'text', (c) => c.notNull().defaultTo('analyst'))
    .addColumn('preferences', T.json, (c) => c.notNull())
    .addColumn('created_at', T.ts, (c) => c.notNull())
    .addColumn('updated_at', T.ts, (c) => c.notNull())
    .addColumn('last_login_at', T.ts)
    .addCheckConstraint('users_role_check', sql`role in ('analyst', 'admin')`)
    .execute();

  await idCol(db.schema.createTable('sessions'))
    .addColumn('user_id', T.id, (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('token_hash', 'text', (c) => c.notNull().unique())
    .addColumn('created_at', T.ts, (c) => c.notNull())
    .addColumn('expires_at', T.ts, (c) => c.notNull())
    .addColumn('last_seen_at', T.ts, (c) => c.notNull())
    .addColumn('user_agent', 'text')
    .addColumn('ip_hash', 'text')
    .execute();
  await db.schema.createIndex('sessions_user_idx').on('sessions').column('user_id').execute();

  await idCol(db.schema.createTable('investigations'))
    .addColumn('owner_id', T.id, (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('description', 'text')
    .addColumn('scope_statement', 'text')
    .addColumn('depth', 'text', (c) => c.notNull())
    .addColumn('mode', 'text', (c) => c.notNull())
    .addColumn('modules', T.json, (c) => c.notNull())
    .addColumn('providers', T.json, (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('created_at', T.ts, (c) => c.notNull())
    .addColumn('updated_at', T.ts, (c) => c.notNull())
    .addColumn('started_at', T.ts)
    .addColumn('completed_at', T.ts)
    .addColumn('retention_until', T.ts)
    .addCheckConstraint('investigations_depth_check', sql`depth in ('quick', 'standard', 'deep', 'custom')`)
    .addCheckConstraint('investigations_mode_check', sql`mode in ('live', 'demo')`)
    .addCheckConstraint('investigations_status_check', sql`status in (${inList(INVESTIGATION_STATUSES)})`)
    .execute();
  await db.schema.createIndex('investigations_owner_idx').on('investigations').columns(['owner_id', 'updated_at']).execute();

  await idCol(db.schema.createTable('targets'))
    .addColumn('investigation_id', T.id, (c) => c.notNull().references('investigations.id').onDelete('cascade'))
    .addColumn('type', 'text', (c) => c.notNull())
    .addColumn('raw_value', 'text', (c) => c.notNull())
    .addColumn('normalized_value', 'text', (c) => c.notNull())
    .addColumn('label', 'text')
    .addColumn('metadata', T.json, (c) => c.notNull())
    .addColumn('created_at', T.ts, (c) => c.notNull())
    .addUniqueConstraint('targets_unique', ['investigation_id', 'type', 'normalized_value'])
    .execute();

  await idCol(db.schema.createTable('investigation_jobs'))
    .addColumn('investigation_id', T.id, (c) => c.notNull().references('investigations.id').onDelete('cascade'))
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('attempt', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('locked_by', 'text')
    .addColumn('locked_at', T.ts)
    .addColumn('heartbeat_at', T.ts)
    .addColumn('cancel_requested', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('total_tasks', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('completed_tasks', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('failed_tasks', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('skipped_tasks', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('stage', 'text')
    .addColumn('error', 'text')
    .addColumn('payload', T.json, (c) => c.notNull())
    .addColumn('created_at', T.ts, (c) => c.notNull())
    .addColumn('started_at', T.ts)
    .addColumn('finished_at', T.ts)
    .addCheckConstraint('jobs_status_check', sql`status in (${inList(JOB_STATUSES)})`)
    .execute();
  await db.schema.createIndex('jobs_status_idx').on('investigation_jobs').columns(['status', 'created_at']).execute();
  await db.schema.createIndex('jobs_investigation_idx').on('investigation_jobs').column('investigation_id').execute();

  await idCol(db.schema.createTable('job_tasks'))
    .addColumn('job_id', T.id, (c) => c.notNull().references('investigation_jobs.id').onDelete('cascade'))
    .addColumn('investigation_id', T.id, (c) => c.notNull().references('investigations.id').onDelete('cascade'))
    .addColumn('provider_id', 'text', (c) => c.notNull())
    .addColumn('target_id', T.id, (c) => c.references('targets.id').onDelete('set null'))
    .addColumn('entity_id', T.id)
    .addColumn('operation', 'text', (c) => c.notNull())
    .addColumn('stage', 'text', (c) => c.notNull())
    .addColumn('input', T.json, (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('started_at', T.ts)
    .addColumn('finished_at', T.ts)
    .addColumn('duration_ms', 'integer')
    .addColumn('result_count', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('error_category', 'text')
    .addColumn('error_message', 'text')
    .addColumn('notes', T.json, (c) => c.notNull())
    .addColumn('created_at', T.ts, (c) => c.notNull())
    .addCheckConstraint('tasks_status_check', sql`status in (${inList(TASK_STATUSES)})`)
    .execute();
  await db.schema.createIndex('tasks_job_idx').on('job_tasks').columns(['job_id', 'status']).execute();
  await db.schema.createIndex('tasks_investigation_idx').on('job_tasks').columns(['investigation_id', 'provider_id']).execute();

  await idCol(db.schema.createTable('sources'))
    .addColumn('investigation_id', T.id, (c) => c.notNull().references('investigations.id').onDelete('cascade'))
    .addColumn('provider_id', 'text', (c) => c.notNull())
    .addColumn('source_key', 'text', (c) => c.notNull())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('url', 'text')
    .addColumn('reliability', 'text', (c) => c.notNull())
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('first_seen_at', T.ts, (c) => c.notNull())
    .addUniqueConstraint('sources_unique', ['investigation_id', 'source_key'])
    .addCheckConstraint('sources_kind_check', sql`kind in ('live', 'local', 'simulated')`)
    .execute();

  await idCol(db.schema.createTable('observations'))
    .addColumn('investigation_id', T.id, (c) => c.notNull().references('investigations.id').onDelete('cascade'))
    .addColumn('task_id', T.id, (c) => c.references('job_tasks.id').onDelete('set null'))
    .addColumn('provider_id', 'text', (c) => c.notNull())
    .addColumn('source_id', T.id, (c) => c.notNull().references('sources.id').onDelete('cascade'))
    .addColumn('target_id', T.id, (c) => c.references('targets.id').onDelete('set null'))
    .addColumn('entity_type', 'text', (c) => c.notNull())
    .addColumn('normalized_value', 'text', (c) => c.notNull())
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('description', 'text')
    .addColumn('excerpt', 'text')
    .addColumn('source_url', 'text')
    .addColumn('published_at', T.ts)
    .addColumn('published_precision', 'text')
    .addColumn('collected_at', T.ts, (c) => c.notNull())
    .addColumn('category', 'text', (c) => c.notNull())
    .addColumn('claim_type', 'text', (c) => c.notNull())
    .addColumn('metadata', T.json, (c) => c.notNull())
    .addColumn('confidence_inputs', T.json, (c) => c.notNull())
    .addColumn('limitations', T.json, (c) => c.notNull())
    .addColumn('is_simulated', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('fingerprint', 'text', (c) => c.notNull())
    .addCheckConstraint('observations_claim_check', sql`claim_type in (${inList(CLAIM_TYPES)})`)
    .execute();
  await db.schema.createIndex('observations_investigation_idx').on('observations').columns(['investigation_id', 'provider_id']).execute();
  await db.schema.createIndex('observations_task_idx').on('observations').column('task_id').execute();

  await idCol(db.schema.createTable('artifacts'))
    .addColumn('investigation_id', T.id, (c) => c.notNull().references('investigations.id').onDelete('cascade'))
    .addColumn('uploaded_by', T.id, (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('original_name', 'text', (c) => c.notNull())
    .addColumn('stored_path', 'text', (c) => c.notNull())
    .addColumn('mime_type', 'text', (c) => c.notNull())
    .addColumn('size_bytes', 'integer', (c) => c.notNull())
    .addColumn('sha256', 'text', (c) => c.notNull())
    .addColumn('phash', 'text')
    .addColumn('width', 'integer')
    .addColumn('height', 'integer')
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('analysis', T.json, (c) => c.notNull())
    .addColumn('error', 'text')
    .addColumn('created_at', T.ts, (c) => c.notNull())
    .addCheckConstraint('artifacts_kind_check', sql`kind in ('image', 'document')`)
    .execute();
  await db.schema.createIndex('artifacts_investigation_idx').on('artifacts').columns(['investigation_id', 'kind']).execute();

  await idCol(db.schema.createTable('evidence'))
    .addColumn('investigation_id', T.id, (c) => c.notNull().references('investigations.id').onDelete('cascade'))
    .addColumn('observation_id', T.id, (c) => c.references('observations.id').onDelete('cascade'))
    .addColumn('artifact_id', T.id, (c) => c.references('artifacts.id').onDelete('cascade'))
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('content', 'text', (c) => c.notNull())
    .addColumn('content_type', 'text', (c) => c.notNull())
    .addColumn('sha256', 'text', (c) => c.notNull())
    .addColumn('source_url', 'text')
    .addColumn('provider_id', 'text')
    .addColumn('collected_at', T.ts, (c) => c.notNull())
    .addColumn('is_simulated', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('redacted', 'integer', (c) => c.notNull().defaultTo(0))
    .execute();
  await db.schema.createIndex('evidence_investigation_idx').on('evidence').columns(['investigation_id', 'kind']).execute();
  await db.schema.createIndex('evidence_observation_idx').on('evidence').column('observation_id').execute();

  await idCol(db.schema.createTable('entities'))
    .addColumn('investigation_id', T.id, (c) => c.notNull().references('investigations.id').onDelete('cascade'))
    .addColumn('type', 'text', (c) => c.notNull())
    .addColumn('value', 'text', (c) => c.notNull())
    .addColumn('display_value', 'text', (c) => c.notNull())
    .addColumn('attributes', T.json, (c) => c.notNull())
    .addColumn('cluster_id', T.id)
    .addColumn('is_target', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('is_simulated', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('first_seen_at', T.ts, (c) => c.notNull())
    .addColumn('last_seen_at', T.ts, (c) => c.notNull())
    .addUniqueConstraint('entities_unique', ['investigation_id', 'type', 'value'])
    .execute();

  await idCol(db.schema.createTable('findings'))
    .addColumn('investigation_id', T.id, (c) => c.notNull().references('investigations.id').onDelete('cascade'))
    .addColumn('entity_id', T.id, (c) => c.references('entities.id').onDelete('set null'))
    .addColumn('fingerprint', 'text', (c) => c.notNull())
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('description', 'text')
    .addColumn('category', 'text', (c) => c.notNull())
    .addColumn('claim_type', 'text', (c) => c.notNull())
    .addColumn('confidence', 'text', (c) => c.notNull())
    .addColumn('confidence_score', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('confidence_rationale', T.json, (c) => c.notNull())
    .addColumn('verification_status', 'text', (c) => c.notNull().defaultTo('unreviewed'))
    .addColumn('source_count', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('provider_count', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('primary_source_url', 'text')
    .addColumn('primary_provider_id', 'text', (c) => c.notNull())
    .addColumn('collected_at', T.ts, (c) => c.notNull())
    .addColumn('published_at', T.ts)
    .addColumn('published_precision', 'text')
    .addColumn('geo_lat', T.real)
    .addColumn('geo_lon', T.real)
    .addColumn('geo_precision', 'text')
    .addColumn('geo_place', 'text')
    .addColumn('geo_country', 'text')
    .addColumn('geo_basis', 'text')
    .addColumn('bookmarked', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('is_simulated', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('created_at', T.ts, (c) => c.notNull())
    .addColumn('updated_at', T.ts, (c) => c.notNull())
    .addUniqueConstraint('findings_unique', ['investigation_id', 'fingerprint'])
    .addCheckConstraint('findings_claim_check', sql`claim_type in (${inList(CLAIM_TYPES)})`)
    .addCheckConstraint('findings_confidence_check', sql`confidence in (${inList(CONFIDENCE)})`)
    .addCheckConstraint('findings_verification_check', sql`verification_status in (${inList(VERIFICATION)})`)
    .addCheckConstraint(
      'findings_geo_precision_check',
      sql`geo_precision is null or geo_precision in ('country', 'region', 'city', 'approximate', 'exact')`,
    )
    .execute();
  await db.schema.createIndex('findings_investigation_idx').on('findings').columns(['investigation_id', 'category']).execute();
  await db.schema.createIndex('findings_entity_idx').on('findings').column('entity_id').execute();

  await db.schema
    .createTable('finding_observations')
    .addColumn('finding_id', T.id, (c) => c.notNull().references('findings.id').onDelete('cascade'))
    .addColumn('observation_id', T.id, (c) => c.notNull().references('observations.id').onDelete('cascade'))
    .addPrimaryKeyConstraint('finding_observations_pk', ['finding_id', 'observation_id'])
    .execute();

  await db.schema
    .createTable('finding_evidence')
    .addColumn('finding_id', T.id, (c) => c.notNull().references('findings.id').onDelete('cascade'))
    .addColumn('evidence_id', T.id, (c) => c.notNull().references('evidence.id').onDelete('cascade'))
    .addPrimaryKeyConstraint('finding_evidence_pk', ['finding_id', 'evidence_id'])
    .execute();
  await db.schema.createIndex('finding_evidence_evidence_idx').on('finding_evidence').column('evidence_id').execute();

  await idCol(db.schema.createTable('finding_reviews'))
    .addColumn('finding_id', T.id, (c) => c.notNull().references('findings.id').onDelete('cascade'))
    .addColumn('investigation_id', T.id, (c) => c.notNull().references('investigations.id').onDelete('cascade'))
    .addColumn('user_id', T.id, (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('from_status', 'text', (c) => c.notNull())
    .addColumn('to_status', 'text', (c) => c.notNull())
    .addColumn('rationale', 'text')
    .addColumn('created_at', T.ts, (c) => c.notNull())
    .execute();
  await db.schema.createIndex('finding_reviews_finding_idx').on('finding_reviews').column('finding_id').execute();

  await idCol(db.schema.createTable('relationships'))
    .addColumn('investigation_id', T.id, (c) => c.notNull().references('investigations.id').onDelete('cascade'))
    .addColumn('from_entity_id', T.id, (c) => c.notNull().references('entities.id').onDelete('cascade'))
    .addColumn('to_entity_id', T.id, (c) => c.notNull().references('entities.id').onDelete('cascade'))
    .addColumn('type', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('confidence', 'text', (c) => c.notNull())
    .addColumn('rationale', 'text')
    .addColumn('is_simulated', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('first_seen_at', T.ts, (c) => c.notNull())
    .addColumn('last_seen_at', T.ts, (c) => c.notNull())
    .addUniqueConstraint('relationships_unique', ['investigation_id', 'from_entity_id', 'to_entity_id', 'type'])
    .addCheckConstraint('relationships_status_check', sql`status in ('confirmed', 'possible', 'rejected')`)
    .addCheckConstraint(
      'relationships_type_check',
      sql`type in ('USES', 'MENTIONS', 'LINKED_TO', 'ASSOCIATED_WITH', 'HOSTED_ON', 'RESOLVES_TO', 'LOCATED_IN', 'APPEARS_IN', 'SIMILAR_TO')`,
    )
    .execute();
  await db.schema.createIndex('relationships_investigation_idx').on('relationships').column('investigation_id').execute();

  await db.schema
    .createTable('relationship_evidence')
    .addColumn('relationship_id', T.id, (c) => c.notNull().references('relationships.id').onDelete('cascade'))
    .addColumn('evidence_id', T.id, (c) => c.notNull().references('evidence.id').onDelete('cascade'))
    .addPrimaryKeyConstraint('relationship_evidence_pk', ['relationship_id', 'evidence_id'])
    .execute();

  await idCol(db.schema.createTable('entity_match_candidates'))
    .addColumn('investigation_id', T.id, (c) => c.notNull().references('investigations.id').onDelete('cascade'))
    .addColumn('entity_a_id', T.id, (c) => c.notNull().references('entities.id').onDelete('cascade'))
    .addColumn('entity_b_id', T.id, (c) => c.notNull().references('entities.id').onDelete('cascade'))
    .addColumn('signals', T.json, (c) => c.notNull())
    .addColumn('strength', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('decided_by', T.id, (c) => c.references('users.id').onDelete('set null'))
    .addColumn('decided_at', T.ts)
    .addColumn('created_at', T.ts, (c) => c.notNull())
    .addUniqueConstraint('candidates_unique', ['investigation_id', 'entity_a_id', 'entity_b_id'])
    .addCheckConstraint('candidates_status_check', sql`status in ('pending', 'accepted', 'rejected', 'separated')`)
    .execute();

  await idCol(db.schema.createTable('timeline_events'))
    .addColumn('investigation_id', T.id, (c) => c.notNull().references('investigations.id').onDelete('cascade'))
    .addColumn('entity_id', T.id, (c) => c.references('entities.id').onDelete('set null'))
    .addColumn('finding_id', T.id, (c) => c.references('findings.id').onDelete('cascade'))
    .addColumn('event_date', 'text')
    .addColumn('date_precision', 'text', (c) => c.notNull())
    .addColumn('date_kind', 'text', (c) => c.notNull())
    .addColumn('label', 'text', (c) => c.notNull())
    .addColumn('description', 'text')
    .addColumn('source_url', 'text')
    .addColumn('provider_id', 'text')
    .addColumn('is_simulated', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('fingerprint', 'text', (c) => c.notNull())
    .addColumn('created_at', T.ts, (c) => c.notNull())
    .addUniqueConstraint('timeline_unique', ['investigation_id', 'fingerprint'])
    .execute();

  await idCol(db.schema.createTable('provider_configurations'))
    .addColumn('user_id', T.id, (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('provider_id', 'text', (c) => c.notNull())
    .addColumn('enabled', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('settings', T.json, (c) => c.notNull())
    .addColumn('updated_at', T.ts, (c) => c.notNull())
    .addUniqueConstraint('provider_config_unique', ['user_id', 'provider_id'])
    .execute();

  await db.schema
    .createTable('provider_health')
    .addColumn('provider_id', 'text', (c) => c.primaryKey())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('message', 'text')
    .addColumn('latency_ms', 'integer')
    .addColumn('checked_at', T.ts, (c) => c.notNull())
    .execute();

  await idCol(db.schema.createTable('analyst_notes'))
    .addColumn('investigation_id', T.id, (c) => c.notNull().references('investigations.id').onDelete('cascade'))
    .addColumn('author_id', T.id, (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('finding_id', T.id, (c) => c.references('findings.id').onDelete('cascade'))
    .addColumn('entity_id', T.id, (c) => c.references('entities.id').onDelete('cascade'))
    .addColumn('body', 'text', (c) => c.notNull())
    .addColumn('created_at', T.ts, (c) => c.notNull())
    .addColumn('updated_at', T.ts, (c) => c.notNull())
    .execute();
  await db.schema.createIndex('notes_investigation_idx').on('analyst_notes').column('investigation_id').execute();

  await idCol(db.schema.createTable('tags'))
    .addColumn('investigation_id', T.id, (c) => c.notNull().references('investigations.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('color', 'text', (c) => c.notNull())
    .addColumn('created_at', T.ts, (c) => c.notNull())
    .addUniqueConstraint('tags_unique', ['investigation_id', 'name'])
    .execute();

  await db.schema
    .createTable('finding_tags')
    .addColumn('finding_id', T.id, (c) => c.notNull().references('findings.id').onDelete('cascade'))
    .addColumn('tag_id', T.id, (c) => c.notNull().references('tags.id').onDelete('cascade'))
    .addPrimaryKeyConstraint('finding_tags_pk', ['finding_id', 'tag_id'])
    .execute();

  await idCol(db.schema.createTable('reports'))
    .addColumn('investigation_id', T.id, (c) => c.notNull().references('investigations.id').onDelete('cascade'))
    .addColumn('created_by', T.id, (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('snapshot', T.json, (c) => c.notNull())
    .addColumn('options', T.json, (c) => c.notNull())
    .addColumn('created_at', T.ts, (c) => c.notNull())
    .execute();
  await db.schema.createIndex('reports_investigation_idx').on('reports').column('investigation_id').execute();

  await idCol(db.schema.createTable('ai_analyses'))
    .addColumn('investigation_id', T.id, (c) => c.notNull().references('investigations.id').onDelete('cascade'))
    .addColumn('created_by', T.id, (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('model', 'text', (c) => c.notNull())
    .addColumn('result', T.json, (c) => c.notNull())
    .addColumn('created_at', T.ts, (c) => c.notNull())
    .execute();
  await db.schema.createIndex('ai_analyses_investigation_idx').on('ai_analyses').column('investigation_id').execute();

  await idCol(db.schema.createTable('audit_events'))
    .addColumn('user_id', T.id, (c) => c.references('users.id').onDelete('set null'))
    .addColumn('investigation_id', T.id)
    .addColumn('action', 'text', (c) => c.notNull())
    .addColumn('target_type', 'text')
    .addColumn('target_id', 'text')
    .addColumn('metadata', T.json, (c) => c.notNull())
    .addColumn('ip_hash', 'text')
    .addColumn('created_at', T.ts, (c) => c.notNull())
    .execute();
  await db.schema.createIndex('audit_user_idx').on('audit_events').columns(['user_id', 'created_at']).execute();
  await db.schema.createIndex('audit_investigation_idx').on('audit_events').column('investigation_id').execute();
}

export async function down(db: AnyDb): Promise<void> {
  const tables = [
    'audit_events', 'ai_analyses', 'reports', 'finding_tags', 'tags', 'analyst_notes', 'provider_health', 'provider_configurations',
    'timeline_events', 'entity_match_candidates', 'relationship_evidence', 'relationships', 'finding_reviews',
    'finding_evidence', 'finding_observations', 'findings', 'entities', 'evidence', 'artifacts', 'observations',
    'sources', 'job_tasks', 'investigation_jobs', 'targets', 'investigations', 'sessions', 'users',
  ];
  for (const table of tables) await db.schema.dropTable(table).ifExists().execute();
}
