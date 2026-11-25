// Minimal PNG encode/decode (8-bit RGBA, no interlacing) on top of fflate's zlib. The app uses the
// browser's encoder for speed; this one is for tests, sample files and environments without one.

import { unzlibSync, zlibSync } from 'fflate';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** Encodes straight-alpha RGBA rows (top row first) as a PNG file. */
export function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    // Filter "Sub" per row: compresses flat paint well and is cheap.
    const o = y * (stride + 1);
    raw[o] = 1;
    for (let x = 0; x < stride; x++) {
      const cur = rgba[y * stride + x];
      raw[o + 1 + x] = x < 4 ? cur : (cur - rgba[y * stride + x - 4]) & 0xff;
    }
  }
  const idat = zlibSync(raw, { level: 6 });
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit, RGBA, deflate, adaptive filtering, no interlace
  const chunks = [chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(8 + chunks.reduce((n, c) => n + c.length, 0));
  out.set(SIGNATURE, 0);
  let p = 8;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const c = new Uint8Array(12 + data.length);
  const dv = new DataView(c.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) c[4 + i] = type.charCodeAt(i);
  c.set(data, 8);
  dv.setUint32(8 + data.length, crc32(c, 4, 8 + data.length));
  return c;
}

/** Decodes an 8-bit RGBA or RGB PNG (non-interlaced) into RGBA rows, top row first. */
export function decodePng(png: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  if (!SIGNATURE.every((b, i) => png[i] === b)) throw new Error('Not a PNG file');
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let p = 8, width = 0, height = 0, colorType = 6;
  const idat: Uint8Array[] = [];
  while (p < png.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(...png.subarray(p + 4, p + 8));
    const data = png.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = dv.getUint32(p + 8);
      height = dv.getUint32(p + 12);
      colorType = data[9];
      if (data[8] !== 8 || (colorType !== 6 && colorType !== 2) || data[12] !== 0) throw new Error('Unsupported PNG');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const all = new Uint8Array(idat.reduce((n, d) => n + d.length, 0));
  let o = 0;
  for (const d of idat) {
    all.set(d, o);
    o += d.length;
  }
  const raw = unzlibSync(all);
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const r = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
      let v = r;
      if (f === 1) v = r + a;
      else if (f === 2) v = r + b;
      else if (f === 3) v = r + ((a + b) >> 1);
      else if (f === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v = r + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      px[y * stride + x] = v & 0xff;
    }
  }
  if (bpp === 4) return { width, height, rgba: px };
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) rgba.set([px[i * 3], px[i * 3 + 1], px[i * 3 + 2], 255], i * 4);
  return { width, height, rgba };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
