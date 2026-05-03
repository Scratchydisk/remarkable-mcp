import { basename } from 'path';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { readConfig } from '../config.js';
import { probeUsbHttp, fetchAllDocuments, docName, buildFolderMap, folderPath } from '../connection.js';
import type { FolderEntry } from '../connection.js';
import { sshExec } from '../ssh.js';
import type { SSHOptions } from '../ssh.js';

const XOCHITL = '/home/root/.local/share/remarkable/xochitl';
export const LIST_CMD = `find ${XOCHITL} -maxdepth 2 -name '*.metadata' -exec sh -c 'echo "---FILE:$1"; cat "$1"' _ {} \\;`;

export interface SshDocument {
  id: string;
  name: string;
  lastModified: number;
  parent: string;
}

export function parseDocuments(raw: string): SshDocument[] {
  const docs: SshDocument[] = [];
  for (const block of raw.split('---FILE:').filter(Boolean)) {
    const lines = block.trim().split('\n');
    try {
      const meta = JSON.parse(lines.slice(1).join('\n')) as Record<string, string>;
      if (meta.visibleName && meta.type === 'DocumentType') {
        docs.push({
          id: basename(lines[0].trim(), '.metadata'),
          name: meta.visibleName,
          lastModified: meta.lastModified ? parseInt(meta.lastModified, 10) : 0,
          parent: meta.parent ?? '',
        });
      }
    } catch { /* skip malformed */ }
  }
  return docs.sort((a, b) => b.lastModified - a.lastModified);
}

export function parseFolderMap(raw: string): Map<string, FolderEntry> {
  const map = new Map<string, FolderEntry>();
  for (const block of raw.split('---FILE:').filter(Boolean)) {
    const lines = block.trim().split('\n');
    try {
      const meta = JSON.parse(lines.slice(1).join('\n')) as Record<string, string>;
      if (meta.visibleName && meta.type === 'CollectionType') {
        const id = basename(lines[0].trim(), '.metadata');
        map.set(id, { name: meta.visibleName, parent: meta.parent ?? '' });
      }
    } catch { /* skip malformed */ }
  }
  return map;
}

export const LIST_TOOL: Tool = {
  name: 'remarkable_list',
  description:
    'List all documents on the reMarkable tablet, sorted by most recently modified. ' +
    'Documents inside folders are shown with their full path (e.g. "Work / Meeting Notes"). ' +
    'Use the folder parameter to filter to a specific folder.',
  inputSchema: {
    type: 'object',
    properties: {
      folder: { type: 'string', description: 'Filter to documents inside this folder name (substring match). Omit to list all documents.' },
    },
  },
};

export async function handleList(args: Record<string, unknown>): Promise<CallToolResult> {
  const folderArg = (args.folder as string | undefined)?.toLowerCase();
  const config = await readConfig();
  const { usbHost, wifiHost, port, username, privateKeyPath } = config.connection;

  // USB-first: try HTTP web API
  const usbResult = await probeUsbHttp();
  if (usbResult.available) {
    const allDocuments = await fetchAllDocuments(usbHost);
    const fm = buildFolderMap(allDocuments);
    let docs = allDocuments
      .filter((d) => d.Type === 'DocumentType')
      .sort((a, b) => new Date(b.ModifiedClient).getTime() - new Date(a.ModifiedClient).getTime());

    if (folderArg) {
      docs = docs.filter((d) => folderPath(d.Parent, fm).toLowerCase().includes(folderArg));
    }

    if (docs.length === 0) return { content: [{ type: 'text', text: 'No documents found on the tablet.' }] };
    const lines = docs.map((d, i) => {
      const date = new Date(d.ModifiedClient).toLocaleDateString('en-GB');
      const fp = folderPath(d.Parent, fm);
      const label = fp ? `${fp} / ${docName(d)}` : docName(d);
      return `${i + 1}. ${label} (${date})`;
    });
    return { content: [{ type: 'text', text: `[via USB]\n${lines.join('\n')}` }] };
  }

  // SSH fallback: try WiFi then USB SSH
  const hosts = [wifiHost, usbHost].filter(Boolean);
  for (const host of hosts) {
    const opts: SSHOptions = { host, port, username, privateKeyPath };
    try {
      const raw = await sshExec(opts, LIST_CMD, 60000);
      const fm = parseFolderMap(raw);
      let docs = parseDocuments(raw);
      if (folderArg) {
        docs = docs.filter((d) => folderPath(d.parent, fm).toLowerCase().includes(folderArg));
      }
      if (docs.length === 0) return { content: [{ type: 'text', text: 'No documents found on the tablet.' }] };
      const lines = docs.map((d, i) => {
        const date = d.lastModified ? new Date(d.lastModified).toLocaleDateString('en-GB') : 'unknown';
        const fp = folderPath(d.parent, fm);
        const label = fp ? `${fp} / ${d.name}` : d.name;
        return `${i + 1}. ${label} (${date})`;
      });
      return { content: [{ type: 'text', text: `[via SSH ${host}]\n${lines.join('\n')}` }] };
    } catch { /* try next host */ }
  }

  return {
    isError: true,
    content: [{ type: 'text', text: 'Cannot connect to tablet. Connect via USB or ensure WiFi SSH is configured.' }],
  };
}
