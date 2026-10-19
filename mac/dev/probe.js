// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Self-check: a minimal Windows-side client. Pairs once (click Allow),
// saves {fp, token} in dev/.probe.json, then says hello, pings for 5 s and prints the RTT.
// Usage: npm run probe [-- <host>]
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const P = require('../../shared/protocol.js');

const host = process.argv[2] || '127.0.0.1';
const saveFile = path.join(__dirname, '.probe.json');
let saved = {};
try { saved = JSON.parse(fs.readFileSync(saveFile, 'utf8')); } catch {}
if (!saved.id) saved.id = crypto.randomUUID();
const name = `probe@${os.hostname().replace(/\.local$/i, '')}`;

const ws = new WebSocket(`wss://${host}:${P.PORT}`, { rejectUnauthorized: false });
let fp = null;
let nw = null;
let rtts = [];

const send = (m) => ws.send(JSON.stringify(m));
const save = () => fs.writeFileSync(saveFile, JSON.stringify(saved, null, 2));
const done = (code, text) => {
  console.log(text);
  ws.close();
  process.exit(code);
};

ws.on('upgrade', (res) => {
  fp = P.normFingerprint(res.socket.getPeerCertificate().fingerprint256);
  console.log(`connected to ${host}, fp ${fp}`);
});

const hello = () => send({ t: P.T.HELLO, v: P.PROTOCOL_VERSION, id: saved.id, name, token: saved.token });

ws.on('open', () => {
  if (saved.token) {
    if (saved.fp !== fp) return done(1, "This Mac's identity changed — delete dev/.probe.json and pair again");
    console.log('paired before, sending hello');
    return hello();
  }
  nw = P.randomHex(16);
  console.log('not paired, sending pair.start');
  send({ t: P.T.PAIR_START, v: P.PROTOCOL_VERSION, id: saved.id, name, commit: P.commitOf(nw) });
});

ws.on('message', (data) => {
  const m = JSON.parse(data.toString());
  switch (m.t) {
    case P.T.PAIR_NONCE:
      send({ t: P.T.PAIR_REVEAL, nonce: nw });
      console.log(`code ${P.sasCode(fp, nw, m.nonce)} — click Allow in the TwinDesk window`);
      send({ t: P.T.PAIR_CONFIRM });
      break;
    case P.T.PAIR_OK:
      Object.assign(saved, { fp, token: m.token, macId: m.macId, macName: m.macName });
      save();
      console.log(`pair.ok from ${m.macName}, saved token`);
      hello();
      break;
    case P.T.WELCOME:
      console.log(`welcome from ${m.macName} (${m.macId})`);
      setInterval(() => send({ t: P.T.PING, ts: Date.now() }), P.PING_MS);
      setTimeout(() => {
        const avg = rtts.length ? (rtts.reduce((a, b) => a + b, 0) / rtts.length).toFixed(1) : 'n/a';
        done(0, `RTT avg ${avg} ms over ${rtts.length} pings`);
      }, 5000);
      break;
    case P.T.PING:
      send({ t: P.T.PONG, ts: m.ts });
      break;
    case P.T.PONG:
      rtts.push(Date.now() - m.ts);
      break;
    case P.T.ERROR:
      if (m.code === P.E.BAD_TOKEN) {
        delete saved.token;
        save();
      }
      done(1, `error ${m.code}: ${m.message}`);
      break;
    default:
      break;
  }
});

ws.on('close', () => done(1, 'connection closed'));
ws.on('error', (err) => done(1, `socket error: ${err.message}`));
