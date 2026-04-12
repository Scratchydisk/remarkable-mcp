import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/connection.js', () => ({
  probeUsbHttp: vi.fn().mockResolvedValue({ available: true, documents: [
    { ID: 'a1', VissibleName: 'My Notes', Type: 'DocumentType', ModifiedClient: '2026-04-12T10:00:00Z', Parent: '' },
  ]}),
  selectDocument: vi.fn().mockReturnValue({ ID: 'a1', VissibleName: 'My Notes', Type: 'DocumentType', ModifiedClient: '', Parent: '' }),
  downloadRmdoc: vi.fn().mockResolvedValue(Buffer.from('fake-zip')),
  extractRmdoc: vi.fn().mockResolvedValue(undefined),
  downloadThumbnail: vi.fn().mockResolvedValue(Buffer.from('fake-thumb')),
  docName: vi.fn().mockReturnValue('My Notes'),
  USB_IP: '10.11.99.1',
}));

vi.mock('../../src/render.js', () => ({
  renderPages: vi.fn().mockResolvedValue([{ pageNum: 1, localPath: '/tmp/p.png', format: 'png' }]),
  selectPageIds: vi.fn().mockReturnValue(['uuid-1']),
}));

vi.mock('../../src/ocr.js', () => ({
  processPage: vi.fn().mockResolvedValue({ pageNum: 1, text: '', imageBase64: 'abc', renderFormat: 'png' }),
}));

vi.mock('../../src/config.js', () => ({
  readConfig: vi.fn().mockResolvedValue({
    connection: { usbHost: '10.11.99.1', wifiHost: '192.168.1.100', port: 22, username: 'root', privateKeyPath: '/tmp/key' },
    ocr: { provider: 'native' },
  }),
}));

vi.mock('../../src/ssh.js', () => ({ sshExec: vi.fn(), sshPipeTar: vi.fn() }));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    mkdtemp: vi.fn().mockResolvedValue('/tmp/rm-test'),
    readFile: vi.fn().mockResolvedValue('{"cPages":{"pages":[{"id":"uuid-1"}]}}'),
    rm: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
  };
});

import { PULL_TOOL } from '../../src/tools/pull.js';

describe('remarkable_pull', () => {
  it('PULL_TOOL.name is remarkable_pull', () => {
    expect(PULL_TOOL.name).toBe('remarkable_pull');
  });
});
