// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Drive a TwinDesk window over Chrome DevTools (the app started with --remote-debugging-port,
// as scripts/vm-test.sh does), for testing:
//   node cdp.js PORT list
//   node cdp.js PORT eval "expr" [page]      page: part of the URL (app.html), #n for the n-th, #* for all
//   node cdp.js PORT shot out.png [page]
//   node cdp.js PORT click x,y [page]
'use strict';

const http = require('http');
const path = require('path');
const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'));

const [port, cmd, arg, sel = 'app.html'] = process.argv.slice(2);
const [match, nth = '0'] = sel.split('#');

function run(page) {
  return new Promise((done) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const send = (id, method, params) => ws.send(JSON.stringify({ id, method, params }));
    ws.on('open', () => {
      if (cmd === 'eval') send(1, 'Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true });
      else if (cmd === 'shot') send(1, 'Page.captureScreenshot', { format: 'png' });
      else if (cmd === 'click') {
        const [x, y] = arg.split(',').map(Number);
        const ev = (type, id) => send(id, 'Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
        ev('mouseMoved', 7);
        setTimeout(() => ev('mousePressed', 8), 80);
        setTimeout(() => ev('mouseReleased', 1), 160);
      }
    });
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.id !== 1) return;
      if (cmd === 'eval') {
        const r = m.result;
        console.log(r.exceptionDetails ? `EXC ${JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description)}` : JSON.stringify(r.result && r.result.value, null, 1));
      } else if (cmd === 'shot') require('fs').writeFileSync(arg, Buffer.from(m.result.data, 'base64'));
      ws.close();
      done();
    });
  });
}

http.get({ host: '127.0.0.1', port, path: '/json' }, (res) => {
  let body = '';
  res.on('data', (d) => (body += d));
  res.on('end', async () => {
    const pages = JSON.parse(body).filter((p) => p.type === 'page');
    if (cmd === 'list') {
      for (const p of pages) console.log(p.id.slice(0, 6), p.title, '|', p.url);
      return;
    }
    const hits = pages.filter((p) => p.url.includes(match));
    const todo = nth === '*' ? hits : [hits[Number(nth)]].filter(Boolean);
    if (!todo.length) {
      console.error('no page', sel);
      process.exit(1);
    }
    for (const p of todo) await run(p);
  });
}).on('error', (e) => {
  console.error(e.message);
  process.exit(1);
});
