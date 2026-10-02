/**
 * Local analysers for uploaded artifacts (images and documents).
 * Embedded metadata is reported as a SOURCE CLAIM: it is what the file says about itself, which can be edited,
 * stripped or forged — never an independently verified fact.
 */
import type { NormalizedRecord, Provider, ProviderContext, ProviderInput, ProviderResult } from '../types';
import { ProviderError } from '../types';
import { makeRecord, truncate } from '../util';
import { readArtifactFile } from '../../storage/files';
import { analyzeImage, prepareForOcr, makeThumbnail } from '../../analysis/image';
import { hammingDistance } from '../../analysis/phash';
import { runOcr } from '../../analysis/ocr';
import { parseDocument, type DocumentKind } from '../../analysis/documents';
import { extractEntities, type Extracted } from '../../analysis/extract';
import { findPlacesInText, geocodePlace } from '../../geo/gazetteer';
import { saveThumbnail } from '../../storage/files';
import { ocrEnabled } from '../../config/env';

export interface ArtifactParams {
  artifactId: string;
  storedPath: string;
  originalName: string;
  mimeType: string;
  kind: 'image' | 'document';
  otherImages?: Array<{ artifactId: string; name: string; phash: string | null; sha256: string }>;
  targetValues?: string[];
}

export interface ArtifactPatch {
  status?: string;
  phash?: string | null;
  width?: number | null;
  height?: number | null;
  analysis?: Record<string, unknown>;
  error?: string | null;
}

export type ArtifactProviderResult = ProviderResult & { artifactPatch?: ArtifactPatch };

function params(input: ProviderInput): ArtifactParams {
  const p = input.params as unknown as ArtifactParams;
  if (!p?.artifactId || !p.storedPath) throw new ProviderError('invalid_input', 'Artifact reference missing.');
  return p;
}

const artifactValue = (id: string) => `artifact:${id}`;

/** Records for indicators extracted from untrusted text (document body or OCR output). */
function extractionRecords(
  provider: Provider,
  ctx: ProviderContext,
  p: ArtifactParams,
  ex: Extracted,
  text: string,
  origin: 'document text' | 'OCR text',
  entityType: 'document' | 'image',
): NormalizedRecord[] {
  const out: NormalizedRecord[] = [];
  const subject = { ref: 'art', type: entityType, value: artifactValue(p.artifactId), display: p.originalName } as const;
  const targetSet = new Set((p.targetValues ?? []).map((v) => v.toLowerCase()));
  const groups: Array<{ items: string[]; type: 'email' | 'url' | 'domain' | 'ip' | 'phone' | 'person' | 'organization'; label: string; nlp?: boolean }> = [
    { items: ex.emails, type: 'email', label: 'Email address' },
    { items: ex.urls.slice(0, 30), type: 'url', label: 'URL' },
    { items: ex.domains.slice(0, 30), type: 'domain', label: 'Domain' },
    { items: ex.ips, type: 'ip', label: 'IP address' },
    { items: ex.phones, type: 'phone', label: 'Phone number' },
    { items: ex.people.slice(0, 20), type: 'person', label: 'Person name', nlp: true },
    { items: ex.organizations.slice(0, 20), type: 'organization', label: 'Organization name', nlp: true },
  ];
  for (const g of groups) {
    for (const item of g.items) {
      const value = g.nlp ? item.toLowerCase() : item;
      const matchesTarget = targetSet.has(value.toLowerCase());
      out.push(
        makeRecord(provider, ctx, {
          sourceName: `${provider.name} (${origin})`,
          sourceUrl: null,
          title: matchesTarget ? `${p.originalName} mentions investigation target "${item}"` : `${g.label} "${item}" found in ${p.originalName}`,
          description: g.nlp
            ? `Extracted from ${origin} by automated named-entity recognition, which can misclassify text.`
            : `Pattern-matched in ${origin}. Presence in the file does not establish a relationship with the target.`,
          excerpt: item,
          entityType: g.type,
          normalizedValue: value,
          category: entityType === 'image' ? 'image' : 'document',
          claimType: matchesTarget ? 'FACT' : g.nlp ? 'INFERENCE' : 'UNVERIFIED_LEAD',
          confidenceInputs: { sourceReliability: 'unknown', matchType: matchesTarget ? 'exact' : g.nlp ? 'fuzzy' : 'exact', signals: matchesTarget ? ['target_mentioned'] : [] },
          entities: [subject, { ref: 'x', type: g.type, value, display: item }],
          subjectRef: 'x',
          relationships: [{ from: 'art', to: 'x', type: 'MENTIONS', status: g.nlp ? 'possible' : 'confirmed', rationale: `Appears in ${origin}.` }],
          metadata: { artifactId: p.artifactId, origin, extraction: g.nlp ? 'nlp' : 'pattern' },
          fingerprintKey: `extract:${p.artifactId}:${g.type}:${value}`,
        }),
      );
    }
  }
  const places = new Map<string, ReturnType<typeof findPlacesInText>[number]>();
  for (const pl of findPlacesInText(text)) places.set(pl.place, pl);
  for (const name of ex.places) {
    const g = geocodePlace(name, 'Place name extracted by NER and geocoded with the offline gazetteer.');
    if (g && !places.has(g.place)) places.set(g.place, { ...g, mention: name });
  }
  for (const place of [...places.values()].slice(0, 15)) {
    out.push(
      makeRecord(provider, ctx, {
        sourceName: `${provider.name} (${origin})`,
        sourceUrl: null,
        title: `Location "${place.mention}" mentioned in ${p.originalName}`,
        description: `${place.basis} A mention is not evidence that any subject was present there.`,
        excerpt: place.mention,
        entityType: 'location',
        normalizedValue: place.place.toLowerCase(),
        category: 'geolocation',
        claimType: 'INFERENCE',
        confidenceInputs: { sourceReliability: 'unknown', matchType: place.ambiguous ? 'fuzzy' : 'normalized' },
        entities: [subject, { ref: 'loc', type: 'location', value: place.place.toLowerCase(), display: place.place }],
        subjectRef: 'loc',
        relationships: [{ from: 'art', to: 'loc', type: 'MENTIONS', status: 'possible', rationale: `Place name in ${origin}.` }],
        geo: { lat: place.lat, lon: place.lon, precision: place.precision, place: place.place, countryCode: place.countryCode, basis: `Mentioned in ${origin}; ${place.basis}` },
        metadata: { artifactId: p.artifactId, mention: place.mention, ambiguous: place.ambiguous },
        fingerprintKey: `place:${p.artifactId}:${place.place}`,
      }),
    );
  }
  return out;
}

export const imageAnalysisProvider: Provider = {
  id: 'local.image',
  name: 'Image analysis (offline)',
  category: 'image',
  kind: 'local',
  reliability: 'unknown',
  description: 'Safe decoding, EXIF/XMP/IPTC metadata, GPS, perceptual hashing, duplicate detection and OCR for uploaded images.',
  operations: [{ id: 'analyze_image', label: 'Image metadata, hashing & OCR', targetTypes: ['image'], module: 'images', minDepth: 'quick' }],
  config: [],
  timeoutMs: 120_000,
  maxRetries: 0,
  concurrency: 2,
  limitations: [
    'Embedded metadata can be edited, stripped or forged; it is reported as a claim made by the file.',
    'Visual similarity is computed only against images uploaded to the same investigation.',
    'Resemblance never establishes identity of a depicted person.',
  ],
  async run(input, ctx): Promise<ArtifactProviderResult> {
    const p = params(input);
    const buf = await readArtifactFile(p.storedPath);
    let a: Awaited<ReturnType<typeof analyzeImage>>;
    try {
      a = await analyzeImage(buf);
    } catch (err) {
      throw new ProviderError('parse_error', `Image could not be decoded safely: ${(err as Error).message.slice(0, 160)}`);
    }
    try {
      await saveThumbnail(p.artifactId, await makeThumbnail(buf));
    } catch {
      /* thumbnail is optional */
    }
    const records: NormalizedRecord[] = [];
    const subj = { ref: 'img', type: 'image' as const, value: artifactValue(p.artifactId), display: p.originalName };
    const cameraText = [a.camera.make, a.camera.model].filter(Boolean).join(' ');
    records.push(
      makeRecord(this, ctx, {
        sourceName: 'Embedded image metadata',
        sourceUrl: null,
        title: `${p.originalName}: ${a.width}×${a.height} ${a.format?.toUpperCase() ?? ''}${cameraText ? `, camera ${cameraText}` : ''}${a.exifPresent ? '' : ' (no EXIF metadata)'}`,
        description: [
          a.camera.software ? `Software: ${a.camera.software}.` : null,
          a.dates.original ? `Capture time per EXIF: ${a.dates.original} (camera clock; time zone unknown).` : null,
          a.descriptive.artist ? `Artist: ${a.descriptive.artist}.` : null,
          a.descriptive.copyright ? `Copyright: ${a.descriptive.copyright}.` : null,
          !a.exifPresent ? 'Absence of metadata is common for images re-encoded by social platforms.' : null,
        ]
          .filter(Boolean)
          .join(' ') || 'Image decoded successfully.',
        excerpt: JSON.stringify({ format: a.format, width: a.width, height: a.height, camera: a.camera, dates: a.dates, sha256: a.sha256, phash: a.phash }),
        entityType: 'image',
        normalizedValue: subj.value,
        category: 'metadata',
        claimType: 'SOURCE_CLAIM',
        confidenceInputs: { sourceReliability: 'unknown', matchType: 'exact' },
        entities: [subj, ...(a.descriptive.artist ? [{ ref: 'artist', type: 'person' as const, value: a.descriptive.artist.toLowerCase(), display: a.descriptive.artist }] : [])],
        subjectRef: 'img',
        relationships: a.descriptive.artist ? [{ from: 'img', to: 'artist', type: 'ASSOCIATED_WITH', status: 'possible', rationale: 'Artist field in embedded metadata.' }] : [],
        events: a.dates.original ? [{ date: a.dates.original, precision: 'approximate', kind: 'event', label: `${p.originalName} captured (per EXIF; camera clock, time zone unknown)`, entityRef: 'img' }] : [],
        metadata: { artifactId: p.artifactId, ...a, rawExif: undefined, exifFields: Object.keys(a.rawExif).length },
        fingerprintKey: `image-meta:${p.artifactId}`,
        limitations: this.limitations,
        raw: a.rawExif,
      }),
    );
    if (a.gps) {
      records.push(
        makeRecord(this, ctx, {
          sourceName: 'Embedded image metadata (GPS)',
          sourceUrl: `https://www.openstreetmap.org/?mlat=${a.gps.latitude}&mlon=${a.gps.longitude}#map=16/${a.gps.latitude}/${a.gps.longitude}`,
          title: `${p.originalName} contains GPS coordinates ${a.gps.latitude.toFixed(5)}, ${a.gps.longitude.toFixed(5)}`,
          description: 'Coordinates embedded in EXIF by the capturing device or editing software. They can be wrong, edited or spoofed and are not independently verified.',
          excerpt: `GPSLatitude=${a.gps.latitude}; GPSLongitude=${a.gps.longitude}${a.gps.altitude != null ? `; GPSAltitude=${a.gps.altitude}` : ''}`,
          entityType: 'image',
          normalizedValue: subj.value,
          category: 'geolocation',
          claimType: 'SOURCE_CLAIM',
          confidenceInputs: { sourceReliability: 'unknown', matchType: 'exact', signals: ['embedded_gps'] },
          entities: [subj, { ref: 'loc', type: 'location', value: `${a.gps.latitude.toFixed(5)},${a.gps.longitude.toFixed(5)}`, display: `${a.gps.latitude.toFixed(5)}, ${a.gps.longitude.toFixed(5)}` }],
          subjectRef: 'img',
          relationships: [{ from: 'img', to: 'loc', type: 'LOCATED_IN', status: 'possible', rationale: 'Embedded EXIF GPS coordinates.' }],
          geo: { lat: a.gps.latitude, lon: a.gps.longitude, precision: 'exact', place: null, countryCode: null, basis: 'Embedded EXIF GPS coordinates (unverified file metadata).' },
          metadata: { artifactId: p.artifactId, gps: a.gps },
          fingerprintKey: `image-gps:${p.artifactId}`,
          limitations: ['Embedded GPS reflects device/software metadata, not verified location.'],
        }),
      );
    }
    for (const other of p.otherImages ?? []) {
      if (other.artifactId === p.artifactId) continue;
      const identical = other.sha256 === a.sha256;
      const distance = other.phash ? hammingDistance(a.phash, other.phash) : Number.POSITIVE_INFINITY;
      if (!identical && distance > 10) continue;
      records.push(
        makeRecord(this, ctx, {
          sourceName: 'Perceptual-hash comparison (local)',
          sourceUrl: null,
          title: identical ? `${p.originalName} is byte-identical to ${other.name}` : `${p.originalName} is visually near-identical to ${other.name} (pHash distance ${distance}/64)`,
          description: identical
            ? 'Identical SHA-256 digests: the files are the same.'
            : 'Low perceptual-hash distance indicates the same image after resizing, cropping or re-encoding. It does not establish who or what is depicted.',
          excerpt: `sha256 ${a.sha256.slice(0, 16)}… vs ${other.sha256.slice(0, 16)}…; phash ${a.phash} vs ${other.phash ?? '—'}`,
          entityType: 'image',
          normalizedValue: subj.value,
          category: 'image',
          claimType: identical ? 'FACT' : 'INFERENCE',
          confidenceInputs: { sourceReliability: 'authoritative', matchType: identical ? 'exact' : 'fuzzy', signals: ['phash'] },
          entities: [subj, { ref: 'other', type: 'image', value: artifactValue(other.artifactId), display: other.name }],
          subjectRef: 'img',
          relationships: [{ from: 'img', to: 'other', type: 'SIMILAR_TO', status: identical ? 'confirmed' : 'possible', rationale: identical ? 'Identical SHA-256.' : `pHash Hamming distance ${distance}/64.` }],
          metadata: { artifactId: p.artifactId, otherArtifactId: other.artifactId, distance: identical ? 0 : distance, identical },
          fingerprintKey: `image-sim:${[p.artifactId, other.artifactId].sort().join(':')}`,
        }),
      );
    }
    let ocr: { text: string; confidence: number; durationMs: number } | null = null;
    let ocrError: string | null = null;
    if (ocrEnabled() && (a.width ?? 0) * (a.height ?? 0) <= 40_000_000) {
      try {
        ocr = await runOcr(await prepareForOcr(buf), { timeoutMs: 90_000, signal: ctx.signal });
      } catch (err) {
        ocrError = (err as Error).message;
      }
    }
    if (ocr && ocr.text.replace(/\s/g, '').length >= 4) {
      records.push(
        makeRecord(this, ctx, {
          sourceName: 'OCR (tesseract.js, offline)',
          sourceUrl: null,
          title: `Text recognised in ${p.originalName} (${ocr.text.length} characters, OCR confidence ${ocr.confidence}%)`,
          description: truncate(ocr.text, 400),
          excerpt: truncate(ocr.text, 2000),
          entityType: 'image',
          normalizedValue: subj.value,
          category: 'image',
          claimType: 'INFERENCE',
          confidenceInputs: { sourceReliability: ocr.confidence >= 80 ? 'reputable' : 'unknown', matchType: 'fuzzy' },
          entities: [subj],
          subjectRef: 'img',
          metadata: { artifactId: p.artifactId, ocrConfidence: ocr.confidence, ocrDurationMs: ocr.durationMs, text: ocr.text.slice(0, 20000) },
          fingerprintKey: `image-ocr:${p.artifactId}`,
          limitations: ['OCR output can contain recognition errors.'],
        }),
        ...extractionRecords(this, ctx, p, extractEntities(ocr.text), ocr.text, 'OCR text', 'image'),
      );
    }
    return {
      records,
      notes: [ocrError ? `OCR failed: ${ocrError}` : ocr ? `OCR completed in ${ocr.durationMs} ms.` : ocrEnabled() ? 'OCR skipped (image too large).' : 'OCR disabled by configuration.'],
      artifactPatch: {
        status: 'processed',
        phash: a.phash,
        width: a.width,
        height: a.height,
        analysis: {
          format: a.format,
          camera: a.camera,
          dates: a.dates,
          gps: a.gps,
          descriptive: a.descriptive,
          dhash: a.dhash,
          exifPresent: a.exifPresent,
          exif: a.rawExif,
          ocr: ocr ? { text: ocr.text.slice(0, 20000), confidence: ocr.confidence, durationMs: ocr.durationMs } : null,
          ocrError,
        },
        error: null,
      },
    };
  },
};

export const documentAnalysisProvider: Provider = {
  id: 'local.document',
  name: 'Document parser (offline)',
  category: 'documents',
  kind: 'local',
  reliability: 'unknown',
  description: 'Parses PDF, DOCX, TXT, HTML and CSV; extracts metadata, links, emails, phone numbers, names, organisations, places and dates.',
  operations: [{ id: 'analyze_document', label: 'Document parsing & extraction', targetTypes: ['document'], module: 'documents', minDepth: 'quick' }],
  config: [],
  timeoutMs: 120_000,
  maxRetries: 0,
  concurrency: 2,
  limitations: [
    'Document contents are untrusted data; instructions inside documents are never followed.',
    'Named-entity recognition is heuristic and produces false positives.',
  ],
  async run(input, ctx): Promise<ArtifactProviderResult> {
    const p = params(input);
    const buf = await readArtifactFile(p.storedPath);
    const kind = (p.mimeType.includes('pdf') ? 'pdf' : p.mimeType.includes('wordprocessingml') ? 'docx' : p.mimeType.includes('html') ? 'html' : p.mimeType.includes('csv') ? 'csv' : 'txt') as DocumentKind;
    let doc: Awaited<ReturnType<typeof parseDocument>>;
    try {
      doc = await parseDocument(buf, kind);
    } catch (err) {
      throw new ProviderError('parse_error', (err as Error).message);
    }
    const subj = { ref: 'doc', type: 'document' as const, value: artifactValue(p.artifactId), display: doc.title ?? p.originalName };
    const records: NormalizedRecord[] = [];
    records.push(
      makeRecord(this, ctx, {
        sourceName: 'Embedded document metadata',
        sourceUrl: null,
        title: `${p.originalName}: ${kind.toUpperCase()}${doc.pages ? `, ${doc.pages} page(s)` : ''}${doc.title ? ` — "${truncate(doc.title, 80)}"` : ''}`,
        description: [
          doc.author ? `Author (metadata): ${doc.author}.` : 'No author in metadata.',
          doc.organization ? `Organization (metadata): ${doc.organization}.` : null,
          doc.creatorTool ? `Created with: ${doc.creatorTool}.` : null,
          doc.created ? `Created: ${doc.created}.` : null,
          doc.modified ? `Modified: ${doc.modified}.` : null,
          doc.textTruncated ? 'Text truncated for analysis.' : null,
        ]
          .filter(Boolean)
          .join(' '),
        excerpt: truncate(doc.text, 1500),
        entityType: 'document',
        normalizedValue: subj.value,
        publishedAt: doc.created,
        publishedPrecision: doc.created ? 'exact' : null,
        category: 'document',
        claimType: 'SOURCE_CLAIM',
        confidenceInputs: { sourceReliability: 'unknown', matchType: 'exact' },
        entities: [
          subj,
          ...(doc.author ? [{ ref: 'author', type: 'person' as const, value: doc.author.toLowerCase(), display: doc.author }] : []),
          ...(doc.organization ? [{ ref: 'org', type: 'organization' as const, value: doc.organization.toLowerCase(), display: doc.organization }] : []),
        ],
        subjectRef: 'doc',
        relationships: [
          ...(doc.author ? [{ from: 'author', to: 'doc', type: 'ASSOCIATED_WITH' as const, status: 'possible' as const, rationale: 'Author field in document metadata (often a software default or account name).' }] : []),
          ...(doc.organization ? [{ from: 'org', to: 'doc', type: 'ASSOCIATED_WITH' as const, status: 'possible' as const, rationale: 'Company field in document metadata.' }] : []),
        ],
        events: [
          ...(doc.created ? [{ date: doc.created, precision: 'exact' as const, kind: 'source_published' as const, label: `${p.originalName} created (per embedded metadata)`, entityRef: 'doc' }] : []),
          ...(doc.modified && doc.modified !== doc.created ? [{ date: doc.modified, precision: 'exact' as const, kind: 'event' as const, label: `${p.originalName} last modified (per embedded metadata)`, entityRef: 'doc' }] : []),
        ],
        assertions: doc.author ? [{ subjectRef: 'doc', attribute: 'author', value: doc.author }] : [],
        metadata: { artifactId: p.artifactId, kind, title: doc.title, author: doc.author, organization: doc.organization, creatorTool: doc.creatorTool, created: doc.created, modified: doc.modified, pages: doc.pages, language: doc.language, sha256: doc.sha256, links: doc.links.slice(0, 50), textLength: doc.text.length, warnings: doc.warnings, ...doc.metadata },
        fingerprintKey: `doc-meta:${p.artifactId}`,
        limitations: this.limitations,
      }),
    );
    const ex = extractEntities(`${doc.text}\n${doc.links.join('\n')}`);
    records.push(...extractionRecords(this, ctx, p, ex, doc.text, 'document text', 'document'));
    for (const d of ex.dates.slice(0, 15)) {
      records.push(
        makeRecord(this, ctx, {
          sourceName: `${this.name} (document text)`,
          sourceUrl: null,
          title: `Date "${d.text}" mentioned in ${p.originalName}`,
          entityType: 'document',
          normalizedValue: subj.value,
          category: 'document',
          claimType: 'INFERENCE',
          confidenceInputs: { sourceReliability: 'unknown', matchType: 'normalized' },
          entities: [subj],
          subjectRef: 'doc',
          events: [{ date: d.iso, precision: d.precision, kind: 'event', label: `"${d.text}" mentioned in ${p.originalName}`, entityRef: 'doc' }],
          metadata: { artifactId: p.artifactId, dateText: d.text },
          fingerprintKey: `doc-date:${p.artifactId}:${d.iso}:${d.precision}`,
        }),
      );
    }
    return {
      records,
      notes: doc.warnings,
      artifactPatch: {
        status: 'processed',
        analysis: {
          kind,
          title: doc.title,
          author: doc.author,
          organization: doc.organization,
          creatorTool: doc.creatorTool,
          created: doc.created,
          modified: doc.modified,
          pages: doc.pages,
          language: doc.language,
          sha256: doc.sha256,
          textPreview: doc.text.slice(0, 4000),
          textLength: doc.text.length,
          textTruncated: doc.textTruncated,
          links: doc.links.slice(0, 100),
          extracted: { ...ex, dates: ex.dates.map((d) => d.text) },
          warnings: doc.warnings,
        },
        error: null,
      },
    };
  },
};

export const ARTIFACT_PROVIDERS: Provider[] = [imageAnalysisProvider, documentAnalysisProvider];
