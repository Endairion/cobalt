'use strict';

/**
 * Draw the app icon.
 *
 * A checked-in binary nobody can edit is a small liability, so the icon is
 * generated from this file instead: a dark rounded square with three bars —
 * a grid seen edge-on, which is what the app mostly is — over the accent blue
 * the rest of the interface uses.
 *
 * Writes assets/icon.png at 512px. electron-builder derives every size it
 * needs, including the Windows .ico, from that one file.
 *
 * Run: npm run icon
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 512;

const BG = [0x14, 0x16, 0x1c];          // the app's own background
const BAR_TOP = [0x8f, 0xb8, 0xff];     // accent-text, the brightest bar
const BAR_MID = [0x4c, 0x8d, 0xff];     // accent
const BAR_LOW = [0x2f, 0x5c, 0xad];     // accent, receding

/** Distance outside a rounded rectangle, for anti-aliasing its edge. */
function roundedRectDistance(x, y, left, top, right, bottom, radius) {
  const cx = Math.max(left + radius, Math.min(x, right - radius));
  const cy = Math.max(top + radius, Math.min(y, bottom - radius));
  const dx = x - cx;
  const dy = y - cy;
  const d = Math.sqrt(dx * dx + dy * dy);
  return d - radius;
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

function draw() {
  const px = Buffer.alloc(SIZE * SIZE * 4, 0);
  const pad = SIZE * 0.06;
  const radius = SIZE * 0.22;

  // Three bars, the top one widest, so it reads as a table rather than a menu.
  const bars = [
    { y: 0.30, h: 0.105, w: 0.60, color: BAR_TOP },
    { y: 0.45, h: 0.105, w: 0.46, color: BAR_MID },
    { y: 0.60, h: 0.105, w: 0.52, color: BAR_LOW },
  ];

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      const outside = roundedRectDistance(x + 0.5, y + 0.5, pad, pad, SIZE - pad, SIZE - pad, radius);
      // One pixel of feathering, so the corners are not stepped.
      const alpha = Math.max(0, Math.min(1, 0.5 - outside));
      if (alpha <= 0) continue;

      let color = BG;
      for (const bar of bars) {
        const bx = SIZE * 0.20;
        const bw = SIZE * bar.w;
        const by = SIZE * bar.y;
        const bh = SIZE * bar.h;
        const br = bh / 2;
        const d = roundedRectDistance(x + 0.5, y + 0.5, bx, by, bx + bw, by + bh, br);
        const cover = Math.max(0, Math.min(1, 0.5 - d));
        if (cover > 0) color = mix(color, bar.color, cover);
      }

      px[i] = color[0];
      px[i + 1] = color[1];
      px[i + 2] = color[2];
      px[i + 3] = Math.round(alpha * 255);
    }
  }
  return px;
}

/* ------------------------------ PNG encoding ------------------------------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(pixels, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;        // bit depth
  ihdr[9] = 6;        // colour type: RGBA
  // Each scanline is prefixed with its filter type; 0 means none.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = path.join(__dirname, '..', 'assets', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, encodePng(draw(), SIZE));
console.log(`wrote ${out} (${SIZE}x${SIZE})`);
