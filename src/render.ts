import { readFile, readdir, access, writeFile } from 'fs/promises';
import { join } from 'path';
import { renderToPng } from 'remarkable-rm';

export interface ExportedPage {
  pageNum: number;
  localPath: string;
  format: 'png' | 'thumbnail';
}

export function selectPageIds(content: Record<string, unknown>): string[] {
  const cPages = content.cPages as { pages?: Array<{ id?: string } | string> } | undefined;
  if (cPages?.pages) {
    return cPages.pages.map((p) => (typeof p === 'string' ? p : (p.id ?? '')));
  }
  const pages = content.pages as string[] | undefined;
  if (Array.isArray(pages)) return pages;
  return [];
}

/**
 * Render a single .rm file to PNG using remarkable-rm.
 * Returns false if the file doesn't exist or rendering fails.
 */
async function renderRmFile(rmFile: string, pngPath: string): Promise<boolean> {
  try {
    await access(rmFile);
  } catch {
    return false; // .rm file doesn't exist for this page
  }
  try {
    const rmData = await readFile(rmFile);
    const png = await renderToPng(new Uint8Array(rmData));
    await writeFile(pngPath, Buffer.from(png));
    return true;
  } catch {
    return false;
  }
}

/**
 * Render all pages of a document to PNG.
 * Tries remarkable-rm first; falls back to thumbnail PNGs from thumbDir.
 *
 * @param docDir   Directory where the extracted rmdoc or SSH tar contents live
 * @param docId    Document UUID
 * @param pageIds  Ordered list of page UUIDs from .content
 * @param tempDir  Temp directory to write rendered PNGs into
 * @param thumbDir Optional: directory of pre-rendered thumbnail PNGs (fallback)
 */
export async function renderPages(
  docDir: string,
  docId: string,
  pageIds: string[],
  tempDir: string,
  thumbDir?: string,
  pageNums?: Set<number>,
): Promise<ExportedPage[]> {
  // The rmdoc ZIP may extract to a flat layout or a subdirectory.
  // Try both: docDir/{pageId}.rm and docDir/{docId}/{pageId}.rm
  const subDir = join(docDir, docId);
  const pages: ExportedPage[] = [];

  if (pageIds.length > 0) {
    for (let i = 0; i < pageIds.length; i++) {
      const num = i + 1;
      if (pageNums && !pageNums.has(num)) continue;
      const pngPath = join(tempDir, `page-${num}.png`);
      const flatRm = join(docDir, `${pageIds[i]}.rm`);
      const subRm = join(subDir, `${pageIds[i]}.rm`);

      const ok = await renderRmFile(flatRm, pngPath) || await renderRmFile(subRm, pngPath);
      if (ok) pages.push({ pageNum: num, localPath: pngPath, format: 'png' });
    }
  }

  if (pages.length > 0) return pages;

  // Thumbnail fallback
  const td = thumbDir ?? join(docDir, `${docId}.thumbnails`);
  try {
    const thumbFiles = (await readdir(td)).filter((f) => f.endsWith('.png')).sort();
    for (let i = 0; i < thumbFiles.length; i++) {
      pages.push({ pageNum: i + 1, localPath: join(td, thumbFiles[i]), format: 'thumbnail' });
    }
  } catch {
    // No thumbnails available
  }

  return pages;
}
