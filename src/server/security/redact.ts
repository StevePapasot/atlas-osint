/**
 * Redaction helpers used by the logger, evidence snapshots and exports.
 * Pure functions (no server-only import) so they can be unit tested.
 */
const SECRET_KEY_PATTERN = /pass(word)?|secret|token|api[-_]?key|authorization|cookie|session|credential|private[-_]?key|x-subscription-token|hibp-api-key|^key$/i;

const INLINE_SECRET_PATTERNS: RegExp[] = [
  /(api[_-]?key|token|secret|password)=([^&\s"']+)/gi,
  /(Bearer\s+)[A-Za-z0-9._~+/-]+=*/g,
];

export function redactString(value: string): string {
  let out = value;
  for (const p of INLINE_SECRET_PATTERNS) {
    out = out.replace(p, (_m, a: string) => `${a}${a.endsWith('=') || a.endsWith(' ') ? '' : '='}[REDACTED]`);
  }
  return out;
}

export function redactObject(input: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]';
  if (input === null || input === undefined) return input;
  if (typeof input === 'string') return redactString(input);
  if (typeof input !== 'object') return input;
  if (input instanceof Error) {
    return { name: input.name, message: redactString(input.message) };
  }
  if (Array.isArray(input)) return input.slice(0, 200).map((v) => redactObject(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] = SECRET_KEY_PATTERN.test(k) ? '[REDACTED]' : redactObject(v, depth + 1);
  }
  return out;
}

/** Partially mask an email address for logs / redacted exports: j***@example.org */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '[REDACTED]';
  return `${local[0]}***@${domain}`;
}

/** Mask phone numbers keeping the country prefix and last two digits. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.length < 5) return '[REDACTED]';
  return `${digits.slice(0, 3)}${'•'.repeat(Math.max(0, digits.length - 5))}${digits.slice(-2)}`;
}

/** Redact sensitive identifiers inside free text (used for redacted report mode). */
export function redactSensitiveText(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (m) => maskEmail(m))
    .replace(/\+?\d[\d\s().-]{7,}\d/g, (m) => maskPhone(m));
}
