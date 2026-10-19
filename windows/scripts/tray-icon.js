// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Writes assets/tray-white.png / tray-black.png (16 px) and @2x (32 px): the app mark's two
// screens as the tray icon: white for dark taskbars, black
// for light ones. Same shapes as mac/dev/tray-icon.js, on a 16 px canvas. Run: node scripts/tray-icon.js
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const RECTS = [ // [x, y, w, h, stroke] in px on a 16 × 16 canvas: two equal screen outlines
  [0.5, 4.5, 7, 6.5, 1.5],
  [8.5, 4.5, 7, 6.5, 1.5],
];

function alphaAt(px, py) {
  for (const [x, y, w, h, s] of RECTS) {
    const inOuter = px >= x && px <= x + w && py >= y && py <= y + h;
    const inInner = px > x + s && px < x + w - s && py > y + s && py < y + h - s;
    if (inOuter && !inInner) return 1;
  }
  return 0;
}

function png(size, rgb) {
  const k = size / 16, ss = 4;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let a = 0;
      for (let i = 0; i < ss; i++) for (let j = 0; j < ss; j++) a += alphaAt((x + (i + 0.5) / ss) / k, (y + (j + 0.5) / ss) / k);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = rgb; raw[o + 1] = rgb; raw[o + 2] = rgb;
      raw[o + 3] = Math.round((255 * a) / (ss * ss));
    }
  }
  const crc = (buf) => {
    let c = ~0;
    for (const b of buf) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const out = path.join(__dirname, '..', 'assets');
for (const [name, rgb] of [['white', 255], ['black', 0]]) {
  fs.writeFileSync(path.join(out, `tray-${name}.png`), png(16, rgb));
  fs.writeFileSync(path.join(out, `tray-${name}@2x.png`), png(32, rgb));
}
console.log('wrote assets/tray-white.png, tray-black.png, @2x');
