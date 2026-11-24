// Generates the PWA icons (PNG + SVG) without any image tooling: a tiny polygon rasterizer
// with 4x4 supersampling, encoded as PNG via zlib. Run: npm run icons
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BG = [29, 31, 35];
const FACES = [
  { color: [255, 160, 64], pts: [[0.5, 0.2], [0.78, 0.36], [0.5, 0.52], [0.22, 0.36]] }, // top
  { color: [214, 110, 30], pts: [[0.22, 0.36], [0.5, 0.52], [0.5, 0.84], [0.22, 0.68]] }, // left
  { color: [150, 72, 18], pts: [[0.5, 0.52], [0.78, 0.36], [0.78, 0.68], [0.5, 0.84]] }, // right
];

function inside(pts, x, y) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function render(size, { scale = 1, rounded = true } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const ss = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (x + (sx + 0.5) / ss) / size, v = (y + (sy + 0.5) / ss) / size;
          // rounded-square mask (corner radius 22%)
          const rad = 0.22, dx = Math.max(Math.abs(u - 0.5) - (0.5 - rad), 0), dy = Math.max(Math.abs(v - 0.5) - (0.5 - rad), 0);
          if (rounded && dx * dx + dy * dy > rad * rad) continue;
          let col = BG;
          const cu = (u - 0.5) / scale + 0.5, cv = (v - 0.5) / scale + 0.5;
          for (const f of FACES) if (inside(f.pts, cu, cv)) col = f.color;
          r += col[0]; g += col[1]; b += col[2]; a += 255;
        }
      }
      const n = ss * ss, o = (y * size + x) * 4;
      if (a > 0) {
        const cov = a / 255;
        px[o] = r / cov; px[o + 1] = g / cov; px[o + 2] = b / cov;
      }
      px[o + 3] = a / n;
    }
  }
  return png(size, size, px);
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

writeFileSync('public/icon-192.png', render(192));
writeFileSync('public/icon-512.png', render(512));
// Maskable icons must be full-bleed with the artwork inside the 80% safe zone.
writeFileSync('public/icon-maskable-512.png', render(512, { scale: 0.72, rounded: false }));
const poly = (f) => `<polygon fill="rgb(${f.color})" points="${f.pts.map(([x, y]) => `${x * 100},${y * 100}`).join(' ')}"/>`;
writeFileSync('public/icon.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="rgb(${BG})"/>${FACES.map(poly).join('')}</svg>\n`);
console.log('icons written to public/');
