import AdmZip from 'adm-zip';
import { createConnection } from 'net';

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

/**
 * Probe the USB web interface by fetching /documents/.
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
  } catch {
    return { available: false, documents: [] };
  }
}

/**
 * Select a document from the HTTP document list.
 * Filters to DocumentType only. Returns undefined if no match.
 */
export function selectDocument(documents: RmApiDocument[], name: string | undefined): RmApiDocument | undefined {
  const docs = documents
    .filter((d) => d.Type === 'DocumentType')
    .sort((a, b) => new Date(b.ModifiedClient).getTime() - new Date(a.ModifiedClient).getTime());

  if (!name) return docs[0];
  const term = name.toLowerCase();
  return docs.find((d) => docName(d).toLowerCase().includes(term));
}

/**
 * Raw TCP HTTP GET that tolerates the reMarkable firmware bug where the
 * server sends both Content-Length and Transfer-Encoding: chunked.
 * Node's http module and fetch both reject this as invalid HTTP/1.1.
 */
function rawHttpGet(host: string, path: string, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port: 80 });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`Timeout: GET ${path}`)); }, timeoutMs);
    const chunks: Buffer[] = [];
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
        if (code !== 200) { socket.destroy(); clearTimeout(timer); reject(new Error(`HTTP ${code}: GET ${path}`)); return; }
        const m = headers.match(/content-length:\s*(\d+)/i);
        if (m) contentLength = parseInt(m[1], 10);
      }
      const body = rawBuf.slice(bodyStart);
      if (contentLength >= 0 && body.length >= contentLength) {
        socket.destroy();
        clearTimeout(timer);
        resolve(body.slice(0, contentLength));
      }
    });

    socket.on('end', () => { clearTimeout(timer); resolve(rawBuf.slice(bodyStart)); });
    socket.on('error', (err) => { clearTimeout(timer); reject(err); });
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
