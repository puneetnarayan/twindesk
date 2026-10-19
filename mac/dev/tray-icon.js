// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Writes assets/trayTemplate.png (18 pt) and @2x: the app mark's two screens as a menu bar
// template image (black + alpha; macOS tints it). Run: node dev/tray-icon.js
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Shapes in points on an 18 × 18 canvas: the app mark's two equal screen outlines.
const RECTS = [ // [x, y, w, h, stroke]
  [1, 5.5, 7.5, 6.5, 1.5],
  [9.5, 5.5, 7.5, 6.5, 1.5],
];
const FILLS = [];

function alphaAt(px, py) { // coverage of one point-space sample
  for (const [x, y, w, h, s] of RECTS) {
    const inOuter = px >= x && px <= x + w && py >= y && py <= y + h;
    const inInner = px > x + s && px < x + w - s && py > y + s && py < y + h - s;
    if (inOuter && !inInner) return 1;
  }
  for (const [x, y, w, h] of FILLS) if (px >= x && px <= x + w && py >= y && py <= y + h) return 1;
  return 0;
}

function png(size) {
  const k = size / 18, ss = 4;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let a = 0;
      for (let i = 0; i < ss; i++) for (let j = 0; j < ss; j++) a += alphaAt((x + (i + 0.5) / ss) / k, (y + (j + 0.5) / ss) / k);
      raw[y * (size * 4 + 1) + 1 + x * 4 + 3] = Math.round((255 * a) / (ss * ss));
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
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'trayTemplate.png'), png(18));
fs.writeFileSync(path.join(out, 'trayTemplate@2x.png'), png(36));
console.log('wrote assets/trayTemplate.png, @2x');
