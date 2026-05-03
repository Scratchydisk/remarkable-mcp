import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { readConfig } from '../config.js';
import { probeUsbHttp, fetchAllDocuments, fromHttpDoc, filterAndSortDocs } from '../connection.js';
import { handlePull } from './pull.js';
import { IndexArgs } from '../schemas.js';
import { hasCompleteCache, readDocMeta } from '../cache.js';
import { debug } from '../debug.js';

export const INDEX_TOOL: Tool = {
  name: 'remarkable_index',
  description:
    'Bulk-OCR every document on the tablet and add it to the search corpus. For each document: pulls it ' +
    'over USB HTTP, runs OCR via the configured provider (ocr.provider in config — must be "ollama" or ' +
    '"local", not "native"), writes the text into the cache, and updates the search index. Documents ' +
    'already cached and indexed for the current mtime are skipped unless force=true. Long-running on ' +
    'large libraries (each OCR call can take seconds in ollama mode); progress is reported in the ' +
    'response. Use remarkable_search afterwards to query the corpus.',
  annotations: {
    title: 'Bulk-index reMarkable documents',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: 'object',
    properties: {
      limit:  { type: 'number', description: 'Cap how many documents to process this call. Default: all.' },
      folder: { type: 'string', description: 'Restrict to documents inside this folder (substring match).' },
      force:  { type: 'boolean', description: 'Re-OCR documents that are already indexed for the current mtime. Default false.' },
    },
  },
};

export async function handleBulkIndex(args: Record<string, unknown>): Promise<CallToolResult> {
  const parsed = IndexArgs.safeParse(args);
  if (!parsed.success) {
    return { isError: true, content: [{ type: 'text', text: `Invalid arguments: ${parsed.error.issues.map((i) => i.message).join('; ')}` }] };
  }
  const { limit, folder, force } = parsed.data;
  const config = await readConfig();

  if (config.ocr.provider === 'native') {
    return {
      isError: true,
      content: [{
        type: 'text',
        text:
          'Bulk indexing requires an OCR provider that produces text. Your config has ocr.provider="native" — ' +
          'change it to "ollama" or "local" in ~/.config/remarkable-mcp/config.json and re-run.',
      }],
    };
  }

  // List documents (USB HTTP path only — bulk indexing assumes a wired connection).
  const usb = await probeUsbHttp();
  if (!usb.available) {
    return { isError: true, content: [{ type: 'text', text: 'Tablet not reachable via USB HTTP. Bulk indexing requires a wired connection — plug the tablet in and retry.' }] };
  }
  const all = (await fetchAllDocuments(config.connection.usbHost)).map(fromHttpDoc);
  const { docs } = filterAndSortDocs(all, folder);
  const targets = docs.slice(0, limit ?? docs.length);

  const lines: string[] = [`Indexing ${targets.length} document(s)…`];
  let indexed = 0;
  let skipped = 0;
  let failed = 0;

  // pull.ts requires output_dir when inline_images is false. We don't actually want to keep the
  // rendered files for bulk indexing, so use a single mkdtemp scratch dir and rm it at the end.
  const scratch = await mkdtemp(join(tmpdir(), 'remarkable-bulk-'));
  try {
    for (const doc of targets) {
      const mtimeKey = String(doc.modifiedMs || Date.now());
      // Skip if already cached + indexed for this mtime (unless force).
      if (!force && (await hasCompleteCache(doc.id, mtimeKey)) && (await readDocMeta(doc.id, mtimeKey))?.indexedPages?.length) {
        skipped++;
        continue;
      }
      try {
        const result = await handlePull({ document: doc.name, inline_images: false, output_dir: scratch });
        if (result.isError) { failed++; debug('bulk-index: %s failed: %s', doc.name, JSON.stringify(result.content?.[0])); }
        else indexed++;
      } catch (err) {
        failed++;
        debug('bulk-index: %s threw: %s', doc.name, (err as Error).message);
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  lines.push(`✓ Indexed: ${indexed}`, `↷ Skipped (already cached): ${skipped}`, `✗ Failed: ${failed}`);
  if (failed > 0) lines.push('Set DEBUG=remarkable-mcp to see why specific documents failed.');
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
