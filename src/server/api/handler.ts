import 'server-only';
import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { ZodError, type ZodType } from 'zod';
import { ApiError, unauthorized } from './errors';
import { resolveSession, SESSION_COOKIE, type SessionContext } from '../auth/session';
import { ensureDatabase } from '../db/ensure';
import { rateLimit } from '../security/rate-limit';
import { logger } from '../logging/logger';
import { ensureWorkerStarted } from '../engine/bootstrap';
import { env } from '../config/env';

export interface HandlerArgs<P> {
  req: NextRequest;
  params: P;
  session: SessionContext | null;
  ip: string | null;
  requestId: string;
}

export interface AuthedArgs<P> extends HandlerArgs<P> {
  session: SessionContext;
}

interface BaseOptions {
  rateLimit?: { bucket: string; limit: number; windowMs: number };
  /** Max JSON body size in bytes (default 1 MB). */
  maxBodyBytes?: number;
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Best-effort client address for rate limiting and (hashed) audit records.
 *
 * Next.js sets X-Forwarded-For to the socket address only when the header is absent, so leftmost entries are
 * client-controlled. With ATLAS_TRUSTED_PROXY_HOPS=N, the entry appended by the outermost trusted proxy (N-th from
 * the right) is used; with 0 the rightmost entry is used. Spoofing can therefore only move a direct client between
 * per-IP buckets — which is why sensitive endpoints also have a global backstop limit (see `wrap`).
 */
export function clientIp(req: Pick<NextRequest, 'headers'>, hops = trustedProxyHops()): string | null {
  const chain = (req.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (chain.length) return chain[Math.max(0, chain.length - Math.max(1, hops))]!.slice(0, 64);
  return req.headers.get('x-real-ip')?.trim().slice(0, 64) || null;
}

function trustedProxyHops(): number {
  try {
    return env().ATLAS_TRUSTED_PROXY_HOPS;
  } catch {
    return 0;
  }
}

/**
 * CSRF defence for cookie-authenticated mutations: browsers always send Origin (or Sec-Fetch-Site) on
 * cross-site requests, so a mismatch is rejected. Combined with SameSite=Lax cookies and JSON-only bodies.
 */
export function checkSameOrigin(req: NextRequest): boolean {
  if (!UNSAFE_METHODS.has(req.method)) return true;
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.get('origin');
  if (!origin) return true;
  const allowed = new Set<string>();
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (host) {
    allowed.add(`http://${host}`);
    allowed.add(`https://${host}`);
  }
  if (process.env.ATLAS_APP_URL) {
    try {
      allowed.add(new URL(process.env.ATLAS_APP_URL).origin);
    } catch {
      /* ignore malformed */
    }
  }
  return allowed.has(origin);
}

export function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

export function errorResponse(err: unknown, requestId: string): Response {
  if (err instanceof ApiError) {
    return Response.json(
      { error: { code: err.code, message: err.message, details: err.details ?? null, requestId } },
      { status: err.status },
    );
  }
  if (err instanceof ZodError) {
    return Response.json(
      {
        error: {
          code: 'validation_error',
          message: 'Request validation failed.',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          requestId,
        },
      },
      { status: 400 },
    );
  }
  logger.error('unhandled API error', { requestId, error: err instanceof Error ? err.message : String(err) });
  return Response.json(
    { error: { code: 'internal_error', message: 'An unexpected error occurred.', requestId } },
    { status: 500 },
  );
}

export async function readJson<T>(req: NextRequest, schema: ZodType<T>, maxBytes = 1_000_000): Promise<T> {
  const ct = req.headers.get('content-type') ?? '';
  if (!ct.toLowerCase().includes('application/json')) {
    throw new ApiError(415, 'unsupported_media_type', 'Content-Type must be application/json.');
  }
  const len = Number(req.headers.get('content-length') ?? '0');
  if (len > maxBytes) throw new ApiError(413, 'payload_too_large', 'Request body too large.');
  const text = await req.text();
  if (text.length > maxBytes) throw new ApiError(413, 'payload_too_large', 'Request body too large.');
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(400, 'invalid_json', 'Malformed JSON body.');
  }
  return schema.parse(body);
}

type RouteCtx<P> = { params: Promise<P> };

function wrap<P>(
  opts: BaseOptions & { auth: boolean },
  fn: (args: HandlerArgs<P>) => Promise<Response>,
): (req: NextRequest, ctx: RouteCtx<P>) => Promise<Response> {
  return async (req, ctx) => {
    const requestId = randomUUID();
    try {
      await ensureDatabase();
      ensureWorkerStarted();
      if (!checkSameOrigin(req)) {
        throw new ApiError(403, 'csrf_rejected', 'Cross-origin request rejected.');
      }
      const ip = clientIp(req);
      if (opts.rateLimit) {
        const { bucket, limit, windowMs } = opts.rateLimit;
        let rl = await rateLimit(`${bucket}:${ip ?? 'unknown'}`, limit, windowMs);
        // Global backstop per bucket: bounds abuse even if per-IP keys are evaded with forged forwarding headers.
        if (rl.allowed) rl = await rateLimit(`${bucket}:*`, limit * 25, windowMs);
        if (!rl.allowed) {
          return Response.json(
            { error: { code: 'rate_limited', message: 'Too many requests. Please slow down.', requestId } },
            { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
          );
        }
      }
      const session = await resolveSession(req.cookies.get(SESSION_COOKIE)?.value);
      if (opts.auth && !session) throw unauthorized();
      if (session && UNSAFE_METHODS.has(req.method)) {
        const rl = await rateLimit(`user-write:${session.user.id}`, 600, 60_000);
        if (!rl.allowed) {
          return Response.json(
            { error: { code: 'rate_limited', message: 'Too many requests. Please slow down.', requestId } },
            { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
          );
        }
      }
      const params = (ctx?.params ? await ctx.params : {}) as P;
      return await fn({ req, params, session, ip, requestId });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** Authenticated route: handler receives a non-null session. */
export function authed<P = Record<string, never>>(
  fn: (args: AuthedArgs<P>) => Promise<Response>,
  opts: BaseOptions = {},
) {
  return wrap<P>({ ...opts, auth: true }, fn as (args: HandlerArgs<P>) => Promise<Response>);
}

/** Public route (login, register, health). */
export function publicRoute<P = Record<string, never>>(
  fn: (args: HandlerArgs<P>) => Promise<Response>,
  opts: BaseOptions = {},
) {
  return wrap<P>({ ...opts, auth: false }, fn);
}
