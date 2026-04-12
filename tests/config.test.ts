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

  it('sets localEngine to tesseract', () => {
    expect(buildDefaultConfig('/tmp/c').ocr.localEngine).toBe('tesseract');
  });
});
