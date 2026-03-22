import sharp from 'sharp';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 180 180">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.3" y2="1">
      <stop offset="0%" stop-color="#e2eef4"/>
      <stop offset="40%" stop-color="#a0d0e8"/>
      <stop offset="100%" stop-color="#70b8d6"/>
    </linearGradient>
    <radialGradient id="sun" cx="0.75" cy="0.1" r="0.5">
      <stop offset="0%" stop-color="rgba(255,200,100,0.4)"/>
      <stop offset="100%" stop-color="rgba(255,200,100,0)"/>
    </radialGradient>
  </defs>
  <rect width="180" height="180" fill="url(#bg)"/>
  <rect width="180" height="180" fill="url(#sun)"/>
  <text
    x="90" y="128"
    text-anchor="middle"
    font-family="Georgia, 'Times New Roman', serif"
    font-size="116"
    font-weight="bold"
    fill="rgba(255,255,255,0.92)"
    letter-spacing="-2"
  >R</text>
</svg>`;

const sizes = [180, 192, 512];

for (const size of sizes) {
  await sharp(Buffer.from(svg))
    .resize(size, size)
    .png()
    .toFile(join(__dirname, '..', 'public', `icon-${size}.png`));
  console.log(`Generated icon-${size}.png`);
}
