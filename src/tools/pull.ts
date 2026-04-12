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
import { parseDocuments } from './list.js';

const XOCHITL = '/home/root/.local/share/remarkable/xochitl';
const LIST_CMD = `find ${XOCHITL} -maxdepth 2 -name '*.metadata' -exec sh -c 'echo "---FILE:$1"; cat "$1"' _ {} \\;`;

export const PULL_TOOL: Tool = {
  name: 'remarkable_pull',
  description:
    'Pull a document from the reMarkable tablet. Returns rendered page images and transcribed text. ' +
    'Uses USB when connected, WiFi SSH otherwise.',
  inputSchema: {
    type: 'object',
    properties: {
      document: { type: 'string', description: 'Document name substring. Defaults to most recently modified.' },
      page:     { type: 'number', description: 'Specific page number (1-based). Defaults to all pages.' },
      prompt:   { type: 'string', description: 'Custom transcription instruction (native mode: returned as agent context).' },
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

      const opts: SSHOptions = { host: connectedHost, port, username, privateKeyPath };
      const tarCmd = `cd ${XOCHITL} && tar cf - ${targetId}.* ${targetId}/ 2>/dev/null`;
      await sshPipeTar(opts, tarCmd, docDir);
      pageIds = await readPageIds(docDir, targetId);
    }

    // ── Render ─────────────────────────────────────────────────────────────
    const allPages = await renderPages(docDir, targetId, pageIds, tempDir, thumbDir);

    if (allPages.length === 0) {
      return { isError: true, content: [{ type: 'text', text: `No renderable pages for "${targetName}". Open the document on the tablet at least once.` }] };
    }

    const pageArg = args.page as number | undefined;
    const pagesToProcess = pageArg ? allPages.filter((p) => p.pageNum === pageArg) : allPages;

    if (pageArg && pagesToProcess.length === 0) {
      return { isError: true, content: [{ type: 'text', text: `Page ${pageArg} not found. Document has ${allPages.length} page(s).` }] };
    }

    // ── OCR + assemble ─────────────────────────────────────────────────────
    const prompt = args.prompt as string | undefined;
    const content: CallToolResult['content'] = [];

    const header = [`Document: ${targetName} — ${pagesToProcess.length} page(s).`];
    if (config.ocr.provider === 'native' && prompt) header.push(`Transcription instruction: ${prompt}`);
    content.push({ type: 'text', text: header.join('\n') });

    for (const page of pagesToProcess) {
      const result = await processPage(page, config.ocr, prompt);
      if (pagesToProcess.length > 1) content.push({ type: 'text', text: `--- Page ${result.pageNum} ---` });
      if (result.text) content.push({ type: 'text', text: result.text });
      content.push({ type: 'image', data: result.imageBase64, mimeType: 'image/png' });
    }

    return { content };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
