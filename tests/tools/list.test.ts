import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/connection.js')>();
  return {
    ...actual,
    probeUsbHttp: vi.fn().mockResolvedValue({ available: true, documents: [
      { ID: 'a1', VissibleName: 'My Notes', Type: 'DocumentType', ModifiedClient: '2026-04-12T10:00:00Z', Parent: '' },
    ]}),
    selectDocument: vi.fn(),
    docName: vi.fn((d: { VissibleName: string }) => d.VissibleName),
  };
});

vi.mock('../../src/ssh.js', () => ({ sshExec: vi.fn() }));

vi.mock('../../src/config.js', () => ({
  readConfig: vi.fn().mockResolvedValue({
    connection: { usbHost: '10.11.99.1', wifiHost: '192.168.1.100', port: 22, username: 'root', privateKeyPath: '/tmp/key' },
    ocr: { provider: 'native' },
  }),
}));

import { parseDocuments, LIST_TOOL, handleList } from '../../src/tools/list.js';

describe('remarkable_list', () => {
  it('LIST_TOOL.name is remarkable_list', () => {
    expect(LIST_TOOL.name).toBe('remarkable_list');
  });

  it('parseDocuments returns only DocumentType entries', () => {
    const raw = [
      '---FILE:/xochitl/aaa.metadata',
      '{"visibleName":"My Notes","type":"DocumentType","lastModified":"2000"}',
      '---FILE:/xochitl/bbb.metadata',
      '{"visibleName":"Folder","type":"CollectionType","lastModified":"1000"}',
    ].join('\n');
    expect(parseDocuments(raw)).toHaveLength(1);
    expect(parseDocuments(raw)[0].name).toBe('My Notes');
  });

  it('parseDocuments sorts by lastModified descending', () => {
    const raw = [
      '---FILE:/xochitl/aaa.metadata',
      '{"visibleName":"Older","type":"DocumentType","lastModified":"1000"}',
      '---FILE:/xochitl/bbb.metadata',
      '{"visibleName":"Newer","type":"DocumentType","lastModified":"2000"}',
    ].join('\n');
    expect(parseDocuments(raw)[0].name).toBe('Newer');
  });

  it('parseDocuments skips malformed JSON', () => {
    const raw = ['---FILE:/xochitl/bad.metadata', 'not-json'].join('\n');
    expect(parseDocuments(raw)).toHaveLength(0);
  });
});

describe('handleList', () => {
  it('returns USB document list when USB available', async () => {
    const result = await handleList({});
    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('[via USB]');
    expect(text).toContain('My Notes');
  });

  it('uses SSH when USB unavailable', async () => {
    const { probeUsbHttp } = await import('../../src/connection.js');
    const { sshExec } = await import('../../src/ssh.js');
    vi.mocked(probeUsbHttp).mockResolvedValueOnce({ available: false, documents: [] });
    vi.mocked(sshExec).mockResolvedValueOnce(
      '---FILE:/xochitl/aaa.metadata\n{"visibleName":"WiFi Doc","type":"DocumentType","lastModified":"1000"}'
    );
    const result = await handleList({});
    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('[via SSH');
    expect(text).toContain('WiFi Doc');
  });

  it('returns error when both USB and SSH fail', async () => {
    const { probeUsbHttp } = await import('../../src/connection.js');
    const { sshExec } = await import('../../src/ssh.js');
    vi.mocked(probeUsbHttp).mockResolvedValueOnce({ available: false, documents: [] });
    vi.mocked(sshExec).mockRejectedValueOnce(new Error('timeout'));
    vi.mocked(sshExec).mockRejectedValueOnce(new Error('timeout'));
    const result = await handleList({});
    expect(result.isError).toBe(true);
  });
});
