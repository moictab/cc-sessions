'use strict';
// App icon: a terminal prompt ">_" with three status lights, one per kind of session state
// (your turn, needs permission, working), in the app's own status colors.
// Generates assets/icon.svg (reference), assets/icon.png (512 px), assets/mark.svg (the small
// version, used in the sidebar) and a multi-size assets/icon.ico. Sizes up to 32 px are
// snapped to whole pixels so they stay sharp.
//   npm run icon

const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const DIR = path.join(__dirname, '..', 'assets');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
const INK = '#d6dbe4'; // the prompt
const LIGHTS = ['#4fd1a1', '#f5a524', '#6ea8fe']; // --st-done, --st-permission, --st-busy

function tile(size, small) {
  const radius = size * (small ? 0.2 : 0.21);
  if (small) return `<rect width="${size}" height="${size}" rx="${radius}" fill="#171b22"/>`;
  const s = size;
  return `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#262c38"/><stop offset="1" stop-color="#0f1217"/></linearGradient></defs>` +
    `<rect x="${s * 0.03}" y="${s * 0.03}" width="${s * 0.94}" height="${s * 0.94}" rx="${radius}" fill="url(#bg)"/>` +
    `<rect x="${s * 0.033}" y="${s * 0.033}" width="${s * 0.934}" height="${s * 0.934}" rx="${radius}" fill="none" stroke="#fff" stroke-opacity=".09" stroke-width="${Math.max(1, s / 170)}"/>`;
}

/** Designed on a 16-unit grid; small sizes snap every edge to a whole pixel. */
function iconSvg(size) {
  const small = size <= 32;
  const u = size / 16;
  const px = (v) => (small ? Math.round(v) : v);
  const stroke = small ? Math.max(2, Math.round(1.5 * u)) : 1.5 * u;

  // ">" — square ends when small (crisp), round when large
  const chevron = `<path d="M${px(3.6 * u)} ${px(5 * u)} L${px(6.8 * u)} ${px(8 * u)} L${px(3.6 * u)} ${px(11 * u)}" fill="none" ` +
    `stroke="${INK}" stroke-width="${stroke}" stroke-linecap="${small ? 'square' : 'round'}" stroke-linejoin="${small ? 'miter' : 'round'}"/>`;
  // "_" — the cursor
  const cursorH = small ? Math.max(2, Math.round(1.4 * u)) : 1.4 * u;
  const cursor = `<rect x="${px(7.8 * u)}" y="${px(10.2 * u)}" width="${px(3.2 * u)}" height="${cursorH}" rx="${small ? 0 : 0.5 * u}" fill="${INK}" fill-opacity=".9"/>`;
  // the three lights, stacked on the right
  const lights = LIGHTS.map((color, i) => {
    const cy = (4.5 + i * 3.5) * u;
    if (!small) return `<circle cx="${12.6 * u}" cy="${cy}" r="${0.95 * u}" fill="${color}"/>`;
    const d = Math.max(2, Math.round(1.8 * u));
    return `<rect x="${Math.round(12 * u)}" y="${Math.round(cy - d / 2)}" width="${d}" height="${d}" fill="${color}"/>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"${small ? ' shape-rendering="crispEdges"' : ''}>` +
    tile(size, small) + chevron + cursor + lights + '</svg>';
}

function render(size) {
  return new Resvg(iconSvg(size), { fitTo: { mode: 'width', value: size } }).render();
}

function dib(img) {
  const size = img.width;
  const rgba = img.pixels;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR bitmap + AND mask
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(size * size * 4, 20);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4;
      const d = ((size - 1 - y) * size + x) * 4; // bottom-up, BGRA
      pixels[d] = rgba[s + 2];
      pixels[d + 1] = rgba[s + 1];
      pixels[d + 2] = rgba[s];
      pixels[d + 3] = rgba[s + 3];
    }
  }
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size); // all opaque; alpha does the work
  return Buffer.concat([header, pixels, mask]);
}

function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = header.length + dir.length;
  images.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...images.map((i) => i.data)]);
}

const images = SIZES.map((size) => {
  const img = render(size);
  return { size, data: size === 256 ? img.asPng() : dib(img) };
});
fs.writeFileSync(path.join(DIR, 'icon.ico'), ico(images));
fs.writeFileSync(path.join(DIR, 'icon.png'), render(512).asPng());
fs.writeFileSync(path.join(DIR, 'icon.svg'), iconSvg(256) + '\n');
fs.writeFileSync(path.join(DIR, 'mark.svg'), iconSvg(20) + '\n');
console.log(`assets/icon.ico (${SIZES.join(', ')} px), icon.png (512 px), icon.svg and mark.svg written`);
