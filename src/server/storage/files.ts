import 'server-only';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataDir } from '../config/env';

/**
 * Local filesystem storage for uploaded artifacts and derived thumbnails.
 * Stored paths are generated server-side (UUIDs) — user-supplied filenames never touch the filesystem.
 */
function root(): string {
  return path.join(dataDir(), 'files');
}

function safeResolve(rel: string): string {
  const base = root();
  const full = path.resolve(base, rel);
  if (!full.startsWith(base + path.sep)) throw new Error('Path traversal blocked.');
  return full;
}

const ID_RE = /^[0-9a-f-]{36}$/i;

export async function saveArtifactFile(investigationId: string, data: Buffer, ext: string): Promise<string> {
  if (!ID_RE.test(investigationId)) throw new Error('Invalid investigation id.');
  const safeExt = ext.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase() || 'bin';
  const rel = path.join('uploads', investigationId, `${randomUUID()}.${safeExt}`);
  const full = safeResolve(rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, data, { mode: 0o600 });
  return rel;
}

export async function readArtifactFile(rel: string): Promise<Buffer> {
  return fs.readFile(safeResolve(rel));
}

export async function saveThumbnail(artifactId: string, data: Buffer): Promise<string> {
  if (!ID_RE.test(artifactId)) throw new Error('Invalid artifact id.');
  const rel = path.join('thumbs', `${artifactId}.webp`);
  const full = safeResolve(rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, data, { mode: 0o600 });
  return rel;
}

export async function readThumbnail(artifactId: string): Promise<Buffer | null> {
  if (!ID_RE.test(artifactId)) return null;
  try {
    return await fs.readFile(safeResolve(path.join('thumbs', `${artifactId}.webp`)));
  } catch {
    return null;
  }
}

export async function deleteInvestigationFiles(investigationId: string, artifactIds: string[]): Promise<void> {
  if (!ID_RE.test(investigationId)) return;
  await fs.rm(safeResolve(path.join('uploads', investigationId)), { recursive: true, force: true });
  for (const id of artifactIds) {
    if (ID_RE.test(id)) await fs.rm(safeResolve(path.join('thumbs', `${id}.webp`)), { force: true });
  }
}
