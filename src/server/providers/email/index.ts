/**
 * Email intelligence providers. No mailbox probing, no login-flow enumeration, no password testing.
 * Breach lookups use Have I Been Pwned's documented, key-authenticated API only.
 */
import { createHash } from 'node:crypto';
import type { NormalizedRecord, Provider } from '../types';
import { makeRecord, parseSourceDate } from '../util';
import { profileRecord } from '../username';

export const hibpProvider: Provider = {
  id: 'hibp',
  name: 'Have I Been Pwned',
  category: 'email',
  kind: 'live',
  reliability: 'reputable',
  description: 'Breach and paste exposure for an email address via the authorised HIBP v3 API (subscription key required).',
  homepage: 'https://haveibeenpwned.com',
  docsUrl: 'https://haveibeenpwned.com/API/v3',
  operations: [{ id: 'breached_account', label: 'Breach exposure', targetTypes: ['email'], module: 'breach', minDepth: 'standard' }],
  config: [{ env: 'HIBP_API_KEY', label: 'HIBP API key' }],
  timeoutMs: 15000,
  maxRetries: 2,
  concurrency: 1,
  minIntervalMs: 6100, // entry-level subscription: 10 requests/minute
  limitations: [
    'Shows which breached services listed the address; ATLAS never retrieves or stores breached passwords.',
    'Sensitive breaches are omitted by HIBP unless the domain is verified.',
  ],
  async run(input, ctx) {
    const email = input.subject.value;
    const res = await ctx.http.request(
      `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}?truncateResponse=false`,
      { headers: { 'hibp-api-key': ctx.env.HIBP_API_KEY!, 'user-agent': ctx.env.ATLAS_HTTP_USER_AGENT }, allowStatus: [404] },
    );
    if (res.status === 404) return { records: [], notes: ['HIBP lists no breaches for this address.'] };
    const breaches = res.json<Array<{ Name: string; Title: string; Domain: string; BreachDate: string; AddedDate: string; PwnCount: number; DataClasses: string[]; IsVerified: boolean; IsFabricated: boolean }>>();
    const records: NormalizedRecord[] = breaches.slice(0, 50).map((b) => {
      const d = parseSourceDate(b.BreachDate);
      return makeRecord(this, ctx, {
        sourceUrl: `https://haveibeenpwned.com/PwnedWebsites#${encodeURIComponent(b.Name)}`,
        title: `${email} appears in the ${b.Title} breach (${b.BreachDate})`,
        description: `Exposed data classes: ${b.DataClasses.join(', ')}. ${b.PwnCount.toLocaleString('en')} accounts affected.${b.IsVerified ? '' : ' Breach is UNVERIFIED by HIBP.'}${b.IsFabricated ? ' Breach flagged as FABRICATED by HIBP.' : ''}`,
        excerpt: `name=${b.Name}; domain=${b.Domain || '—'}; breach_date=${b.BreachDate}; data_classes=${b.DataClasses.join('|')}`,
        entityType: 'email',
        normalizedValue: email,
        publishedAt: parseSourceDate(b.AddedDate)?.iso ?? null,
        publishedPrecision: 'exact',
        category: 'breach',
        claimType: 'SOURCE_CLAIM',
        confidenceInputs: { sourceReliability: b.IsVerified && !b.IsFabricated ? 'reputable' : 'low', matchType: 'exact' },
        entities: [
          { ref: 'e', type: 'email', value: email },
          { ref: 'svc', type: 'organization', value: b.Title.toLowerCase(), display: b.Title, attributes: { breach: true, domain: b.Domain } },
          ...(b.Domain ? [{ ref: 'd', type: 'domain' as const, value: b.Domain.toLowerCase() }] : []),
        ],
        subjectRef: 'e',
        relationships: [
          { from: 'e', to: 'svc', type: 'APPEARS_IN', status: 'confirmed', rationale: 'Listed by HIBP for this breach.' },
          ...(b.Domain ? [{ from: 'svc', to: 'd', type: 'ASSOCIATED_WITH' as const, status: 'confirmed' as const, rationale: 'Breached service domain.' }] : []),
        ],
        events: d ? [{ date: d.iso, precision: d.precision, kind: 'event', label: `${b.Title} breach occurred`, entityRef: 'e' }] : [],
        metadata: { breach: b.Name, dataClasses: b.DataClasses, pwnCount: b.PwnCount, verified: b.IsVerified, fabricated: b.IsFabricated },
        fingerprintKey: `hibp:${email}:${b.Name}`,
        raw: b,
      });
    });
    return { records };
  },
  async healthCheck(ctx) {
    const t = Date.now();
    const res = await ctx.http.request('https://haveibeenpwned.com/api/v3/subscription/status', {
      headers: { 'hibp-api-key': ctx.env.HIBP_API_KEY!, 'user-agent': ctx.env.ATLAS_HTTP_USER_AGENT },
    });
    const sub = res.json<{ SubscriptionName?: string; SubscribedUntil?: string }>();
    return {
      status: 'healthy',
      message: `HIBP accepted the key${sub.SubscriptionName ? ` (${sub.SubscriptionName}${sub.SubscribedUntil ? `, until ${sub.SubscribedUntil.slice(0, 10)}` : ''})` : ''}.`,
      latencyMs: Date.now() - t,
    };
  },
};

export const gravatarProvider: Provider = {
  id: 'gravatar',
  name: 'Gravatar',
  category: 'email',
  kind: 'live',
  reliability: 'reputable',
  description: 'Public Gravatar profile for an email hash (REST API v3), including verified linked accounts.',
  homepage: 'https://gravatar.com',
  docsUrl: 'https://docs.gravatar.com/api/profiles/rest-api/',
  operations: [{ id: 'gravatar_profile', label: 'Gravatar profile', targetTypes: ['email'], module: 'email', minDepth: 'quick' }],
  config: [],
  timeoutMs: 10000,
  maxRetries: 1,
  concurrency: 2,
  limitations: ['Only profiles the owner has made public are visible.'],
  async run(input, ctx) {
    const email = input.subject.value;
    const hash = createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
    const res = await ctx.http.request(`https://api.gravatar.com/v3/profiles/${hash}`, { allowStatus: [404] });
    if (res.status === 404) return { records: [], notes: ['No public Gravatar profile.'] };
    const d = res.json<{ hash: string; display_name?: string; profile_url: string; avatar_url?: string; location?: string; description?: string; job_title?: string; company?: string; verified_accounts?: Array<{ service_label: string; service_type: string; url: string }> }>();
    const rec = profileRecord(this, ctx, input, {
      platform: 'Gravatar',
      username: d.profile_url.split('/').pop() ?? hash.slice(0, 12),
      url: d.profile_url,
      displayName: d.display_name ?? null,
      bio: [d.job_title, d.company, d.description].filter(Boolean).join(' · ') || null,
      location: d.location ?? null,
      avatarUrl: d.avatar_url ?? null,
      extra: { verifiedAccounts: d.verified_accounts ?? [] },
      raw: d,
    });
    rec.relationships![0] = { from: 'subject', to: 'acct', type: 'USES', status: 'confirmed', rationale: 'Gravatar profiles are keyed by a hash of the exact email address.' };
    rec.claimType = 'SOURCE_CLAIM';
    rec.confidenceInputs = { sourceReliability: 'reputable', matchType: 'exact', signals: ['email_hash_match'] };
    for (const [i, a] of (d.verified_accounts ?? []).slice(0, 12).entries()) {
      rec.entities!.push({ ref: `va${i}`, type: 'social_account', value: `${a.service_type.toLowerCase()}:${a.url.toLowerCase()}`, display: `${a.service_label}: ${a.url}`, attributes: { platform: a.service_label, profileUrl: a.url } });
      rec.relationships!.push({ from: 'acct', to: `va${i}`, type: 'LINKED_TO', status: 'confirmed', rationale: `Verified account listed on Gravatar (${a.service_label}).` });
    }
    return { records: [rec] };
  },
};

export const EMAIL_PROVIDERS: Provider[] = [hibpProvider, gravatarProvider];
