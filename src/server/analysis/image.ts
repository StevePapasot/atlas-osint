import sharp from 'sharp';
import exifr from 'exifr';
import { createHash } from 'node:crypto';
import { differenceHash, perceptualHash } from './phash';

export const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/tiff': 'tif',
  'image/avif': 'avif',
};

export const MAX_IMAGE_PIXELS = 100_000_000;

export interface ImageAnalysis {
  sha256: string;
  format: string | null;
  width: number | null;
  height: number | null;
  phash: string;
  dhash: string;
  hasAlpha: boolean;
  orientation: number | null;
  camera: { make: string | null; model: string | null; lens: string | null; software: string | null };
  dates: { original: string | null; created: string | null; modified: string | null };
  gps: { latitude: number; longitude: number; altitude: number | null } | null;
  descriptive: { description: string | null; artist: string | null; copyright: string | null; creatorTool: string | null };
  exifPresent: boolean;
  rawExif: Record<string, unknown>;
}

function str(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 300);
  if (Array.isArray(v) && typeof v[0] === 'string') return String(v[0]).slice(0, 300);
  if (v && typeof v === 'object' && 'value' in (v as Record<string, unknown>)) return str((v as Record<string, unknown>).value);
  return null;
}

function iso(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
  if (typeof v === 'string') {
    const m = v.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`;
  }
  return null;
}

/** Decode safely (pixel limit), extract embedded metadata and perceptual hashes. */
export async function analyzeImage(buf: Buffer): Promise<ImageAnalysis> {
  const img = sharp(buf, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'error' });
  const meta = await img.metadata();
  let exif: Record<string, unknown> = {};
  try {
    exif = ((await exifr.parse(buf, { tiff: true, exif: true, gps: true, xmp: true, iptc: true, icc: false, mergeOutput: true })) ?? {}) as Record<string, unknown>;
  } catch {
    exif = {};
  }
  const lat = typeof exif.latitude === 'number' ? exif.latitude : null;
  const lon = typeof exif.longitude === 'number' ? exif.longitude : null;
  const gpsValid = lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
  const safeExif: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(exif)) {
    if (v instanceof Uint8Array || Buffer.isBuffer(v)) continue;
    if (typeof v === 'string' && v.length > 500) continue;
    safeExif[k] = v instanceof Date ? v.toISOString() : v;
    if (Object.keys(safeExif).length > 120) break;
  }
  return {
    sha256: createHash('sha256').update(buf).digest('hex'),
    format: meta.format ?? null,
    width: meta.width ?? null,
    height: meta.height ?? null,
    phash: await perceptualHash(buf),
    dhash: await differenceHash(buf),
    hasAlpha: Boolean(meta.hasAlpha),
    orientation: meta.orientation ?? null,
    camera: { make: str(exif.Make), model: str(exif.Model), lens: str(exif.LensModel), software: str(exif.Software) ?? str(exif.CreatorTool) },
    dates: { original: iso(exif.DateTimeOriginal), created: iso(exif.CreateDate), modified: iso(exif.ModifyDate) },
    gps: gpsValid ? { latitude: lat!, longitude: lon!, altitude: typeof exif.GPSAltitude === 'number' ? exif.GPSAltitude : null } : null,
    descriptive: { description: str(exif.ImageDescription) ?? str(exif.description), artist: str(exif.Artist) ?? str(exif.creator), copyright: str(exif.Copyright) ?? str(exif.rights), creatorTool: str(exif.CreatorTool) },
    exifPresent: Object.keys(exif).length > 0,
    rawExif: safeExif,
  };
}

/** Thumbnail for UI/reports. sharp strips EXIF/GPS metadata unless explicitly retained. */
export async function makeThumbnail(buf: Buffer, size = 480): Promise<Buffer> {
  return sharp(buf, { limitInputPixels: MAX_IMAGE_PIXELS }).rotate().resize(size, size, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
}

/** Downscaled greyscale PNG used as OCR input (bounded cost). */
export async function prepareForOcr(buf: Buffer): Promise<Buffer> {
  return sharp(buf, { limitInputPixels: MAX_IMAGE_PIXELS }).rotate().resize(2400, 2400, { fit: 'inside', withoutEnlargement: true }).greyscale().normalize().png().toBuffer();
}
