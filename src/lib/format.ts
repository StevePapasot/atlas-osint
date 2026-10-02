export function formatDate(iso: string | null | undefined, opts: { time?: boolean } = {}): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    ...(opts.time ? { hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' } : { timeZone: 'UTC' }),
  });
}

/** Render a source date honestly according to its precision. */
export function formatPrecisionDate(iso: string | null | undefined, precision: string | null | undefined): string {
  if (!iso) return 'Date unknown';
  switch (precision) {
    case 'year':
      return `${iso.slice(0, 4)} (year)`;
    case 'month':
      return new Date(iso).toLocaleString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }) + ' (month)';
    case 'approximate':
      return `≈ ${formatDate(iso, { time: true })}`;
    case 'exact':
      return formatDate(iso, { time: true });
    case 'unknown':
      return 'Date unknown';
    default:
      return formatDate(iso);
  }
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(diff);
  const units: Array<[number, string]> = [
    [86_400_000 * 365, 'y'],
    [86_400_000 * 30, 'mo'],
    [86_400_000, 'd'],
    [3_600_000, 'h'],
    [60_000, 'm'],
  ];
  for (const [ms, label] of units) if (abs >= ms) return `${Math.floor(abs / ms)}${label} ${diff >= 0 ? 'ago' : 'from now'}`;
  return 'just now';
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
