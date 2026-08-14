import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');

const RASTER_ICONS: Array<{ file: string; size: number }> = [
  { file: 'favicon-32x32.png', size: 32 },
  { file: 'favicon-16x16.png', size: 16 },
  { file: 'apple-touch-icon.png', size: 180 },
  { file: 'pwa-192x192.png', size: 192 },
  { file: 'pwa-512x512.png', size: 512 },
  { file: 'maskable-icon-512x512.png', size: 512 },
];

describe('PWA icon set', () => {
  it('favicon.svg exists', () => {
    expect(existsSync(join(publicDir, 'favicon.svg'))).toBe(true);
  });

  for (const { file, size } of RASTER_ICONS) {
    it(`${file} exists at exactly ${size}x${size}`, async () => {
      const path = join(publicDir, file);
      expect(existsSync(path)).toBe(true);
      const metadata = await sharp(path).metadata();
      expect(metadata.width).toBe(size);
      expect(metadata.height).toBe(size);
      expect(metadata.format).toBe('png');
    });
  }
});
