import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const tmpRoot = await mkdtemp(join(tmpdir(), 'rm-search-test-'));
process.env.REMARKABLE_CACHE_DIR = tmpRoot;

const { replaceDocPages, removeDocPages, searchPages, indexSize, _resetForTests } = await import('../src/search.js');

afterAll(async () => { await rm(tmpRoot, { recursive: true, force: true }); });

describe('search', () => {
  beforeEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
    _resetForTests();
  });

  it('starts empty', async () => {
    expect(await indexSize()).toBe(0);
    expect(await searchPages('anything')).toEqual([]);
  });

  it('indexes a doc and finds a content match', async () => {
    await replaceDocPages('doc-a', 'Project Notes', 'Work', [], [
      { pageNum: 1, text: 'Discussed the kafka migration timeline with the team.' },
      { pageNum: 2, text: 'Action items: write the rfc and review by Friday.' },
    ]);
    const hits = await searchPages('kafka');
    expect(hits.length).toBe(1);
    expect(hits[0].docId).toBe('doc-a');
    expect(hits[0].pageNum).toBe(1);
    expect(hits[0].snippet).toContain('kafka');
  });

  it('ranks doc-name matches above body matches via field boosting', async () => {
    await replaceDocPages('doc-a', 'Random Notes', 'Work', [], [{ pageNum: 1, text: 'a passing mention of kafka' }]);
    await replaceDocPages('doc-b', 'Kafka Migration Plan', 'Work', [], [{ pageNum: 1, text: 'unrelated body text here' }]);
    const hits = await searchPages('kafka');
    expect(hits[0].docId).toBe('doc-b');
  });

  it('respects the folder filter', async () => {
    await replaceDocPages('doc-a', 'Notes', 'Work / Engineering', [], [{ pageNum: 1, text: 'kafka' }]);
    await replaceDocPages('doc-b', 'Notes', 'Personal', [], [{ pageNum: 1, text: 'kafka' }]);
    const work = await searchPages('kafka', { folder: 'engineering' });
    expect(work.length).toBe(1);
    expect(work[0].docId).toBe('doc-a');
  });

  it('skips pages with empty OCR text', async () => {
    await replaceDocPages('doc-a', 'Notes', 'Work', [], [
      { pageNum: 1, text: 'kafka' },
      { pageNum: 2, text: '' },
      { pageNum: 3, text: '   ' },
    ]);
    expect(await indexSize()).toBe(1);
  });

  it('replacing doc pages drops stale entries', async () => {
    await replaceDocPages('doc-a', 'Notes', 'Work', [], [
      { pageNum: 1, text: 'old content about kafka' },
      { pageNum: 2, text: 'old content about pulsar' },
    ]);
    expect(await indexSize()).toBe(2);

    await replaceDocPages('doc-a', 'Notes', 'Work', [1, 2], [
      { pageNum: 1, text: 'new content about rabbitmq' },
    ]);
    expect(await indexSize()).toBe(1);
    expect((await searchPages('kafka')).length).toBe(0);
    expect((await searchPages('rabbitmq')).length).toBe(1);
  });

  it('removeDocPages drops every entry for that doc', async () => {
    await replaceDocPages('doc-a', 'Notes', 'Work', [], [
      { pageNum: 1, text: 'kafka' },
      { pageNum: 2, text: 'pulsar' },
    ]);
    await removeDocPages('doc-a', [1, 2]);
    expect(await indexSize()).toBe(0);
  });

  it('persists to disk and reloads', async () => {
    await replaceDocPages('doc-a', 'Notes', 'Work', [], [{ pageNum: 1, text: 'kafka migration' }]);
    _resetForTests();
    const hits = await searchPages('kafka');
    expect(hits.length).toBe(1);
    expect(hits[0].docId).toBe('doc-a');
  });

  it('returns prefix matches', async () => {
    await replaceDocPages('doc-a', 'Notes', 'Work', [], [{ pageNum: 1, text: 'production deployment' }]);
    const hits = await searchPages('deploy');
    expect(hits.length).toBe(1);
  });
});
