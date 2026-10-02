import 'server-only';
import path from 'node:path';
import { createRequire } from 'node:module';

export interface OcrResult {
  text: string;
  confidence: number;
  durationMs: number;
}

/**
 * OCR with tesseract.js using locally installed English traineddata (@tesseract.js-data/eng),
 * so no CDN download is required. Each call uses a fresh worker that is always terminated.
 */
export async function runOcr(image: Buffer, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<OcrResult> {
  const require = createRequire(path.join(process.cwd(), 'package.json'));
  const { createWorker } = require('tesseract.js') as typeof import('tesseract.js');
  const langPath = (require('@tesseract.js-data/eng') as { langPath: string }).langPath;
  const started = Date.now();
  const worker = await createWorker('eng', 1, { langPath, cacheMethod: 'none', gzip: true });
  let timer: NodeJS.Timeout | undefined;
  try {
    const recognition = worker.recognize(image);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('OCR timed out')), opts.timeoutMs ?? 60_000);
      opts.signal?.addEventListener('abort', () => reject(new Error('OCR cancelled')), { once: true });
    });
    const r = await Promise.race([recognition, timeout]);
    return { text: r.data.text.trim().slice(0, 100_000), confidence: Math.round(r.data.confidence), durationMs: Date.now() - started };
  } finally {
    if (timer) clearTimeout(timer);
    await worker.terminate().catch(() => undefined);
  }
}
