import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { analyzeImage, makeThumbnail } from '@/server/analysis/image';
import { hammingDistance, perceptualHash } from '@/server/analysis/phash';
import { parseDocument, detectDocumentKind, assertZipSafe, DocumentParseError } from '@/server/analysis/documents';
import { extractEntities, extractDates } from '@/server/analysis/extract';
import { findPlacesInText, geocodePlace, countryInfo } from '@/server/geo/gazetteer';
import { runOcr } from '@/server/analysis/ocr';
import { makeDocx, makeExifJpeg, makePdf, makeZipBomb } from '../helpers/fixtures';

describe('image analysis', () => {
  it('extracts EXIF camera, capture date and GPS', async () => {
    const a = await analyzeImage(await makeExifJpeg());
    expect(a.camera).toMatchObject({ make: 'FictionalCam', model: 'FC-1000' });
    expect(a.gps?.latitude).toBeCloseTo(38.7223, 3);
    expect(a.gps?.longitude).toBeCloseTo(-9.1393, 3);
    expect(a.dates.original).toBe('2024-03-14T10:30:00.000Z');
    expect(a.width).toBe(1000);
  });
  it('perceptual hash is robust to resizing and distinguishes different images', async () => {
    const img = await makeExifJpeg('Original text sample');
    const resized = await sharp(img).resize(500).jpeg({ quality: 60 }).toBuffer();
    const other = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#224488' } }).composite([{ input: Buffer.from('<svg width="400" height="300"><circle cx="200" cy="150" r="120" fill="white"/></svg>') }]).png().toBuffer();
    const [h1, h2, h3] = await Promise.all([perceptualHash(img), perceptualHash(resized), perceptualHash(other)]);
    expect(hammingDistance(h1, h2)).toBeLessThanOrEqual(10);
    expect(hammingDistance(h1, h3)).toBeGreaterThan(10);
  });
  it('thumbnails strip EXIF/GPS metadata', async () => {
    const thumb = await makeThumbnail(await makeExifJpeg());
    const meta = await sharp(thumb).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.format).toBe('webp');
  });
  it('rejects undecodable data', async () => {
    await expect(analyzeImage(Buffer.from('not an image'))).rejects.toThrow();
  });
  it('OCR recognises text offline', async () => {
    const r = await runOcr(await makeExifJpeg('ATLAS OCR CHECK 2026'), { timeoutMs: 60_000 });
    expect(r.text.toUpperCase()).toContain('ATLAS');
    expect(r.confidence).toBeGreaterThan(50);
  });
});

describe('document parsing', () => {
  it('detects kinds by content', async () => {
    expect(detectDocumentKind(await makePdf(), 'x.bin')).toBe('pdf');
    expect(detectDocumentKind(await makeDocx(), 'memo.docx')).toBe('docx');
    expect(detectDocumentKind(Buffer.from('<html><title>x</title></html>'), 'a.txt')).toBe('html');
    expect(detectDocumentKind(Buffer.from('a,b\n1,2'), 'data.csv')).toBe('csv');
    expect(detectDocumentKind(Buffer.from([0, 1, 2, 3]), 'x.txt')).toBeNull();
  });
  it('parses PDF metadata and text (and treats embedded instructions as plain data)', async () => {
    const d = await parseDocument(await makePdf(), 'pdf');
    expect(d).toMatchObject({ kind: 'pdf', title: 'Northwind Analytics Annual Review (fictional)', author: 'Jane Doe', pages: 1 });
    expect(d.text).toContain('j.doe@example.org');
    expect(d.text).toContain('Ignore previous instructions');
  });
  it('parses DOCX core properties and text', async () => {
    const d = await parseDocument(await makeDocx(), 'docx');
    expect(d).toMatchObject({ title: 'Logistics memo (fictional)', author: 'John Smith', created: '2025-01-02T09:00:00Z' });
    expect(d.text).toContain('Bluefin Logistics');
  });
  it('parses HTML without scripts and CSV', async () => {
    const h = await parseDocument(Buffer.from('<html><head><title>T</title><meta name="author" content="A"><script>alert(1)</script></head><body><p>Hello <a href="https://example.org">x</a></p></body></html>'), 'html');
    expect(h).toMatchObject({ title: 'T', author: 'A' });
    expect(h.text).not.toContain('alert');
    expect(h.links).toEqual(['https://example.org']);
    const c = await parseDocument(Buffer.from('name,email\nJane,j@example.org\n'), 'csv');
    expect(c.metadata.columns).toEqual(['name', 'email']);
  });
  it('rejects zip bombs before decompression', async () => {
    const bomb = await makeZipBomb();
    expect(() => assertZipSafe(bomb)).toThrow(DocumentParseError);
    await expect(parseDocument(bomb, 'docx')).rejects.toThrow(/zip bomb/);
  });
});

describe('entity extraction & gazetteer', () => {
  it('extracts indicators and named entities from text', () => {
    const ex = extractEntities('Jane Doe of Northwind Analytics Ltd emailed j.doe@example.org from 8.8.8.8 about https://example.com/a. Call +44 20 7946 0958. Wallet 1BoatSLRHtKNngkdXEeobR76b53LETtpyT. Office in Lisbon.');
    expect(ex.emails).toEqual(['j.doe@example.org']);
    expect(ex.urls).toEqual(['https://example.com/a']);
    expect(ex.ips).toEqual(['8.8.8.8']);
    expect(ex.phones).toEqual(['+442079460958']);
    expect(ex.crypto[0]?.chain).toBe('bitcoin');
    expect(ex.domains).toEqual(expect.arrayContaining(['example.com', 'example.org']));
    expect(ex.people).toContain('Jane Doe');
  });
  it('extracts dates with honest precision', () => {
    const d = extractDates('Signed 14 March 2024, reviewed March 2025 and on 2023-07-01.');
    expect(d).toEqual(expect.arrayContaining([
      expect.objectContaining({ iso: '2024-03-14T00:00:00.000Z', precision: 'day' }),
      expect.objectContaining({ iso: '2025-03-01T00:00:00.000Z', precision: 'month' }),
      expect.objectContaining({ iso: '2023-07-01T00:00:00.000Z', precision: 'day' }),
    ]));
  });
  it('geocodes at country or city precision and flags ambiguity', () => {
    expect(geocodePlace('Portugal')).toMatchObject({ precision: 'country', countryCode: 'PT' });
    expect(geocodePlace('Lisbon, Portugal')).toMatchObject({ precision: 'city', countryCode: 'PT', ambiguous: false });
    expect(geocodePlace('London')).toMatchObject({ ambiguous: true, countryCode: 'GB' });
    expect(geocodePlace('Atlantis-not-a-place')).toBeNull();
    expect(countryInfo('GB')?.name).toMatch(/United Kingdom/);
    const places = findPlacesInText('Meetings were held in Paris and later in Germany.');
    expect(places.map((p) => p.countryCode).sort()).toEqual(['DE', 'FR']);
  });
});
