import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtemp, rm, readdir, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const tmpRoot = await mkdtemp(join(tmpdir(), 'rm-cache-test-'));
process.env.REMARKABLE_CACHE_DIR = tmpRoot;

const { mtimeKey, docCacheDir, hasCompleteCache, markComplete, sweepStaleMtimes, prepareSourceDir } = await import('../src/cache.js');

afterAll(async () => { await rm(tmpRoot, { recursive: true, force: true }); });

describe('mtimeKey', () => {
  it('passes numbers through', () => {
    expect(mtimeKey(1700000000000)).toBe('1700000000000');
  });

  it('converts dates to epoch ms', () => {
    expect(mtimeKey(new Date(1700000000000))).toBe('1700000000000');
  });

  it('strips filesystem-unsafe characters from strings', () => {
    expect(mtimeKey('2026-04-12T10:00:00Z')).toBe('2026-04-12T100000Z');
  });
});

describe('cache lifecycle', () => {
  beforeEach(async () => {
    // start each test with a clean tmpRoot
    await rm(tmpRoot, { recursive: true, force: true });
    await mkdir(tmpRoot, { recursive: true });
  });

  it('hasCompleteCache returns false when no sentinel', async () => {
    expect(await hasCompleteCache('doc-a', '111')).toBe(false);
  });

  it('hasCompleteCache returns true after markComplete', async () => {
    await markComplete('doc-a', '111');
    expect(await hasCompleteCache('doc-a', '111')).toBe(true);
  });

  it('prepareSourceDir creates the source directory', async () => {
    const dir = await prepareSourceDir('doc-a', '111');
    expect(dir).toBe(join(docCacheDir('doc-a', '111'), 'source'));
    await writeFile(join(dir, 'test.rm'), 'data');
  });

  it('sweepStaleMtimes removes other mtime dirs but keeps the current one', async () => {
    await markComplete('doc-a', '111');
    await markComplete('doc-a', '222');
    await markComplete('doc-a', '333');
    await sweepStaleMtimes('doc-a', '222');
    const remaining = await readdir(join(tmpRoot, 'doc-a'));
    expect(remaining.sort()).toEqual(['222']);
  });

  it('sweepStaleMtimes is a no-op when the docId has no cache yet', async () => {
    await sweepStaleMtimes('never-cached', '111');
    // should not throw
  });
});
