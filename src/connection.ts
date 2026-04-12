import AdmZip from 'adm-zip';

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
 * Download a document as an rmdoc archive (ZIP of .rm files).
 * Requires firmware 3.9+.
 */
export async function downloadRmdoc(docId: string, host = USB_IP): Promise<Buffer> {
  const response = await fetch(`http://${host}/download/${docId}/rmdoc`, {
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`rmdoc download failed: ${response.status} ${response.statusText}`);
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Download the tablet-generated thumbnail for a document.
 * Used as a last-resort fallback when rmdoc rendering fails.
 */
export async function downloadThumbnail(docId: string, host = USB_IP): Promise<Buffer> {
  const response = await fetch(`http://${host}/thumbnail/${docId}`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Thumbnail download failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Extract an rmdoc ZIP buffer into destDir.
 * After extraction, destDir will contain the raw notebook files (.rm, .content, etc.).
 */
export async function extractRmdoc(buffer: Buffer, destDir: string): Promise<void> {
  const zip = new AdmZip(buffer);
  zip.extractAllTo(destDir, /* overwrite */ true);
}
