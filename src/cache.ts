import { access, mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { debug } from './debug.js';

/**
 * Persistent cache for downloaded reMarkable document sources, keyed by docId+mtime.
 *
 * Layout:
 *   <root>/<docId>/<mtime>/source/   ← extracted rmdoc files (.rm, .content, etc.)
 *   <root>/<docId>/<mtime>/.complete  ← sentinel; only present if the cached source was complete
 *
 * "Complete" means every page UUID in .content had a matching .rm file at download time.
 * Partial documents (e.g. user has the doc open and a page hasn't been flushed) are deliberately
 * not marked complete, so the next pull retries the download.
 */

export const CACHE_ROOT = process.env.REMARKABLE_CACHE_DIR ?? join(homedir(), '.cache', 'remarkable-mcp');
const COMPLETE = '.complete';

/** Normalise an mtime to a filesystem-safe directory name. */
export function mtimeKey(mtime: string | number | Date): string {
  if (typeof mtime === 'number') return String(mtime);
  if (mtime instanceof Date) return String(mtime.getTime());
  // ISO strings contain ':' which is fine on Linux but reads better stripped
  return String(mtime).replace(/[^0-9a-zA-Z_-]/g, '');
}

export function docCacheDir(docId: string, mtime: string | number | Date): string {
  return join(CACHE_ROOT, docId, mtimeKey(mtime));
}

export function sourceDir(docId: string, mtime: string | number | Date): string {
  return join(docCacheDir(docId, mtime), 'source');
}

export function ocrDir(docId: string, mtime: string | number | Date): string {
  return join(docCacheDir(docId, mtime), 'ocr');
}

export interface DocMeta {
  id: string;
  name: string;
  folder: string;
  mtimeMs: number;
  /** 1-based page numbers for which we have OCR text on disk. */
  indexedPages: number[];
}

export async function writeDocMeta(docId: string, mtime: string | number | Date, meta: DocMeta): Promise<void> {
  const dir = docCacheDir(docId, mtime);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
}

export async function readDocMeta(docId: string, mtime: string | number | Date): Promise<DocMeta | null> {
  try {
    const raw = await readFile(join(docCacheDir(docId, mtime), 'meta.json'), 'utf8');
    return JSON.parse(raw) as DocMeta;
  } catch { return null; }
}

export async function writePageText(docId: string, mtime: string | number | Date, pageNum: number, text: string): Promise<void> {
  const dir = ocrDir(docId, mtime);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `page-${pageNum}.txt`), text, 'utf8');
}

export async function readPageText(docId: string, mtime: string | number | Date, pageNum: number): Promise<string | null> {
  try {
    return await readFile(join(ocrDir(docId, mtime), `page-${pageNum}.txt`), 'utf8');
  } catch { return null; }
}

/** Iterate every cached document directory: yields { docId, mtimeKey } for each <docId>/<mtime>. */
export async function *iterCachedDocs(): AsyncGenerator<{ docId: string; mtimeKey: string }> {
  let docIds: string[];
  try { docIds = await readdir(CACHE_ROOT); } catch { return; }
  for (const docId of docIds) {
    let mtimes: string[];
    try { mtimes = await readdir(join(CACHE_ROOT, docId)); } catch { continue; }
    for (const mtimeKey of mtimes) yield { docId, mtimeKey };
  }
}

/** True when a complete cached source exists for this docId+mtime. */
export async function hasCompleteCache(docId: string, mtime: string | number | Date): Promise<boolean> {
  try {
    await access(join(docCacheDir(docId, mtime), COMPLETE));
    return true;
  } catch {
    return false;
  }
}

/** Make sure the source directory exists and return its path. */
export async function prepareSourceDir(docId: string, mtime: string | number | Date): Promise<string> {
  const dir = sourceDir(docId, mtime);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Mark a cached source as complete. Call only after all .rm pages were present. */
export async function markComplete(docId: string, mtime: string | number | Date): Promise<void> {
  const dir = docCacheDir(docId, mtime);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, COMPLETE), '');
  debug('cache: marked complete %s/%s', docId, mtimeKey(mtime));
}

/** Delete every <docId>/<mtime> directory other than the one we just wrote. */
export async function sweepStaleMtimes(docId: string, keepMtime: string | number | Date): Promise<void> {
  const docRoot = join(CACHE_ROOT, docId);
  const keep = mtimeKey(keepMtime);
  let entries: string[];
  try {
    entries = await readdir(docRoot);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === keep) continue;
    try {
      await rm(join(docRoot, entry), { recursive: true, force: true });
      debug('cache: swept stale %s/%s', docId, entry);
    } catch (err) {
      debug('cache: sweep failed for %s/%s: %s', docId, entry, (err as Error).message);
    }
  }
}
