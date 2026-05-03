import { mkdtemp, readFile, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { readConfig } from '../config.js';
import { probeUsbHttp, selectDocument, downloadRmdoc, extractRmdoc, downloadThumbnail, docName } from '../connection.js';
import { sshExec, sshPipeTar } from '../ssh.js';
import type { SSHOptions } from '../ssh.js';
import { renderPages, selectPageIds } from '../render.js';
import { processPage } from '../ocr.js';
import { parseDocuments, LIST_CMD } from './list.js';

const XOCHITL = '/home/root/.local/share/remarkable/xochitl';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PULL_TOOL: Tool = {
  name: 'remarkable_pull',
  description:
    'Pull a document from the reMarkable tablet. Returns rendered page images and transcribed text. ' +
    'Uses USB when connected, WiFi SSH otherwise.',
  inputSchema: {
    type: 'object',
    properties: {
      document: { type: 'string', description: 'Document name substring. Defaults to most recently modified.' },
      page:       { type: 'string', description: 'Page(s) to return: a single number ("3") or inclusive range ("1-4"). Defaults to all pages.' },
      output_dir: { type: 'string', description: 'Directory to save rendered page PNGs. If omitted, images are only returned inline.' },
      prompt:     { type: 'string', description: 'Custom transcription instruction (native mode: returned as agent context).' },
    },
  },
};

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

export async function handlePull(args: Record<string, unknown>): Promise<CallToolResult> {
  const config = await readConfig();
  const { usbHost, wifiHost, port, username, privateKeyPath } = config.connection;

  const tempDir = await mkdtemp(join(tmpdir(), 'remarkable-'));
  const docDir = join(tempDir, 'doc');

  try {
    await mkdir(docDir, { recursive: true });

    let targetName = '';
    let targetId = '';
    let pageIds: string[] = [];
    let thumbDir: string | undefined;

    // ── USB HTTP path ──────────────────────────────────────────────────────
    const usbResult = await probeUsbHttp();

    if (usbResult.available) {
      const docArg = args.document as string | undefined;
      const target = selectDocument(usbResult.documents, docArg);

      if (!target) {
        const names = usbResult.documents.filter((d) => d.Type === 'DocumentType').slice(0, 5).map(docName).join(', ');
        return { isError: true, content: [{ type: 'text', text: `No document matching "${docArg}". Available: ${names}` }] };
      }

      targetName = docName(target);
      targetId = target.ID;

      if (!UUID_RE.test(targetId)) {
        return { isError: true, content: [{ type: 'text', text: `Unexpected document ID format: ${targetId}` }] };
      }

      try {
        const rmdocBuffer = await downloadRmdoc(targetId);
        await extractRmdoc(rmdocBuffer, docDir);
        pageIds = await readPageIds(docDir, targetId);
      } catch (err) {
        // rmdoc failed — thumbnail fallback
        try {
          const thumb = await downloadThumbnail(targetId);
          const thumbPath = join(tempDir, 'thumbnail.png');
          await writeFile(thumbPath, thumb);
          thumbDir = tempDir;
        } catch {
          return { isError: true, content: [{ type: 'text', text: `Failed to download "${targetName}": ${(err as Error).message}` }] };
        }
      }

    } else {
      // ── SSH fallback path ────────────────────────────────────────────────
      const hosts = [wifiHost, usbHost].filter(Boolean);
      let raw = '';
      let connectedHost = '';

      for (const host of hosts) {
        try {
          const opts: SSHOptions = { host, port, username, privateKeyPath };
          raw = await sshExec(opts, LIST_CMD, 60000);
          connectedHost = host;
          break;
        } catch { /* try next */ }
      }

      if (!connectedHost) {
        return { isError: true, content: [{ type: 'text', text: 'Cannot connect to tablet. Connect USB or check WiFi SSH config.' }] };
      }

      const docs = parseDocuments(raw);
      if (docs.length === 0) return { content: [{ type: 'text', text: 'No documents found on the tablet.' }] };

      const docArg = args.document as string | undefined;
      const target = docArg
        ? docs.find((d) => d.name.toLowerCase().includes(docArg.toLowerCase()))
        : docs[0];

      if (!target) {
        const names = docs.slice(0, 5).map((d) => d.name).join(', ');
        return { isError: true, content: [{ type: 'text', text: `No document matching "${docArg}". Available: ${names}` }] };
      }

      targetName = target.name;
      targetId = target.id;

      if (!UUID_RE.test(targetId)) {
        return { isError: true, content: [{ type: 'text', text: `Unexpected document ID format: ${targetId}` }] };
      }

      const opts: SSHOptions = { host: connectedHost, port, username, privateKeyPath };
      const tarCmd = `cd ${XOCHITL} && tar cf - ${targetId}.* ${targetId}/ 2>/dev/null`;
      await sshPipeTar(opts, tarCmd, docDir);
      pageIds = await readPageIds(docDir, targetId);
    }

    // ── Page range parsing ─────────────────────────────────────────────────
    const pageArg = args.page as string | undefined;
    let pageNums: Set<number> | undefined;
    if (pageArg) {
      const rangeMatch = pageArg.match(/^(\d+)-(\d+)$/);
      const singleMatch = pageArg.match(/^(\d+)$/);
      if (rangeMatch) {
        const from = parseInt(rangeMatch[1], 10);
        const to = parseInt(rangeMatch[2], 10);
        pageNums = new Set(Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i));
      } else if (singleMatch) {
        pageNums = new Set([parseInt(singleMatch[1], 10)]);
      } else {
        return { isError: true, content: [{ type: 'text', text: `Invalid page argument "${pageArg}". Use a number ("3") or range ("1-4").` }] };
      }
    }

    // ── Render ─────────────────────────────────────────────────────────────
    const pagesToProcess = await renderPages(docDir, targetId, pageIds, tempDir, thumbDir, pageNums);

    if (pagesToProcess.length === 0) {
      if (pageNums) {
        return { isError: true, content: [{ type: 'text', text: `Page(s) "${pageArg}" not found or not renderable. Document has ${pageIds.length} page(s).` }] };
      }
      return { isError: true, content: [{ type: 'text', text: `No renderable pages for "${targetName}". Open the document on the tablet at least once.` }] };
    }

    // ── OCR + assemble ─────────────────────────────────────────────────────
    const prompt = args.prompt as string | undefined;
    const outputDir = args.output_dir as string | undefined;
    const content: CallToolResult['content'] = [];

    const header = [`Document: ${targetName} — ${pagesToProcess.length} page(s).`];
    if (config.ocr.provider === 'native' && prompt) header.push(`Transcription instruction: ${prompt}`);
    if (outputDir) header.push(`Saving pages to: ${outputDir}`);
    content.push({ type: 'text', text: header.join('\n') });

    if (outputDir) {
      await mkdir(outputDir, { recursive: true });
    }

    const savedPaths: string[] = [];
    for (const page of pagesToProcess) {
      const result = await processPage(page, config.ocr, prompt);
      if (pagesToProcess.length > 1) content.push({ type: 'text', text: `--- Page ${result.pageNum} ---` });
      if (result.text) content.push({ type: 'text', text: result.text });
      content.push({ type: 'image', data: result.imageBase64, mimeType: 'image/png' });

      if (outputDir) {
        const safeName = targetName.replace(/[^a-zA-Z0-9_\- ]/g, '_');
        const dest = join(outputDir, `${safeName}-page${result.pageNum}.png`);
        await writeFile(dest, Buffer.from(result.imageBase64, 'base64'));
        savedPaths.push(dest);
      }
    }

    if (savedPaths.length > 0) {
      content.push({ type: 'text', text: `Saved:\n${savedPaths.join('\n')}` });
    }

    return { content };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
