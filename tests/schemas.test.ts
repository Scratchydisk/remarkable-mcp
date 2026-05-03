import { describe, it, expect } from 'vitest';
import { SetupArgs, ListArgs, PullArgs } from '../src/schemas.js';

describe('SetupArgs', () => {
  it('accepts no args (refresh mode)', () => {
    expect(SetupArgs.safeParse({}).success).toBe(true);
  });

  it('rejects an empty password (would otherwise tunnel to refresh mode silently)', () => {
    expect(SetupArgs.safeParse({ password: '' }).success).toBe(false);
  });

  it('accepts a non-empty password (full setup mode)', () => {
    const r = SetupArgs.safeParse({ password: 'x' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.password).toBe('x');
  });
});

describe('ListArgs', () => {
  it('accepts empty', () => {
    expect(ListArgs.safeParse({}).success).toBe(true);
  });

  it('accepts a folder string', () => {
    expect(ListArgs.safeParse({ folder: 'work' }).success).toBe(true);
  });

  it('rejects a numeric folder', () => {
    expect(ListArgs.safeParse({ folder: 5 }).success).toBe(false);
  });
});

describe('PullArgs', () => {
  it('coerces a numeric page to string', () => {
    const r = PullArgs.parse({ page: 5 });
    expect(r.page).toBe('5');
  });

  it('rejects max_width that is not a positive integer', () => {
    expect(PullArgs.safeParse({ max_width: -1 }).success).toBe(false);
    expect(PullArgs.safeParse({ max_width: 1.5 }).success).toBe(false);
    expect(PullArgs.safeParse({ max_width: 9999 }).success).toBe(false); // > 2160
  });

  it('rejects an unknown format', () => {
    expect(PullArgs.safeParse({ format: 'gif' }).success).toBe(false);
  });

  it('accepts the full happy-path payload', () => {
    const r = PullArgs.parse({
      document: 'notes',
      folder: 'work',
      page: '1-3',
      output_dir: '/tmp/out',
      prompt: 'transcribe please',
      max_width: 1024,
      format: 'jpeg',
    });
    expect(r.format).toBe('jpeg');
    expect(r.max_width).toBe(1024);
  });
});
