import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/connection.js')>();
  return {
    ...actual,
    probeUsbHttp: vi.fn().mockResolvedValue({ available: true, documents: [
      { ID: '12345678-1234-1234-1234-123456789abc', VissibleName: 'My Notes', Type: 'DocumentType', ModifiedClient: '2026-04-12T10:00:00Z', Parent: '' },
    ]}),
    fetchAllDocuments: vi.fn().mockResolvedValue([
      { ID: '12345678-1234-1234-1234-123456789abc', VissibleName: 'My Notes', Type: 'DocumentType', ModifiedClient: '2026-04-12T10:00:00Z', Parent: '' },
    ]),
    selectDocument: vi.fn().mockReturnValue({ ID: '12345678-1234-1234-1234-123456789abc', VissibleName: 'My Notes', Type: 'DocumentType', ModifiedClient: '', Parent: '' }),
    downloadRmdoc: vi.fn().mockResolvedValue(Buffer.from('fake-zip')),
    extractRmdoc: vi.fn().mockResolvedValue(undefined),
    downloadThumbnail: vi.fn().mockResolvedValue(Buffer.from('fake-thumb')),
    docName: vi.fn().mockReturnValue('My Notes'),
  };
});

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

import { PULL_TOOL, handlePull } from '../../src/tools/pull.js';

describe('remarkable_pull', () => {
  it('PULL_TOOL.name is remarkable_pull', () => {
    expect(PULL_TOOL.name).toBe('remarkable_pull');
  });
});

describe('handlePull', () => {
  it('returns image content on USB path', async () => {
    const result = await handlePull({});
    expect(result.isError).toBeFalsy();
    const imageBlock = result.content.find((c) => c.type === 'image');
    expect(imageBlock).toBeDefined();
    expect((imageBlock as { data: string }).data).toBe('abc');
  });

  it('returns isError when no document matches', async () => {
    const { selectDocument } = await import('../../src/connection.js');
    vi.mocked(selectDocument).mockReturnValueOnce(undefined);
    const result = await handlePull({ document: 'nonexistent' });
    expect(result.isError).toBe(true);
  });

  it('returns isError when no connection', async () => {
    const { probeUsbHttp } = await import('../../src/connection.js');
    const { sshExec } = await import('../../src/ssh.js');
    vi.mocked(probeUsbHttp).mockResolvedValueOnce({ available: false, documents: [] });
    vi.mocked(sshExec).mockRejectedValueOnce(new Error('timeout'));
    vi.mocked(sshExec).mockRejectedValueOnce(new Error('timeout'));
    const result = await handlePull({});
    expect(result.isError).toBe(true);
  });
});
