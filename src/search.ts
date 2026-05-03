import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import MiniSearch from 'minisearch';
import { CACHE_ROOT } from './cache.js';
import { debug } from './debug.js';

/**
 * Persistent BM25 search index over the OCR'd contents of cached reMarkable documents.
 *
 * Indexed unit: a single page. Doc id is `<docId>#<pageNum>` so we can replace per-page entries
 * cheaply. The authoritative "what pages do we have" is the per-document meta.json sitting in the
 * cache directory — search.ts never has to enumerate the index to find stale entries.
 *
 * Storage: a single JSON file at <CACHE_ROOT>/index.json. Loaded lazily and rewritten after each
 * batch of edits. The OCR text itself lives next to the rendered pages in
 * <CACHE_ROOT>/<docId>/<mtime>/ocr/.
 */

export const INDEX_PATH = join(CACHE_ROOT, 'index.json');

export interface IndexedPage {
  /** `<docId>#<pageNum>` */
  id: string;
  docId: string;
  name: string;
  folder: string;
  pageNum: number;
  /** Concatenated OCR text for the page. Empty pages are skipped at index time. */
  text: string;
}

export interface SearchHit {
  docId: string;
  name: string;
  folder: string;
  pageNum: number;
  score: number;
  snippet: string;
}

const SEARCH_OPTIONS = {
  fields: ['name', 'folder', 'text'],
  storeFields: ['docId', 'name', 'folder', 'pageNum', 'text'],
  searchOptions: {
    boost: { name: 3, folder: 1.5, text: 1 },
    prefix: true,
    fuzzy: 0.15,
  },
};

let cached: MiniSearch<IndexedPage> | null = null;

async function load(): Promise<MiniSearch<IndexedPage>> {
  if (cached) return cached;
  try {
    const raw = await readFile(INDEX_PATH, 'utf8');
    cached = MiniSearch.loadJSON<IndexedPage>(raw, SEARCH_OPTIONS);
    debug('search: loaded index with %d pages', cached.documentCount);
  } catch {
    cached = new MiniSearch<IndexedPage>(SEARCH_OPTIONS);
    debug('search: created new index');
  }
  return cached;
}

async function save(idx: MiniSearch<IndexedPage>): Promise<void> {
  await mkdir(CACHE_ROOT, { recursive: true });
  await writeFile(INDEX_PATH, JSON.stringify(idx), 'utf8');
}

/**
 * Replace the entries for the given docId with the supplied pages.
 * Caller passes the previously-indexed page numbers (from meta.json) so we can drop stale entries
 * without enumerating the index.
 */
export async function replaceDocPages(
  docId: string,
  name: string,
  folder: string,
  oldPageNums: number[],
  newPages: Array<{ pageNum: number; text: string }>,
): Promise<void> {
  const idx = await load();
  const oldIds = oldPageNums.map((n) => `${docId}#${n}`).filter((id) => idx.has(id));
  if (oldIds.length > 0) idx.discardAll(oldIds);
  const docs: IndexedPage[] = newPages
    .filter((p) => p.text.trim().length > 0)
    .map((p) => ({ id: `${docId}#${p.pageNum}`, docId, name, folder, pageNum: p.pageNum, text: p.text }));
  if (docs.length > 0) idx.addAll(docs);
  await save(idx);
  debug('search: replaced %s — removed %d, added %d (total now %d)', docId, oldIds.length, docs.length, idx.documentCount);
}

/** Remove every entry for a docId. Caller supplies the page numbers (typically from meta.json). */
export async function removeDocPages(docId: string, pageNums: number[]): Promise<void> {
  const idx = await load();
  const ids = pageNums.map((n) => `${docId}#${n}`).filter((id) => idx.has(id));
  if (ids.length === 0) return;
  idx.discardAll(ids);
  await save(idx);
  debug('search: removed %s (%d pages)', docId, ids.length);
}

export interface SearchOptions {
  limit?: number;
  /** Restrict to documents whose folder path contains this substring (case-insensitive). */
  folder?: string;
}

function makeSnippet(text: string, query: string, terms: string[]): string {
  if (!text) return '';
  const lower = text.toLowerCase();
  let pos = -1;
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase());
    if (i !== -1 && (pos === -1 || i < pos)) pos = i;
  }
  if (pos === -1) pos = lower.indexOf(query.toLowerCase());
  if (pos === -1) pos = 0;

  const radius = 60;
  const start = Math.max(0, pos - radius);
  const end = Math.min(text.length, pos + radius);
  const lead = start > 0 ? '…' : '';
  const trail = end < text.length ? '…' : '';
  return `${lead}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${trail}`;
}

export async function searchPages(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
  const idx = await load();
  const folderFilter = opts.folder?.toLowerCase();
  const limit = Math.max(1, Math.min(100, opts.limit ?? 20));

  const results = idx.search(query, {
    filter: folderFilter
      ? (r) => typeof r.folder === 'string' && r.folder.toLowerCase().includes(folderFilter)
      : undefined,
  });

  return results.slice(0, limit).map((r) => ({
    docId: r.docId as string,
    name: r.name as string,
    folder: r.folder as string,
    pageNum: r.pageNum as number,
    score: r.score,
    snippet: makeSnippet(r.text as string, query, r.terms ?? []),
  }));
}

export async function indexSize(): Promise<number> {
  const idx = await load();
  return idx.documentCount;
}

/** For tests: drop the in-memory cache so the next call re-reads from disk. */
export function _resetForTests(): void {
  cached = null;
}
