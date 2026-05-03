import { mkdtemp, readFile, rm, mkdir, writeFile, stat, copyFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { readConfig } from '../config.js';
import {
  probeUsbHttp,
  fetchAllDocuments,
  fromHttpDoc,
  filterAndSortDocs,
  findByName,
  folderPath,
  downloadRmdoc,
  extractRmdoc,
  downloadThumbnail,
  type FolderEntry,
  type UnifiedDoc,
} from '../connection.js';
import { sshExec, sshPipeTar, resolveTabletMdns, categoriseSshError } from '../ssh.js';
import { renderPages, selectPageIds, mimeForFormat, type RenderOptions } from '../render.js';
import { processPage } from '../ocr.js';
import { parseUnifiedDocs, LIST_CMD, buildSshOpts } from './list.js';
import { getInlineBudgetBytes, isClaudeDesktop } from '../client.js';
import {
  hasCompleteCache,
  prepareSourceDir,
  sourceDir,
  markComplete,
  sweepStaleMtimes,
  writePageText,
  writeDocMeta,
  readDocMeta,
} from '../cache.js';
import { replaceDocPages } from '../search.js';
import { PullArgs } from '../schemas.js';
import { debug } from '../debug.js';

const XOCHITL = '/home/root/.local/share/remarkable/xochitl';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PULL_TOOL: Tool = {
  name: 'remarkable_pull',
  description:
    'Pull a document from the reMarkable tablet and return rendered page images. Connects over USB HTTP ' +
    'when available, otherwise SSH over WiFi (saved IP → mDNS remarkable.local → USB SSH). Source files ' +
    'are cached by document mtime, so repeat pulls of an unchanged document are fast and offline-capable. ' +
    'Pages with no .rm file on disk (likely unflushed because the document is open on the tablet) are ' +
    'reported in the response. When output_dir is provided, rendered images are saved to that local ' +
    'directory in addition to being returned in the response.',
  annotations: {
    title: 'Pull reMarkable document',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: 'object',
    properties: {
      document:   { type: 'string', description: 'Document name substring. Defaults to most recently modified.' },
      folder:     { type: 'string', description: 'Folder name substring to restrict the search. Use when the same document name exists in multiple folders.' },
      page:       { type: 'string', description: 'Page(s) to return: a single number ("3") or inclusive range ("1-4"). Defaults to all pages.' },
      output_dir: { type: 'string', description: 'Local directory to save rendered images into. Created if it does not exist. Files are named "<doc>-page<N>.<ext>".' },
      prompt:     { type: 'string', description: 'Custom transcription instruction. In native OCR mode the prompt is included in the response for the host LLM to use.' },
      max_width:  { type: 'number', description: 'Render width in pixels. Default from config (1024). Lower values reduce response size; native rM2 is 1404.' },
      format:     { type: 'string', enum: ['png', 'jpeg'], description: 'Output format. PNG preserves linework; JPEG is much smaller. Default from config.' },
      inline_images: { type: 'boolean', description: 'If false, return only the saved file paths and skip inline image blocks. Useful for clients with a Read tool (Claude Code, Codex) that can open the saved files on demand, and to bypass the response-size cap entirely. Requires output_dir. Default: true.' },
    },
  },
};

/**
 * Decide how many of the rendered pages can fit inline before exceeding the client's response cap.
 * Always returns at least 1 — a single oversized page is the caller's problem to flag, not silently drop.
 */
export function planInlinePages(sizesBase64: number[], budgetBytes: number): number {
  let running = 0;
  let count = 0;
  for (const s of sizesBase64) {
    if (count > 0 && running + s > budgetBytes) break;
    running += s;
    count++;
  }
  return Math.max(1, count);
}

async function readPageIds(dir: string, docId: string): Promise<string[]> {
  for (const p of [join(dir, `${docId}.content`), join(dir, '.content')]) {
    try {
      const raw = await readFile(p, 'utf8');
      const ids = selectPageIds(JSON.parse(raw) as Record<string, unknown>);
      if (ids.length > 0) return ids;
    } catch { /* try next */ }
  }
  return [];
}

function parsePageRange(pageArg: string | undefined): Set<number> | undefined | { error: string } {
  if (!pageArg) return undefined;
  const range = pageArg.match(/^(\d+)-(\d+)$/);
  if (range) {
    const from = parseInt(range[1], 10);
    const to = parseInt(range[2], 10);
    return new Set(Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i));
  }
  const single = pageArg.match(/^(\d+)$/);
  if (single) return new Set([parseInt(single[1], 10)]);
  return { error: `Invalid page argument "${pageArg}". Use a number ("3") or range ("1-4").` };
}

export async function handlePull(args: Record<string, unknown>): Promise<CallToolResult> {
  const parsed = PullArgs.safeParse(args);
  if (!parsed.success) {
    return { isError: true, content: [{ type: 'text', text: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` }] };
  }
  const a = parsed.data;
  const config = await readConfig();
  const { usbHost, wifiHost } = config.connection;
  const renderOpts: RenderOptions = {
    width: a.max_width ?? config.render.width,
    format: a.format ?? config.render.format,
    jpegQuality: config.render.jpegQuality,
  };

  const tempDir = await mkdtemp(join(tmpdir(), 'remarkable-'));

  try {
    let target: UnifiedDoc | undefined;
    let folderMap: Map<string, FolderEntry> = new Map();
    let pageIds: string[] = [];
    let thumbDir: string | undefined;
    let docDir = '';
    let cacheHit = false;
    let mtimeKey = '';

    // ── USB HTTP path ──────────────────────────────────────────────────────
    const usbResult = await probeUsbHttp();

    if (usbResult.available) {
      const all = (await fetchAllDocuments(usbHost)).map(fromHttpDoc);
      const { docs, folderMap: fm } = filterAndSortDocs(all, a.folder);
      folderMap = fm;
      target = findByName(docs, a.document);

      if (!target) {
        const names = docs.slice(0, 5).map((d) => d.name).join(', ');
        return { isError: true, content: [{ type: 'text', text: `No document matching "${a.document}". Available: ${names}` }] };
      }
      if (!UUID_RE.test(target.id)) {
        return { isError: true, content: [{ type: 'text', text: `Unexpected document ID format: ${target.id}` }] };
      }

      mtimeKey = String(target.modifiedMs || Date.now());

      if (await hasCompleteCache(target.id, mtimeKey)) {
        cacheHit = true;
        docDir = sourceDir(target.id, mtimeKey);
        debug('pull: cache hit %s/%s', target.id, mtimeKey);
        pageIds = await readPageIds(docDir, target.id);
      } else {
        docDir = await prepareSourceDir(target.id, mtimeKey);
        try {
          const rmdocBuffer = await downloadRmdoc(target.id);
          await extractRmdoc(rmdocBuffer, docDir);
          pageIds = await readPageIds(docDir, target.id);
        } catch (err) {
          // rmdoc failed — thumbnail fallback (not cached)
          try {
            const thumb = await downloadThumbnail(target.id);
            const thumbPath = join(tempDir, 'thumbnail.png');
            await writeFile(thumbPath, thumb);
            thumbDir = tempDir;
            docDir = tempDir;
          } catch {
            return { isError: true, content: [{ type: 'text', text: `Failed to download "${target.name}": ${(err as Error).message}` }] };
          }
        }
      }
    } else {
      // ── SSH fallback path ────────────────────────────────────────────────
      // Try saved wifiHost → mDNS (recovers from stale DHCP lease) → USB SSH.
      const mdns = await resolveTabletMdns();
      const hosts = Array.from(new Set([wifiHost, mdns, usbHost].filter((h): h is string => Boolean(h))));
      let raw = '';
      let connectedHost = '';
      const errors: string[] = [];

      for (const host of hosts) {
        const { opts, persistIfNew } = buildSshOpts(config, host);
        try {
          raw = await sshExec(opts, LIST_CMD, 60000);
          await persistIfNew();
          connectedHost = host;
          break;
        } catch (err) {
          errors.push(`${host}: ${categoriseSshError(err as Error)}`);
        }
      }

      if (!connectedHost) {
        return { isError: true, content: [{ type: 'text', text: `Cannot connect to tablet. Tried:\n${errors.map((e) => `  - ${e}`).join('\n')}` }] };
      }

      const all = parseUnifiedDocs(raw);
      const { docs, folderMap: fm } = filterAndSortDocs(all, a.folder);
      folderMap = fm;
      if (docs.length === 0) return { content: [{ type: 'text', text: 'No documents found on the tablet.' }] };
      target = findByName(docs, a.document);

      if (!target) {
        const names = docs.slice(0, 5).map((d) => d.name).join(', ');
        return { isError: true, content: [{ type: 'text', text: `No document matching "${a.document}". Available: ${names}` }] };
      }
      if (!UUID_RE.test(target.id)) {
        return { isError: true, content: [{ type: 'text', text: `Unexpected document ID format: ${target.id}` }] };
      }
      const safeId = target.id;
      mtimeKey = String(target.modifiedMs || Date.now());

      if (await hasCompleteCache(safeId, mtimeKey)) {
        cacheHit = true;
        docDir = sourceDir(safeId, mtimeKey);
        debug('pull: cache hit %s/%s (ssh)', safeId, mtimeKey);
        pageIds = await readPageIds(docDir, safeId);
      } else {
        docDir = await prepareSourceDir(safeId, mtimeKey);
        const tarCmd = `cd ${XOCHITL} && tar cf - ${safeId}.* ${safeId}/ 2>/dev/null`;
        const { opts } = buildSshOpts(config, connectedHost);
        await sshPipeTar(opts, tarCmd, docDir);
        pageIds = await readPageIds(docDir, safeId);
      }
    }

    // ── Page range parsing ─────────────────────────────────────────────────
    const rangeParsed = parsePageRange(a.page);
    if (rangeParsed && 'error' in rangeParsed) {
      return { isError: true, content: [{ type: 'text', text: rangeParsed.error }] };
    }
    const pageNums = rangeParsed as Set<number> | undefined;

    // ── Render ─────────────────────────────────────────────────────────────
    const { rendered, missing } = await renderPages(docDir, target.id, pageIds, tempDir, thumbDir, pageNums, renderOpts);

    // Cache management: mark complete only when no pages were missing AND we just downloaded.
    if (!cacheHit && !thumbDir && pageIds.length > 0 && missing.length === 0) {
      await markComplete(target.id, mtimeKey);
      await sweepStaleMtimes(target.id, mtimeKey);
    }

    if (rendered.length === 0) {
      if (pageNums) {
        return { isError: true, content: [{ type: 'text', text: `Page(s) "${a.page}" not found or not renderable. Document has ${pageIds.length} page(s).` }] };
      }
      return { isError: true, content: [{ type: 'text', text: `No renderable pages for "${target.name}". Open the document on the tablet at least once.` }] };
    }

    // ── Plan inline payload ────────────────────────────────────────────────
    // When inline_images is explicitly false, skip the inline path entirely: every page is "dropped"
    // and saved only to output_dir. This sidesteps the response-size cap for clients that prefer to
    // open the saved files via their own Read tool (Claude Code, Codex).
    const inlineMode = a.inline_images !== false;
    const pageSizes = inlineMode
      ? await Promise.all(rendered.map(async (p) => Math.ceil(((await stat(p.localPath)).size * 4) / 3)))
      : rendered.map(() => 0);
    const totalBase64 = pageSizes.reduce((a, b) => a + b, 0);
    const budget = getInlineBudgetBytes();
    const inlineCount = inlineMode ? planInlinePages(pageSizes, budget) : 0;
    const inlinePages = rendered.slice(0, inlineCount);
    const droppedPages = rendered.slice(inlineCount);

    // ── OCR + assemble ─────────────────────────────────────────────────────
    const content: CallToolResult['content'] = [];
    const fmtMb = (n: number) => `${(n / 1_000_000).toFixed(2)} MB`;

    const sizeNote = inlineMode ? `, ~${fmtMb(totalBase64)} total inline` : '';
    const header = [`Document: ${target.name} — ${rendered.length} page(s) rendered as ${renderOpts.format} @ ${renderOpts.width}px${sizeNote}.`];
    if (!inlineMode) header.push('Inline images disabled — pages are saved to disk only; open them with your file-reading tool.');
    if (cacheHit) header.push('(served from cache)');
    if (config.ocr.provider === 'native' && a.prompt) header.push(`Transcription instruction: ${a.prompt}`);
    if (a.output_dir) header.push(`Saving pages to: ${a.output_dir}`);

    if (missing.length > 0) {
      const list = missing.length <= 8 ? missing.join(', ') : `${missing.slice(0, 8).join(', ')}, …`;
      header.push(
        `⚠ Page(s) ${list} had no saved data on the tablet — likely unflushed.`,
        'Close the document or change pages on the tablet to save them, then call remarkable_pull again.',
      );
    }

    // The "trimmed for response size" warning only applies when inlining was actually attempted.
    // In inline_images=false mode, every page is dropped from inline by design — no warning needed.
    if (inlineMode && droppedPages.length > 0) {
      const firstDropped = droppedPages[0].pageNum;
      const lastDropped = droppedPages[droppedPages.length - 1].pageNum;
      const range = firstDropped === lastDropped ? `${firstDropped}` : `${firstDropped}-${lastDropped}`;
      const clientHint = isClaudeDesktop()
        ? 'Claude Desktop limits tool responses to ~1 MB'
        : `client cap is ${fmtMb(budget)}`;
      header.push(
        `⚠ Inlining pages ${inlinePages[0].pageNum}–${inlinePages[inlinePages.length - 1].pageNum} only — ${clientHint}.`,
        `Call remarkable_pull again with page="${range}" to fetch the rest, set max_width smaller (e.g. 800), use format="jpeg", or set inline_images=false with output_dir to bypass the cap entirely.`,
      );
    }
    content.push({ type: 'text', text: header.join('\n') });

    if (a.output_dir) await mkdir(a.output_dir, { recursive: true });
    const safeName = target.name.replace(/[^a-zA-Z0-9_\- ]/g, '_');
    const savedPaths: string[] = [];
    const ext = renderOpts.format === 'jpeg' ? 'jpg' : 'png';

    // Collect every page for which we generated OCR text, so we can persist it to the cache and
    // update the search index once at the end. Native mode produces empty text — those pages are
    // skipped at index-write time (search.ts filters empty text) but still get a result entry.
    const pageTexts: Array<{ pageNum: number; text: string }> = [];

    // Inline pages: OCR + image block + optional save.
    for (const page of inlinePages) {
      const result = await processPage(page, config.ocr, a.prompt);
      pageTexts.push({ pageNum: result.pageNum, text: result.text });
      if (rendered.length > 1) content.push({ type: 'text', text: `--- Page ${result.pageNum} ---` });
      if (result.text) content.push({ type: 'text', text: result.text });
      content.push({ type: 'image', data: result.imageBase64, mimeType: mimeForFormat(page.format) });

      if (a.output_dir) {
        const dest = join(a.output_dir, `${safeName}-page${result.pageNum}.${ext}`);
        await writeFile(dest, Buffer.from(result.imageBase64, 'base64'));
        savedPaths.push(dest);
      }
    }

    // Dropped pages: save to disk and (in path-only mode) emit OCR text without an image block.
    // OCR is skipped in native mode because the host LLM was supposed to read the image — there's
    // nothing useful to add. For ollama/local providers we run OCR so the agent gets the text.
    for (const page of droppedPages) {
      let dest: string | undefined;
      if (a.output_dir) {
        dest = join(a.output_dir, `${safeName}-page${page.pageNum}.${ext}`);
        await copyFile(page.localPath, dest);
        savedPaths.push(dest);
      }
      if (!inlineMode && config.ocr.provider !== 'native') {
        const result = await processPage(page, config.ocr, a.prompt);
        pageTexts.push({ pageNum: result.pageNum, text: result.text });
        if (rendered.length > 1) content.push({ type: 'text', text: `--- Page ${result.pageNum} ---` });
        if (result.text) content.push({ type: 'text', text: result.text });
      }
    }

    // ── Persist OCR text + update the search index ─────────────────────────
    // Skip when no OCR ran (native mode produces empty text for every page) — there's nothing to
    // index. The doc still appears in remarkable_list; only content search is degraded.
    const withText = pageTexts.filter((p) => p.text.trim().length > 0);
    if (withText.length > 0) {
      const targetFolder = folderPath(target.parent, folderMap);
      try {
        for (const p of withText) await writePageText(target.id, mtimeKey, p.pageNum, p.text);
        const oldMeta = await readDocMeta(target.id, mtimeKey);
        const oldPageNums = oldMeta?.indexedPages ?? [];
        await replaceDocPages(target.id, target.name, targetFolder, oldPageNums, withText);
        await writeDocMeta(target.id, mtimeKey, {
          id: target.id,
          name: target.name,
          folder: targetFolder,
          mtimeMs: target.modifiedMs,
          indexedPages: withText.map((p) => p.pageNum),
        });
      } catch (err) {
        debug('search: failed to update index for %s: %s', target.id, (err as Error).message);
      }
    }

    if (savedPaths.length > 0) {
      content.push({ type: 'text', text: `Saved:\n${savedPaths.join('\n')}` });
    }

    // In native OCR mode the host LLM reads the images directly and the server has no way to
    // capture the resulting text. Tell the agent how to feed it back into the search index so
    // future remarkable_search calls can find this document.
    if (config.ocr.provider === 'native' && rendered.length > 0 && inlineMode) {
      content.push({
        type: 'text',
        text:
          `To make this document searchable, after transcribing the page images call ` +
          `remarkable_save_transcription with doc_id="${target.id}" and ` +
          `pages=[{pageNum, text}, …]. Skip if the pages had no meaningful text.`,
      });
    }

    return { content };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
