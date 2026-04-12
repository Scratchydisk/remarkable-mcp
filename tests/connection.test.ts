import { describe, it, expect, vi } from 'vitest';
import { selectDocument, docName } from '../src/connection.js';

describe('selectDocument', () => {
  const docs = [
    { ID: 'a1', VissibleName: 'Meeting Notes', Type: 'DocumentType', ModifiedClient: '2026-04-12T10:00:00Z', Parent: '' },
    { ID: 'b2', VissibleName: 'Architecture', Type: 'DocumentType', ModifiedClient: '2026-04-11T09:00:00Z', Parent: '' },
    { ID: 'c3', VissibleName: 'My Folder',    Type: 'CollectionType', ModifiedClient: '2026-04-10T08:00:00Z', Parent: '' },
  ];

  it('returns most recent DocumentType when no name given', () => {
    expect(selectDocument(docs, undefined)?.ID).toBe('a1');
  });

  it('matches by substring case-insensitively', () => {
    expect(selectDocument(docs, 'arch')?.ID).toBe('b2');
  });

  it('excludes CollectionType folders', () => {
    expect(selectDocument(docs, 'folder')).toBeUndefined();
  });

  it('returns undefined when no match', () => {
    expect(selectDocument(docs, 'zzz')).toBeUndefined();
  });
});

describe('docName', () => {
  it('returns VissibleName (API typo)', () => {
    expect(docName({ ID: 'x', VissibleName: 'Test', Type: 'DocumentType', ModifiedClient: '', Parent: '' })).toBe('Test');
  });

  it('falls back to empty string', () => {
    expect(docName({ ID: 'x', VissibleName: '', Type: 'DocumentType', ModifiedClient: '', Parent: '' })).toBe('');
  });
});
