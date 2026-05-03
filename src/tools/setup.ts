import { join } from 'path';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { buildDefaultConfig, readConfig, writeConfig, CONFIG_DIR } from '../config.js';
import { generateKeyPair, deployPublicKey, enableUsbWebInterface, getWifiIp, sshExec, resolveTabletMdns, categoriseSshError } from '../ssh.js';
import type { SSHOptions } from '../ssh.js';
import { probeUsbHttp, USB_IP } from '../connection.js';
import { SetupArgs } from '../schemas.js';

export const SETUP_TOOL: Tool = {
  name: 'remarkable_setup',
  description:
    'Configure access to a reMarkable tablet. With a password (full setup): deploys an SSH public key over ' +
    'USB, enables the on-tablet USB web interface, captures the SSH host-key fingerprint for pinning, and ' +
    'records the WiFi IP. The password is found on the tablet at Settings → Help → Copyright and licenses ' +
    'and is passed as a tool argument (it may appear in agent transcripts). Without a password (refresh ' +
    'mode): assumes a prior setup ran and just rediscovers the current WiFi IP using the existing SSH key, ' +
    'trying USB SSH then the saved WiFi IP then mDNS (remarkable.local). Use refresh mode after the tablet ' +
    'rejoins the network on a different IP.',
  annotations: {
    title: 'Set up reMarkable tablet',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: 'object',
    properties: {
      password: {
        type: 'string',
        description: 'Root password from Settings → Help → Copyright and licenses. Omit to run in refresh mode (just rediscover the WiFi IP using the existing SSH key).',
      },
    },
  },
};

/** Pick the first SSH-reachable host candidate using the provided key. */
async function probeSshKey(opts: Omit<SSHOptions, 'host'>, host: string, timeoutMs = 20000): Promise<{ ok: boolean; error?: string }> {
  try {
    await sshExec({ ...opts, host }, 'true', timeoutMs);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: categoriseSshError(err as Error) };
  }
}

async function handleRefresh(): Promise<CallToolResult> {
  const config = await readConfig();
  const { wifiHost, port, username, privateKeyPath, hostKey } = config.connection;
  const baseOpts = { port, username, privateKeyPath, expectedHostKey: hostKey };

  // Build candidate list: USB SSH > saved wifiHost > mDNS
  const mdns = await resolveTabletMdns();
  const candidates = Array.from(new Set([USB_IP, wifiHost, mdns].filter((h): h is string => Boolean(h))));

  const tried: string[] = [];
  for (const host of candidates) {
    const probe = await probeSshKey(baseOpts, host);
    tried.push(`${host}: ${probe.ok ? 'reachable' : probe.error}`);
    if (!probe.ok) continue;

    // Got a working SSH connection — read the current WiFi IP.
    const newWifiIp = await getWifiIp({ ...baseOpts, host });
    const next = { ...config, connection: { ...config.connection } };
    if (newWifiIp) next.connection.wifiHost = newWifiIp;
    await writeConfig(next);

    const lines = [
      'Refresh complete.',
      `Reachable via: ${host}.`,
      newWifiIp
        ? wifiHost === newWifiIp
          ? `WiFi IP unchanged: ${newWifiIp}.`
          : `WiFi IP updated: ${wifiHost || '(unset)'} → ${newWifiIp}.`
        : 'Tablet has no WiFi connection right now (wlan0 down).',
    ];
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  const sawTimeout = tried.some((t) => /timeout/i.test(t));
  const hint = sawTimeout
    ? 'The tablet is most likely asleep — wake it (tap the screen or draw a stroke) and retry. ' +
      'If it stays unreachable after waking, the saved WiFi IP may be stale or the SSH key was lost; ' +
      're-run remarkable_setup with the password over USB.'
    : 'If the tablet was reflashed or the SSH key was lost, run remarkable_setup again with the password to re-do full setup.';

  return {
    isError: true,
    content: [{
      type: 'text',
      text: `Refresh failed — no SSH host reachable. Tried:\n${tried.map((t) => `  - ${t}`).join('\n')}\n${hint}`,
    }],
  };
}

async function handleFullSetup(password: string): Promise<CallToolResult> {
  const keyPath = join(CONFIG_DIR, 'id_ed25519');
  let capturedHostKey: string | undefined;
  const captureHostKey = (fp: string) => { capturedHostKey = fp; };

  const usbOpts: SSHOptions = { host: USB_IP, port: 22, username: 'root', password, onHostKey: captureHostKey };

  try {
    // 1. Generate and deploy SSH keypair (needed for WiFi use). The first sshExec captures the host key fingerprint.
    const { publicKey } = await generateKeyPair(keyPath);
    await deployPublicKey(usbOpts, publicKey);

    // 2. Enable USB web interface (idempotent). Now using key auth.
    const keyOpts: SSHOptions = { host: USB_IP, port: 22, username: 'root', privateKeyPath: keyPath, expectedHostKey: capturedHostKey };
    const webIfaceStatus = await enableUsbWebInterface(keyOpts);

    // 3. Verify HTTP web interface is now up
    const { available } = await probeUsbHttp();

    // 4. Discover WiFi IP
    const wifiIp = await getWifiIp(keyOpts);

    // 5. Save config (including pinned host-key fingerprint for future SSH connects)
    const config = buildDefaultConfig(CONFIG_DIR);
    config.connection.wifiHost = wifiIp ?? '';
    config.connection.privateKeyPath = keyPath;
    if (capturedHostKey) config.connection.hostKey = capturedHostKey;
    await writeConfig(config);

    const lines = [
      'reMarkable setup complete.',
      `SSH keypair saved to ${keyPath}.`,
      capturedHostKey ? `Host-key fingerprint pinned: sha256:${capturedHostKey.slice(0, 16)}…` : 'Host-key fingerprint not captured (TOFU on first connect).',
      `USB web interface: ${webIfaceStatus === 'already-enabled' ? 'already enabled' : webIfaceStatus === 'enabled' ? 'enabled' : 'could not enable — you may need to enable it manually in Settings → Storage → USB web interface'}.`,
      available ? 'USB web interface is reachable.' : 'USB web interface did not respond — check the tablet setting.',
      wifiIp ? `WiFi IP discovered and saved: ${wifiIp}.` : 'No WiFi IP found — tablet may not be connected to WiFi.',
      'Run remarkable_list to verify the connection.',
    ];
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Setup failed: ${(err as Error).message}` }],
    };
  }
}

export async function handleSetup(args: Record<string, unknown>): Promise<CallToolResult> {
  const parsed = SetupArgs.safeParse(args);
  if (!parsed.success) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Invalid arguments: ${parsed.error.issues.map((i) => i.message).join('; ')}` }],
    };
  }
  const { password } = parsed.data;
  return password ? handleFullSetup(password) : handleRefresh();
}
