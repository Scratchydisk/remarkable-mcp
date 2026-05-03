import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  iterCachedDocs,
  readDocMeta,
  writeDocMeta,
  writePageText,
  readPageText,
  type DocMeta,
} from '../cache.js';
import { replaceDocPages } from '../search.js';
import { SaveTranscriptionArgs } from '../schemas.js';

export const SAVE_TRANSCRIPTION_TOOL: Tool = {
  name: 'remarkable_save_transcription',
  description:
    'Save text the agent transcribed from a previous remarkable_pull call into the cache and search ' +
    'index. Use this in native OCR mode (the default), where the host LLM reads the images directly and ' +
    'the MCP server has no other way to capture the text. After pulling a document and transcribing its ' +
    'pages, call this tool with doc_id (preferred — included in the pull response footer) or a document ' +
    'name substring, plus a pages array of { pageNum, text }. The text is appended to the cache; ' +
    'subsequent remarkable_search calls will find it. Skip this for documents whose images had no ' +
    'meaningful text content.',
  annotations: {
    title: 'Save transcription to search index',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: 'object',
    properties: {
      doc_id:   { type: 'string', description: 'Tablet document UUID. Found in the remarkable_pull response footer or in remarkable_list output.' },
      document: { type: 'string', description: 'Document name substring (case-insensitive). Resolves to the most recently cached matching document. Use when doc_id is not available.' },
      pages: {
        type: 'array',
        description: 'One entry per transcribed page. Page numbers are 1-based and match the pageNum in the remarkable_pull response.',
        items: {
          type: 'object',
          properties: {
            pageNum: { type: 'number', description: '1-based page number.' },
            text:    { type: 'string', description: 'Transcribed text. Empty strings are dropped.' },
          },
          required: ['pageNum', 'text'],
        },
      },
    },
    required: ['pages'],
  },
};

interface CachedHit { docId: string; mtimeKey: string; meta: DocMeta }

/** Pick the cached document matching the supplied identifiers. Returns the most recent mtime when multiple candidates exist. */
async function resolveTarget(docId: string | undefined, name: string | undefined): Promise<CachedHit | null> {
  let best: CachedHit | null = null;
  const term = name?.toLowerCase();
  for await (const { docId: id, mtimeKey } of iterCachedDocs()) {
    if (docId && id !== docId) continue;
    const meta = await readDocMeta(id, mtimeKey);
    if (!meta) continue;
    if (term && !meta.name.toLowerCase().includes(term)) continue;
    if (!best || meta.mtimeMs > best.meta.mtimeMs) best = { docId: id, mtimeKey, meta };
  }
  return best;
}

export async function handleSaveTranscription(args: Record<string, unknown>): Promise<CallToolResult> {
  const parsed = SaveTranscriptionArgs.safeParse(args);
  if (!parsed.success) {
    return { isError: true, content: [{ type: 'text', text: `Invalid arguments: ${parsed.error.issues.map((i) => i.message).join('; ')}` }] };
  }
  const { doc_id, document, pages } = parsed.data;

  const target = await resolveTarget(doc_id, document);
  if (!target) {
    const lookup = doc_id ? `doc_id "${doc_id}"` : `document "${document}"`;
    return {
      isError: true,
      content: [{
        type: 'text',
        text:
          `No matching cached document for ${lookup}. ` +
          `The document must have been pulled at least once with remarkable_pull before its transcription can be saved.`,
      }],
    };
  }

  // Write each non-empty page to the OCR text dir, then merge with any existing pages.
  const withText = pages.filter((p) => p.text.trim().length > 0);
  if (withText.length === 0) {
    return { content: [{ type: 'text', text: `No non-empty pages to save for "${target.meta.name}". Nothing changed.` }] };
  }

  for (const p of withText) {
    await writePageText(target.docId, target.mtimeKey, p.pageNum, p.text);
  }

  // Build the full set of indexed pages — the freshly-saved ones plus any pages already on disk
  // from a previous pull at the same mtime.
  const existing = new Set(target.meta.indexedPages ?? []);
  const updatedSet = new Set<number>([...existing, ...withText.map((p) => p.pageNum)]);
  const allPages: Array<{ pageNum: number; text: string }> = [];
  for (const n of [...updatedSet].sort((a, b) => a - b)) {
    const overrideText = withText.find((p) => p.pageNum === n)?.text;
    const text = overrideText ?? (await readPageText(target.docId, target.mtimeKey, n)) ?? '';
    if (text.trim().length > 0) allPages.push({ pageNum: n, text });
  }

  await replaceDocPages(
    target.docId,
    target.meta.name,
    target.meta.folder,
    target.meta.indexedPages ?? [],
    allPages,
  );
  await writeDocMeta(target.docId, target.mtimeKey, {
    ...target.meta,
    indexedPages: allPages.map((p) => p.pageNum),
  });

  return {
    content: [{
      type: 'text',
      text: `Saved transcription for "${target.meta.name}": ${withText.length} new page(s), ${allPages.length} total indexed.`,
    }],
  };
}
