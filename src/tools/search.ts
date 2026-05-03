import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { searchPages, indexSize } from '../search.js';
import { SearchArgs } from '../schemas.js';

export const SEARCH_TOOL: Tool = {
  name: 'remarkable_search',
  description:
    'Full-text search across the OCR\'d contents of cached reMarkable documents. Returns ranked ' +
    'page-level hits with a short snippet, ordered by BM25 relevance. Search is fuzzy and supports ' +
    'prefix matching. The corpus contains every document you have previously pulled with an OCR ' +
    'provider configured (ollama or local) — pulls in native OCR mode produce no searchable text. ' +
    'To index every document on the tablet at once, use remarkable_index.',
  annotations: {
    title: 'Search reMarkable documents',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: 'object',
    properties: {
      query:  { type: 'string', description: 'Search query. Supports prefix and fuzzy matching; multi-word queries are AND-combined.' },
      limit:  { type: 'number', description: 'Maximum number of hits to return. Default 20, max 100.' },
      folder: { type: 'string', description: 'Restrict to documents whose folder path contains this substring (case-insensitive).' },
    },
    required: ['query'],
  },
};

export async function handleSearch(args: Record<string, unknown>): Promise<CallToolResult> {
  const parsed = SearchArgs.safeParse(args);
  if (!parsed.success) {
    return { isError: true, content: [{ type: 'text', text: `Invalid arguments: ${parsed.error.issues.map((i) => i.message).join('; ')}` }] };
  }
  const { query, limit, folder } = parsed.data;
  const total = await indexSize();
  if (total === 0) {
    return {
      content: [{
        type: 'text',
        text:
          'Search index is empty — no documents have been transcribed yet.\n' +
          'Three ways to populate it:\n' +
          ' • Pull a document with ocr.provider="ollama" or "local" in ~/.config/remarkable-mcp/config.json (text is cached automatically).\n' +
          ' • Pull a document in native OCR mode and call remarkable_save_transcription with the transcribed pages.\n' +
          ' • Run remarkable_index to bulk-OCR everything on the tablet (ollama/local mode only).',
      }],
    };
  }

  const hits = await searchPages(query, { limit, folder });
  if (hits.length === 0) {
    return { content: [{ type: 'text', text: `No matches for "${query}" across ${total} indexed page(s).` }] };
  }

  const lines = [`Found ${hits.length} hit(s) for "${query}" across ${total} indexed page(s):`, ''];
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const where = h.folder ? `${h.folder} / ${h.name}` : h.name;
    lines.push(`${i + 1}. ${where} — page ${h.pageNum} (score ${h.score.toFixed(2)})`);
    if (h.snippet) lines.push(`     ${h.snippet}`);
  }
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
