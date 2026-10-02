/**
 * Safe parsing of public documents (PDF, DOCX, TXT, HTML, CSV).
 * - Content is treated as untrusted data: never executed, never rendered as HTML, never followed as instructions.
 * - Inputs are size-limited; DOCX archives are checked for zip bombs before decompression.
 * - PDF parsing uses pdf.js with eval disabled.
 */
import * as cheerio from 'cheerio';
import Papa from 'papaparse';
import JSZip from 'jszip';
import { createHash } from 'node:crypto';

export type DocumentKind = 'pdf' | 'docx' | 'txt' | 'html' | 'csv';

export const DOCUMENT_MIME: Record<DocumentKind, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  html: 'text/html',
  csv: 'text/csv',
};

export interface ParsedDocument {
  kind: DocumentKind;
  sha256: string;
  title: string | null;
  author: string | null;
  organization: string | null;
  creatorTool: string | null;
  created: string | null;
  modified: string | null;
  pages: number | null;
  language: string | null;
  text: string;
  textTruncated: boolean;
  links: string[];
  metadata: Record<string, unknown>;
  warnings: string[];
}

const MAX_TEXT = 1_500_000;
const MAX_ZIP_UNCOMPRESSED = 80 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 3000;

export class DocumentParseError extends Error {}

/** Detect document kind from magic bytes, falling back to the (untrusted) filename only for text formats. */
export function detectDocumentKind(buf: Buffer, filename: string): DocumentKind | null {
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    return /\.docx$/i.test(filename) || buf.includes(Buffer.from('word/document.xml')) ? 'docx' : null;
  }
  // Text formats must be valid UTF-8 without NUL bytes.
  if (buf.includes(0)) return null;
  const head = buf.subarray(0, 4096).toString('utf8');
  if (/\.html?$/i.test(filename) || /^\s*(<!doctype html|<html)/i.test(head)) return 'html';
  if (/\.csv$/i.test(filename)) return 'csv';
  if (/\.(txt|md|log|text)$/i.test(filename) || /^[\s\S]*$/.test(head)) return 'txt';
  return null;
}

/** Inspect the ZIP central directory to bound decompressed size before any inflation happens. */
export function assertZipSafe(buf: Buffer): void {
  const minEocd = 22;
  const start = Math.max(0, buf.length - 65_557);
  let eocd = -1;
  for (let i = buf.length - minEocd; i >= start; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new DocumentParseError('Malformed ZIP container (no end-of-central-directory record).');
  const entries = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (entries > MAX_ZIP_ENTRIES) throw new DocumentParseError('Archive has too many entries.');
  let p = cdOffset;
  let total = 0;
  for (let i = 0; i < entries; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new DocumentParseError('Malformed ZIP central directory.');
    const compressed = buf.readUInt32LE(p + 20);
    const uncompressed = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    total += uncompressed;
    if (total > MAX_ZIP_UNCOMPRESSED) throw new DocumentParseError('Archive expands beyond the permitted size (possible zip bomb).');
    if (compressed > 0 && uncompressed / compressed > 200) throw new DocumentParseError('Suspicious compression ratio (possible zip bomb).');
    p += 46 + nameLen + extraLen + commentLen;
  }
}

function cap(text: string): { text: string; truncated: boolean } {
  return text.length > MAX_TEXT ? { text: text.slice(0, MAX_TEXT), truncated: true } : { text, truncated: false };
}

function pdfDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = v.match(/^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/);
  if (!m) return null;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00'] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`;
  return Number.isNaN(new Date(iso).getTime()) ? null : iso;
}

async function parsePdf(buf: Buffer): Promise<Omit<ParsedDocument, 'kind' | 'sha256'>> {
  const { getDocumentProxy, extractText, getMeta, extractLinks } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buf), { useSystemFonts: false, stopAtErrors: false, maxImageSize: 1 });
  try {
    const pages = pdf.numPages;
    const warnings: string[] = [];
    if (pages > 500) warnings.push(`Document has ${pages} pages; text extraction limited.`);
    const { text } = await extractText(pdf, { mergePages: true });
    const meta = await getMeta(pdf).catch(() => ({ info: {} as Record<string, unknown>, metadata: null }));
    const info = (meta.info ?? {}) as Record<string, unknown>;
    let links: string[] = [];
    try {
      links = ((await extractLinks(pdf)).links ?? []).slice(0, 500);
    } catch {
      links = [];
    }
    const c = cap(String(text ?? ''));
    return {
      title: typeof info.Title === 'string' && info.Title.trim() ? info.Title.trim() : null,
      author: typeof info.Author === 'string' && info.Author.trim() ? info.Author.trim() : null,
      organization: null,
      creatorTool: [info.Creator, info.Producer].filter((x) => typeof x === 'string' && x).join(' / ') || null,
      created: pdfDate(info.CreationDate),
      modified: pdfDate(info.ModDate),
      pages,
      language: typeof info.Language === 'string' ? info.Language : null,
      text: c.text,
      textTruncated: c.truncated,
      links,
      metadata: Object.fromEntries(Object.entries(info).filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')),
      warnings,
    };
  } finally {
    await pdf.cleanup().catch(() => undefined);
    await (pdf as unknown as { loadingTask?: { destroy?: () => Promise<void> } }).loadingTask?.destroy?.().catch(() => undefined);
  }
}

function xmlTag(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]{0,500})</${tag}>`, 'i'));
  return m?.[1]?.trim() ? m[1].trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : null;
}

async function parseDocx(buf: Buffer): Promise<Omit<ParsedDocument, 'kind' | 'sha256'>> {
  assertZipSafe(buf);
  const zip = await JSZip.loadAsync(buf, { checkCRC32: false });
  const core = (await zip.file('docProps/core.xml')?.async('string')) ?? '';
  const app = (await zip.file('docProps/app.xml')?.async('string')) ?? '';
  const mammoth = await import('mammoth');
  const { value } = await mammoth.extractRawText({ buffer: buf });
  const rels = (await zip.file('word/_rels/document.xml.rels')?.async('string')) ?? '';
  const links = [...rels.matchAll(/Target="(https?:\/\/[^"]+)"[^>]*TargetMode="External"/g)].map((m) => m[1]!).slice(0, 500);
  const c = cap(value);
  return {
    title: xmlTag(core, 'dc:title'),
    author: xmlTag(core, 'dc:creator'),
    organization: xmlTag(app, 'Company'),
    creatorTool: xmlTag(app, 'Application'),
    created: xmlTag(core, 'dcterms:created'),
    modified: xmlTag(core, 'dcterms:modified'),
    pages: Number(xmlTag(app, 'Pages')) || null,
    language: xmlTag(core, 'dc:language'),
    text: c.text,
    textTruncated: c.truncated,
    links,
    metadata: { lastModifiedBy: xmlTag(core, 'cp:lastModifiedBy'), revision: xmlTag(core, 'cp:revision'), template: xmlTag(app, 'Template') },
    warnings: [],
  };
}

function parseHtml(buf: Buffer): Omit<ParsedDocument, 'kind' | 'sha256'> {
  const $ = cheerio.load(buf.toString('utf8'));
  $('script, style, noscript, iframe, object, embed, template').remove();
  const meta = (name: string) => $(`meta[name="${name}"], meta[property="${name}"]`).attr('content')?.trim() || null;
  const links = $('a[href]')
    .toArray()
    .map((a) => $(a).attr('href') ?? '')
    .filter((h) => /^https?:\/\//i.test(h))
    .slice(0, 500);
  const c = cap($('body').text().replace(/\s+/g, ' ').trim());
  return {
    title: $('title').first().text().trim() || meta('og:title'),
    author: meta('author') ?? meta('article:author'),
    organization: meta('og:site_name'),
    creatorTool: meta('generator'),
    created: meta('article:published_time') ?? meta('date'),
    modified: meta('article:modified_time'),
    pages: null,
    language: $('html').attr('lang') ?? null,
    text: c.text,
    textTruncated: c.truncated,
    links,
    metadata: { description: meta('description'), canonical: $('link[rel="canonical"]').attr('href') ?? null },
    warnings: [],
  };
}

function parseCsv(buf: Buffer): Omit<ParsedDocument, 'kind' | 'sha256'> {
  const parsed = Papa.parse<string[]>(buf.toString('utf8'), { preview: 20_000, skipEmptyLines: true });
  const rows = parsed.data;
  const header = rows[0] ?? [];
  const c = cap(rows.map((r) => r.join(' | ')).join('\n'));
  return {
    title: null,
    author: null,
    organization: null,
    creatorTool: null,
    created: null,
    modified: null,
    pages: null,
    language: null,
    text: c.text,
    textTruncated: c.truncated || rows.length >= 20_000,
    links: [],
    metadata: { columns: header.slice(0, 100), rowCount: rows.length, parseErrors: parsed.errors.length },
    warnings: parsed.errors.length ? [`${parsed.errors.length} CSV parse warning(s).`] : [],
  };
}

function parseTxt(buf: Buffer): Omit<ParsedDocument, 'kind' | 'sha256'> {
  const c = cap(buf.toString('utf8'));
  const firstLine = c.text.split('\n').find((l) => l.trim())?.trim().slice(0, 200) ?? null;
  return { title: firstLine, author: null, organization: null, creatorTool: null, created: null, modified: null, pages: null, language: null, text: c.text, textTruncated: c.truncated, links: [], metadata: {}, warnings: [] };
}

export async function parseDocument(buf: Buffer, kind: DocumentKind): Promise<ParsedDocument> {
  const sha256 = createHash('sha256').update(buf).digest('hex');
  let parsed: Omit<ParsedDocument, 'kind' | 'sha256'>;
  try {
    switch (kind) {
      case 'pdf':
        parsed = await parsePdf(buf);
        break;
      case 'docx':
        parsed = await parseDocx(buf);
        break;
      case 'html':
        parsed = parseHtml(buf);
        break;
      case 'csv':
        parsed = parseCsv(buf);
        break;
      default:
        parsed = parseTxt(buf);
    }
  } catch (err) {
    if (err instanceof DocumentParseError) throw err;
    throw new DocumentParseError(`Could not parse ${kind.toUpperCase()}: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown error'}`);
  }
  return { kind, sha256, ...parsed };
}
