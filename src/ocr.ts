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
  renderFormat: 'png' | 'jpeg' | 'thumbnail';
}

export interface OllamaPayload {
  model: string;
  messages: Array<{ role: string; content: string; images: string[] }>;
  stream: boolean;
}

/**
 * Build the payload for Ollama's native /api/chat endpoint.
 * Uses the `images` array (base64 PNG, no data URL prefix) which is the
 * documented Ollama format and supported across all vision-capable models.
 */
export function buildOllamaPayload(model: string, imageBase64: string, prompt: string): OllamaPayload {
  return {
    model,
    messages: [{ role: 'user', content: prompt, images: [imageBase64] }],
    stream: false,
  };
}

async function ocrViaOllama(imageBase64: string, config: OcrConfig, prompt: string): Promise<string> {
  const host = config.ollamaHost ?? 'http://localhost:11434';
  const model = config.ollamaModel ?? 'llama3.2-vision';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.ollamaApiKey) headers['Authorization'] = `Bearer ${config.ollamaApiKey}`;

  const response = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify(buildOllamaPayload(model, imageBase64, prompt)),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`Ollama ${response.status} ${response.statusText}`);
  type R = { message?: { content?: string } };
  return ((await response.json()) as R).message?.content ?? '';
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
