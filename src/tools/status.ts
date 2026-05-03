import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { CONFIG_PATH, readConfig } from '../config.js';
import { CACHE_ROOT } from '../cache.js';
import { probeUsbHttp, USB_IP } from '../connection.js';
import { sshExec, resolveTabletMdns, categoriseSshError, type SSHOptions } from '../ssh.js';
import { getClientName } from '../client.js';
import { StatusArgs } from '../schemas.js';

// Read once at module load. dist/tools/status.js → ../../package.json.
const PKG_VERSION = (() => {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
})();

export const STATUS_TOOL: Tool = {
  name: 'remarkable_status',
  description:
    'Report connectivity and configuration: USB HTTP reachability, WiFi SSH reachability over the saved IP ' +
    'and via mDNS (remarkable.local) fallback, tablet firmware version, host-key pinning state, ' +
    'configuration and cache file locations, render and OCR defaults, and the connected MCP client. ' +
    'Each failure includes a categorised reason (timeout, refused, unreachable, auth failed, host-key ' +
    'mismatch) so the agent can suggest the right next step.',
  annotations: {
    title: 'reMarkable connection status',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: { type: 'object', properties: {} },
};

const WIFI_PROBE_TIMEOUT_MS = 20000; // generous: the tablet may need to wake its WiFi radio

async function probeWifiSsh(opts: SSHOptions): Promise<{ ok: boolean; firmware?: string; error?: string }> {
  try {
    const out = await sshExec(opts, "cat /etc/version 2>/dev/null || echo unknown", WIFI_PROBE_TIMEOUT_MS);
    return { ok: true, firmware: out.trim() };
  } catch (err) {
    return { ok: false, error: categoriseSshError(err as Error) };
  }
}

export async function handleStatus(args: Record<string, unknown>): Promise<CallToolResult> {
  StatusArgs.parse(args);
  const config = await readConfig();
  const lines: string[] = [];

  lines.push(`remarkable-mcp v${PKG_VERSION}`);
  lines.push(`Client: ${getClientName() ?? 'unknown'}`);
  lines.push(`Config: ${CONFIG_PATH}`);
  lines.push(`Cache:  ${CACHE_ROOT}`);
  lines.push('');

  // USB HTTP
  const usb = await probeUsbHttp();
  if (usb.available) {
    lines.push(`USB HTTP (${USB_IP}): reachable — ${usb.documents.length} root entries.`);
  } else {
    lines.push(`USB HTTP (${USB_IP}): not reachable — tablet may be unplugged or USB web interface disabled.`);
  }

  // WiFi SSH (saved IP first, then mDNS fallback if it differs / fails)
  const { wifiHost, port, username, privateKeyPath, hostKey } = config.connection;
  const mdns = await resolveTabletMdns();
  if (!wifiHost && !mdns) {
    lines.push('WiFi SSH: no WiFi host configured and remarkable.local does not resolve — run remarkable_setup over USB.');
  } else {
    const tried: string[] = [];
    if (wifiHost) {
      const opts: SSHOptions = { host: wifiHost, port, username, privateKeyPath, expectedHostKey: hostKey };
      const wifi = await probeWifiSsh(opts);
      tried.push(wifiHost);
      if (wifi.ok) {
        lines.push(`WiFi SSH (${wifiHost}): reachable — firmware ${wifi.firmware}.`);
      } else {
        lines.push(`WiFi SSH (${wifiHost}): not reachable — ${wifi.error}.`);
        // Try mDNS as a fallback if it points somewhere different
        if (mdns && mdns !== wifiHost) {
          const opts2: SSHOptions = { host: mdns, port, username, privateKeyPath, expectedHostKey: hostKey };
          const wifi2 = await probeWifiSsh(opts2);
          tried.push(mdns);
          if (wifi2.ok) {
            lines.push(`WiFi SSH via mDNS (${mdns}): reachable — firmware ${wifi2.firmware}.`);
            lines.push(`  → Saved IP differs from current. Run remarkable_setup with no password to refresh.`);
          } else {
            lines.push(`WiFi SSH via mDNS (${mdns}): not reachable — ${wifi2.error}.`);
          }
        }
      }
    } else if (mdns) {
      const opts: SSHOptions = { host: mdns, port, username, privateKeyPath, expectedHostKey: hostKey };
      const wifi = await probeWifiSsh(opts);
      tried.push(mdns);
      if (wifi.ok) {
        lines.push(`WiFi SSH via mDNS (${mdns}): reachable — firmware ${wifi.firmware}.`);
      } else {
        lines.push(`WiFi SSH via mDNS (${mdns}): not reachable — ${wifi.error}.`);
      }
    }
    if (mdns && !tried.includes(mdns)) lines.push(`mDNS: remarkable.local resolves to ${mdns}.`);
  }

  // Host-key pinning
  if (hostKey) {
    lines.push(`Host key: pinned (sha256:${hostKey.slice(0, 16)}…).`);
  } else {
    lines.push('Host key: NOT pinned — TOFU on next connect. Re-run remarkable_setup over USB to pin.');
  }

  // Render defaults
  lines.push('');
  lines.push(`Render: ${config.render.format} @ ${config.render.width}px${config.render.format === 'jpeg' ? ` (q=${config.render.jpegQuality})` : ''}.`);
  lines.push(`OCR:    ${config.ocr.provider}${config.ocr.provider === 'ollama' ? ` (${config.ocr.ollamaModel ?? 'llama3.2-vision'})` : ''}.`);

  // Firmware caveat
  lines.push('');
  lines.push('Note: rmdoc download (used by remarkable_pull over USB) requires firmware ≥ 3.9.');

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
