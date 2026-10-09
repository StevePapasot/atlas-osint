import 'server-only';
import path from 'node:path';
import { z } from 'zod';

/**
 * Centralised, validated server configuration.
 * Secret values never leave this module except to the provider/AI code that needs them;
 * the UI only ever receives booleans from `secretPresence()`.
 */
const boolish = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .optional()
  .transform((v) => (v === undefined ? undefined : ['true', '1', 'yes'].includes(v)));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().default('file:./data/atlas.db'),
  ATLAS_DATA_DIR: z.string().default('./data'),
  ATLAS_APP_URL: z.string().optional(),
  /** Where users of this instance can get its source code (AGPL-3.0 §13). Forks running modified code must change it. */
  ATLAS_SOURCE_URL: z.string().url().optional(),
  /** Number of reverse proxies in front of the app that append to X-Forwarded-For (0 = exposed directly). */
  ATLAS_TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  ATLAS_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 90).default(24 * 7),
  ATLAS_COOKIE_SECURE: boolish,
  ATLAS_ALLOW_REGISTRATION: boolish,
  ATLAS_INPROCESS_WORKER: boolish,
  ATLAS_WORKER_JOB_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  ATLAS_TASK_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  ATLAS_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),
  ATLAS_MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(100).default(20),
  ATLAS_ENABLE_OCR: boolish,
  ATLAS_ALLOW_TARGET_FETCH: boolish,
  ATLAS_DNS_SERVERS: z.string().optional(),
  ATLAS_HTTP_USER_AGENT: z.string().default('ATLAS-OSINT/0.1 (+passive public-source research)'),
  ATLAS_DEFAULT_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(0),
  REDIS_URL: z.string().optional(),
  // Search providers
  BRAVE_SEARCH_API_KEY: z.string().optional(),
  SERPAPI_API_KEY: z.string().optional(),
  PARALLEL_API_KEY: z.string().optional(),
  // Username / social
  GITHUB_TOKEN_OSINT: z.string().optional(),
  YOUTUBE_API_KEY: z.string().optional(),
  ATLAS_MASTODON_INSTANCES: z.string().default('mastodon.social,fosstodon.org,infosec.exchange'),
  // Email / breach / reputation
  HIBP_API_KEY: z.string().optional(),
  // IP / domain
  VIRUSTOTAL_API_KEY: z.string().optional(),
  SHODAN_API_KEY: z.string().optional(),
  ABUSEIPDB_API_KEY: z.string().optional(),
  IPINFO_TOKEN: z.string().optional(),
  // Crypto
  ETHERSCAN_API_KEY: z.string().optional(),
  // Dark web (authorized, clearnet-indexed sources only)
  ATLAS_ENABLE_AHMIA: boolish,
  INTELX_API_KEY: z.string().optional(),
  INTELX_API_URL: z.string().default('https://free.intelx.io'),
  ATLAS_DARKWEB_INDEX_URL: z.string().optional(),
  ATLAS_DARKWEB_INDEX_TOKEN: z.string().optional(),
  // Geo
  ATLAS_ENABLE_NOMINATIM: boolish,
  NOMINATIM_URL: z.string().default('https://nominatim.openstreetmap.org'),
  NEXT_PUBLIC_MAP_TILE_URL: z.string().optional(),
  // AI (optional)
  ANTHROPIC_API_KEY: z.string().optional(),
  ATLAS_AI_MODEL: z.string().default('claude-opus-5-5'),
  ATLAS_AI_BASE_URL: z.string().default('https://api.anthropic.com'),
});

export type AppEnv = z.infer<typeof schema>;

let cached: AppEnv | null = null;

export function env(): AppEnv {
  if (cached) return cached;
  const raw: Record<string, string | undefined> = {};
  for (const key of Object.keys(schema.shape)) {
    const v = process.env[key];
    raw[key] = v === '' ? undefined : v;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid ATLAS configuration: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** For tests: drop cached env so changes to process.env are picked up. */
export function resetEnvCache(): void {
  cached = null;
}

export function dataDir(): string {
  return path.resolve(/*turbopackIgnore: true*/ process.cwd(), env().ATLAS_DATA_DIR);
}

export function isProduction(): boolean {
  return env().NODE_ENV === 'production';
}

export function registrationAllowed(): boolean {
  return env().ATLAS_ALLOW_REGISTRATION ?? true;
}

export function cookieSecure(): boolean {
  return env().ATLAS_COOKIE_SECURE ?? isProduction();
}

export function inProcessWorkerEnabled(): boolean {
  return env().ATLAS_INPROCESS_WORKER ?? true;
}

export function ocrEnabled(): boolean {
  return env().ATLAS_ENABLE_OCR ?? true;
}

/** Secret names whose presence (never value) may be shown to users. */
export const SECRET_KEYS = [
  'BRAVE_SEARCH_API_KEY',
  'SERPAPI_API_KEY',
  'PARALLEL_API_KEY',
  'GITHUB_TOKEN_OSINT',
  'YOUTUBE_API_KEY',
  'HIBP_API_KEY',
  'VIRUSTOTAL_API_KEY',
  'SHODAN_API_KEY',
  'ABUSEIPDB_API_KEY',
  'IPINFO_TOKEN',
  'ETHERSCAN_API_KEY',
  'INTELX_API_KEY',
  'ATLAS_DARKWEB_INDEX_TOKEN',
  'ANTHROPIC_API_KEY',
  'REDIS_URL',
] as const satisfies readonly (keyof AppEnv)[];

export type SecretKey = (typeof SECRET_KEYS)[number];

export function secretPresence(): Record<SecretKey, boolean> {
  const e = env();
  return Object.fromEntries(SECRET_KEYS.map((k) => [k, Boolean(e[k])])) as Record<SecretKey, boolean>;
}
