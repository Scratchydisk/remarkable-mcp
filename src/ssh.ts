import { Client, type ConnectConfig } from 'ssh2';
import { readFile, mkdir, access } from 'fs/promises';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { dirname } from 'path';
import { createHash } from 'crypto';
import { lookup } from 'dns/promises';
import { debug } from './debug.js';

/** Thrown by sshExec when the tablet's SSH host key didn't match the pinned fingerprint. */
export class HostKeyMismatchError extends Error {
  constructor(public expected: string, public actual: string, host: string) {
    super(`Host-key mismatch for ${host}: expected sha256:${expected.slice(0, 16)}…, got sha256:${actual.slice(0, 16)}…. The tablet may have been reflashed; re-run remarkable_setup over USB to re-pin.`);
    this.name = 'HostKeyMismatchError';
  }
}

/** Categorise an SSH error string into a user-actionable diagnostic. */
export function categoriseSshError(err: Error): string {
  if (err instanceof HostKeyMismatchError) return err.message;
  const m = err.message;
  if (/ETIMEDOUT|timed out/i.test(m)) return 'timeout — tablet may be asleep, off, or the saved WiFi IP is stale';
  if (/ECONNREFUSED/i.test(m))       return 'connection refused — SSH daemon not listening (tablet rebooting, or wrong IP)';
  if (/EHOSTUNREACH|ENETUNREACH/i.test(m)) return 'host unreachable — tablet not on the network or wrong IP';
  if (/authentication methods failed/i.test(m)) return 'auth failed — SSH key not deployed (run remarkable_setup over USB)';
  return m;
}

/** Try mDNS / Bonjour to locate the tablet by its default hostname. */
export async function resolveTabletMdns(hostname = 'remarkable.local'): Promise<string | null> {
  try {
    const { address } = await lookup(hostname, { family: 4 });
    debug('mdns: %s → %s', hostname, address);
    return address;
  } catch (err) {
    debug('mdns: %s lookup failed: %s', hostname, (err as Error).message);
    return null;
  }
}

const execFileAsync = promisify(execFile);

export interface SSHOptions {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  /** Pinned host-key fingerprint (sha256 hex). When set, connection fails if the host key doesn't match. */
  expectedHostKey?: string;
  /** Called with the actual fingerprint when expectedHostKey is unset (TOFU capture). */
  onHostKey?: (fingerprint: string) => void;
}

/** Compute the sha256 hex fingerprint of an SSH host public key buffer. */
export function fingerprintHostKey(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Side-channel for surfacing host-key mismatch out of the synchronous hostVerifier callback. */
interface MismatchCarrier { mismatch?: { expected: string; actual: string } }

export async function buildConnectOptions(opts: SSHOptions, carrier?: MismatchCarrier): Promise<ConnectConfig> {
  const config: ConnectConfig = {
    host: opts.host,
    port: opts.port,
    username: opts.username,
    readyTimeout: 15000,
    hostVerifier: (key: Buffer) => {
      const fp = fingerprintHostKey(key);
      if (opts.expectedHostKey) {
        const match = fp === opts.expectedHostKey;
        if (!match) {
          debug('host key mismatch for %s: expected %s got %s', opts.host, opts.expectedHostKey, fp);
          if (carrier) carrier.mismatch = { expected: opts.expectedHostKey, actual: fp };
        }
        return match;
      }
      // Trust on first use: capture fingerprint for the caller to persist.
      opts.onHostKey?.(fp);
      return true;
    },
  };
  if (opts.password) {
    config.password = opts.password;
  } else if (opts.privateKeyPath) {
    config.privateKey = await readFile(opts.privateKeyPath);
  }
  return config;
}

export async function sshExec(opts: SSHOptions, command: string, timeoutMs = 30000): Promise<string> {
  const carrier: MismatchCarrier = {};
  const connectConfig = await buildConnectOptions(opts, carrier);
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const fail = (err: Error) => {
      // If hostVerifier rejected with a mismatch, surface that as a typed error regardless of
      // what ssh2 wrapped the failure as ("All configured authentication methods failed", etc.).
      if (carrier.mismatch) reject(new HostKeyMismatchError(carrier.mismatch.expected, carrier.mismatch.actual, opts.host));
      else reject(err);
    };
    const timer = setTimeout(() => { conn.destroy(); fail(new Error(`SSH timed out: ${command}`)); }, timeoutMs);

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) { clearTimeout(timer); conn.end(); fail(err); return; }
        let stdout = '';
        let stderr = '';
        stream.on('data', (d: Buffer) => { stdout += d.toString(); });
        stream.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        stream.on('close', (code: number) => {
          clearTimeout(timer);
          conn.end();
          if (code !== 0) reject(new Error(`Exit ${code}: ${stderr.trim() || command}`));
          else resolve(stdout);
        });
      });
    });
    conn.on('error', (err: Error) => { clearTimeout(timer); fail(err); });
    conn.connect(connectConfig);
  });
}

export async function sshPipeTar(opts: SSHOptions, remoteCmd: string, localDir: string): Promise<void> {
  const carrier: MismatchCarrier = {};
  const connectConfig = await buildConnectOptions(opts, carrier);
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const tarProc = spawn('tar', ['xf', '-', '-C', localDir], { stdio: ['pipe', 'inherit', 'pipe'] });
    let tarError = '';
    tarProc.stderr?.on('data', (d: Buffer) => { tarError += d.toString(); });
    const timer = setTimeout(() => { conn.destroy(); tarProc.kill(); reject(new Error('sshPipeTar timed out')); }, 120000);

    const fail = (err: Error) => {
      if (carrier.mismatch) reject(new HostKeyMismatchError(carrier.mismatch.expected, carrier.mismatch.actual, opts.host));
      else reject(err);
    };
    conn.on('ready', () => {
      conn.exec(remoteCmd, (err, stream) => {
        if (err) { clearTimeout(timer); conn.end(); tarProc.kill(); fail(err); return; }
        stream.pipe(tarProc.stdin);
        stream.on('close', () => { conn.end(); tarProc.stdin.end(); });
        stream.stderr.on('data', () => {});
      });
    });
    conn.on('error', (err: Error) => { clearTimeout(timer); tarProc.kill(); fail(err); });
    tarProc.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`tar exited ${code}: ${tarError.trim()}`));
    });
    conn.connect(connectConfig);
  });
}

export async function generateKeyPair(keyPath: string): Promise<{ publicKey: string }> {
  await mkdir(dirname(keyPath), { recursive: true });
  let keyExists = false;
  try { await access(keyPath); keyExists = true; } catch { /* doesn't exist */ }
  if (!keyExists) {
    await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-q', '-C', 'remarkable-mcp'], { timeout: 10000 });
  }
  const publicKey = (await readFile(`${keyPath}.pub`, 'utf8')).trim();
  return { publicKey };
}

/**
 * Append our public key to the tablet's authorized_keys, idempotently.
 * Encodes the key as base64 to avoid any shell quoting concerns.
 */
export async function deployPublicKey(opts: SSHOptions, publicKey: string): Promise<void> {
  const b64 = Buffer.from(publicKey + '\n').toString('base64');
  // base64 alphabet is shell-safe ([A-Za-z0-9+/=]). Decode server-side and append only if not already present.
  const cmd =
    'mkdir -p /home/root/.ssh && chmod 700 /home/root/.ssh && ' +
    'touch /home/root/.ssh/authorized_keys && chmod 600 /home/root/.ssh/authorized_keys && ' +
    `KEY=$(echo ${b64} | base64 -d) && ` +
    'grep -qF "$KEY" /home/root/.ssh/authorized_keys || printf "%s" "$KEY" >> /home/root/.ssh/authorized_keys';
  await sshExec(opts, cmd);
}

/**
 * Enable the USB web interface on the tablet via SSH.
 * Modifies xochitl.conf and restarts the UI service.
 * Returns: 'already-enabled' | 'enabled' | 'failed'
 */
export async function enableUsbWebInterface(opts: SSHOptions): Promise<'already-enabled' | 'enabled' | 'failed'> {
  const conf = '/home/root/.config/remarkable/xochitl.conf';
  const script =
    `set -e; ` +
    `if grep -q '^WebInterfaceEnabled=true' ${conf} 2>/dev/null; then echo already-enabled; exit 0; fi; ` +
    `if grep -q '^WebInterfaceEnabled=' ${conf} 2>/dev/null; then ` +
    `  sed -i 's/^WebInterfaceEnabled=.*/WebInterfaceEnabled=true/' ${conf}; ` +
    `else ` +
    `  echo 'WebInterfaceEnabled=true' >> ${conf}; ` +
    `fi; ` +
    `systemctl restart xochitl && echo enabled || echo failed`;
  try {
    const out = await sshExec(opts, script, 15000);
    const status = out.trim().split('\n').pop() ?? '';
    if (status === 'already-enabled') return 'already-enabled';
    if (status === 'enabled') {
      // Give xochitl a moment to come back up before the HTTP probe.
      await new Promise((r) => setTimeout(r, 3000));
      return 'enabled';
    }
    return 'failed';
  } catch (err) {
    debug('enableUsbWebInterface failed: %s', (err as Error).message);
    return 'failed';
  }
}

/**
 * Get the tablet's current WiFi IP via `ip -4 addr show wlan0`.
 * Returns null if not connected to WiFi.
 */
export async function getWifiIp(opts: SSHOptions): Promise<string | null> {
  try {
    const out = await sshExec(opts, 'ip -4 addr show wlan0', 10000);
    const match = out.match(/inet (\d+\.\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch (err) {
    debug('getWifiIp failed: %s', (err as Error).message);
    return null;
  }
}
