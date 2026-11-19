// Builds images/icon.png (128x128) for the VS Code Marketplace from the official
// WeRoam brand logomark: white logomark composited onto a rounded brand-purple
// tile (reads even on light & dark marketplace themes). Dependency-free — decodes
// the source PNGs with zlib, samples the brand purple from the full-color mark,
// 4x supersamples and box-downsamples for anti-aliasing, re-encodes via zlib.
//
// Source assets in images/_brand/ are downloaded from the WeRoam media kit.
// Run: node scripts/gen-icon.js
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const BRAND = path.join(__dirname, '..', 'images', '_brand');
const WHITE_LOGO = path.join(BRAND, 'Logomark-White.png');
const COLOR_LOGO = path.join(BRAND, 'Logomark-Fullcolor.png');
const OUT_PATH = path.join(__dirname, '..', 'images', 'icon.png');

const OUT = 128, S = 4, N = OUT * S; // render at 512, downsample to 128

// ---------- minimal PNG decode (8-bit, color type 2/6, no interlace) ----------
function decodePng(file) {
  const buf = fs.readFileSync(file);
  let p = 8; // skip signature
  let w = 0, h = 0, ct = 6, bd = 8;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p); const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bd !== 8) throw new Error('only 8-bit PNG supported');
  const channels = ct === 6 ? 4 : ct === 2 ? 3 : 0;
  if (!channels) throw new Error('only color type 2/6 supported, got ' + ct);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = Buffer.alloc(w * h * 4);
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  let q = 0;
  const pae = (a, b, c) => { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < h; y++) {
    const f = raw[q++];
    for (let i = 0; i < stride; i++) {
      const x = raw[q++];
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v;
      switch (f) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: v = x + pae(a, b, c); break;
        default: throw new Error('bad filter ' + f);
      }
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < w; x++) {
      const si = x * channels, di = (y * w + x) * 4;
      out[di] = cur[si]; out[di + 1] = cur[si + 1]; out[di + 2] = cur[si + 2];
      out[di + 3] = channels === 4 ? cur[si + 3] : 255;
    }
    cur.copy(prev);
  }
  return { w, h, data: out };
}

// ---------- sample brand purple from the full-color logomark ----------
function sampleBrandPurple(img) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < img.w * img.h; i++) {
    const o = i * 4, R = img.data[o], G = img.data[o + 1], B = img.data[o + 2], A = img.data[o + 3];
    if (A > 200 && B > 110 && R > G + 30 && B > G + 30) { r += R; g += G; b += B; n++; }
  }
  if (!n) return [124, 46, 230];
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

const white = decodePng(WHITE_LOGO);
const purple = sampleBrandPurple(decodePng(COLOR_LOGO));
console.log('brand purple =', purple);

// content bbox of the logo (alpha-based)
let minx = white.w, miny = white.h, maxx = 0, maxy = 0;
for (let y = 0; y < white.h; y++) for (let x = 0; x < white.w; x++) {
  if (white.data[(y * white.w + x) * 4 + 3] > 16) { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
}
const lw = maxx - minx + 1, lh = maxy - miny + 1;

// fit logo into a target box centered in N (render space)
const target = Math.round(N * 0.66);
const scale = target / Math.max(lw, lh);
const dW = lw * scale, dH = lh * scale;
const offX = (N - dW) / 2, offY = (N - dH) / 2;
const R = Math.round(N * 0.20); // rounded corner radius

function logoAlphaAt(X, Y) {
  // inverse-map render pixel -> source coords (bilinear alpha)
  const sx = minx + (X - offX) / scale;
  const sy = miny + (Y - offY) / scale;
  if (sx < 0 || sy < 0 || sx >= white.w - 1 || sy >= white.h - 1) return 0;
  const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
  const a = (ix, iy) => white.data[(iy * white.w + ix) * 4 + 3];
  const top = a(x0, y0) * (1 - fx) + a(x0 + 1, y0) * fx;
  const bot = a(x0, y0 + 1) * (1 - fx) + a(x0 + 1, y0 + 1) * fx;
  return top * (1 - fy) + bot * fy;
}
function insideTile(x, y) {
  const minc = R, maxcx = N - R, maxcy = N - R;
  const cx = Math.max(minc, Math.min(x, maxcx)), cy = Math.max(minc, Math.min(y, maxcy));
  if ((x < minc || x > maxcx) && (y < minc || y > maxcy)) return Math.hypot(x - cx, y - cy) <= R;
  return true;
}

// render supersampled RGBA
const big = Buffer.alloc(N * N * 4);
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  const i = (y * N + x) * 4;
  if (!insideTile(x, y)) { big[i + 3] = 0; continue; }
  const a = logoAlphaAt(x, y) / 255; // white logo coverage
  big[i] = Math.round(purple[0] * (1 - a) + 255 * a);
  big[i + 1] = Math.round(purple[1] * (1 - a) + 255 * a);
  big[i + 2] = Math.round(purple[2] * (1 - a) + 255 * a);
  big[i + 3] = 255;
}

// box-downsample S x S -> OUT (premultiplied for clean rounded edges)
const out = Buffer.alloc(OUT * OUT * 4);
for (let y = 0; y < OUT; y++) for (let x = 0; x < OUT; x++) {
  let r = 0, g = 0, b = 0, a = 0;
  for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
    const i = ((y * S + sy) * N + (x * S + sx)) * 4, af = big[i + 3] / 255;
    r += big[i] * af; g += big[i + 1] * af; b += big[i + 2] * af; a += big[i + 3];
  }
  const o = (y * OUT + x) * 4, aAvg = a / (S * S);
  if (aAvg === 0) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; continue; }
  const wsum = a / 255;
  out[o] = Math.round(r / wsum); out[o + 1] = Math.round(g / wsum); out[o + 2] = Math.round(b / wsum); out[o + 3] = Math.round(aAvg);
}

// ---------- PNG encode (RGBA 8-bit) ----------
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(b) { let c = ~0; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8); return ~c; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0); const body = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0, 0); return Buffer.concat([len, body, crc]); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(OUT, 0); ihdr.writeUInt32BE(OUT, 4); ihdr[8] = 8; ihdr[9] = 6;
const rawOut = Buffer.alloc(OUT * (OUT * 4 + 1));
for (let y = 0; y < OUT; y++) { rawOut[y * (OUT * 4 + 1)] = 0; out.copy(rawOut, y * (OUT * 4 + 1) + 1, y * OUT * 4, (y + 1) * OUT * 4); }
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rawOut, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
fs.writeFileSync(OUT_PATH, png);
console.log(`wrote ${OUT_PATH} (${png.length} bytes, ${OUT}x${OUT})`);
