import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/connection.js', () => ({
  probeUsbHttp: vi.fn().mockResolvedValue({ available: true, documents: [] }),
  USB_IP: '10.11.99.1',
}));

vi.mock('../../src/ssh.js', () => ({
  sshExec: vi.fn().mockResolvedValue(''),
  generateKeyPair: vi.fn().mockResolvedValue({ publicKey: 'ssh-ed25519 AAAA test' }),
  deployPublicKey: vi.fn().mockResolvedValue(undefined),
  enableUsbWebInterface: vi.fn().mockResolvedValue('already-enabled'),
  getWifiIp: vi.fn().mockResolvedValue('192.168.1.50'),
  resolveTabletMdns: vi.fn().mockResolvedValue(null),
  categoriseSshError: (e: Error) => e.message,
}));

vi.mock('../../src/config.js', () => ({
  readConfig: vi.fn().mockResolvedValue({
    connection: { usbHost: '10.11.99.1', wifiHost: '192.168.1.40', port: 22, username: 'root', privateKeyPath: '/tmp/key', hostKey: 'abc' },
    ocr: { provider: 'native' },
    render: { width: 1024, format: 'png', jpegQuality: 80 },
  }),
  writeConfig: vi.fn().mockResolvedValue(undefined),
  CONFIG_DIR: '/tmp/test-config',
  buildDefaultConfig: vi.fn().mockReturnValue({
    connection: { usbHost: '10.11.99.1', wifiHost: '', port: 22, username: 'root', privateKeyPath: '/tmp/key' },
    ocr: { provider: 'native' },
    render: { width: 1024, format: 'png', jpegQuality: 80 },
  }),
}));

import { handleSetup, SETUP_TOOL } from '../../src/tools/setup.js';

describe('remarkable_setup', () => {
  it('SETUP_TOOL.name is remarkable_setup', () => {
    expect(SETUP_TOOL.name).toBe('remarkable_setup');
  });

  it('rejects an empty-string password (validation error)', async () => {
    const result = await handleSetup({ password: '' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('Invalid arguments');
  });

  it('full setup deploys SSH key when password is provided', async () => {
    const { deployPublicKey } = await import('../../src/ssh.js');
    vi.mocked(deployPublicKey).mockClear();
    await handleSetup({ password: 'secret' });
    expect(deployPublicKey).toHaveBeenCalled();
  });

  it('full setup writes config on success', async () => {
    const { writeConfig } = await import('../../src/config.js');
    vi.mocked(writeConfig).mockClear();
    await handleSetup({ password: 'secret' });
    expect(writeConfig).toHaveBeenCalled();
  });

  it('full setup returns success text', async () => {
    const result = await handleSetup({ password: 'secret' });
    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toContain('complete');
  });

  it('refresh mode (no password) does NOT deploy a new key', async () => {
    const { deployPublicKey, sshExec, getWifiIp } = await import('../../src/ssh.js');
    vi.mocked(deployPublicKey).mockClear();
    vi.mocked(sshExec).mockResolvedValueOnce('');
    vi.mocked(getWifiIp).mockResolvedValueOnce('192.168.1.99');
    const result = await handleSetup({});
    expect(deployPublicKey).not.toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toContain('Refresh complete');
  });

  it('refresh mode reports updated WiFi IP when it changes', async () => {
    const { sshExec, getWifiIp } = await import('../../src/ssh.js');
    vi.mocked(sshExec).mockResolvedValueOnce('');
    vi.mocked(getWifiIp).mockResolvedValueOnce('192.168.1.77');
    const result = await handleSetup({});
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('192.168.1.40 → 192.168.1.77');
  });

  it('refresh mode returns isError when no SSH host is reachable', async () => {
    const { sshExec } = await import('../../src/ssh.js');
    vi.mocked(sshExec).mockRejectedValue(new Error('ETIMEDOUT'));
    const result = await handleSetup({});
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('Refresh failed');
  });
});
