// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Dev check for macshare-linuxhelper: edge, capture, keys, buttons,
// wheel, stop at an edge, dead-man, place, injected moves and the return edge, the hotkey. Needs a
// display nobody's mouse is over (Xephyr picks up the PC's pointer): `Xvfb :3 -screen 0
// 1920x1080x24 &`, then `DISPLAY=:3 node linux-helper/dev/helper-test.js`. Fakes input with xt.c
// (XTest, built on first use), so the helper starts with MACSHARE_HELPER_TEST_XTEST=1.
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const BIN = path.join(__dirname, '..', 'bin', 'macshare-linuxhelper');
const XT = path.join(__dirname, '..', 'bin', 'xt');
if (!require('fs').existsSync(XT)) execFileSync('gcc', ['-O2', '-o', XT, path.join(__dirname, 'xt.c'), '-lX11', '-lXtst']);
const env = { ...process.env, DISPLAY: process.env.DISPLAY || ':3', MACSHARE_HELPER_TEST_XTEST: '1' };
const h = spawn(BIN, [], { env, stdio: ['pipe', 'pipe', 'inherit'] });
const events = [];
let id = 1;
const waiters = new Map();
let buf = '';
h.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    const m = JSON.parse(line);
    if (m.event) events.push(m);
    else if (waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  }
});
const req = (cmd, a = {}) => new Promise((r) => { const n = id++; waiters.set(n, r); h.stdin.write(JSON.stringify({ ...a, cmd, id: n }) + '\n'); });
const send = (cmd, a = {}) => h.stdin.write(JSON.stringify({ ...a, cmd }) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const xt = (...a) => execFileSync(XT, a.map(String), { env });
const ok = (name, cond, extra = '') => console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));
const take = (name) => { const i = events.findIndex((e) => e.event === name); return i < 0 ? null : events.splice(i, 1)[0]; };

(async () => {
  await sleep(300);
  ok('ready', !!take('ready'));
  await req('kvmConfig', { side: 'right', resistancePx: 60, hotkey: 'AltRight', driveOther: true, keyboard: true, deadmanMs: 1500, doubleTapMs: 400 });
  // 1. edge: put the pointer at the right edge and keep pushing
  xt('move', 1919, 500);
  await sleep(100);
  for (let i = 0; i < 20; i++) { xt('rel', 10, 0); await sleep(15); }
  await sleep(200);
  const edge = take('edge');
  ok('edge event', !!edge, JSON.stringify(edge));
  let info = await req('info');
  ok('capturing after edge', info.capturing === true, JSON.stringify(info));
  // 2. motion while capturing becomes k.mm
  events.length = 0;
  const keep = setInterval(() => send('keepalive'), 300);
  xt('rel', -30, 5);
  await sleep(150);
  const mm = events.filter((e) => e.event === 'ev' && e.ev.t === 'k.mm');
  ok('k.mm forwarded', mm.length > 0, JSON.stringify(mm.slice(0, 2)));
  // 3. a key while capturing → k.kd/k.ku
  events.length = 0;
  xt('key', 38); // A
  await sleep(150);
  const keys = events.filter((e) => e.event === 'ev' && /^k\.k/.test(e.ev.t)).map((e) => e.ev.t + ':' + e.ev.code);
  ok('keys forwarded', keys.includes('k.kd:KeyA') && keys.includes('k.ku:KeyA'), keys.join(','));
  // 4. click → k.md/k.mu, wheel → k.wh
  events.length = 0;
  xt('click', 1, 'click', 5);
  await sleep(150);
  const btn = events.filter((e) => e.event === 'ev').map((e) => e.ev.t);
  ok('buttons + wheel forwarded', btn.includes('k.md') && btn.includes('k.mu') && btn.includes('k.wh'), btn.join(','));
  // 5. stop with a side: pointer goes to the right edge at the offset
  clearInterval(keep);
  await req('capture', { on: false, side: 'right', offset: 0.25 });
  info = await req('info');
  ok('stop puts pointer at edge', info.capturing === false && info.cursor[0] >= 1915 && Math.abs(info.cursor[1] - 270) < 5, JSON.stringify(info));
  // 6. dead-man: capture with no keepalive ends by itself
  await req('capture', { on: true, mouse: true, keyboard: true });
  await sleep(1900);
  ok('dead-man ends capture', !!take('captureEnded'));
  await req('kvmConfig', { side: 'right', resistancePx: 60, hotkey: 'AltRight', driveOther: false, keyboard: true }); // our XTest moves would cross again
  await req('kvmConfig', { side: 'right', resistancePx: 60, hotkey: 'AltRight', driveOther: false, keyboard: true }); // our XTest moves would cross again
  // 7. driven: place + inject moves, return edge
  await req('place', { side: 'left', offset: 0.5 });
  info = await req('info');
  ok('place at left edge', info.cursor[0] <= 3 && Math.abs(info.cursor[1] - 540) < 3, JSON.stringify(info.cursor));
  await req('armReturn', { on: true, side: 'right', resistancePx: 60 });
  for (let i = 0; i < 100; i++) send('inject', { ev: { t: 'k.mm', dx: 25, dy: 0 } });
  await sleep(300);
  info = await req('info');
  const ret = take('return');
  ok('inject moved to right edge, return fired', info.cursor[0] >= 1915 && !!ret, JSON.stringify(info.cursor) + ' ' + JSON.stringify(ret));
  // 8. hotkey: a double-tap at home, and while capturing (stops capture first, never sent over)
  events.length = 0;
  xt('tap', 108, 2, 120); // Right Alt
  await sleep(150);
  ok('hotkey at home', events.some((e) => e.event === 'hotkey' && e.wasCapturing === false));
  const keep2 = setInterval(() => send('keepalive'), 300);
  await req('capture', { on: true, mouse: true, keyboard: true });
  events.length = 0;
  xt('tap', 108, 2, 120);
  await sleep(150);
  clearInterval(keep2);
  info = await req('info');
  ok('hotkey while capturing', events.some((e) => e.event === 'hotkey' && e.wasCapturing === true) && !info.capturing
    && !events.some((e) => e.event === 'ev' && e.ev.t === 'k.kd'), 'taps never reach the other computer');
  // 9. inject a key; releaseAll
  send('inject', { ev: { t: 'k.kd', code: 'ShiftLeft' } });
  await req('releaseAll');
  ok('releaseAll answered', true);
  h.stdin.end();
  h.on('exit', (c) => { console.log('exit', c); process.exit(0); });
})();
