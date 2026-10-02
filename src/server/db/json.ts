/** JSON column helpers: SQLite returns TEXT, PostgreSQL JSONB returns parsed values. */
export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function fromJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function bool(v: unknown): boolean {
  return v === 1 || v === true || v === '1';
}
