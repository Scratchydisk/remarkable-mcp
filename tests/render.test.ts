import { describe, it, expect, vi } from 'vitest';

vi.mock('remarkable-rm', () => ({
  renderToPng: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  renderToJpeg: vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6])),
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, readdir: vi.fn(), access: vi.fn(), writeFile: vi.fn() };
});

import { selectPageIds } from '../src/render.js';

describe('render', () => {
  it('parses cPages format', () => {
    expect(selectPageIds({ cPages: { pages: [{ id: 'aaa' }, { id: 'bbb' }] } })).toEqual(['aaa', 'bbb']);
  });

  it('parses flat pages array', () => {
    expect(selectPageIds({ pages: ['ccc', 'ddd'] })).toEqual(['ccc', 'ddd']);
  });

  it('returns empty for unknown format', () => {
    expect(selectPageIds({})).toEqual([]);
  });

  it('drops cPages entries without id', () => {
    expect(selectPageIds({ cPages: { pages: [{ id: 'aaa' }, {}] } })).toEqual(['aaa']);
  });

  it('handles cPages string entries', () => {
    expect(selectPageIds({ cPages: { pages: ['xxx', { id: 'yyy' }] } })).toEqual(['xxx', 'yyy']);
  });
});
