/**
 * Username intelligence: public-profile discovery through official/public APIs only.
 * A matching username is NOT proof of matching identity — every account is a "possible" link and
 * cross-account identity requires analyst confirmation (see entity resolution).
 */
import type { NormalizedRecord, Provider, ProviderContext, ProviderInput, ProviderResult } from '../types';
import { ProviderError } from '../types';
import { makeRecord, parseSourceDate, truncate } from '../util';
import { geocodePlace } from '../../geo/gazetteer';
import { normalizeEmail, normalizeUrl } from '@/shared/targets';

export interface ProfileData {
  platform: string;
  username: string;
  url: string;
  displayName?: string | null;
  bio?: string | null;
  website?: string | null;
  location?: string | null;
  email?: string | null;
  created?: string | null;
  avatarUrl?: string | null;
  followers?: number | null;
  extra?: Record<string, unknown>;
  raw?: unknown;
}

export function profileRecord(provider: Provider, ctx: ProviderContext, input: ProviderInput, p: ProfileData): NormalizedRecord {
  const acct = `${p.platform.toLowerCase()}:${p.username.toLowerCase()}`;
  const created = parseSourceDate(p.created);
  const site = p.website ? normalizeUrl(p.website) : null;
  const email = p.email ? normalizeEmail(p.email) : null;
  const geo = p.location ? geocodePlace(p.location, `Self-reported ${p.platform} profile location "${p.location}" (not verified).`) : null;
  const exact = input.subject.type === 'username' && input.subject.value === p.username.toLowerCase();
  const signals = [exact ? 'username_exact' : 'username_variant', p.displayName ? 'display_name' : null, site ? 'linked_website' : null].filter(Boolean) as string[];
  const subjectType = input.subject.type === 'username' ? 'username' : input.subject.type === 'email' ? 'email' : 'person';
  return makeRecord(provider, ctx, {
    sourceUrl: p.url,
    title: `${p.platform} account "${p.username}"${p.displayName ? ` (${p.displayName})` : ''} exists`,
    description: [
      p.bio ? `Bio: ${truncate(p.bio, 280)}` : null,
      p.location ? `Self-reported location: ${p.location}.` : null,
      site ? `Website: ${site.url}.` : null,
      created ? `Account created ${created.iso.slice(0, 10)}.` : null,
    ]
      .filter(Boolean)
      .join(' ') || 'Public profile found.',
    excerpt: [
      `username=${p.username}`,
      p.displayName ? `display_name=${p.displayName}` : null,
      p.bio ? `bio=${truncate(p.bio, 200)}` : null,
      p.location ? `location=${p.location}` : null,
      site ? `website=${site.url}` : null,
      p.followers != null ? `followers=${p.followers}` : null,
    ]
      .filter(Boolean)
      .join('; '),
    entityType: 'social_account',
    normalizedValue: acct,
    publishedAt: created?.iso ?? null,
    publishedPrecision: created?.precision ?? null,
    category: 'profile',
    claimType: 'SOURCE_CLAIM',
    confidenceInputs: { sourceReliability: 'reputable', matchType: exact ? 'exact' : 'partial', signals },
    entities: [
      { ref: 'subject', type: subjectType, value: input.subject.value, display: input.subject.display },
      {
        ref: 'acct',
        type: 'social_account',
        value: acct,
        display: `${p.platform} / ${p.username}`,
        attributes: { platform: p.platform, username: p.username, displayName: p.displayName ?? null, bio: p.bio ?? null, website: site?.url ?? null, location: p.location ?? null, profileUrl: p.url, avatarUrl: p.avatarUrl ?? null, created: created?.iso ?? null },
      },
      ...(site ? [{ ref: 'site', type: 'url' as const, value: site.url }] : []),
      ...(email ? [{ ref: 'email', type: 'email' as const, value: email.email }] : []),
      ...(geo ? [{ ref: 'loc', type: 'location' as const, value: geo.place.toLowerCase(), display: geo.place, attributes: { precision: geo.precision } }] : []),
    ],
    subjectRef: 'acct',
    relationships: [
      {
        from: 'subject',
        to: 'acct',
        type: 'USES',
        status: 'possible',
        rationale: exact ? 'Account username exactly matches the supplied identifier; identity not established.' : 'Account associated with the supplied identifier by the platform API.',
      },
      ...(site ? [{ from: 'acct', to: 'site', type: 'LINKED_TO' as const, status: 'confirmed' as const, rationale: `Website listed on the ${p.platform} profile.` }] : []),
      ...(email ? [{ from: 'acct', to: 'email', type: 'LINKED_TO' as const, status: 'confirmed' as const, rationale: `Public email listed on the ${p.platform} profile.` }] : []),
      ...(geo ? [{ from: 'acct', to: 'loc', type: 'LOCATED_IN' as const, status: 'possible' as const, rationale: 'Self-reported profile location.' }] : []),
    ],
    geo: geo ? { lat: geo.lat, lon: geo.lon, precision: geo.precision, place: geo.place, countryCode: geo.countryCode, basis: geo.basis } : null,
    events: created ? [{ date: created.iso, precision: created.precision, kind: 'event', label: `${p.platform} account "${p.username}" created`, entityRef: 'acct' }] : [],
    assertions: p.displayName ? [{ subjectRef: 'subject', attribute: 'display_name', value: p.displayName }] : [],
    metadata: { platform: p.platform, username: p.username, displayName: p.displayName ?? null, bio: p.bio ?? null, website: site?.url ?? null, location: p.location ?? null, email: email?.email ?? null, followers: p.followers ?? null, ...p.extra },
    fingerprintKey: `profile:${acct}`,
    limitations: ['A matching username is not proof of matching identity.', 'Profile fields are self-reported by the account holder.'],
    raw: p.raw ?? null,
  });
}

function usernameOnly(input: ProviderInput): string {
  if (input.subject.type !== 'username') throw new ProviderError('not_applicable', 'This provider only looks up usernames.');
  return input.subject.display.replace(/^@/, '');
}

const notFound = (platform: string, username: string): ProviderResult => ({ records: [], notes: [`No ${platform} account named "${username}".`] });

// --------------------------------------------------------------------------------------------- GitHub
export const githubProvider: Provider = {
  id: 'github',
  name: 'GitHub',
  category: 'username',
  kind: 'live',
  reliability: 'reputable',
  description: 'Public GitHub user profiles (REST API). Optional token raises the rate limit from 60 to 5,000 requests/hour.',
  homepage: 'https://github.com',
  docsUrl: 'https://docs.github.com/en/rest/users/users#get-a-user',
  operations: [
    { id: 'github_user', label: 'GitHub profile', targetTypes: ['username'], module: 'username', minDepth: 'quick' },
    { id: 'github_email', label: 'GitHub users with public email', targetTypes: ['email'], module: 'email', minDepth: 'standard' },
  ],
  config: [{ env: 'GITHUB_TOKEN_OSINT', label: 'GitHub token (read-only, no scopes needed)', optional: true }],
  timeoutMs: 12000,
  maxRetries: 2,
  concurrency: 2,
  async run(input, ctx) {
    const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
    if (ctx.env.GITHUB_TOKEN_OSINT) headers.authorization = `Bearer ${ctx.env.GITHUB_TOKEN_OSINT}`;
    if (input.operation === 'github_email') {
      const res = await ctx.http.request(`https://api.github.com/search/users?q=${encodeURIComponent(`${input.subject.value} in:email`)}&per_page=5`, { headers });
      const items = res.json<{ items?: Array<{ login: string }> }>().items ?? [];
      const records: NormalizedRecord[] = [];
      for (const it of items.slice(0, 3)) {
        const u = await ctx.http.request(`https://api.github.com/users/${encodeURIComponent(it.login)}`, { headers });
        const d = u.json<GithubUser>();
        records.push(profileRecord(this, ctx, input, githubProfile(d)));
      }
      return { records, notes: items.length ? [] : ['No GitHub user lists this email publicly.'] };
    }
    const username = usernameOnly(input);
    const res = await ctx.http.request(`https://api.github.com/users/${encodeURIComponent(username)}`, { headers, allowStatus: [404] });
    if (res.status === 404) return notFound('GitHub', username);
    return { records: [profileRecord(this, ctx, input, githubProfile(res.json<GithubUser>()))] };
  },
};

interface GithubUser {
  login: string;
  name: string | null;
  bio: string | null;
  blog: string | null;
  location: string | null;
  email: string | null;
  company: string | null;
  created_at: string;
  html_url: string;
  avatar_url: string;
  followers: number;
  public_repos: number;
  twitter_username: string | null;
  type: string;
}

function githubProfile(d: GithubUser): ProfileData {
  return {
    platform: 'GitHub',
    username: d.login,
    url: d.html_url,
    displayName: d.name,
    bio: d.bio,
    website: d.blog || null,
    location: d.location,
    email: d.email,
    created: d.created_at,
    avatarUrl: d.avatar_url,
    followers: d.followers,
    extra: { company: d.company, publicRepos: d.public_repos, twitter: d.twitter_username, accountType: d.type },
    raw: d,
  };
}

// --------------------------------------------------------------------------------------------- GitLab
export const gitlabProvider: Provider = {
  id: 'gitlab',
  name: 'GitLab.com',
  category: 'username',
  kind: 'live',
  reliability: 'reputable',
  description: 'Public GitLab.com user lookup (users API, unauthenticated).',
  homepage: 'https://gitlab.com',
  docsUrl: 'https://docs.gitlab.com/api/users/#list-users',
  operations: [{ id: 'gitlab_user', label: 'GitLab profile', targetTypes: ['username'], module: 'username', minDepth: 'quick' }],
  config: [],
  timeoutMs: 12000,
  maxRetries: 2,
  concurrency: 2,
  limitations: ['Unauthenticated API exposes name, state and avatar only; bio/location require authentication.'],
  async run(input, ctx) {
    const username = usernameOnly(input);
    const res = await ctx.http.request(`https://gitlab.com/api/v4/users?username=${encodeURIComponent(username)}`);
    const users = res.json<Array<{ id: number; username: string; name: string; state: string; avatar_url: string; web_url: string; public_email?: string; locked?: boolean }>>();
    const u = users[0];
    if (!u) return notFound('GitLab', username);
    return {
      records: [
        profileRecord(this, ctx, input, {
          platform: 'GitLab',
          username: u.username,
          url: u.web_url,
          displayName: u.name,
          email: u.public_email || null,
          avatarUrl: u.avatar_url,
          extra: { gitlabId: u.id, state: u.state, locked: u.locked ?? null },
          raw: u,
        }),
      ],
    };
  },
  async healthCheck(ctx) {
    const t = Date.now();
    await ctx.http.request('https://gitlab.com/api/v4/users?username=gitlab');
    return { status: 'healthy', message: 'GitLab users API reachable.', latencyMs: Date.now() - t };
  },
};

// --------------------------------------------------------------------------------------------- npm
export const npmProvider: Provider = {
  id: 'npm',
  name: 'npm registry',
  category: 'username',
  kind: 'live',
  reliability: 'reputable',
  description: 'Packages maintained by an npm username (registry search API). Package metadata may list maintainer emails.',
  homepage: 'https://www.npmjs.com',
  docsUrl: 'https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md#get-v1search',
  operations: [{ id: 'npm_maintainer', label: 'npm maintainer packages', targetTypes: ['username'], module: 'username', minDepth: 'standard' }],
  config: [],
  timeoutMs: 12000,
  maxRetries: 2,
  concurrency: 2,
  async run(input, ctx) {
    const username = usernameOnly(input).toLowerCase();
    const res = await ctx.http.request(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(`maintainer:${username}`)}&size=20`);
    const data = res.json<{ total: number; objects: Array<{ package: { name: string; version: string; description?: string; date: string; maintainers?: Array<{ username: string; email?: string }>; links?: { npm?: string; repository?: string; homepage?: string } } }> }>();
    const pkgs = data.objects.filter((o) => o.package.maintainers?.some((m) => m.username.toLowerCase() === username));
    if (!pkgs.length) return notFound('npm', username);
    const maint = pkgs[0]!.package.maintainers!.find((m) => m.username.toLowerCase() === username)!;
    const dates = pkgs.map((p) => p.package.date).sort();
    const rec = profileRecord(this, ctx, input, {
      platform: 'npm',
      username: maint.username,
      url: `https://www.npmjs.com/~${maint.username}`,
      email: maint.email ?? null,
      extra: { totalPackages: data.total, samplePackages: pkgs.slice(0, 10).map((p) => p.package.name) },
      raw: { total: data.total, packages: pkgs.slice(0, 10).map((p) => ({ name: p.package.name, version: p.package.version, date: p.package.date, links: p.package.links })) },
    });
    rec.title = `npm maintainer "${maint.username}" publishes ${data.total} package(s)`;
    rec.description = `Packages include ${pkgs.slice(0, 5).map((p) => p.package.name).join(', ')}. Most recent publish ${dates[dates.length - 1]?.slice(0, 10) ?? 'unknown'}.`;
    rec.events = [
      ...(rec.events ?? []),
      ...(dates[dates.length - 1] ? [{ date: dates[dates.length - 1]!, precision: 'exact' as const, kind: 'event' as const, label: `Most recent npm publish by ${maint.username}`, entityRef: 'acct' }] : []),
    ];
    return { records: [rec] };
  },
  async healthCheck(ctx) {
    const t = Date.now();
    await ctx.http.request('https://registry.npmjs.org/-/v1/search?text=maintainer:npm&size=1');
    return { status: 'healthy', message: 'npm registry search reachable.', latencyMs: Date.now() - t };
  },
};

// --------------------------------------------------------------------------------------------- Reddit
export const redditProvider: Provider = {
  id: 'reddit',
  name: 'Reddit',
  category: 'username',
  kind: 'live',
  reliability: 'reputable',
  description: 'Public Reddit account metadata (about.json).',
  homepage: 'https://www.reddit.com',
  docsUrl: 'https://www.reddit.com/dev/api/#GET_user_{username}_about',
  operations: [{ id: 'reddit_user', label: 'Reddit account', targetTypes: ['username'], module: 'username', minDepth: 'quick' }],
  config: [],
  timeoutMs: 12000,
  maxRetries: 1,
  concurrency: 1,
  minIntervalMs: 2000,
  limitations: ['Reddit restricts unauthenticated API access; requests may be refused (HTTP 403/429).'],
  async run(input, ctx) {
    const username = usernameOnly(input);
    const res = await ctx.http.request(`https://www.reddit.com/user/${encodeURIComponent(username)}/about.json?raw_json=1`, { allowStatus: [404] });
    if (res.status === 404) return notFound('Reddit', username);
    const d = res.json<{ data?: { name: string; created_utc: number; link_karma: number; comment_karma: number; is_suspended?: boolean; subreddit?: { public_description?: string; title?: string } } }>().data;
    if (!d || d.is_suspended) return { records: [], notes: [d?.is_suspended ? 'Account suspended.' : 'No data.'] };
    return {
      records: [
        profileRecord(this, ctx, input, {
          platform: 'Reddit',
          username: d.name,
          url: `https://www.reddit.com/user/${d.name}`,
          displayName: d.subreddit?.title || null,
          bio: d.subreddit?.public_description || null,
          created: new Date(d.created_utc * 1000).toISOString(),
          extra: { linkKarma: d.link_karma, commentKarma: d.comment_karma },
          raw: d,
        }),
      ],
    };
  },
};

// --------------------------------------------------------------------------------------------- Mastodon
export const mastodonProvider: Provider = {
  id: 'mastodon',
  name: 'Mastodon (configured instances)',
  category: 'username',
  kind: 'live',
  reliability: 'reputable',
  description: 'Account lookup on configured Mastodon instances (ATLAS_MASTODON_INSTANCES) or the instance in a profile URL.',
  docsUrl: 'https://docs.joinmastodon.org/methods/accounts/#lookup',
  operations: [{ id: 'mastodon_lookup', label: 'Mastodon account lookup', targetTypes: ['username'], module: 'username', minDepth: 'standard' }],
  config: [{ env: 'ATLAS_MASTODON_INSTANCES', label: 'Instances to query', optional: true }],
  timeoutMs: 15000,
  maxRetries: 1,
  concurrency: 2,
  limitations: ['Only the configured instances are checked; the fediverse has thousands of servers.'],
  async run(input, ctx) {
    const username = usernameOnly(input);
    const fromUrl = typeof input.subject.metadata.instance === 'string' ? [input.subject.metadata.instance] : [];
    const instances = [...new Set([...fromUrl, ...ctx.env.ATLAS_MASTODON_INSTANCES.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)])].slice(0, 6);
    const records: NormalizedRecord[] = [];
    const notes: string[] = [];
    for (const inst of instances) {
      try {
        const res = await ctx.http.request(`https://${inst}/api/v1/accounts/lookup?acct=${encodeURIComponent(username)}`, { allowStatus: [404] });
        if (res.status === 404) {
          notes.push(`No account on ${inst}.`);
          continue;
        }
        const d = res.json<{ username: string; acct: string; display_name: string; note: string; url: string; created_at: string; followers_count: number; fields?: Array<{ name: string; value: string }>; avatar?: string }>();
        const website = d.fields?.map((f) => f.value.match(/href="([^"]+)"/)?.[1]).find(Boolean) ?? null;
        records.push(
          profileRecord(this, ctx, input, {
            platform: `Mastodon (${inst})`,
            username: d.username,
            url: d.url,
            displayName: d.display_name || null,
            bio: d.note.replace(/<[^>]+>/g, ' ').trim() || null,
            website,
            created: d.created_at,
            avatarUrl: d.avatar ?? null,
            followers: d.followers_count,
            extra: { instance: inst, acct: d.acct },
            raw: d,
          }),
        );
      } catch (err) {
        if (err instanceof ProviderError && err.category === 'cancelled') throw err;
        notes.push(`${inst}: ${(err as Error).message}`);
      }
    }
    if (!records.length && notes.every((n) => !n.startsWith('No account'))) {
      throw new ProviderError('network', `All Mastodon instances failed: ${notes.join(' ')}`, true);
    }
    return { records, notes };
  },
};

// --------------------------------------------------------------------------------------------- Hacker News
export const hackerNewsProvider: Provider = {
  id: 'hackernews',
  name: 'Hacker News',
  category: 'username',
  kind: 'live',
  reliability: 'reputable',
  description: 'Hacker News user profiles via the official Firebase API.',
  docsUrl: 'https://github.com/HackerNews/API',
  operations: [{ id: 'hn_user', label: 'Hacker News profile', targetTypes: ['username'], module: 'username', minDepth: 'standard' }],
  config: [],
  timeoutMs: 10000,
  maxRetries: 1,
  concurrency: 2,
  async run(input, ctx) {
    const username = usernameOnly(input);
    const res = await ctx.http.request(`https://hacker-news.firebaseio.com/v0/user/${encodeURIComponent(username)}.json`);
    const d = res.json<{ id: string; created: number; karma: number; about?: string } | null>();
    if (!d) return notFound('Hacker News', username);
    const about = d.about?.replace(/<[^>]+>/g, ' ').replace(/&#x2F;/g, '/').replace(/&#x27;/g, "'") ?? null;
    const website = about?.match(/https?:\/\/[^\s"<]+/)?.[0] ?? null;
    return {
      records: [
        profileRecord(this, ctx, input, {
          platform: 'Hacker News',
          username: d.id,
          url: `https://news.ycombinator.com/user?id=${d.id}`,
          bio: about,
          website,
          created: new Date(d.created * 1000).toISOString(),
          extra: { karma: d.karma },
          raw: d,
        }),
      ],
    };
  },
};

// --------------------------------------------------------------------------------------------- Keybase
export const keybaseProvider: Provider = {
  id: 'keybase',
  name: 'Keybase',
  category: 'username',
  kind: 'live',
  reliability: 'reputable',
  description: 'Keybase users and their cryptographically proven linked identities.',
  docsUrl: 'https://keybase.io/docs/api/1.0/call/user/lookup',
  operations: [{ id: 'keybase_lookup', label: 'Keybase lookup', targetTypes: ['username'], module: 'username', minDepth: 'standard' }],
  config: [],
  timeoutMs: 12000,
  maxRetries: 1,
  concurrency: 1,
  async run(input, ctx) {
    const username = usernameOnly(input);
    const res = await ctx.http.request(`https://keybase.io/_/api/1.0/user/lookup.json?usernames=${encodeURIComponent(username)}&fields=basics,profile,proofs_summary`);
    const d = res.json<{ them?: Array<{ basics: { username: string; ctime: number }; profile?: { full_name?: string; bio?: string; location?: string }; proofs_summary?: { all?: Array<{ proof_type: string; nametag: string; service_url: string }> } } | null> }>();
    const u = d.them?.[0];
    if (!u) return notFound('Keybase', username);
    const proofs = u.proofs_summary?.all ?? [];
    const rec = profileRecord(this, ctx, input, {
      platform: 'Keybase',
      username: u.basics.username,
      url: `https://keybase.io/${u.basics.username}`,
      displayName: u.profile?.full_name ?? null,
      bio: u.profile?.bio ?? null,
      location: u.profile?.location ?? null,
      created: new Date(u.basics.ctime * 1000).toISOString(),
      extra: { proofs },
      raw: u,
    });
    // Keybase proofs are cryptographic claims made by the account holder — strong linkage evidence.
    for (const [i, p] of proofs.slice(0, 12).entries()) {
      const ref = `proof${i}`;
      rec.entities!.push({ ref, type: 'social_account', value: `${p.proof_type.toLowerCase()}:${p.nametag.toLowerCase()}`, display: `${p.proof_type} / ${p.nametag}`, attributes: { platform: p.proof_type, username: p.nametag, profileUrl: p.service_url } });
      rec.relationships!.push({ from: 'acct', to: ref, type: 'LINKED_TO', status: 'confirmed', rationale: `Keybase identity proof (${p.proof_type}).` });
    }
    return { records: [rec] };
  },
};

// --------------------------------------------------------------------------------------------- YouTube
export const youtubeProvider: Provider = {
  id: 'youtube',
  name: 'YouTube Data API',
  category: 'username',
  kind: 'live',
  reliability: 'reputable',
  description: 'YouTube channel lookup by @handle via the YouTube Data API v3.',
  docsUrl: 'https://developers.google.com/youtube/v3/docs/channels/list',
  operations: [{ id: 'youtube_handle', label: 'YouTube channel by handle', targetTypes: ['username'], module: 'username', minDepth: 'standard' }],
  config: [{ env: 'YOUTUBE_API_KEY', label: 'YouTube Data API key' }],
  timeoutMs: 12000,
  maxRetries: 1,
  concurrency: 2,
  async run(input, ctx) {
    const username = usernameOnly(input);
    const res = await ctx.http.request(`https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&forHandle=${encodeURIComponent('@' + username)}&key=${encodeURIComponent(ctx.env.YOUTUBE_API_KEY!)}`);
    const item = res.json<{ items?: Array<{ id: string; snippet: { title: string; description: string; customUrl?: string; publishedAt: string; country?: string }; statistics?: { subscriberCount?: string } }> }>().items?.[0];
    if (!item) return notFound('YouTube', username);
    return {
      records: [
        profileRecord(this, ctx, input, {
          platform: 'YouTube',
          username: (item.snippet.customUrl ?? username).replace(/^@/, ''),
          url: `https://www.youtube.com/channel/${item.id}`,
          displayName: item.snippet.title,
          bio: item.snippet.description,
          location: item.snippet.country ?? null,
          created: item.snippet.publishedAt,
          followers: item.statistics?.subscriberCount ? Number(item.statistics.subscriberCount) : null,
          extra: { channelId: item.id },
          raw: item,
        }),
      ],
    };
  },
};

// --------------------------------------------------------------------------------------------- Bluesky
export const blueskyProvider: Provider = {
  id: 'bluesky',
  name: 'Bluesky',
  category: 'username',
  kind: 'live',
  reliability: 'reputable',
  description: 'Bluesky profile lookup via the public AppView API (handle or <username>.bsky.social).',
  docsUrl: 'https://docs.bsky.app/docs/api/app-bsky-actor-get-profile',
  operations: [{ id: 'bsky_profile', label: 'Bluesky profile', targetTypes: ['username'], module: 'username', minDepth: 'standard' }],
  config: [],
  timeoutMs: 12000,
  maxRetries: 1,
  concurrency: 2,
  async run(input, ctx) {
    const username = usernameOnly(input);
    const handle = username.includes('.') ? username : `${username}.bsky.social`;
    const res = await ctx.http.request(`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(handle)}`, { allowStatus: [400, 404] });
    if (res.status !== 200) return notFound('Bluesky', handle);
    const d = res.json<{ did: string; handle: string; displayName?: string; description?: string; createdAt?: string; followersCount?: number; avatar?: string }>();
    return {
      records: [
        profileRecord(this, ctx, input, {
          platform: 'Bluesky',
          username: d.handle,
          url: `https://bsky.app/profile/${d.handle}`,
          displayName: d.displayName ?? null,
          bio: d.description ?? null,
          website: d.description?.match(/https?:\/\/[^\s]+/)?.[0] ?? null,
          created: d.createdAt ?? null,
          followers: d.followersCount ?? null,
          avatarUrl: d.avatar ?? null,
          extra: { did: d.did },
          raw: d,
        }),
      ],
    };
  },
};

// --------------------------------------------------------------------------------------------- DEV Community
export const devtoProvider: Provider = {
  id: 'devto',
  name: 'DEV Community',
  category: 'username',
  kind: 'live',
  reliability: 'reputable',
  description: 'DEV Community (dev.to) public user profiles.',
  docsUrl: 'https://developers.forem.com/api/v1#tag/users/operation/getUser',
  operations: [{ id: 'devto_user', label: 'DEV profile', targetTypes: ['username'], module: 'username', minDepth: 'deep' }],
  config: [],
  timeoutMs: 10000,
  maxRetries: 1,
  concurrency: 1,
  async run(input, ctx) {
    const username = usernameOnly(input);
    const res = await ctx.http.request(`https://dev.to/api/users/by_username?url=${encodeURIComponent(username)}`, { allowStatus: [404] });
    if (res.status === 404) return notFound('DEV', username);
    const d = res.json<{ username: string; name: string; summary?: string; location?: string; website_url?: string; joined_at?: string; github_username?: string; twitter_username?: string }>();
    const rec = profileRecord(this, ctx, input, {
      platform: 'DEV',
      username: d.username,
      url: `https://dev.to/${d.username}`,
      displayName: d.name,
      bio: d.summary ?? null,
      location: d.location ?? null,
      website: d.website_url ?? null,
      created: d.joined_at ?? null,
      extra: { github: d.github_username ?? null, twitter: d.twitter_username ?? null },
      raw: d,
    });
    if (d.github_username) {
      rec.entities!.push({ ref: 'gh', type: 'social_account', value: `github:${d.github_username.toLowerCase()}`, display: `GitHub / ${d.github_username}` });
      rec.relationships!.push({ from: 'acct', to: 'gh', type: 'LINKED_TO', status: 'confirmed', rationale: 'GitHub account linked via DEV OAuth profile.' });
    }
    return { records: [rec] };
  },
};

export const USERNAME_PROVIDERS: Provider[] = [
  githubProvider, gitlabProvider, npmProvider, redditProvider, mastodonProvider, hackerNewsProvider, keybaseProvider, youtubeProvider, blueskyProvider, devtoProvider,
];
