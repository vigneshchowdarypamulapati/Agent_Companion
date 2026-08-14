import sharp from 'sharp';
import { readFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(__dirname, '..', 'src', 'assets');
const publicDir = join(__dirname, '..', 'public');

// All three source SVGs use viewBox="0 0 100 100" with no explicit width/height.
// The exact DPI convention librsvg uses by default for unitless viewBox coordinates
// isn't worth relying on precisely — instead, always rasterize at a fixed density
// far higher than any target size needs (2000 DPI against a 100-unit viewBox is
// roughly a 2778px render), then resize() down to the exact target. Downscaling
// from a much-higher-resolution source is always safe; the failure mode this
// avoids is under-rasterizing and then upscaling, which blurs.
const RASTER_DENSITY = 2000;

async function renderSvgToPng(sourcePath, outputPath, targetSize) {
  const svgBuffer = readFileSync(sourcePath);
  await sharp(svgBuffer, { density: RASTER_DENSITY })
    .resize(targetSize, targetSize)
    .png()
    .toFile(outputPath);
  const metadata = await sharp(outputPath).metadata();
  if (metadata.width !== targetSize || metadata.height !== targetSize) {
    throw new Error(`${outputPath}: expected ${targetSize}x${targetSize}, got ${metadata.width}x${metadata.height}`);
  }
  console.log(`✓ ${outputPath} (${metadata.width}x${metadata.height})`);
}

const iconSource = join(assetsDir, 'icon-source.svg');
const faviconSource = join(assetsDir, 'favicon-source.svg');
const maskableSource = join(assetsDir, 'icon-maskable-source.svg');

await renderSvgToPng(faviconSource, join(publicDir, 'favicon-32x32.png'), 32);
await renderSvgToPng(faviconSource, join(publicDir, 'favicon-16x16.png'), 16);
await renderSvgToPng(iconSource, join(publicDir, 'apple-touch-icon.png'), 180);
await renderSvgToPng(iconSource, join(publicDir, 'pwa-192x192.png'), 192);
await renderSvgToPng(iconSource, join(publicDir, 'pwa-512x512.png'), 512);
await renderSvgToPng(maskableSource, join(publicDir, 'maskable-icon-512x512.png'), 512);

copyFileSync(faviconSource, join(publicDir, 'favicon.svg'));
console.log('✓ favicon.svg (copied as-is)');

console.log('All icons generated.');
