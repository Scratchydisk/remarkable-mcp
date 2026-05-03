import { describe, it, expect } from 'vitest';
import { buildOllamaPayload } from '../src/ocr.js';

describe('ocr', () => {
  it('sets the model', () => {
    expect(buildOllamaPayload('llama3.2-vision', 'abc', 'Transcribe').model).toBe('llama3.2-vision');
  });

  it('puts the prompt in message content', () => {
    expect(buildOllamaPayload('m', 'abc', 'do it').messages[0].content).toBe('do it');
  });

  it('puts the raw base64 image in the images array (no data URL prefix)', () => {
    expect(buildOllamaPayload('m', 'abc', 'x').messages[0].images).toEqual(['abc']);
  });

  it('sets stream false', () => {
    expect(buildOllamaPayload('m', 'abc', 'x').stream).toBe(false);
  });
});
