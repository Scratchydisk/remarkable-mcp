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
