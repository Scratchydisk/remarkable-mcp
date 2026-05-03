import { readFile, readdir, access, writeFile } from 'fs/promises';
import { join } from 'path';
import { renderToPng, renderToJpeg } from 'remarkable-rm';
import { debug } from './debug.js';

export type RenderFormat = 'png' | 'jpeg';

export interface ExportedPage {
  pageNum: number;
  localPath: string;
  format: 'png' | 'jpeg' | 'thumbnail';
}

export interface RenderOptions {
  /** Output pixel width. Native rM2 is 1404. Smaller = smaller payload. */
  width?: number;
  /** Output format. PNG preserves linework; JPEG is much smaller for OCR-grade pulls. */
  format?: RenderFormat;
  /** JPEG quality 1-100. Ignored for PNG. */
  jpegQuality?: number;
}

export interface RenderResult {
  rendered: ExportedPage[];
  /** 1-based page numbers whose .rm source file was missing on the tablet (likely unflushed). */
  missing: number[];
}

export function selectPageIds(content: Record<string, unknown>): string[] {
  const cPages = content.cPages as { pages?: Array<{ id?: string } | string> } | undefined;
  if (cPages?.pages) {
    return cPages.pages.map((p) => (typeof p === 'string' ? p : (p.id ?? ''))).filter(Boolean);
  }
  const pages = content.pages as string[] | undefined;
  if (Array.isArray(pages)) return pages.filter(Boolean);
  return [];
}

const PNG_MIME = 'image/png';
const JPEG_MIME = 'image/jpeg';

export function mimeForFormat(format: 'png' | 'jpeg' | 'thumbnail'): string {
  if (format === 'jpeg') return JPEG_MIME;
  return PNG_MIME;
}

function extForFormat(format: RenderFormat): string {
  return format === 'jpeg' ? 'jpg' : 'png';
}

/**
 * Render a single .rm file to PNG or JPEG using remarkable-rm.
 * Returns false if the file doesn't exist (page not yet flushed) or rendering fails.
 */
async function renderRmFile(rmFile: string, outPath: string, opts: Required<RenderOptions>): Promise<boolean> {
  try {
    await access(rmFile);
  } catch {
    return false; // .rm file doesn't exist for this page (likely unflushed)
  }
  try {
    const rmData = await readFile(rmFile);
    const bytes = await (opts.format === 'jpeg'
      ? renderToJpeg(new Uint8Array(rmData), { width: opts.width, quality: opts.jpegQuality })
      : renderToPng(new Uint8Array(rmData), { width: opts.width }));
    await writeFile(outPath, Buffer.from(bytes));
    return true;
  } catch (err) {
    // Surface real render failures via DEBUG=remarkable-mcp — silent failure here turned a missing
    // peer dep ("sharp" for JPEG) into a confusing "page not renderable" message.
    debug('renderRmFile failed (%s, %s): %s', rmFile, opts.format, (err as Error).message);
    return false;
  }
}

const DEFAULTS: Required<RenderOptions> = { width: 1024, format: 'png', jpegQuality: 80 };

/**
 * Render all pages of a document. Tries remarkable-rm first; falls back to thumbnail PNGs from thumbDir.
 * Returns rendered pages along with the list of page numbers whose .rm source was missing.
 *
 * @param docDir   Directory where the extracted rmdoc or SSH tar contents live
 * @param docId    Document UUID
 * @param pageIds  Ordered list of page UUIDs from .content
 * @param tempDir  Temp directory to write rendered images into
 * @param thumbDir Optional: directory of pre-rendered thumbnail PNGs (fallback)
 * @param pageNums Optional: restrict to these 1-based page numbers
 * @param options  Render options (width, format, jpegQuality)
 */
export async function renderPages(
  docDir: string,
  docId: string,
  pageIds: string[],
  tempDir: string,
  thumbDir?: string,
  pageNums?: Set<number>,
  options: RenderOptions = {},
): Promise<RenderResult> {
  const opts: Required<RenderOptions> = { ...DEFAULTS, ...options };
  const subDir = join(docDir, docId);
  const rendered: ExportedPage[] = [];
  const missing: number[] = [];
  const ext = extForFormat(opts.format);

  if (pageIds.length > 0) {
    for (let i = 0; i < pageIds.length; i++) {
      const num = i + 1;
      if (pageNums && !pageNums.has(num)) continue;
      const outPath = join(tempDir, `page-${num}.${ext}`);
      const flatRm = join(docDir, `${pageIds[i]}.rm`);
      const subRm = join(subDir, `${pageIds[i]}.rm`);

      const ok = await renderRmFile(flatRm, outPath, opts) || await renderRmFile(subRm, outPath, opts);
      if (ok) rendered.push({ pageNum: num, localPath: outPath, format: opts.format });
      else missing.push(num);
    }
  }

  if (rendered.length > 0) return { rendered, missing };

  // Thumbnail fallback (only when no .rm pages rendered at all)
  const td = thumbDir ?? join(docDir, `${docId}.thumbnails`);
  try {
    const thumbFiles = (await readdir(td)).filter((f) => f.endsWith('.png')).sort();
    for (let i = 0; i < thumbFiles.length; i++) {
      rendered.push({ pageNum: i + 1, localPath: join(td, thumbFiles[i]), format: 'thumbnail' });
    }
  } catch {
    // No thumbnails available
  }

  return { rendered, missing };
}
