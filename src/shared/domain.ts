/**
 * Shared domain vocabulary for ATLAS OSINT (safe for client and server).
 */

export const TARGET_TYPES = [
  'person',
  'organization',
  'username',
  'email',
  'ip',
  'domain',
  'url',
  'phone',
  'crypto',
  'image',
  'document',
  'keyword',
] as const;
export type TargetType = (typeof TARGET_TYPES)[number];

export const TARGET_TYPE_LABELS: Record<TargetType, string> = {
  person: 'Person name',
  organization: 'Organization',
  username: 'Username / profile URL',
  email: 'Email address',
  ip: 'IP address',
  domain: 'Domain',
  url: 'URL',
  phone: 'Phone number',
  crypto: 'Cryptocurrency address',
  image: 'Image (upload or URL)',
  document: 'Public document URL',
  keyword: 'Other identifier / keyword',
};

export const DEPTHS = ['quick', 'standard', 'deep', 'custom'] as const;
export type Depth = (typeof DEPTHS)[number];

export const DEPTH_DESCRIPTIONS: Record<Depth, string> = {
  quick: 'Small set of searches and basic enrichment. Fastest.',
  standard: 'Broader searches, target-specific providers and entity normalization.',
  deep: 'Expanded queries, infrastructure pivots, documents, image analysis and relationship correlation.',
  custom: 'Choose modules and providers explicitly.',
};

export const MODULES = [
  'web_search',
  'username',
  'email',
  'breach',
  'ip',
  'domain',
  'infrastructure',
  'reputation',
  'phone',
  'crypto',
  'documents',
  'images',
  'geoint',
  'darkweb',
  'correlation',
] as const;
export type ModuleId = (typeof MODULES)[number];

export const MODULE_LABELS: Record<ModuleId, { label: string; description: string }> = {
  web_search: { label: 'Surface web search', description: 'Planned queries against configured search APIs.' },
  username: { label: 'Username intelligence', description: 'Public profile discovery on supported platforms.' },
  email: { label: 'Email intelligence', description: 'Domain extraction, mail infrastructure, public references.' },
  breach: { label: 'Breach exposure', description: 'Authorized breach lookups (Have I Been Pwned API).' },
  ip: { label: 'IP intelligence', description: 'ASN, prefix, reverse DNS, registration and approximate geolocation.' },
  domain: { label: 'Domain intelligence', description: 'DNS, mail policy, RDAP registration, certificate transparency.' },
  infrastructure: { label: 'Infrastructure pivots', description: 'Enrich IPs/domains discovered during collection (Deep).' },
  reputation: { label: 'Reputation', description: 'Abuse and threat reputation from configured providers.' },
  phone: { label: 'Phone intelligence', description: 'Offline numbering-plan analysis (country, line type).' },
  crypto: { label: 'Cryptocurrency', description: 'Address validation and public ledger lookups.' },
  documents: { label: 'Documents', description: 'Document discovery and parsing of uploaded public documents.' },
  images: { label: 'Image intelligence', description: 'EXIF, perceptual hashing, duplicates, OCR.' },
  geoint: { label: 'GEOINT', description: 'Geographic extraction, geocoding and mapping.' },
  darkweb: { label: 'Dark-web sources', description: 'Configured, lawful, clearnet-indexed dark-web research sources.' },
  correlation: { label: 'Correlation', description: 'Entity resolution, relationship correlation, contradictions.' },
};

export const DEPTH_MODULES: Record<Exclude<Depth, 'custom'>, ModuleId[]> = {
  quick: ['web_search', 'username', 'email', 'ip', 'domain', 'phone', 'crypto', 'images', 'documents'],
  standard: [
    'web_search', 'username', 'email', 'breach', 'ip', 'domain', 'reputation', 'phone', 'crypto', 'documents', 'images',
    'geoint', 'correlation',
  ],
  deep: [
    'web_search', 'username', 'email', 'breach', 'ip', 'domain', 'infrastructure', 'reputation', 'phone', 'crypto',
    'documents', 'images', 'geoint', 'darkweb', 'correlation',
  ],
};

export const INVESTIGATION_STATUSES = [
  'draft',
  'queued',
  'running',
  'partially_completed',
  'completed',
  'failed',
  'cancelled',
] as const;
export type InvestigationStatus = (typeof INVESTIGATION_STATUSES)[number];
export type JobStatus = Exclude<InvestigationStatus, 'draft'>;
export const TERMINAL_STATUSES: readonly InvestigationStatus[] = ['partially_completed', 'completed', 'failed', 'cancelled'];

export const TASK_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'skipped', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const CLAIM_TYPES = ['FACT', 'SOURCE_CLAIM', 'INFERENCE', 'UNVERIFIED_LEAD'] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];
export const CLAIM_TYPE_LABELS: Record<ClaimType, { label: string; description: string }> = {
  FACT: { label: 'Fact', description: 'Directly observed from an authoritative technical source (e.g. a live DNS answer).' },
  SOURCE_CLAIM: { label: 'Source claim', description: 'Asserted by a source; accuracy depends on that source.' },
  INFERENCE: { label: 'Inference', description: 'Derived by ATLAS or an analyst from other evidence.' },
  UNVERIFIED_LEAD: { label: 'Unverified lead', description: 'Possible relevance only; requires analyst verification.' },
};

export const CONFIDENCE_LEVELS = ['verified', 'high', 'moderate', 'low', 'unverified'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];
export const CONFIDENCE_LABELS: Record<ConfidenceLevel, string> = {
  verified: 'Verified',
  high: 'High confidence',
  moderate: 'Moderate confidence',
  low: 'Low confidence',
  unverified: 'Unverified',
};

export const VERIFICATION_STATUSES = ['unreviewed', 'verified', 'disputed', 'false_positive'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];
export const VERIFICATION_LABELS: Record<VerificationStatus, string> = {
  unreviewed: 'Unreviewed',
  verified: 'Verified',
  disputed: 'Disputed',
  false_positive: 'False positive',
};

export const ENTITY_TYPES = [
  'person',
  'username',
  'email',
  'domain',
  'ip',
  'organization',
  'location',
  'image',
  'document',
  'social_account',
  'crypto_address',
  'phone',
  'url',
  'asn',
  'certificate',
  'keyword',
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const ENTITY_LABELS: Record<EntityType, string> = {
  person: 'Person',
  username: 'Username',
  email: 'Email',
  domain: 'Domain',
  ip: 'IP address',
  organization: 'Organization',
  location: 'Location',
  image: 'Image',
  document: 'Document',
  social_account: 'Social account',
  crypto_address: 'Crypto address',
  phone: 'Phone',
  url: 'URL',
  asn: 'ASN',
  certificate: 'Certificate',
  keyword: 'Keyword',
};

export const RELATIONSHIP_TYPES = [
  'USES',
  'MENTIONS',
  'LINKED_TO',
  'ASSOCIATED_WITH',
  'HOSTED_ON',
  'RESOLVES_TO',
  'LOCATED_IN',
  'APPEARS_IN',
  'SIMILAR_TO',
] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];
export type RelationshipStatus = 'confirmed' | 'possible' | 'rejected';

export const GEO_PRECISIONS = ['country', 'region', 'city', 'approximate', 'exact'] as const;
export type GeoPrecision = (typeof GEO_PRECISIONS)[number];
export const GEO_PRECISION_LABELS: Record<GeoPrecision, string> = {
  country: 'Country-level',
  region: 'Region-level',
  city: 'City-level',
  approximate: 'Approximate area',
  exact: 'Exact coordinates',
};
/** Display radius (metres) used to draw an uncertainty circle on the map. */
export const GEO_PRECISION_RADIUS_M: Record<GeoPrecision, number> = {
  country: 400_000,
  region: 120_000,
  city: 20_000,
  approximate: 3_000,
  exact: 25,
};

export const DATE_PRECISIONS = ['exact', 'day', 'month', 'year', 'approximate', 'unknown'] as const;
export type DatePrecision = (typeof DATE_PRECISIONS)[number];

export const DATE_KINDS = ['event', 'source_published', 'registration', 'observed'] as const;
export type DateKind = (typeof DATE_KINDS)[number];

export const EVIDENCE_CATEGORIES = [
  'web_mention',
  'profile',
  'dns',
  'registration',
  'certificate',
  'network',
  'geolocation',
  'reputation',
  'breach',
  'metadata',
  'document',
  'image',
  'darkweb',
  'phone',
  'crypto',
  'correlation',
] as const;
export type EvidenceCategory = (typeof EVIDENCE_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<EvidenceCategory, string> = {
  web_mention: 'Web mention',
  profile: 'Public profile',
  dns: 'DNS',
  registration: 'Registration',
  certificate: 'Certificate',
  network: 'Network',
  geolocation: 'Geolocation',
  reputation: 'Reputation',
  breach: 'Breach exposure',
  metadata: 'Metadata',
  document: 'Document',
  image: 'Image',
  darkweb: 'Dark-web source',
  phone: 'Phone',
  crypto: 'Cryptocurrency',
  correlation: 'Correlation',
};

export type SourceReliability = 'authoritative' | 'reputable' | 'unknown' | 'low';
export type MatchType = 'exact' | 'normalized' | 'partial' | 'fuzzy' | 'none';

export const PROVIDER_CATEGORIES = [
  'search',
  'username',
  'email',
  'ip',
  'domain',
  'phone',
  'crypto',
  'image',
  'documents',
  'geoint',
  'darkweb',
  'analysis',
  'demo',
] as const;
export type ProviderCategory = (typeof PROVIDER_CATEGORIES)[number];

export type ProviderKind = 'live' | 'local' | 'simulated';

export type ErrorCategory =
  | 'timeout'
  | 'network'
  | 'rate_limited'
  | 'auth'
  | 'not_configured'
  | 'invalid_input'
  | 'upstream_error'
  | 'parse_error'
  | 'not_applicable'
  | 'cancelled'
  | 'disabled'
  | 'internal';
