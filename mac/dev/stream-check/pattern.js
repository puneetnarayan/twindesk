// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Clock: 24 bits of (Date.now() mod 2^24) as 48 px black/white blocks in the top-left corner,
// plus moving text so the encoder has real work.
const BITS = 24, B = 48;
const c = document.getElementById('c');
const g = c.getContext('2d');
c.width = innerWidth; c.height = innerHeight;
const lorem = 'The quick brown fox jumps over the lazy dog 0123456789 — TwinDesk stream check. ';
function draw() {
  const now = Date.now() % 2 ** BITS;
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < BITS; i++) {
    g.fillStyle = (now >> i) & 1 ? '#fff' : '#000';
    g.fillRect(i * B, 0, B, B);
  }
  g.fillStyle = '#f00'; g.fillRect(BITS * B, 0, B, B); // end marker
  g.fillStyle = '#222'; g.font = '14px -apple-system, sans-serif';
  const off = (performance.now() / 8) % 600;
  for (let y = 80; y < c.height; y += 20) g.fillText(lorem.repeat(4), 20 - off + ((y * 7) % 300), y);
  const x = (performance.now() / 3) % (c.width - 200);
  g.fillStyle = '#0a84ff'; g.fillRect(x, c.height / 2 - 100, 200, 200);
  requestAnimationFrame(draw);
}
draw();
