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
  renderPages: vi.fn().mockResolvedValue({
    rendered: [{ pageNum: 1, localPath: '/tmp/p.png', format: 'png' }],
    missing: [],
  }),
  selectPageIds: vi.fn().mockReturnValue(['uuid-1']),
  mimeForFormat: (f: string) => f === 'jpeg' ? 'image/jpeg' : 'image/png',
}));

vi.mock('../../src/ocr.js', () => ({
  processPage: vi.fn().mockResolvedValue({ pageNum: 1, text: '', imageBase64: 'abc', renderFormat: 'png' }),
}));

vi.mock('../../src/cache.js', () => ({
  hasCompleteCache: vi.fn().mockResolvedValue(false),
  prepareSourceDir: vi.fn().mockResolvedValue('/tmp/cache-src'),
  sourceDir: vi.fn().mockReturnValue('/tmp/cache-src'),
  markComplete: vi.fn().mockResolvedValue(undefined),
  sweepStaleMtimes: vi.fn().mockResolvedValue(undefined),
  writePageText: vi.fn().mockResolvedValue(undefined),
  writeDocMeta: vi.fn().mockResolvedValue(undefined),
  readDocMeta: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/search.js', () => ({
  replaceDocPages: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/config.js', () => ({
  readConfig: vi.fn().mockResolvedValue({
    connection: { usbHost: '10.11.99.1', wifiHost: '192.168.1.100', port: 22, username: 'root', privateKeyPath: '/tmp/key' },
    ocr: { provider: 'native' },
    render: { width: 1024, format: 'png', jpegQuality: 80 },
  }),
}));

vi.mock('../../src/ssh.js', () => ({
  sshExec: vi.fn(),
  sshPipeTar: vi.fn(),
  resolveTabletMdns: vi.fn().mockResolvedValue(null),
  categoriseSshError: (e: Error) => e.message,
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    mkdtemp: vi.fn().mockResolvedValue('/tmp/rm-test'),
    readFile: vi.fn().mockResolvedValue('{"cPages":{"pages":[{"id":"uuid-1"}]}}'),
    rm: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    copyFile: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ size: 1000 }),
  };
});

import { PULL_TOOL, handlePull, planInlinePages } from '../../src/tools/pull.js';

describe('planInlinePages', () => {
  it('inlines all pages when total fits the budget', () => {
    expect(planInlinePages([100, 200, 300], 1000)).toBe(3);
  });

  it('drops pages once running total would exceed the budget', () => {
    expect(planInlinePages([400, 400, 400], 900)).toBe(2);
  });

  it('always returns at least 1 even when a single page exceeds the budget', () => {
    expect(planInlinePages([5_000_000], 1_000_000)).toBe(1);
  });
});

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

  it('marks cache complete when no pages are missing', async () => {
    const cache = await import('../../src/cache.js');
    vi.mocked(cache.markComplete).mockClear();
    await handlePull({});
    expect(cache.markComplete).toHaveBeenCalled();
  });

  it('does NOT mark cache complete when pages are missing', async () => {
    const cache = await import('../../src/cache.js');
    const render = await import('../../src/render.js');
    vi.mocked(cache.markComplete).mockClear();
    vi.mocked(render.renderPages).mockResolvedValueOnce({
      rendered: [{ pageNum: 1, localPath: '/tmp/p.png', format: 'png' }],
      missing: [2],
    });
    const result = await handlePull({});
    expect(cache.markComplete).not.toHaveBeenCalled();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Page(s) 2 had no saved data');
  });

  it('skips download when cache is complete', async () => {
    const cache = await import('../../src/cache.js');
    const conn = await import('../../src/connection.js');
    vi.mocked(cache.hasCompleteCache).mockResolvedValueOnce(true);
    vi.mocked(conn.downloadRmdoc).mockClear();
    const result = await handlePull({});
    expect(conn.downloadRmdoc).not.toHaveBeenCalled();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('cache');
  });

  it('rejects invalid arguments via zod', async () => {
    const result = await handlePull({ max_width: 'huge' });
    expect(result.isError).toBe(true);
  });

  it('rejects inline_images=false without output_dir', async () => {
    const result = await handlePull({ inline_images: false });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('output_dir');
  });

  it('inline_images=false returns saved paths but no image blocks', async () => {
    const result = await handlePull({ inline_images: false, output_dir: '/tmp/out' });
    expect(result.isError).toBeFalsy();
    expect(result.content.find((c) => c.type === 'image')).toBeUndefined();
    const text = result.content.map((c) => (c as { text?: string }).text).filter(Boolean).join('\n');
    expect(text).toContain('Inline images disabled');
    expect(text).toContain('Saved:');
  });

  it('returns isError when no document matches', async () => {
    const { fetchAllDocuments } = await import('../../src/connection.js');
    vi.mocked(fetchAllDocuments).mockResolvedValueOnce([]);
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
