import { readFile, writeFile, mkdir } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

export type OcrProvider = 'native' | 'ollama' | 'local';
export type RenderFormat = 'png' | 'jpeg';

export interface ConnectionConfig {
  usbHost: string;
  wifiHost: string;
  port: number;
  username: string;
  privateKeyPath: string;
  /** sha256 hex fingerprint of the tablet's SSH host key, captured during setup. Verified on every WiFi/SSH connect. */
  hostKey?: string;
}

export interface OcrConfig {
  provider: OcrProvider;
  ollamaHost?: string;
  ollamaModel?: string;
  ollamaApiKey?: string;
  localEngine?: string;
}

export interface RenderConfigFields {
  /** Default output width in pixels. 1404 = native rM2; 1024 reduces size ~2× with no legibility loss. */
  width: number;
  /** Default output format. PNG preserves linework; JPEG is much smaller for OCR pulls. */
  format: RenderFormat;
  /** JPEG quality 1-100. Ignored when format is png. */
  jpegQuality: number;
}

export interface Config {
  connection: ConnectionConfig;
  ocr: OcrConfig;
  render: RenderConfigFields;
}

export const CONFIG_DIR = join(homedir(), '.config', 'remarkable-mcp');
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
    render: {
      width: 1024,
      format: 'png',
      jpegQuality: 80,
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
      render: { ...defaults.render, ...parsed.render },
    };
  } catch {
    return buildDefaultConfig(CONFIG_DIR);
  }
}

export async function writeConfig(config: Config): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}
