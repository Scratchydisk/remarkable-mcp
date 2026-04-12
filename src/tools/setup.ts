import { join } from 'path';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { buildDefaultConfig, writeConfig, CONFIG_DIR } from '../config.js';
import { sshExec, generateKeyPair, deployPublicKey, enableUsbWebInterface, getWifiIp } from '../ssh.js';
import { probeUsbHttp, USB_IP } from '../connection.js';

export const SETUP_TOOL: Tool = {
  name: 'remarkable_setup',
  description:
    'First-time setup for reMarkable tablet access. Connects via USB (10.11.99.1), deploys an SSH keypair ' +
    'for WiFi use, enables the USB web interface, and discovers the WiFi IP. ' +
    'The root password is shown on-tablet under Settings → Help → Copyright and licenses.',
  inputSchema: {
    type: 'object',
    properties: {
      password: { type: 'string', description: 'Root password from Settings → Help → Copyright and licenses' },
    },
    required: ['password'],
  },
};

export async function handleSetup(args: Record<string, unknown>): Promise<CallToolResult> {
  const password = args.password as string | undefined;
  if (!password) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'password is required. Find it on the tablet: Settings → Help → Copyright and licenses.' }],
    };
  }

  const usbOpts = { host: USB_IP, port: 22, username: 'root', password };
  const keyPath = join(CONFIG_DIR, 'id_ed25519');

  try {
    // 1. Generate and deploy SSH keypair (needed for WiFi use)
    const { publicKey } = await generateKeyPair(keyPath);
    await deployPublicKey(usbOpts, publicKey);

    // 2. Enable USB web interface (idempotent)
    const keyOpts = { host: USB_IP, port: 22, username: 'root', privateKeyPath: keyPath };
    const webIfaceStatus = await enableUsbWebInterface(keyOpts);

    // 3. Verify HTTP web interface is now up
    const { available } = await probeUsbHttp();

    // 4. Discover WiFi IP
    const wifiIp = await getWifiIp(keyOpts);

    // 5. Save config
    const config = buildDefaultConfig(CONFIG_DIR);
    config.connection.wifiHost = wifiIp ?? '';
    config.connection.privateKeyPath = keyPath;
    await writeConfig(config);

    const lines = [
      'reMarkable setup complete.',
      `SSH keypair saved to ${keyPath}.`,
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
