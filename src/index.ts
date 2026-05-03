#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { SETUP_TOOL, handleSetup } from './tools/setup.js';
import { LIST_TOOL, handleList } from './tools/list.js';
import { PULL_TOOL, handlePull } from './tools/pull.js';
import { STATUS_TOOL, handleStatus } from './tools/status.js';
import { SEARCH_TOOL, handleSearch } from './tools/search.js';
import { INDEX_TOOL, handleBulkIndex } from './tools/bulk-index.js';
import { SAVE_TRANSCRIPTION_TOOL, handleSaveTranscription } from './tools/save-transcription.js';
import { setClientName } from './client.js';

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const { version } = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };

const server = new Server(
  { name: 'remarkable-mcp', version },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [SETUP_TOOL, LIST_TOOL, PULL_TOOL, STATUS_TOOL, SEARCH_TOOL, INDEX_TOOL, SAVE_TRANSCRIPTION_TOOL],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // initialize has completed by the time the first tool call arrives — capture the client name now.
  setClientName(server.getClientVersion()?.name);
  const { name, arguments: args = {} } = request.params;
  const a = args as Record<string, unknown>;
  switch (name) {
    case 'remarkable_setup':  return handleSetup(a);
    case 'remarkable_list':   return handleList(a);
    case 'remarkable_pull':   return handlePull(a);
    case 'remarkable_status': return handleStatus(a);
    case 'remarkable_search': return handleSearch(a);
    case 'remarkable_index':  return handleBulkIndex(a);
    case 'remarkable_save_transcription': return handleSaveTranscription(a);
    default: throw new Error(`Unknown tool: ${name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
