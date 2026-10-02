import sharp from 'sharp';

/**
 * Perceptual hashes for near-duplicate image detection.
 *  - pHash: 32x32 greyscale → 2D DCT → top-left 8x8 low frequencies (excluding DC) vs median → 64 bits.
 *  - dHash: 9x8 greyscale horizontal gradient → 64 bits.
 * Hamming distance ≤ 10 (of 64) typically indicates the same image after resizing/re-encoding.
 */
const N = 32;
const COS: number[][] = Array.from({ length: N }, (_, k) => Array.from({ length: N }, (_, n) => Math.cos(((2 * n + 1) * k * Math.PI) / (2 * N))));

function bitsToHex(bits: number[]): string {
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) hex += ((bits[i]! << 3) | (bits[i + 1]! << 2) | (bits[i + 2]! << 1) | bits[i + 3]!).toString(16);
  return hex;
}

export async function perceptualHash(input: Buffer): Promise<string> {
  const { data } = await sharp(input, { limitInputPixels: 100_000_000 }).rotate().greyscale().resize(N, N, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const px: number[][] = Array.from({ length: N }, (_, y) => Array.from({ length: N }, (_, x) => data[y * N + x]!));
  // Separable 2D DCT-II restricted to the 8x8 low-frequency block we need.
  const rows: number[][] = px.map((row) => Array.from({ length: 8 }, (_, k) => row.reduce((s, v, n) => s + v * COS[k]![n]!, 0)));
  const coeffs: number[] = [];
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let s = 0;
      for (let y = 0; y < N; y++) s += rows[y]![v]! * COS[u]![y]!;
      coeffs.push(s);
    }
  }
  const ac = coeffs.slice(1);
  const median = [...ac].sort((a, b) => a - b)[Math.floor(ac.length / 2)]!;
  return bitsToHex(coeffs.map((c) => (c > median ? 1 : 0)));
}

export async function differenceHash(input: Buffer): Promise<string> {
  const { data } = await sharp(input, { limitInputPixels: 100_000_000 }).rotate().greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const bits: number[] = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits.push(data[y * 9 + x]! < data[y * 9 + x + 1]! ? 1 : 0);
  return bitsToHex(bits);
}

export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}
