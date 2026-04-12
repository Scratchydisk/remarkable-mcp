import { describe, it, expect, vi, beforeEach } from 'vitest';

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
}));

vi.mock('../../src/config.js', () => ({
  writeConfig: vi.fn().mockResolvedValue(undefined),
  CONFIG_DIR: '/tmp/test-config',
  buildDefaultConfig: vi.fn().mockReturnValue({
    connection: { usbHost: '10.11.99.1', wifiHost: '', port: 22, username: 'root', privateKeyPath: '/tmp/key' },
    ocr: { provider: 'native' },
  }),
}));

import { handleSetup, SETUP_TOOL } from '../../src/tools/setup.js';

describe('remarkable_setup', () => {
  it('SETUP_TOOL.name is remarkable_setup', () => {
    expect(SETUP_TOOL.name).toBe('remarkable_setup');
  });

  it('returns error when password missing', async () => {
    const result = await handleSetup({});
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('password');
  });

  it('deploys SSH key on success', async () => {
    const { deployPublicKey } = await import('../../src/ssh.js');
    await handleSetup({ password: 'secret' });
    expect(deployPublicKey).toHaveBeenCalled();
  });

  it('writes config on success', async () => {
    const { writeConfig } = await import('../../src/config.js');
    await handleSetup({ password: 'secret' });
    expect(writeConfig).toHaveBeenCalled();
  });

  it('returns success text', async () => {
    const result = await handleSetup({ password: 'secret' });
    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toContain('complete');
  });
});
