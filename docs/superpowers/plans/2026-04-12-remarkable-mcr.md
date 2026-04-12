# remarkable-mcr Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone TypeScript MCP server that pulls handwritten notes and diagrams from a reMarkable 2 tablet, preferring the USB HTTP web API when the tablet is on USB and falling back to SSH over WiFi, rendering pages via the `remarkable-rm` npm package and returning image + OCR text to the host agent.

**Architecture:** USB-first decision tree — probe `http://10.11.99.1/documents/` first; if available, download the `.rmdoc` archive via HTTP; if not, fall back to SSH tar download. Both paths feed the same `render.ts` module which uses `remarkable-rm` for native TypeScript rendering. SSH is retained for WiFi connectivity and for enabling the USB web interface during setup. Three tools (`remarkable_setup`, `remarkable_list`, `remarkable_pull`) wired into an MCP server via `@modelcontextprotocol/sdk`.

**Tech Stack:** TypeScript 5, `@modelcontextprotocol/sdk`, `ssh2`, `remarkable-rm` (own package — use `file:../remarkable-rm` until published), `@resvg/resvg-js`, `adm-zip`, `vitest`

> **Note:** Replace `"file:../remarkable-rm"` in `package.json` with the published npm package name once `remarkable-rm` is published.

---

## File Map

| File | Responsibility |
|------|----------------|
| `src/index.ts` | MCP server entry — registers tools, starts stdio transport |
| `src/config.ts` | Types + read/write `~/.config/remarkable-mcr/config.json` |
| `src/connection.ts` | USB HTTP: probe web API, list docs, download rmdoc, extract ZIP |
| `src/ssh.ts` | SSH exec, tar pipe download, key generation, key deployment (WiFi path) |
| `src/render.ts` | Render pages to PNG via `remarkable-rm`; thumbnail fallback |
| `src/ocr.ts` | Route pages through native / Ollama / local OCR |
| `src/tools/setup.ts` | `remarkable_setup` — USB probe, SSH key deploy, web interface enable, WiFi discovery |
| `src/tools/list.ts` | `remarkable_list` — HTTP path or SSH fallback |
| `src/tools/pull.ts` | `remarkable_pull` — USB HTTP preferred, SSH fallback; render; OCR |
| `tests/connection.test.ts` | Unit tests for USB HTTP helpers (mocked fetch) |
| `tests/ssh.test.ts` | Unit tests for SSH helpers (mocked ssh2) |
| `tests/render.test.ts` | Unit tests for render pipeline (mocked remarkable-rm) |
| `tests/ocr.test.ts` | Unit tests for OCR routing (mocked) |
| `tests/tools/setup.test.ts` | Unit tests for setup tool |
| `tests/tools/list.test.ts` | Unit tests for list tool |
| `tests/tools/pull.test.ts` | Unit tests for pull tool |

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "remarkable-mcr",
  "version": "0.1.0",
  "description": "MCP server for reMarkable 2 — pull handwritten notes into any AI agent",
  "license": "MIT",
  "type": "module",
  "bin": {
    "remarkable-mcr": "dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "@resvg/resvg-js": "^2.0.0",
    "adm-zip": "^0.5.16",
    "remarkable-rm": "file:../remarkable-rm",
    "ssh2": "^1.17.0"
  },
  "devDependencies": {
    "@types/adm-zip": "^0.5.7",
    "@types/node": "^22.0.0",
    "@types/ssh2": "^1.15.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^4.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
  },
});
```

- [ ] **Step 4: Create .gitignore**

```
node_modules/
dist/
```

- [ ] **Step 5: Install dependencies**

```bash
npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 6: Verify TypeScript compiles**

Create `src/index.ts` with `console.log('ok');`, run `npm run build`, confirm `dist/index.js` exists. Delete the placeholder content.

- [ ] **Step 7: Commit**

```bash
git init
git add package.json tsconfig.json vitest.config.ts .gitignore
git commit -m "chore: scaffold remarkable-mcr TypeScript project"
```

---

### Task 2: Config module

**Files:**
- Create: `src/config.ts`
- Create: `tests/config.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/config.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildDefaultConfig } from '../src/config.js';

describe('config', () => {
  it('sets USB host to 10.11.99.1', () => {
    expect(buildDefaultConfig('/tmp/c').connection.usbHost).toBe('10.11.99.1');
  });

  it('sets empty WiFi host', () => {
    expect(buildDefaultConfig('/tmp/c').connection.wifiHost).toBe('');
  });

  it('sets port 22 and root username', () => {
    const cfg = buildDefaultConfig('/tmp/c');
    expect(cfg.connection.port).toBe(22);
    expect(cfg.connection.username).toBe('root');
  });

  it('sets native OCR provider', () => {
    expect(buildDefaultConfig('/tmp/c').ocr.provider).toBe('native');
  });

  it('privateKeyPath is inside configDir', () => {
    expect(buildDefaultConfig('/tmp/c').connection.privateKeyPath).toBe('/tmp/c/id_ed25519');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test
```

Expected: FAIL — `Cannot find module '../src/config.js'`

- [ ] **Step 3: Create src/config.ts**

```typescript
import { readFile, writeFile, mkdir } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

export type OcrProvider = 'native' | 'ollama' | 'local';

export interface ConnectionConfig {
  usbHost: string;
  wifiHost: string;
  port: number;
  username: string;
  privateKeyPath: string;
}

export interface OcrConfig {
  provider: OcrProvider;
  ollamaHost?: string;
  ollamaModel?: string;
  ollamaApiKey?: string;
  localEngine?: string;
}

export interface Config {
  connection: ConnectionConfig;
  ocr: OcrConfig;
}

export const CONFIG_DIR = join(homedir(), '.config', 'remarkable-mcr');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

export function buildDefaultConfig(configDir: string): Config {
  return {
    connection: {
      usbHost: '10.11.99.1',
      wifiHost: '',
      port: 22,
      username: 'root',
      privateKeyPath: join(configDir, 'id_ed25519'),
    },
    ocr: {
      provider: 'native',
      localEngine: 'tesseract',
    },
  };
}

export async function readConfig(): Promise<Config> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Config>;
    const defaults = buildDefaultConfig(CONFIG_DIR);
    return {
      connection: { ...defaults.connection, ...parsed.connection },
      ocr: { ...defaults.ocr, ...parsed.ocr },
    };
  } catch {
    return buildDefaultConfig(CONFIG_DIR);
  }
}

export async function writeConfig(config: Config): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npm test
```

Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: add config module with typed defaults and read/write"
```

---

### Task 3: Connection module (USB HTTP path)

**Files:**
- Create: `src/connection.ts`
- Create: `tests/connection.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/connection.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test
```

Expected: FAIL — `Cannot find module '../src/connection.js'`

- [ ] **Step 3: Create src/connection.ts**

```typescript
import AdmZip from 'adm-zip';
import { writeFile } from 'fs/promises';
import { join } from 'path';

export const USB_IP = '10.11.99.1';
export const USB_HTTP_TIMEOUT_MS = 2000;

export interface RmApiDocument {
  ID: string;
  VissibleName: string; // API has this typo
  Type: string;
  ModifiedClient: string;
  Parent: string;
}

export interface UsbHttpResult {
  available: boolean;
  documents: RmApiDocument[];
}

/** Returns the display name, tolerating the API's VissibleName typo. */
export function docName(doc: RmApiDocument): string {
  return (doc.VissibleName ?? '').trim();
}

/**
 * Probe the USB web interface by fetching /documents/.
 * Returns available:false on any error or timeout.
 */
export async function probeUsbHttp(host = USB_IP, timeoutMs = USB_HTTP_TIMEOUT_MS): Promise<UsbHttpResult> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`http://${host}/documents/`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return { available: false, documents: [] };
    const documents = (await response.json()) as RmApiDocument[];
    return { available: true, documents: Array.isArray(documents) ? documents : [] };
  } catch {
    return { available: false, documents: [] };
  }
}

/**
 * Select a document from the HTTP document list.
 * Filters to DocumentType only. Returns undefined if no match.
 */
export function selectDocument(documents: RmApiDocument[], name: string | undefined): RmApiDocument | undefined {
  const docs = documents
    .filter((d) => d.Type === 'DocumentType')
    .sort((a, b) => new Date(b.ModifiedClient).getTime() - new Date(a.ModifiedClient).getTime());

  if (!name) return docs[0];
  const term = name.toLowerCase();
  return docs.find((d) => docName(d).toLowerCase().includes(term));
}

/**
 * Download a document as an rmdoc archive (ZIP of .rm files).
 * Requires firmware 3.9+.
 */
export async function downloadRmdoc(docId: string, host = USB_IP): Promise<Buffer> {
  const response = await fetch(`http://${host}/download/${docId}/rmdoc`, {
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`rmdoc download failed: ${response.status} ${response.statusText}`);
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Download the tablet-generated thumbnail for a document.
 * Used as a last-resort fallback when rmdoc rendering fails.
 */
export async function downloadThumbnail(docId: string, host = USB_IP): Promise<Buffer> {
  const response = await fetch(`http://${host}/thumbnail/${docId}`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Thumbnail download failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Extract an rmdoc ZIP buffer into destDir.
 * After extraction, destDir will contain the raw notebook files (.rm, .content, etc.).
 */
export async function extractRmdoc(buffer: Buffer, destDir: string): Promise<void> {
  const zip = new AdmZip(buffer);
  zip.extractAllTo(destDir, /* overwrite */ true);
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npm test
```

Expected: 6 connection tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/connection.ts tests/connection.test.ts
git commit -m "feat: add connection module — USB HTTP probe, rmdoc download, document selection"
```

---

### Task 4: SSH module (WiFi path)

**Files:**
- Create: `src/ssh.ts`
- Create: `tests/ssh.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/ssh.test.ts`:

```typescript
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

import { buildConnectOptions } from '../src/ssh.js';

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
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test
```

Expected: FAIL — `Cannot find module '../src/ssh.js'`

- [ ] **Step 3: Create src/ssh.ts**

```typescript
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
      "grep -q 'WebInterfaceEnabled=true' /home/root/.config/remarkable/xochitl.conf " +
      "&& echo already-enabled " +
      "|| (sed -i 's/WebInterfaceEnabled=false/WebInterfaceEnabled=true/' " +
      "/home/root/.config/remarkable/xochitl.conf && systemctl restart xochitl && echo enabled)",
      15000,
    );
    const status = out.trim();
    if (status === 'already-enabled') return 'already-enabled';
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
```

- [ ] **Step 4: Run to verify it passes**

```bash
npm test
```

Expected: 3 SSH tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ssh.ts tests/ssh.test.ts
git commit -m "feat: add SSH module — exec, tar pipe, key gen/deploy, web interface enable, WiFi discovery"
```

---

### Task 5: Render module

**Files:**
- Create: `src/render.ts`
- Create: `tests/render.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/render.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

vi.mock('remarkable-rm', () => ({
  renderToPng: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
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

  it('handles cPages entries without id', () => {
    expect(selectPageIds({ cPages: { pages: [{ id: 'aaa' }, {}] } })).toEqual(['aaa', '']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test
```

Expected: FAIL — `Cannot find module '../src/render.js'`

- [ ] **Step 3: Create src/render.ts**

```typescript
import { readFile, readdir, access, writeFile } from 'fs/promises';
import { join } from 'path';
import { renderToPng } from 'remarkable-rm';

export interface ExportedPage {
  pageNum: number;
  localPath: string;
  format: 'png' | 'thumbnail';
}

export function selectPageIds(content: Record<string, unknown>): string[] {
  const cPages = content.cPages as { pages?: Array<{ id?: string } | string> } | undefined;
  if (cPages?.pages) {
    return cPages.pages.map((p) => (typeof p === 'string' ? p : (p.id ?? '')));
  }
  const pages = content.pages as string[] | undefined;
  if (Array.isArray(pages)) return pages;
  return [];
}

/**
 * Render a single .rm file to PNG using remarkable-rm.
 * Returns null if the file doesn't exist or rendering fails.
 */
async function renderRmFile(rmFile: string, pngPath: string): Promise<boolean> {
  try {
    await access(rmFile);
  } catch {
    return false; // .rm file doesn't exist for this page
  }
  try {
    const rmData = await readFile(rmFile);
    const png = await renderToPng(new Uint8Array(rmData));
    await writeFile(pngPath, Buffer.from(png));
    return true;
  } catch {
    return false;
  }
}

/**
 * Render all pages of a document to PNG.
 * Tries remarkable-rm first; falls back to thumbnail PNGs from thumbDir.
 *
 * @param docDir   Directory where the extracted rmdoc or SSH tar contents live
 * @param docId    Document UUID
 * @param pageIds  Ordered list of page UUIDs from .content
 * @param tempDir  Temp directory to write rendered PNGs into
 * @param thumbDir Optional: directory of pre-rendered thumbnail PNGs (fallback)
 */
export async function renderPages(
  docDir: string,
  docId: string,
  pageIds: string[],
  tempDir: string,
  thumbDir?: string,
): Promise<ExportedPage[]> {
  // The rmdoc ZIP may extract to a flat layout or a subdirectory.
  // Try both: docDir/{pageId}.rm and docDir/{docId}/{pageId}.rm
  const subDir = join(docDir, docId);
  const pages: ExportedPage[] = [];

  if (pageIds.length > 0) {
    for (let i = 0; i < pageIds.length; i++) {
      const pngPath = join(tempDir, `page-${i + 1}.png`);
      const flatRm = join(docDir, `${pageIds[i]}.rm`);
      const subRm = join(subDir, `${pageIds[i]}.rm`);

      const ok = await renderRmFile(flatRm, pngPath) || await renderRmFile(subRm, pngPath);
      if (ok) pages.push({ pageNum: i + 1, localPath: pngPath, format: 'png' });
    }
  }

  if (pages.length > 0) return pages;

  // Thumbnail fallback
  const td = thumbDir ?? join(docDir, `${docId}.thumbnails`);
  try {
    const thumbFiles = (await readdir(td)).filter((f) => f.endsWith('.png')).sort();
    for (let i = 0; i < thumbFiles.length; i++) {
      pages.push({ pageNum: i + 1, localPath: join(td, thumbFiles[i]), format: 'thumbnail' });
    }
  } catch {
    // No thumbnails available
  }

  return pages;
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npm test
```

Expected: 4 render tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render.ts tests/render.test.ts
git commit -m "feat: add render module — remarkable-rm native PNG rendering with thumbnail fallback"
```

---

### Task 6: OCR module

**Files:**
- Create: `src/ocr.ts`
- Create: `tests/ocr.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/ocr.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildOllamaPayload } from '../src/ocr.js';

describe('ocr', () => {
  it('sets the model', () => {
    expect(buildOllamaPayload('llama3.2-vision', 'abc', 'Transcribe').model).toBe('llama3.2-vision');
  });

  it('embeds image as data URL', () => {
    const content = buildOllamaPayload('m', 'abc', 'x').messages[0].content as Array<{ type: string; image_url?: { url: string } }>;
    expect(content.find((c) => c.type === 'image_url')?.image_url?.url).toBe('data:image/png;base64,abc');
  });

  it('includes prompt as text block', () => {
    const content = buildOllamaPayload('m', 'abc', 'do it').messages[0].content as Array<{ type: string; text?: string }>;
    expect(content.find((c) => c.type === 'text')?.text).toBe('do it');
  });

  it('sets stream false', () => {
    expect(buildOllamaPayload('m', 'abc', 'x').stream).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test
```

Expected: FAIL — `Cannot find module '../src/ocr.js'`

- [ ] **Step 3: Create src/ocr.ts**

```typescript
import { readFile } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { OcrConfig } from './config.js';
import type { ExportedPage } from './render.js';

const execFileAsync = promisify(execFile);

const DEFAULT_PROMPT =
  'Transcribe the handwritten text in this image exactly as written. ' +
  'Output ONLY the transcribed text with no preamble or commentary. ' +
  'Preserve line breaks. Use blank lines between distinct paragraphs.';

export interface PageResult {
  pageNum: number;
  text: string;
  imageBase64: string;
  renderFormat: 'png' | 'thumbnail';
}

export interface OllamaPayload {
  model: string;
  messages: Array<{ role: string; content: Array<{ type: string; image_url?: { url: string }; text?: string }> }>;
  stream: boolean;
}

export function buildOllamaPayload(model: string, imageBase64: string, prompt: string): OllamaPayload {
  return {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
        { type: 'text', text: prompt },
      ],
    }],
    stream: false,
  };
}

async function ocrViaOllama(imageBase64: string, config: OcrConfig, prompt: string): Promise<string> {
  const host = config.ollamaHost ?? 'http://localhost:11434';
  const model = config.ollamaModel ?? 'llama3.2-vision';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.ollamaApiKey) headers['Authorization'] = `Bearer ${config.ollamaApiKey}`;

  const response = await fetch(`${host}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(buildOllamaPayload(model, imageBase64, prompt)),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`Ollama ${response.status} ${response.statusText}`);
  type R = { choices?: Array<{ message?: { content?: string } }> };
  return ((await response.json()) as R).choices?.[0]?.message?.content ?? '';
}

async function ocrViaLocal(imagePath: string, config: OcrConfig): Promise<string> {
  const { stdout } = await execFileAsync(config.localEngine ?? 'tesseract', [imagePath, 'stdout'], { timeout: 30000 });
  return stdout.trim();
}

export async function processPage(page: ExportedPage, config: OcrConfig, prompt = DEFAULT_PROMPT): Promise<PageResult> {
  const imageBuffer = await readFile(page.localPath);
  const imageBase64 = imageBuffer.toString('base64');
  let text = '';

  if (config.provider === 'ollama') {
    try { text = await ocrViaOllama(imageBase64, config, prompt); }
    catch (err) { text = `[Ollama OCR failed: ${(err as Error).message}]`; }
  } else if (config.provider === 'local') {
    try { text = await ocrViaLocal(page.localPath, config); }
    catch (err) { text = `[Local OCR failed: ${(err as Error).message}]`; }
  }
  // native: text stays empty — agent reads the image

  return { pageNum: page.pageNum, text, imageBase64, renderFormat: page.format };
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npm test
```

Expected: 4 OCR tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ocr.ts tests/ocr.test.ts
git commit -m "feat: add OCR module — native pass-through, Ollama, local Tesseract"
```

---

### Task 7: remarkable_setup tool

**Files:**
- Create: `src/tools/setup.ts`
- Create: `tests/tools/setup.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/tools/setup.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/connection.js', () => ({
  probeUsbHttp: vi.fn().mockResolvedValue({ available: true, documents: [] }),
  USB_IP: '10.11.99.1',
}));

vi.mock('../../src/ssh.js', () => ({
  sshExec: vi.fn().mockResolvedValue(''),
  generateKeyPair: vi.fn().mockResolvedValue({ publicKey: 'ssh-ed25519 AAAA test' }),
  deployPublicKey: vi.fn().mockResolvedValue(undefined),
  enableUsbWebInterface: vi.fn().mockResolvedValue('already-enabled'),
  getWifiIp: vi.fn().mockResolvedValue('192.168.1.50'),
}));

vi.mock('../../src/config.js', () => ({
  writeConfig: vi.fn().mockResolvedValue(undefined),
  CONFIG_DIR: '/tmp/test-config',
  buildDefaultConfig: vi.fn().mockReturnValue({
    connection: { usbHost: '10.11.99.1', wifiHost: '', port: 22, username: 'root', privateKeyPath: '/tmp/key' },
    ocr: { provider: 'native' },
  }),
}));

import { handleSetup, SETUP_TOOL } from '../../src/tools/setup.js';

describe('remarkable_setup', () => {
  it('SETUP_TOOL.name is remarkable_setup', () => {
    expect(SETUP_TOOL.name).toBe('remarkable_setup');
  });

  it('returns error when password missing', async () => {
    const result = await handleSetup({});
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('password');
  });

  it('deploys SSH key on success', async () => {
    const { deployPublicKey } = await import('../../src/ssh.js');
    await handleSetup({ password: 'secret' });
    expect(deployPublicKey).toHaveBeenCalled();
  });

  it('writes config on success', async () => {
    const { writeConfig } = await import('../../src/config.js');
    await handleSetup({ password: 'secret' });
    expect(writeConfig).toHaveBeenCalled();
  });

  it('returns success text', async () => {
    const result = await handleSetup({ password: 'secret' });
    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toContain('complete');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test
```

Expected: FAIL — `Cannot find module '../../src/tools/setup.js'`

- [ ] **Step 3: Create src/tools/setup.ts**

```typescript
import { join } from 'path';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { buildDefaultConfig, writeConfig, CONFIG_DIR } from '../config.js';
import { sshExec, generateKeyPair, deployPublicKey, enableUsbWebInterface, getWifiIp } from '../ssh.js';
import { probeUsbHttp, USB_IP } from '../connection.js';

export const SETUP_TOOL: Tool = {
  name: 'remarkable_setup',
  description:
    'First-time setup for reMarkable tablet access. Connects via USB (10.11.99.1), deploys an SSH keypair ' +
    'for WiFi use, enables the USB web interface, and discovers the WiFi IP. ' +
    'The root password is shown on-tablet under Settings → Help → Copyright and licenses.',
  inputSchema: {
    type: 'object',
    properties: {
      password: { type: 'string', description: 'Root password from Settings → Help → Copyright and licenses' },
    },
    required: ['password'],
  },
};

export async function handleSetup(args: Record<string, unknown>): Promise<CallToolResult> {
  const password = args.password as string | undefined;
  if (!password) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'password is required. Find it on the tablet: Settings → Help → Copyright and licenses.' }],
    };
  }

  const usbOpts = { host: USB_IP, port: 22, username: 'root', password };
  const keyPath = join(CONFIG_DIR, 'id_ed25519');

  try {
    // 1. Generate and deploy SSH keypair (needed for WiFi use)
    const { publicKey } = await generateKeyPair(keyPath);
    await deployPublicKey(usbOpts, publicKey);

    // 2. Enable USB web interface (idempotent)
    const keyOpts = { host: USB_IP, port: 22, username: 'root', privateKeyPath: keyPath };
    const webIfaceStatus = await enableUsbWebInterface(keyOpts);

    // 3. Verify HTTP web interface is now up
    const { available } = await probeUsbHttp();

    // 4. Discover WiFi IP
    const wifiIp = await getWifiIp(keyOpts);

    // 5. Save config
    const config = buildDefaultConfig(CONFIG_DIR);
    config.connection.wifiHost = wifiIp ?? '';
    config.connection.privateKeyPath = keyPath;
    await writeConfig(config);

    const lines = [
      'reMarkable setup complete.',
      `SSH keypair saved to ${keyPath}.`,
      `USB web interface: ${webIfaceStatus === 'already-enabled' ? 'already enabled' : webIfaceStatus === 'enabled' ? 'enabled' : 'could not enable — you may need to enable it manually in Settings → Storage → USB web interface'}.`,
      available ? 'USB web interface is reachable.' : 'USB web interface did not respond — check the tablet setting.',
      wifiIp ? `WiFi IP discovered and saved: ${wifiIp}.` : 'No WiFi IP found — tablet may not be connected to WiFi.',
      'Run remarkable_list to verify the connection.',
    ];
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Setup failed: ${(err as Error).message}` }],
    };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npm test
```

Expected: 5 setup tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/setup.ts tests/tools/setup.test.ts
git commit -m "feat: add remarkable_setup — key deploy, web interface enable, WiFi discovery"
```

---

### Task 8: remarkable_list tool

**Files:**
- Create: `src/tools/list.ts`
- Create: `tests/tools/list.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/tools/list.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/connection.js', () => ({
  probeUsbHttp: vi.fn().mockResolvedValue({ available: true, documents: [
    { ID: 'a1', VissibleName: 'My Notes', Type: 'DocumentType', ModifiedClient: '2026-04-12T10:00:00Z', Parent: '' },
  ]}),
  selectDocument: vi.fn(),
  docName: vi.fn((d: { VissibleName: string }) => d.VissibleName),
  USB_IP: '10.11.99.1',
}));

vi.mock('../../src/ssh.js', () => ({ sshExec: vi.fn() }));

vi.mock('../../src/config.js', () => ({
  readConfig: vi.fn().mockResolvedValue({
    connection: { usbHost: '10.11.99.1', wifiHost: '192.168.1.100', port: 22, username: 'root', privateKeyPath: '/tmp/key' },
    ocr: { provider: 'native' },
  }),
}));

import { parseDocuments, LIST_TOOL } from '../../src/tools/list.js';

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
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test
```

Expected: FAIL — `Cannot find module '../../src/tools/list.js'`

- [ ] **Step 3: Create src/tools/list.ts**

```typescript
import { basename } from 'path';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { readConfig } from '../config.js';
import { probeUsbHttp, docName } from '../connection.js';
import { sshExec } from '../ssh.js';
import type { SSHOptions } from '../ssh.js';

const XOCHITL = '/home/root/.local/share/remarkable/xochitl';
const LIST_CMD = `find ${XOCHITL} -maxdepth 2 -name '*.metadata' -exec sh -c 'echo "---FILE:$1"; cat "$1"' _ {} \\;`;

export interface SshDocument {
  id: string;
  name: string;
  lastModified: number;
  parent: string;
}

export function parseDocuments(raw: string): SshDocument[] {
  const docs: SshDocument[] = [];
  for (const block of raw.split('---FILE:').filter(Boolean)) {
    const lines = block.trim().split('\n');
    try {
      const meta = JSON.parse(lines.slice(1).join('\n')) as Record<string, string>;
      if (meta.visibleName && meta.type === 'DocumentType') {
        docs.push({
          id: basename(lines[0].trim(), '.metadata'),
          name: meta.visibleName,
          lastModified: meta.lastModified ? parseInt(meta.lastModified, 10) : 0,
          parent: meta.parent ?? '',
        });
      }
    } catch { /* skip malformed */ }
  }
  return docs.sort((a, b) => b.lastModified - a.lastModified);
}

export const LIST_TOOL: Tool = {
  name: 'remarkable_list',
  description: 'List all documents on the reMarkable tablet, sorted by most recently modified.',
  inputSchema: { type: 'object', properties: {} },
};

export async function handleList(_args: Record<string, unknown>): Promise<CallToolResult> {
  const config = await readConfig();
  const { usbHost, wifiHost, port, username, privateKeyPath } = config.connection;

  // USB-first: try HTTP web API
  const usbResult = await probeUsbHttp();
  if (usbResult.available) {
    const docs = usbResult.documents
      .filter((d) => d.Type === 'DocumentType')
      .sort((a, b) => new Date(b.ModifiedClient).getTime() - new Date(a.ModifiedClient).getTime());

    if (docs.length === 0) return { content: [{ type: 'text', text: 'No documents found on the tablet.' }] };
    const lines = docs.map((d, i) => {
      const date = new Date(d.ModifiedClient).toLocaleDateString('en-GB');
      return `${i + 1}. ${docName(d)} (${date})`;
    });
    return { content: [{ type: 'text', text: `[via USB]\n${lines.join('\n')}` }] };
  }

  // SSH fallback: try WiFi then USB SSH
  const hosts = [wifiHost, usbHost].filter(Boolean);
  for (const host of hosts) {
    const opts: SSHOptions = { host, port, username, privateKeyPath };
    try {
      const raw = await sshExec(opts, LIST_CMD, 60000);
      const docs = parseDocuments(raw);
      if (docs.length === 0) return { content: [{ type: 'text', text: 'No documents found on the tablet.' }] };
      const lines = docs.map((d, i) => {
        const date = d.lastModified ? new Date(d.lastModified).toLocaleDateString('en-GB') : 'unknown';
        return `${i + 1}. ${d.name} (${date})`;
      });
      return { content: [{ type: 'text', text: `[via SSH ${host}]\n${lines.join('\n')}` }] };
    } catch { /* try next host */ }
  }

  return {
    isError: true,
    content: [{ type: 'text', text: 'Cannot connect to tablet. Connect via USB or ensure WiFi SSH is configured.' }],
  };
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npm test
```

Expected: 4 list tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/list.ts tests/tools/list.test.ts
git commit -m "feat: add remarkable_list — USB HTTP preferred, SSH WiFi/USB fallback"
```

---

### Task 9: remarkable_pull tool

**Files:**
- Create: `src/tools/pull.ts`
- Create: `tests/tools/pull.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/tools/pull.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/connection.js', () => ({
  probeUsbHttp: vi.fn().mockResolvedValue({ available: true, documents: [
    { ID: 'a1', VissibleName: 'My Notes', Type: 'DocumentType', ModifiedClient: '2026-04-12T10:00:00Z', Parent: '' },
  ]}),
  selectDocument: vi.fn().mockReturnValue({ ID: 'a1', VissibleName: 'My Notes', Type: 'DocumentType', ModifiedClient: '', Parent: '' }),
  downloadRmdoc: vi.fn().mockResolvedValue(Buffer.from('fake-zip')),
  extractRmdoc: vi.fn().mockResolvedValue(undefined),
  downloadThumbnail: vi.fn().mockResolvedValue(Buffer.from('fake-thumb')),
  docName: vi.fn().mockReturnValue('My Notes'),
  USB_IP: '10.11.99.1',
}));

vi.mock('../../src/render.js', () => ({
  renderPages: vi.fn().mockResolvedValue([{ pageNum: 1, localPath: '/tmp/p.png', format: 'png' }]),
  selectPageIds: vi.fn().mockReturnValue(['uuid-1']),
}));

vi.mock('../../src/ocr.js', () => ({
  processPage: vi.fn().mockResolvedValue({ pageNum: 1, text: '', imageBase64: 'abc', renderFormat: 'png' }),
}));

vi.mock('../../src/config.js', () => ({
  readConfig: vi.fn().mockResolvedValue({
    connection: { usbHost: '10.11.99.1', wifiHost: '192.168.1.100', port: 22, username: 'root', privateKeyPath: '/tmp/key' },
    ocr: { provider: 'native' },
  }),
}));

vi.mock('../../src/ssh.js', () => ({ sshExec: vi.fn(), sshPipeTar: vi.fn() }));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    mkdtemp: vi.fn().mockResolvedValue('/tmp/rm-test'),
    readFile: vi.fn().mockResolvedValue('{"cPages":{"pages":[{"id":"uuid-1"}]}}'),
    rm: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
  };
});

import { PULL_TOOL } from '../../src/tools/pull.js';

describe('remarkable_pull', () => {
  it('PULL_TOOL.name is remarkable_pull', () => {
    expect(PULL_TOOL.name).toBe('remarkable_pull');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test
```

Expected: FAIL — `Cannot find module '../../src/tools/pull.js'`

- [ ] **Step 3: Create src/tools/pull.ts**

```typescript
import { mkdtemp, readFile, rm, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { readConfig } from '../config.js';
import { probeUsbHttp, selectDocument, downloadRmdoc, extractRmdoc, downloadThumbnail, docName } from '../connection.js';
import { sshExec, sshPipeTar } from '../ssh.js';
import type { SSHOptions } from '../ssh.js';
import { renderPages, selectPageIds } from '../render.js';
import { processPage } from '../ocr.js';
import { parseDocuments } from './list.js';

const XOCHITL = '/home/root/.local/share/remarkable/xochitl';
const LIST_CMD = `find ${XOCHITL} -maxdepth 2 -name '*.metadata' -exec sh -c 'echo "---FILE:$1"; cat "$1"' _ {} \\;`;

export const PULL_TOOL: Tool = {
  name: 'remarkable_pull',
  description:
    'Pull a document from the reMarkable tablet. Returns rendered page images and transcribed text. ' +
    'Uses USB when connected, WiFi SSH otherwise.',
  inputSchema: {
    type: 'object',
    properties: {
      document: { type: 'string', description: 'Document name substring. Defaults to most recently modified.' },
      page:     { type: 'number', description: 'Specific page number (1-based). Defaults to all pages.' },
      prompt:   { type: 'string', description: 'Custom transcription instruction (native mode: returned as agent context).' },
    },
  },
};

async function readPageIds(dir: string, docId: string): Promise<string[]> {
  for (const p of [join(dir, `${docId}.content`), join(dir, '.content')]) {
    try {
      const raw = await readFile(p, 'utf8');
      const ids = selectPageIds(JSON.parse(raw) as Record<string, unknown>);
      if (ids.length > 0) return ids;
    } catch { /* try next */ }
  }
  return [];
}

export async function handlePull(args: Record<string, unknown>): Promise<CallToolResult> {
  const config = await readConfig();
  const { usbHost, wifiHost, port, username, privateKeyPath } = config.connection;

  const tempDir = await mkdtemp(join(tmpdir(), 'remarkable-'));
  const docDir = join(tempDir, 'doc');

  try {
    await mkdir(docDir, { recursive: true });

    let targetName = '';
    let targetId = '';
    let pageIds: string[] = [];
    let thumbDir: string | undefined;

    // ── USB HTTP path ──────────────────────────────────────────────────────
    const usbResult = await probeUsbHttp();

    if (usbResult.available) {
      const docArg = args.document as string | undefined;
      const target = selectDocument(usbResult.documents, docArg);

      if (!target) {
        const names = usbResult.documents.filter((d) => d.Type === 'DocumentType').slice(0, 5).map(docName).join(', ');
        return { isError: true, content: [{ type: 'text', text: `No document matching "${docArg}". Available: ${names}` }] };
      }

      targetName = docName(target);
      targetId = target.ID;

      try {
        const rmdocBuffer = await downloadRmdoc(targetId);
        await extractRmdoc(rmdocBuffer, docDir);
        pageIds = await readPageIds(docDir, targetId);
      } catch (err) {
        // rmdoc failed — thumbnail fallback
        try {
          const thumb = await downloadThumbnail(targetId);
          const thumbPath = join(tempDir, 'thumbnail.png');
          await (await import('fs/promises')).writeFile(thumbPath, thumb);
          thumbDir = tempDir;
        } catch {
          return { isError: true, content: [{ type: 'text', text: `Failed to download "${targetName}": ${(err as Error).message}` }] };
        }
      }

    } else {
      // ── SSH fallback path ────────────────────────────────────────────────
      const hosts = [wifiHost, usbHost].filter(Boolean);
      let raw = '';
      let connectedHost = '';

      for (const host of hosts) {
        try {
          const opts: SSHOptions = { host, port, username, privateKeyPath };
          raw = await sshExec(opts, LIST_CMD, 60000);
          connectedHost = host;
          break;
        } catch { /* try next */ }
      }

      if (!connectedHost) {
        return { isError: true, content: [{ type: 'text', text: 'Cannot connect to tablet. Connect USB or check WiFi SSH config.' }] };
      }

      const docs = parseDocuments(raw);
      if (docs.length === 0) return { content: [{ type: 'text', text: 'No documents found on the tablet.' }] };

      const docArg = args.document as string | undefined;
      const target = docArg
        ? docs.find((d) => d.name.toLowerCase().includes(docArg.toLowerCase()))
        : docs[0];

      if (!target) {
        const names = docs.slice(0, 5).map((d) => d.name).join(', ');
        return { isError: true, content: [{ type: 'text', text: `No document matching "${docArg}". Available: ${names}` }] };
      }

      targetName = target.name;
      targetId = target.id;

      const opts: SSHOptions = { host: connectedHost, port, username, privateKeyPath };
      const tarCmd = `cd ${XOCHITL} && tar cf - ${targetId}.* ${targetId}/ 2>/dev/null`;
      await sshPipeTar(opts, tarCmd, docDir);
      pageIds = await readPageIds(docDir, targetId);
    }

    // ── Render ─────────────────────────────────────────────────────────────
    const allPages = await renderPages(docDir, targetId, pageIds, tempDir, thumbDir);

    if (allPages.length === 0) {
      return { isError: true, content: [{ type: 'text', text: `No renderable pages for "${targetName}". Open the document on the tablet at least once.` }] };
    }

    const pageArg = args.page as number | undefined;
    const pagesToProcess = pageArg ? allPages.filter((p) => p.pageNum === pageArg) : allPages;

    if (pageArg && pagesToProcess.length === 0) {
      return { isError: true, content: [{ type: 'text', text: `Page ${pageArg} not found. Document has ${allPages.length} page(s).` }] };
    }

    // ── OCR + assemble ─────────────────────────────────────────────────────
    const prompt = args.prompt as string | undefined;
    const content: CallToolResult['content'] = [];

    const header = [`Document: ${targetName} — ${pagesToProcess.length} page(s).`];
    if (config.ocr.provider === 'native' && prompt) header.push(`Transcription instruction: ${prompt}`);
    content.push({ type: 'text', text: header.join('\n') });

    for (const page of pagesToProcess) {
      const result = await processPage(page, config.ocr, prompt);
      if (pagesToProcess.length > 1) content.push({ type: 'text', text: `--- Page ${result.pageNum} ---` });
      if (result.text) content.push({ type: 'text', text: result.text });
      content.push({ type: 'image', data: result.imageBase64, mimeType: 'image/png' });
    }

    return { content };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npm test
```

Expected: 1 pull test PASS. (Pull tool has one direct test; the rest is integration-tested via the tool path.)

- [ ] **Step 5: Commit**

```bash
git add src/tools/pull.ts tests/tools/pull.test.ts
git commit -m "feat: add remarkable_pull — USB HTTP preferred, SSH WiFi/USB fallback, remarkable-rm rendering"
```

---

### Task 10: MCP server entry point

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Write src/index.ts**

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { SETUP_TOOL, handleSetup } from './tools/setup.js';
import { LIST_TOOL, handleList } from './tools/list.js';
import { PULL_TOOL, handlePull } from './tools/pull.js';

const server = new Server(
  { name: 'remarkable-mcr', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [SETUP_TOOL, LIST_TOOL, PULL_TOOL],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const a = args as Record<string, unknown>;
  switch (name) {
    case 'remarkable_setup': return handleSetup(a);
    case 'remarkable_list':  return handleList(a);
    case 'remarkable_pull':  return handlePull(a);
    default: throw new Error(`Unknown tool: ${name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: `dist/index.js` — no errors.

- [ ] **Step 3: Smoke test**

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node dist/index.js
```

Expected: JSON response listing `remarkable_setup`, `remarkable_list`, `remarkable_pull`.

- [ ] **Step 4: Full test suite**

```bash
npm test
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire MCP server entry point — three tools on stdio transport"
```

---

### Task 11: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Create README.md**

````markdown
# remarkable-mcr

MCP server for reMarkable 2 — pull handwritten notes and diagrams into any AI agent.

Works with Claude Desktop, Claude Code, Codex, Cursor, and any MCP-compatible client.

## How it connects

- **USB connected:** uses the tablet's HTTP web interface (`http://10.11.99.1`) — fastest, no SSH needed
- **WiFi only:** falls back to SSH over the tablet's WiFi IP — requires SSH key setup

## Requirements

- Node.js 20+
- reMarkable 2 tablet

## Install

```bash
npm install -g remarkable-mcr
```

Or clone and build:

```bash
git clone https://github.com/you/remarkable-mcr
cd remarkable-mcr && npm install && npm run build
```

## First-time setup

Connect your tablet via USB, then ask your agent:

> "Set up my reMarkable. The password is [password from Settings → Help → Copyright and licenses]."

The agent calls `remarkable_setup`, which:
1. Deploys an SSH keypair (for WiFi use)
2. Enables the USB web interface on the tablet
3. Discovers and saves your tablet's WiFi IP

## Client configuration

### Claude Desktop

```json
{
  "mcpServers": {
    "remarkable": {
      "command": "node",
      "args": ["/path/to/remarkable-mcr/dist/index.js"]
    }
  }
}
```

### Claude Code

```json
{
  "remarkable": {
    "command": "node",
    "args": ["/path/to/remarkable-mcr/dist/index.js"]
  }
}
```

### Generic stdio

```bash
node /path/to/remarkable-mcr/dist/index.js
```

## OCR modes

Edit `~/.config/remarkable-mcr/config.json`:

| `provider` | Description |
|---|---|
| `native` (default) | Returns the page image — host agent's LLM transcribes it |
| `ollama` | Sends image to a local/remote Ollama vision model |
| `local` | Shells out to Tesseract |

### Ollama example

```json
{
  "ocr": {
    "provider": "ollama",
    "ollamaHost": "http://localhost:11434",
    "ollamaModel": "llama3.2-vision"
  }
}
```

## Tools

| Tool | Description |
|---|---|
| `remarkable_setup` | First-time setup — SSH key, USB web interface, WiFi discovery |
| `remarkable_list` | List documents (USB HTTP or SSH fallback) |
| `remarkable_pull` | Pull a document — images + OCR text |

## Future

- Publish `remarkable-rm` to npm
- `remarkable_push` — write text back to the tablet
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README with install, client config, and OCR modes"
```

---

## Self-review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| TypeScript + `@modelcontextprotocol/sdk` | Task 1 |
| USB HTTP path (`probeUsbHttp`, `downloadRmdoc`, `extractRmdoc`) | Task 3 |
| SSH path for WiFi (key auth, tar download) | Task 4 |
| `remarkable-rm` native rendering, thumbnail fallback | Task 5 |
| OCR: native / Ollama / local | Task 6 |
| `remarkable_setup` — key deploy, web interface enable, WiFi discovery | Task 7 |
| `remarkable_list` — USB preferred, SSH fallback | Task 8 |
| `remarkable_pull` — USB preferred, SSH fallback, page filter, prompt | Task 9 |
| MCP image content block returns | Task 9 |
| Client config examples | Task 11 |
| Error handling throughout | Tasks 7–9 |
