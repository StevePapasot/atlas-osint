import type {
  ClaimType,
  DateKind,
  DatePrecision,
  Depth,
  EntityType,
  ErrorCategory,
  EvidenceCategory,
  GeoPrecision,
  MatchType,
  ModuleId,
  ProviderCategory,
  ProviderKind,
  RelationshipType,
  SourceReliability,
  TargetType,
} from '@/shared/domain';
import type { AppEnv } from '../config/env';

/** What a provider is asked to look at. Either an investigation target or a derived (pivot) entity. */
export interface ProviderSubject {
  /** Target type vocabulary; pivot entities are mapped onto the closest target type. */
  type: TargetType;
  value: string;
  display: string;
  metadata: Record<string, unknown>;
  targetId: string | null;
  entityId: string | null;
}

export interface ProviderInput {
  subject: ProviderSubject;
  operation: string;
  /** Operation-specific parameters, e.g. a planned search query. */
  params: Record<string, unknown>;
  depth: Depth;
  investigation: { id: string; name: string; scopeStatement: string | null; mode: 'live' | 'demo' };
  /** Other targets in the same investigation (used for query planning context). */
  relatedTargets: Array<{ type: TargetType; value: string; display: string }>;
}

export interface ProviderContext {
  signal: AbortSignal;
  env: AppEnv;
  timeoutMs: number;
  /** HTTP client with timeouts, size limits, proxy support and error classification. */
  http: HttpClient;
  /** DNS resolver honouring ATLAS_DNS_SERVERS. */
  dns: DnsClient;
  now: () => Date;
  log: (msg: string, fields?: Record<string, unknown>) => void;
}

export interface HttpRequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Status codes that should be returned instead of thrown (e.g. 404 means "no profile"). */
  allowStatus?: number[];
  /**
   * The URL came from a user or a collected document rather than a fixed provider endpoint: the public-address DNS
   * check is enforced even behind an egress proxy (fail closed), and only GET is allowed.
   */
  untrustedUrl?: boolean;
}

export interface HttpResponse {
  status: number;
  url: string;
  headers: Headers;
  text: string;
  json<T = unknown>(): T;
}

export interface HttpClient {
  request(url: string, opts?: HttpRequestOptions): Promise<HttpResponse>;
}

export interface DnsClient {
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
  resolveMx(name: string): Promise<Array<{ exchange: string; priority: number }>>;
  resolveNs(name: string): Promise<string[]>;
  resolveTxt(name: string): Promise<string[][]>;
  resolveCname(name: string): Promise<string[]>;
  resolveCaa(name: string): Promise<Array<Record<string, unknown>>>;
  resolveSoa(name: string): Promise<{ nsname: string; hostmaster: string; serial: number } | null>;
  reverse(ip: string): Promise<string[]>;
}

/** Entities referenced by a record. `ref` is local to the record and used to wire relationships. */
export interface RecordEntity {
  ref: string;
  type: EntityType;
  value: string;
  display?: string;
  attributes?: Record<string, unknown>;
}

export interface RecordRelationship {
  from: string;
  to: string;
  type: RelationshipType;
  status: 'confirmed' | 'possible';
  rationale: string;
}

export interface RecordGeo {
  lat?: number | null;
  lon?: number | null;
  precision: GeoPrecision;
  place?: string | null;
  countryCode?: string | null;
  basis: string;
}

export interface RecordEvent {
  date: string;
  precision: DatePrecision;
  kind: DateKind;
  label: string;
  description?: string;
  entityRef?: string;
}

/** A single attribute assertion; used to detect contradictions between sources. */
export interface RecordAssertion {
  subjectRef: string;
  attribute: string;
  value: string;
}

export interface ConfidenceInputs {
  sourceReliability: SourceReliability;
  matchType: MatchType;
  signals?: string[];
}

/**
 * The normalized shape every provider returns.
 * Collection time (`collectedAt`) is always set by ATLAS; `publishedAt` is only set when the source states it.
 */
export interface NormalizedRecord {
  providerId: string;
  sourceName: string;
  sourceUrl: string | null;
  title: string;
  description?: string | null;
  excerpt?: string | null;
  entityType: EntityType;
  normalizedValue: string;
  publishedAt?: string | null;
  publishedPrecision?: DatePrecision | null;
  collectedAt: string;
  category: EvidenceCategory;
  claimType: ClaimType;
  confidenceInputs: ConfidenceInputs;
  entities?: RecordEntity[];
  /** ref of the entity this record is primarily about (defaults to an entity matching entityType/normalizedValue). */
  subjectRef?: string;
  relationships?: RecordRelationship[];
  geo?: RecordGeo | null;
  events?: RecordEvent[];
  assertions?: RecordAssertion[];
  metadata?: Record<string, unknown>;
  /** Raw provider payload snapshot (redacted and size-limited before storage). */
  raw?: unknown;
  limitations?: string[];
  /** Override for deduplication; defaults to category + subject + canonical URL/title. */
  fingerprintKey?: string;
  isSimulated?: boolean;
}

export interface ProviderResult {
  records: NormalizedRecord[];
  /** Informational notes about coverage, e.g. "profile is private", "only first page fetched". */
  notes?: string[];
}

export interface ProviderOperation {
  id: string;
  label: string;
  targetTypes: TargetType[];
  module: ModuleId;
  /** Minimum depth at which the planner schedules this operation automatically. */
  minDepth: Exclude<Depth, 'custom'>;
}

export interface ConfigRequirement {
  env: keyof AppEnv;
  label: string;
  /** If true the provider works without it but with reduced capability. */
  optional?: boolean;
}

export interface HealthResult {
  status: 'healthy' | 'degraded' | 'unavailable' | 'not_configured';
  message: string;
  latencyMs?: number;
}

export interface Provider {
  id: string;
  name: string;
  category: ProviderCategory;
  kind: ProviderKind;
  description: string;
  homepage?: string;
  docsUrl?: string;
  reliability: SourceReliability;
  operations: ProviderOperation[];
  config: ConfigRequirement[];
  /** Extra enablement switch (e.g. dark-web sources are opt-in even without keys). */
  enabledByEnv?: (env: AppEnv) => boolean;
  defaultEnabled?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  /** Max concurrent in-flight calls to this provider across the process. */
  concurrency?: number;
  /** Minimum spacing between calls (ms), respecting published rate limits. */
  minIntervalMs?: number;
  limitations?: string[];
  run(input: ProviderInput, ctx: ProviderContext): Promise<ProviderResult>;
  healthCheck?(ctx: ProviderContext): Promise<HealthResult>;
}

export class ProviderError extends Error {
  constructor(
    public readonly category: ErrorCategory,
    message: string,
    public readonly retryable = false,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof ProviderError) return err.retryable;
  return false;
}
