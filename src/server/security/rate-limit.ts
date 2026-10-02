import 'server-only';
import { logger } from '../logging/logger';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

interface Store {
  hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
}

/** Fixed-window counter held in process memory. Suitable for single-instance deployments. */
class MemoryStore implements Store {
  private buckets = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = Date.now();

  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    if (now - this.lastSweep > 60_000) {
      for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
      this.lastSweep = now;
    }
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, b);
    }
    b.count += 1;
    return {
      allowed: b.count <= limit,
      remaining: Math.max(0, limit - b.count),
      retryAfterSec: Math.ceil((b.resetAt - now) / 1000),
    };
  }
}

/** Redis-backed fixed window, shared across instances. Used automatically when REDIS_URL is set. */
class RedisStore implements Store {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private client: any) {}
  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const k = `atlas:rl:${key}`;
    const results = await this.client.multi().incr(k).pexpire(k, windowMs, 'NX').pttl(k).exec();
    const count = Number(results?.[0]?.[1] ?? 0);
    const ttl = Number(results?.[2]?.[1] ?? windowMs);
    return { allowed: count <= limit, remaining: Math.max(0, limit - count), retryAfterSec: Math.ceil(Math.max(ttl, 0) / 1000) };
  }
}

const g = globalThis as unknown as { __atlasRateStore?: Store; __atlasMemoryStore?: MemoryStore };

function memory(): MemoryStore {
  return (g.__atlasMemoryStore ??= new MemoryStore());
}

function store(): Store {
  if (g.__atlasRateStore) return g.__atlasRateStore;
  const url = process.env.REDIS_URL;
  if (url) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Redis = require('ioredis');
      const RedisCtor = Redis.default ?? Redis;
      const client = new RedisCtor(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: false });
      client.on('error', (e: Error) => logger.warn('redis rate-limit store error', { error: e.message }));
      g.__atlasRateStore = new RedisStore(client);
      return g.__atlasRateStore;
    } catch (err) {
      logger.warn('redis unavailable, falling back to in-memory rate limiting', { error: String(err) });
    }
  }
  g.__atlasRateStore = memory();
  return g.__atlasRateStore;
}

export async function rateLimit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  if (process.env.ATLAS_DISABLE_RATE_LIMIT === 'true') return { allowed: true, remaining: limit, retryAfterSec: 0 };
  try {
    return await store().hit(key, limit, windowMs);
  } catch (err) {
    // Fail over to memory rather than failing open or closed on store outages.
    logger.warn('rate-limit store failed; using memory store', { error: err instanceof Error ? err.message : String(err) });
    return memory().hit(key, limit, windowMs);
  }
}
