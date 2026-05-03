import AdmZip from 'adm-zip';
import { createConnection } from 'net';
import { debug } from './debug.js';

export const USB_IP = '10.11.99.1';
export const USB_HTTP_TIMEOUT_MS = 2000;

export interface RmApiDocument {
  ID: string;
  VissibleName: string; // API has this typo
  Type: string;
  ModifiedClient: string;
  Parent: string;
}

export interface UsbHttpResult {
  available: boolean;
  documents: RmApiDocument[];
}

/** Returns the display name, tolerating the API's VissibleName typo. */
export function docName(doc: RmApiDocument): string {
  return (doc.VissibleName ?? '').trim();
}

export interface FolderEntry { name: string; parent: string; }

/** Unified document shape used by the rest of the app. */
export interface UnifiedDoc {
  id: string;
  name: string;
  modifiedMs: number;
  parent: string;
  isFolder: boolean;
}

export function fromHttpDoc(d: RmApiDocument): UnifiedDoc {
  return {
    id: d.ID,
    name: docName(d),
    modifiedMs: new Date(d.ModifiedClient).getTime() || 0,
    parent: d.Parent ?? '',
    isFolder: d.Type === 'CollectionType',
  };
}

/** Build a map of folder UUID → { name, parent } from a unified documents list. */
export function buildFolderMap(documents: UnifiedDoc[]): Map<string, FolderEntry> {
  const map = new Map<string, FolderEntry>();
  for (const d of documents) {
    if (d.isFolder) map.set(d.id, { name: d.name, parent: d.parent });
  }
  return map;
}

/** Resolve the full folder path for a document (e.g. "Work / Meeting Notes"). */
export function folderPath(parentId: string, folderMap: Map<string, FolderEntry>): string {
  const parts: string[] = [];
  let id = parentId;
  const visited = new Set<string>();
  while (id && !visited.has(id)) {
    visited.add(id);
    const entry = folderMap.get(id);
    if (!entry) break;
    parts.unshift(entry.name);
    id = entry.parent;
  }
  return parts.join(' / ');
}

/**
 * Filter to non-folder documents, sort newest-first, optionally restrict by folder name substring.
 * Single source of truth for both USB and SSH list/pull paths.
 */
export function filterAndSortDocs(
  docs: UnifiedDoc[],
  folder: string | undefined,
): { docs: UnifiedDoc[]; folderMap: Map<string, FolderEntry> } {
  const folderMap = buildFolderMap(docs);
  let result = docs.filter((d) => !d.isFolder).sort((a, b) => b.modifiedMs - a.modifiedMs);
  if (folder) {
    const f = folder.toLowerCase();
    result = result.filter((d) => folderPath(d.parent, folderMap).toLowerCase().includes(f));
  }
  return { docs: result, folderMap };
}

/** Find the first document whose name contains the given substring (case-insensitive). */
export function findByName(docs: UnifiedDoc[], name: string | undefined): UnifiedDoc | undefined {
  if (!name) return docs[0];
  const term = name.toLowerCase();
  return docs.find((d) => d.name.toLowerCase().includes(term));
}

async function fetchFolder(host: string, folderId: string, timeoutMs: number): Promise<RmApiDocument[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = folderId ? `http://${host}/documents/${folderId}` : `http://${host}/documents/`;
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return [];
    const items = (await response.json()) as RmApiDocument[];
    return Array.isArray(items) ? items : [];
  } catch (err) {
    clearTimeout(timer);
    debug('fetchFolder failed for %s: %s', folderId || '<root>', (err as Error).message);
    return [];
  }
}

/**
 * Probe the USB web interface by fetching /documents/ (root only, fast).
 * Returns available:false on any error or timeout.
 */
export async function probeUsbHttp(host = USB_IP, timeoutMs = USB_HTTP_TIMEOUT_MS): Promise<UsbHttpResult> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`http://${host}/documents/`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return { available: false, documents: [] };
    const documents = (await response.json()) as RmApiDocument[];
    return { available: true, documents: Array.isArray(documents) ? documents : [] };
  } catch (err) {
    debug('probeUsbHttp failed: %s', (err as Error).message);
    return { available: false, documents: [] };
  }
}

/**
 * Fetch every document on the tablet by recursing all CollectionType folders.
 * Returns a flat list of all RmApiDocument entries (documents and folders).
 */
export async function fetchAllDocuments(host = USB_IP, perFolderTimeoutMs = 5000): Promise<RmApiDocument[]> {
  const all: RmApiDocument[] = [];
  const queue: string[] = [''];  // '' = root
  const visited = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const items = await fetchFolder(host, id, perFolderTimeoutMs);
    for (const item of items) {
      all.push(item);
      if (item.Type === 'CollectionType' && !visited.has(item.ID)) queue.push(item.ID);
    }
  }
  return all;
}

/**
 * Select a document from the HTTP document list.
 * Filters to DocumentType only. Returns undefined if no match.
 * (Wrapper around the unified helpers, kept for compatibility.)
 */
export function selectDocument(
  documents: RmApiDocument[],
  name: string | undefined,
  folder: string | undefined = undefined,
): RmApiDocument | undefined {
  const unified = documents.map(fromHttpDoc);
  const { docs } = filterAndSortDocs(unified, folder);
  const hit = findByName(docs, name);
  return hit ? documents.find((d) => d.ID === hit.id) : undefined;
}

/**
 * Raw TCP HTTP GET that tolerates the reMarkable firmware bug where the
 * server sends both Content-Length and Transfer-Encoding: chunked.
 * Node's http module and fetch both reject this as invalid HTTP/1.1.
 */
function rawHttpGet(host: string, path: string, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port: 80 });
    let settled = false;
    const finish = (action: () => void) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); action(); };
    const timer = setTimeout(() => finish(() => reject(new Error(`Timeout: GET ${path}`))), timeoutMs);
    let headersDone = false;
    let contentLength = -1;
    let bodyStart = 0;
    let rawBuf = Buffer.alloc(0);

    socket.on('connect', () => {
      socket.write(`GET ${path} HTTP/1.0\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });

    socket.on('data', (chunk: Buffer) => {
      rawBuf = Buffer.concat([rawBuf, chunk]);
      if (!headersDone) {
        const sep = rawBuf.indexOf('\r\n\r\n');
        if (sep === -1) return;
        headersDone = true;
        bodyStart = sep + 4;
        const headers = rawBuf.slice(0, sep).toString();
        const statusLine = headers.split('\r\n')[0];
        const code = parseInt(statusLine.split(' ')[1] ?? '0', 10);
        if (code !== 200) { finish(() => reject(new Error(`HTTP ${code}: GET ${path}`))); return; }
        const m = headers.match(/content-length:\s*(\d+)/i);
        if (m) contentLength = parseInt(m[1], 10);
      }
      const body = rawBuf.slice(bodyStart);
      if (contentLength >= 0 && body.length >= contentLength) {
        finish(() => resolve(body.slice(0, contentLength)));
      }
    });

    socket.on('end', () => {
      const body = rawBuf.slice(bodyStart);
      // If we never got a Content-Length the server signalled end-of-body via close (HTTP/1.0 style) — accept.
      // If we did get one and the body is short, the connection was truncated — reject.
      if (contentLength >= 0 && body.length < contentLength) {
        finish(() => reject(new Error(`Truncated: GET ${path} got ${body.length} of ${contentLength} bytes`)));
      } else {
        finish(() => resolve(body));
      }
    });

    socket.on('error', (err) => finish(() => reject(err)));
  });
}

/**
 * Download a document as an rmdoc archive (ZIP of .rm files).
 * Requires firmware 3.9+.
 */
export async function downloadRmdoc(docId: string, host = USB_IP): Promise<Buffer> {
  return rawHttpGet(host, `/download/${docId}/rmdoc`, 120000);
}

/**
 * Download the tablet-generated thumbnail for a document.
 * Used as a last-resort fallback when rmdoc rendering fails.
 */
export async function downloadThumbnail(docId: string, host = USB_IP): Promise<Buffer> {
  return rawHttpGet(host, `/thumbnail/${docId}`, 15000);
}

/**
 * Extract an rmdoc ZIP buffer into destDir.
 * After extraction, destDir will contain the raw notebook files (.rm, .content, etc.).
 */
export async function extractRmdoc(buffer: Buffer, destDir: string): Promise<void> {
  const zip = new AdmZip(buffer);
  zip.extractAllTo(destDir, /* overwrite */ true);
}
