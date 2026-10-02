import type { ConfidenceInputs, NormalizedRecord, Provider, ProviderContext } from './types';

type RecordDraft = Omit<NormalizedRecord, 'providerId' | 'collectedAt' | 'confidenceInputs' | 'sourceName'> & {
  sourceName?: string;
  confidenceInputs?: Partial<ConfidenceInputs>;
};

/** Build a normalized record with provider defaults filled in. */
export function makeRecord(provider: Provider, ctx: ProviderContext, draft: RecordDraft): NormalizedRecord {
  return {
    ...draft,
    providerId: provider.id,
    sourceName: draft.sourceName ?? provider.name,
    collectedAt: ctx.now().toISOString(),
    confidenceInputs: {
      sourceReliability: draft.confidenceInputs?.sourceReliability ?? provider.reliability,
      matchType: draft.confidenceInputs?.matchType ?? 'exact',
      signals: draft.confidenceInputs?.signals ?? [],
    },
    isSimulated: draft.isSimulated ?? provider.kind === 'simulated',
  };
}

export function truncate(text: string | null | undefined, max = 600): string | null {
  if (!text) return null;
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}

/** Strip HTML tags from API snippets (Brave/SerpAPI return <strong> highlighting). Output is plain text. */
export function stripTags(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

/** Parse a date string from a source; returns ISO and a precision or null when not parseable. */
export function parseSourceDate(value: unknown): { iso: string; precision: 'exact' | 'day' | 'month' | 'year' } | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : { iso: d.toISOString(), precision: 'exact' };
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const v = value.trim();
  if (/^\d{4}$/.test(v)) return { iso: `${v}-01-01T00:00:00.000Z`, precision: 'year' };
  if (/^\d{4}-\d{2}$/.test(v)) return { iso: `${v}-01T00:00:00.000Z`, precision: 'month' };
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { iso: `${v}T00:00:00.000Z`, precision: 'day' };
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const year = d.getUTCFullYear();
  if (year < 1970 || year > 2100) return null;
  return { iso: d.toISOString(), precision: /\d{2}:\d{2}/.test(v) ? 'exact' : 'day' };
}

/** Deterministic pseudo-random generator for simulated providers (mulberry32). */
export function seededRandom(seedText: string): () => number {
  let h = 1779033703 ^ seedText.length;
  for (let i = 0; i < seedText.length; i++) {
    h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
