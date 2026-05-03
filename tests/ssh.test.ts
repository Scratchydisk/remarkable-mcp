import { describe, it, expect, vi } from 'vitest';

vi.mock('ssh2', () => {
  const mockConn = {
    on: vi.fn().mockReturnThis(),
    exec: vi.fn(),
    connect: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
  };
  return { Client: vi.fn(() => mockConn) };
});

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, readFile: vi.fn(), mkdir: vi.fn() };
});

import { buildConnectOptions, categoriseSshError, HostKeyMismatchError } from '../src/ssh.js';

describe('categoriseSshError', () => {
  it('flags timeout', () => {
    expect(categoriseSshError(new Error('connect ETIMEDOUT 192.168.1.50:22'))).toContain('timeout');
  });

  it('flags connection refused', () => {
    expect(categoriseSshError(new Error('connect ECONNREFUSED'))).toContain('refused');
  });

  it('flags host unreachable', () => {
    expect(categoriseSshError(new Error('connect EHOSTUNREACH'))).toContain('unreachable');
  });

  it('flags auth failure as missing key', () => {
    expect(categoriseSshError(new Error('All configured authentication methods failed'))).toContain('SSH key not deployed');
  });

  it('returns the HostKeyMismatch message verbatim', () => {
    const err = new HostKeyMismatchError('a'.repeat(64), 'b'.repeat(64), '192.168.1.50');
    expect(categoriseSshError(err)).toContain('Host-key mismatch');
    expect(categoriseSshError(err)).toContain('reflashed');
  });

  it('passes unknown errors through', () => {
    expect(categoriseSshError(new Error('something weird'))).toBe('something weird');
  });
});

describe('ssh', () => {
  it('sets host, port, username', async () => {
    const opts = await buildConnectOptions({ host: '10.11.99.1', port: 22, username: 'root', password: 'pw' });
    expect(opts.host).toBe('10.11.99.1');
    expect(opts.port).toBe(22);
    expect(opts.username).toBe('root');
  });

  it('uses password when provided', async () => {
    const opts = await buildConnectOptions({ host: '10.11.99.1', port: 22, username: 'root', password: 'pw' });
    expect(opts.password).toBe('pw');
    expect(opts.privateKey).toBeUndefined();
  });

  it('reads privateKey from file when no password', async () => {
    const { readFile } = await import('fs/promises');
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.from('fake-key') as never);
    const opts = await buildConnectOptions({ host: '10.11.99.1', port: 22, username: 'root', privateKeyPath: '/tmp/key' });
    expect(opts.privateKey).toBeDefined();
    expect(readFile).toHaveBeenCalledWith('/tmp/key');
  });
});
