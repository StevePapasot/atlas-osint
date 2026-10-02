/** Process-wide per-provider concurrency and pacing (respects provider rate limits across all jobs). */
class ProviderGate {
  private active = 0;
  private queue: Array<() => void> = [];
  private nextAllowedAt = 0;

  constructor(
    private readonly concurrency: number,
    private readonly minIntervalMs: number,
  ) {}

  async acquire(signal: AbortSignal): Promise<() => void> {
    if (this.active >= this.concurrency) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          this.queue = this.queue.filter((f) => f !== go);
          reject(signal.reason ?? new Error('aborted'));
        };
        const go = () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
        this.queue.push(go);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    this.active++;
    if (this.minIntervalMs > 0) {
      const wait = this.nextAllowedAt - Date.now();
      this.nextAllowedAt = Math.max(Date.now(), this.nextAllowedAt) + this.minIntervalMs;
      if (wait > 0) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, wait);
          signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
        });
      }
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.queue.shift()?.();
    };
  }
}

const g = globalThis as unknown as { __atlasGates?: Map<string, ProviderGate> };

export function providerGate(id: string, concurrency = 4, minIntervalMs = 0): ProviderGate {
  g.__atlasGates ??= new Map();
  let gate = g.__atlasGates.get(id);
  if (!gate) {
    gate = new ProviderGate(concurrency, minIntervalMs);
    g.__atlasGates.set(id, gate);
  }
  return gate;
}

/** Run async work over items with bounded concurrency. */
export async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}
