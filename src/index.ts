#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { SETUP_TOOL, handleSetup } from './tools/setup.js';
import { LIST_TOOL, handleList } from './tools/list.js';
import { PULL_TOOL, handlePull } from './tools/pull.js';

const server = new Server(
  { name: 'remarkable-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [SETUP_TOOL, LIST_TOOL, PULL_TOOL],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const a = args as Record<string, unknown>;
  switch (name) {
    case 'remarkable_setup': return handleSetup(a);
    case 'remarkable_list':  return handleList(a);
    case 'remarkable_pull':  return handlePull(a);
    default: throw new Error(`Unknown tool: ${name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
