// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Dev tool: measures the Mac's stream on this Mac (loopback). Needs the Mac app running and
// dev/.probe.json (run `npm run probe` once). Run from mac/: `npx electron dev/stream-check [seconds]`.
// Shows an animated pattern with a pixel-encoded clock on the TwinDesk display, receives the
// stream like Windows does, decodes the clock from each frame -> capture-to-decode latency.
'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, screen } = require('electron');
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
const WebSocket = require('ws');
const saved = require('../.probe.json');

const SECONDS = Number(process.argv[process.argv.length - 1]) || 20;
const pre = path.join(__dirname, 'preload.js');

app.whenReady().then(() => {
  const all = screen.getAllDisplays();
  const target = all.find((d) => /macshare/i.test(d.label)) || all.find((d) => d.id !== screen.getPrimaryDisplay().id);
  if (!target) console.log('no TwinDesk display found — pattern goes on the main display');
  const b = (target || screen.getPrimaryDisplay()).bounds;
  const pattern = new BrowserWindow({ x: b.x, y: b.y, width: b.width, height: b.height, frame: false, show: true, webPreferences: { backgroundThrottling: false } });
  pattern.loadFile(path.join(__dirname, 'pattern.html'));

  const rx = new BrowserWindow({ width: 480, height: 300, show: true, webPreferences: { preload: pre, contextIsolation: true, backgroundThrottling: false } });
  // macOS keeps windows below the menu bar: tell the receiver where the pattern really is.
  const pb = pattern.getBounds();
  rx.loadFile(path.join(__dirname, 'rx.html'), { query: { w: String(b.width), ox: String(pb.x - b.x), oy: String(pb.y - b.y) } });
  rx.webContents.on('console-message', (e) => console.log(e.message));

  const ws = new WebSocket(`wss://127.0.0.1:${Number(process.env.MACSHARE_DEV_PORT) || 47800}`, { rejectUnauthorized: false });
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: 1, id: saved.id || 'probe', name: 'stream-check', token: saved.token })));
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.t === 'ping') return ws.send(JSON.stringify({ t: 'pong', ts: m.ts }));
    if (m.t.startsWith('rtc.') || m.t.startsWith('stream.')) rx.webContents.send('m', m);
    if (m.t === 'error') console.log('error from Mac:', m.code);
    if (m.t === 'welcome' && process.env.AUDIO) ws.send(JSON.stringify({ t: 'audio.policy', accept: true }));
  });
  ws.on('close', () => console.log('link closed'));
  ipcMain.on('out', (_e, m) => ws.send(JSON.stringify(m)));
  setTimeout(() => app.exit(0), SECONDS * 1000);
});
