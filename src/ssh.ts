import { Client, type ConnectConfig } from 'ssh2';
import { readFile, mkdir } from 'fs/promises';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { dirname } from 'path';

const execFileAsync = promisify(execFile);

export interface SSHOptions {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
}

export async function buildConnectOptions(opts: SSHOptions): Promise<ConnectConfig> {
  const config: ConnectConfig = {
    host: opts.host,
    port: opts.port,
    username: opts.username,
    readyTimeout: 15000,
    hostVerifier: () => true,
  };
  if (opts.password) {
    config.password = opts.password;
  } else if (opts.privateKeyPath) {
    config.privateKey = await readFile(opts.privateKeyPath);
  }
  return config;
}

export async function sshExec(opts: SSHOptions, command: string, timeoutMs = 30000): Promise<string> {
  const connectConfig = await buildConnectOptions(opts);
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const timer = setTimeout(() => { conn.destroy(); reject(new Error(`SSH timed out: ${command}`)); }, timeoutMs);

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) { clearTimeout(timer); conn.end(); reject(err); return; }
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
    conn.on('error', (err: Error) => { clearTimeout(timer); reject(err); });
    conn.connect(connectConfig);
  });
}

export async function sshPipeTar(opts: SSHOptions, remoteCmd: string, localDir: string): Promise<void> {
  const connectConfig = await buildConnectOptions(opts);
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const tarProc = spawn('tar', ['xf', '-', '-C', localDir], { stdio: ['pipe', 'inherit', 'pipe'] });
    let tarError = '';
    tarProc.stderr?.on('data', (d: Buffer) => { tarError += d.toString(); });
    const timer = setTimeout(() => { conn.destroy(); tarProc.kill(); reject(new Error('sshPipeTar timed out')); }, 120000);

    conn.on('ready', () => {
      conn.exec(remoteCmd, (err, stream) => {
        if (err) { conn.end(); reject(err); return; }
        stream.pipe(tarProc.stdin);
        stream.on('close', () => { conn.end(); tarProc.stdin.end(); });
        stream.stderr.on('data', () => {});
      });
    });
    conn.on('error', (err: Error) => { tarProc.kill(); reject(err); });
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
  await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-q', '-C', 'remarkable-mcr'], { timeout: 10000 });
  const publicKey = (await readFile(`${keyPath}.pub`, 'utf8')).trim();
  return { publicKey };
}

export async function deployPublicKey(opts: SSHOptions, publicKey: string): Promise<void> {
  const escaped = publicKey.replace(/'/g, "'\\''");
  await sshExec(opts, `mkdir -p /home/root/.ssh && chmod 700 /home/root/.ssh`);
  await sshExec(opts, `echo '${escaped}' >> /home/root/.ssh/authorized_keys && chmod 600 /home/root/.ssh/authorized_keys`);
}

/**
 * Enable the USB web interface on the tablet via SSH.
 * Modifies xochitl.conf and restarts the UI service.
 * Returns: 'already-enabled' | 'enabled' | 'failed'
 */
export async function enableUsbWebInterface(opts: SSHOptions): Promise<'already-enabled' | 'enabled' | 'failed'> {
  try {
    const out = await sshExec(
      opts,
      "if grep -q 'WebInterfaceEnabled=true' /home/root/.config/remarkable/xochitl.conf; then echo already-enabled; " +
      "else grep -q 'WebInterfaceEnabled' /home/root/.config/remarkable/xochitl.conf " +
      "&& sed -i 's/WebInterfaceEnabled=false/WebInterfaceEnabled=true/' /home/root/.config/remarkable/xochitl.conf " +
      "|| echo 'WebInterfaceEnabled=true' >> /home/root/.config/remarkable/xochitl.conf; " +
      "systemctl restart xochitl && echo enabled || echo failed; fi",
      15000,
    );
    const status = out.trim();
    if (status === 'already-enabled') return 'already-enabled';
    if (status === 'failed') return 'failed';
    // Give xochitl 3 seconds to restart before HTTP probe
    await new Promise((r) => setTimeout(r, 3000));
    return 'enabled';
  } catch {
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
  } catch {
    return null;
  }
}
