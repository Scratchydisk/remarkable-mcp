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
