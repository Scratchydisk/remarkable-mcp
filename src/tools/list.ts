import { basename } from 'path';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { readConfig, writeConfig, type Config } from '../config.js';
import {
  probeUsbHttp,
  fetchAllDocuments,
  fromHttpDoc,
  filterAndSortDocs,
  folderPath,
  type UnifiedDoc,
} from '../connection.js';
import { sshExec, resolveTabletMdns, categoriseSshError } from '../ssh.js';
import type { SSHOptions } from '../ssh.js';
import { ListArgs } from '../schemas.js';

const XOCHITL = '/home/root/.local/share/remarkable/xochitl';
export const LIST_CMD = `find ${XOCHITL} -maxdepth 2 -name '*.metadata' -exec sh -c 'echo "---FILE:$1"; cat "$1"' _ {} \\;`;

/** Single parser for the SSH `find … *.metadata` output — produces unified docs (folders included). */
export function parseUnifiedDocs(raw: string): UnifiedDoc[] {
  const out: UnifiedDoc[] = [];
  for (const block of raw.split('---FILE:').filter(Boolean)) {
    const lines = block.trim().split('\n');
    try {
      const meta = JSON.parse(lines.slice(1).join('\n')) as Record<string, string>;
      if (!meta.visibleName) continue;
      const isFolder = meta.type === 'CollectionType';
      if (!isFolder && meta.type !== 'DocumentType') continue;
      out.push({
        id: basename(lines[0].trim(), '.metadata'),
        name: meta.visibleName,
        modifiedMs: meta.lastModified ? parseInt(meta.lastModified, 10) || 0 : 0,
        parent: meta.parent ?? '',
        isFolder,
      });
    } catch { /* skip malformed */ }
  }
  return out;
}

/**
 * Legacy SSH document shape kept for the existing test surface.
 * @deprecated use parseUnifiedDocs.
 */
export interface SshDocument { id: string; name: string; lastModified: number; parent: string; }

/** Backwards-compatible parser: documents only. */
export function parseDocuments(raw: string): SshDocument[] {
  return parseUnifiedDocs(raw)
    .filter((d) => !d.isFolder)
    .map((d) => ({ id: d.id, name: d.name, lastModified: d.modifiedMs, parent: d.parent }))
    .sort((a, b) => b.lastModified - a.lastModified);
}

/** Backwards-compatible folder map parser. */
export function parseFolderMap(raw: string): Map<string, { name: string; parent: string }> {
  const map = new Map<string, { name: string; parent: string }>();
  for (const d of parseUnifiedDocs(raw)) {
    if (d.isFolder) map.set(d.id, { name: d.name, parent: d.parent });
  }
  return map;
}

export const LIST_TOOL: Tool = {
  name: 'remarkable_list',
  description:
    'List documents on the reMarkable tablet, sorted by most recently modified. Documents inside folders ' +
    'are shown with their full path (e.g. "Work / Meeting Notes"). Use the folder parameter to filter to a ' +
    'specific folder by substring match. Connects via USB HTTP when available, otherwise SSH over WiFi ' +
    '(saved IP → mDNS remarkable.local → USB SSH). When a connection fails, the response shows each host ' +
    'tried and a categorised reason (timeout, refused, auth failed, host-key mismatch).',
  annotations: {
    title: 'List reMarkable documents',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: 'object',
    properties: {
      folder: { type: 'string', description: 'Filter to documents inside this folder name (substring match). Omit to list all documents.' },
    },
  },
};

function formatDocLines(docs: UnifiedDoc[], folderMap: Map<string, { name: string; parent: string }>): string {
  return docs.map((d, i) => {
    const date = d.modifiedMs ? new Date(d.modifiedMs).toLocaleDateString('en-GB') : 'unknown';
    const fp = folderPath(d.parent, folderMap);
    const label = fp ? `${fp} / ${d.name}` : d.name;
    return `${i + 1}. ${label} (${date})`;
  }).join('\n');
}

/**
 * Build SSH options for the given host with TOFU host-key pinning wired in.
 * If `connection.hostKey` is unset, the first successful connect captures and persists the fingerprint.
 */
export function buildSshOpts(config: Config, host: string): { opts: SSHOptions; persistIfNew: () => Promise<void> } {
  const { port, username, privateKeyPath, hostKey } = config.connection;
  let captured: string | undefined;
  const opts: SSHOptions = {
    host,
    port,
    username,
    privateKeyPath,
    expectedHostKey: hostKey,
    onHostKey: (fp) => { captured = fp; },
  };
  const persistIfNew = async () => {
    if (!hostKey && captured) {
      const next: Config = { ...config, connection: { ...config.connection, hostKey: captured } };
      await writeConfig(next);
    }
  };
  return { opts, persistIfNew };
}

export async function handleList(args: Record<string, unknown>): Promise<CallToolResult> {
  const parsed = ListArgs.safeParse(args);
  if (!parsed.success) {
    return { isError: true, content: [{ type: 'text', text: `Invalid arguments: ${parsed.error.issues.map((i) => i.message).join('; ')}` }] };
  }
  const folderArg = parsed.data.folder?.toLowerCase();
  const config = await readConfig();
  const { usbHost, wifiHost } = config.connection;

  // USB-first: try HTTP web API
  const usbResult = await probeUsbHttp();
  if (usbResult.available) {
    const allDocuments = (await fetchAllDocuments(usbHost)).map(fromHttpDoc);
    const { docs, folderMap } = filterAndSortDocs(allDocuments, folderArg);
    if (docs.length === 0) return { content: [{ type: 'text', text: 'No documents found on the tablet.' }] };
    return { content: [{ type: 'text', text: `[via USB]\n${formatDocLines(docs, folderMap)}` }] };
  }

  // SSH fallback: try WiFi → mDNS → USB SSH, in that order. mDNS lets us recover when the saved
  // wifiHost has gone stale (DHCP lease moved, network change).
  const mdns = await resolveTabletMdns();
  const hostCandidates = Array.from(new Set([wifiHost, mdns, usbHost].filter((h): h is string => Boolean(h))));
  const errors: string[] = [];
  for (const host of hostCandidates) {
    const { opts, persistIfNew } = buildSshOpts(config, host);
    try {
      const raw = await sshExec(opts, LIST_CMD, 60000);
      await persistIfNew();
      const allDocs = parseUnifiedDocs(raw);
      const { docs, folderMap } = filterAndSortDocs(allDocs, folderArg);
      if (docs.length === 0) return { content: [{ type: 'text', text: 'No documents found on the tablet.' }] };
      const via = host === mdns ? `mDNS ${mdns}` : `SSH ${host}`;
      return { content: [{ type: 'text', text: `[via ${via}]\n${formatDocLines(docs, folderMap)}` }] };
    } catch (err) {
      errors.push(`${host}: ${categoriseSshError(err as Error)}`);
    }
  }

  return {
    isError: true,
    content: [{ type: 'text', text: `Cannot connect to tablet. Tried:\n${errors.map((e) => `  - ${e}`).join('\n')}` }],
  };
}
