// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A small TURN server (RFC 8656) on 127.0.0.1, TCP only, for a phone on a USB cable. adb can
// tunnel TCP (adb reverse) but not UDP, and WebRTC sends its media over UDP: with both ends told
// to use only this relay (iceTransportPolicy 'relay'), each gets a relayed address here, the media
// goes WebRTC -> TCP (the phone's through adb) -> this process -> loopback UDP -> the other end's
// allocation -> TCP, and neither side needs a network. Only what browsers use: Allocate (long-term
// credentials), Refresh, CreatePermission, ChannelBind, Send/Data indications and ChannelData.
//
// Latency: media over TCP never drops, so a stall (adb, the cable, a busy decoder) would queue
// frames and play them late for good. A TCP client more than MAX_QUEUE behind loses datagrams
// instead, as a network would, and WebRTC slows down and asks for a fresh picture. The relay runs
// in a thread of its own (TurnThread), so the app's busy main thread never holds a frame.
//
//   const turn = new TurnThread({ port }); await turn.start(); turn.ice() -> RTCConfiguration
'use strict';

const net = require('net');
const dgram = require('dgram');
const crypto = require('crypto');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const MAX_QUEUE = 64 * 1024; // bytes waiting to go to one client: ~30 ms at 16 Mbps

const COOKIE = 0x2112a442;
const M = {
  BINDING: 0x0001, ALLOCATE: 0x0003, REFRESH: 0x0004, SEND: 0x0016, DATA: 0x0017,
  CREATE_PERMISSION: 0x0008, CHANNEL_BIND: 0x0009,
};
const A = {
  USERNAME: 0x0006, MESSAGE_INTEGRITY: 0x0008, ERROR_CODE: 0x0009, CHANNEL_NUMBER: 0x000c,
  LIFETIME: 0x000d, XOR_PEER_ADDRESS: 0x0012, DATA: 0x0013, REALM: 0x0014, NONCE: 0x0015,
  XOR_RELAYED_ADDRESS: 0x0016, REQUESTED_TRANSPORT: 0x0019, XOR_MAPPED_ADDRESS: 0x0020, FINGERPRINT: 0x8028,
};
const SUCCESS = 0x0100;
const ERROR = 0x0110;
const LIFETIME = 600;
const REALM = 'twindesk';

const pad4 = (n) => (n + 3) & ~3;

function parse(buf) {
  const type = buf.readUInt16BE(0);
  const len = buf.readUInt16BE(2);
  const tid = buf.subarray(8, 20);
  const attrs = new Map();
  let mi = -1;
  for (let o = 20; o + 4 <= 20 + len;) {
    const t = buf.readUInt16BE(o);
    const l = buf.readUInt16BE(o + 2);
    if (t === A.MESSAGE_INTEGRITY) mi = o;
    if (!attrs.has(t)) attrs.set(t, buf.subarray(o + 4, o + 4 + l));
    o += 4 + pad4(l);
  }
  return { type, tid, attrs, mi };
}

function xorAddr(ip, port) {
  const b = Buffer.alloc(8);
  b[1] = 0x01;
  b.writeUInt16BE(port ^ (COOKIE >>> 16), 2);
  const n = ip.split('.').reduce((a, x) => (a << 8) + Number(x), 0) >>> 0;
  b.writeUInt32BE((n ^ COOKIE) >>> 0, 4);
  return b;
}

function unXorAddr(b) {
  if (!b || b.length < 8 || b[1] !== 0x01) return null;
  const port = b.readUInt16BE(2) ^ (COOKIE >>> 16);
  const n = (b.readUInt32BE(4) ^ COOKIE) >>> 0;
  return { ip: [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'), port };
}

function attr(t, v) {
  const h = Buffer.alloc(4);
  h.writeUInt16BE(t, 0);
  h.writeUInt16BE(v.length, 2);
  return Buffer.concat([h, v, Buffer.alloc(pad4(v.length) - v.length)]);
}

// A message; with a key, MESSAGE-INTEGRITY over everything before it (length counting it).
function message(type, tid, attrs, key) {
  let body = Buffer.concat(attrs);
  const head = Buffer.alloc(20);
  head.writeUInt16BE(type, 0);
  head.writeUInt32BE(COOKIE, 4);
  tid.copy(head, 8);
  if (key) {
    head.writeUInt16BE(body.length + 24, 2);
    const mac = crypto.createHmac('sha1', key).update(Buffer.concat([head, body])).digest();
    body = Buffer.concat([body, attr(A.MESSAGE_INTEGRITY, mac)]);
  }
  head.writeUInt16BE(body.length, 2);
  return Buffer.concat([head, body]);
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

class Turn {
  constructor({ port, host = '127.0.0.1', password }) {
    this.port = port;
    this.host = host;
    this.username = 'td';
    this.password = password || crypto.randomBytes(12).toString('hex');
    this.key = crypto.createHash('md5').update(`${this.username}:${REALM}:${this.password}`).digest();
    this.nonce = crypto.randomBytes(8).toString('hex');
    this.conns = new Set();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((sock) => this._conn(sock));
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', reject);
        this.server.on('error', (e) => console.error(`[turn] ${e.message}`));
        resolve();
      });
    });
  }

  stop() {
    for (const c of this.conns) c.sock.destroy();
    if (this.server) this.server.close();
  }

  // What both ends pass to RTCPeerConnection while the phone is on the cable.
  ice() {
    return {
      iceServers: [{ urls: `turn:127.0.0.1:${this.port}?transport=tcp`, username: this.username, credential: this.password }],
      iceTransportPolicy: 'relay',
    };
  }

  _conn(sock) {
    sock.setNoDelay(true);
    const c = { sock, buf: Buffer.alloc(0), relay: null, channels: new Map(), peers: new Map(), expires: 0 };
    this.conns.add(c);
    sock.on('data', (d) => {
      c.buf = c.buf.length ? Buffer.concat([c.buf, d]) : d;
      try {
        this._drain(c);
      } catch (e) {
        console.error(`[turn] ${e.message}`);
        sock.destroy();
      }
    });
    const end = () => {
      this.conns.delete(c);
      if (c.relay) c.relay.close();
      c.relay = null;
    };
    sock.on('close', end);
    sock.on('error', () => {});
  }

  // TCP is a stream: STUN messages (top bits 00) and ChannelData (01, padded to 4 on TCP).
  _drain(c) {
    for (;;) {
      if (c.buf.length < 4) return;
      const first = c.buf[0] >> 6;
      let total;
      if (first === 0) total = 20 + c.buf.readUInt16BE(2);
      else if (first === 1) total = pad4(4 + c.buf.readUInt16BE(2));
      else throw new Error('not STUN');
      if (c.buf.length < total) return;
      const frame = c.buf.subarray(0, total);
      c.buf = c.buf.subarray(total);
      if (first === 1) this._channelData(c, frame);
      else this._stun(c, frame);
    }
  }

  _channelData(c, frame) {
    const peer = c.channels.get(frame.readUInt16BE(0));
    if (peer && c.relay) c.relay.send(frame.subarray(4, 4 + frame.readUInt16BE(2)), peer.port, peer.ip);
  }

  _send(c, b) {
    if (!c.sock.destroyed) c.sock.write(b);
  }

  // Media to a client: dropped while it is too far behind (see MAX_QUEUE).
  _media(c, b) {
    if (c.sock.destroyed) return;
    if (c.sock.writableLength > MAX_QUEUE) {
      c.dropped = (c.dropped || 0) + 1;
      return;
    }
    c.sock.write(b);
  }

  _error(c, m, code, reason, extra = []) {
    const e = Buffer.alloc(4);
    e[2] = Math.floor(code / 100);
    e[3] = code % 100;
    this._send(c, message(m.type | ERROR, m.tid, [attr(A.ERROR_CODE, Buffer.concat([e, Buffer.from(reason)])), ...extra]));
  }

  _ok(c, m, attrs) {
    this._send(c, message(m.type | SUCCESS, m.tid, attrs, this.key));
  }

  // Long-term credentials: the first Allocate gets 401 with the realm and nonce; every request
  // after it is signed with MD5(user:realm:password).
  _authed(c, raw, m) {
    if (m.mi < 0 || !m.attrs.has(A.USERNAME)) {
      this._error(c, m, 401, 'Unauthorized', [attr(A.REALM, Buffer.from(REALM)), attr(A.NONCE, Buffer.from(this.nonce))]);
      return false;
    }
    const signed = Buffer.from(raw.subarray(0, m.mi));
    signed.writeUInt16BE(m.mi + 24 - 20, 2);
    const want = crypto.createHmac('sha1', this.key).update(signed).digest();
    const got = raw.subarray(m.mi + 4, m.mi + 24);
    if (got.length !== 20 || !crypto.timingSafeEqual(want, got)) {
      this._error(c, m, 401, 'Unauthorized', [attr(A.REALM, Buffer.from(REALM)), attr(A.NONCE, Buffer.from(this.nonce))]);
      return false;
    }
    return true;
  }

  _stun(c, raw) {
    if (raw.readUInt32BE(4) !== COOKIE) return;
    const m = parse(raw);
    const mapped = attr(A.XOR_MAPPED_ADDRESS, xorAddr('127.0.0.1', c.sock.remotePort || 0));
    switch (m.type) {
      case M.BINDING:
        return this._send(c, message(M.BINDING | SUCCESS, m.tid, [mapped]));
      case M.ALLOCATE: {
        if (!this._authed(c, raw, m)) return;
        const done = () => this._ok(c, m, [attr(A.XOR_RELAYED_ADDRESS, xorAddr('127.0.0.1', c.relay.address().port)), mapped, attr(A.LIFETIME, u32(LIFETIME))]);
        if (c.relay) return done(); // a retransmission
        const rt = m.attrs.get(A.REQUESTED_TRANSPORT);
        if (!rt || rt[0] !== 17) return this._error(c, m, 442, 'Unsupported Transport Protocol');
        const relay = dgram.createSocket('udp4');
        relay.on('message', (data, from) => this._fromPeer(c, data, from));
        relay.on('error', () => {});
        relay.bind(0, '127.0.0.1', () => {
          c.relay = relay;
          if (c.sock.destroyed) return relay.close();
          done();
        });
        return;
      }
      case M.REFRESH: {
        if (!this._authed(c, raw, m)) return;
        const life = m.attrs.get(A.LIFETIME);
        const secs = life && life.length === 4 ? life.readUInt32BE(0) : LIFETIME;
        this._ok(c, m, [attr(A.LIFETIME, u32(Math.min(secs, LIFETIME)))]);
        if (secs === 0) c.sock.end();
        return;
      }
      case M.CREATE_PERMISSION:
        if (!this._authed(c, raw, m)) return;
        return this._ok(c, m, []); // only loopback peers exist here: every one is allowed
      case M.CHANNEL_BIND: {
        if (!this._authed(c, raw, m)) return;
        const ch = m.attrs.get(A.CHANNEL_NUMBER);
        const peer = unXorAddr(m.attrs.get(A.XOR_PEER_ADDRESS));
        const num = ch && ch.length >= 2 ? ch.readUInt16BE(0) : 0;
        if (!peer || num < 0x4000 || num > 0x4fff) return this._error(c, m, 400, 'Bad Request');
        c.channels.set(num, peer);
        c.peers.set(`${peer.ip}:${peer.port}`, num);
        return this._ok(c, m, []);
      }
      case M.SEND: {
        const peer = unXorAddr(m.attrs.get(A.XOR_PEER_ADDRESS));
        const data = m.attrs.get(A.DATA);
        if (peer && data && c.relay) c.relay.send(data, peer.port, peer.ip);
        return;
      }
      default:
        if (!(m.type & 0x0110)) this._error(c, m, 400, 'Bad Request'); // a request we don't do
    }
  }

  // From a peer to this allocation's client: ChannelData if the peer has a channel, else a Data
  // indication (no integrity: indications never carry it).
  _fromPeer(c, data, from) {
    const num = c.peers.get(`${from.address}:${from.port}`);
    if (num) {
      const h = Buffer.alloc(4);
      h.writeUInt16BE(num, 0);
      h.writeUInt16BE(data.length, 2);
      return this._media(c, Buffer.concat([h, data, Buffer.alloc(pad4(data.length) - data.length)]));
    }
    this._media(c, message(M.DATA, crypto.randomBytes(12), [attr(A.XOR_PEER_ADDRESS, xorAddr(from.address, from.port)), attr(A.DATA, data)]));
  }
}

// The relay in a worker thread: the same start / ice / stop as Turn.
class TurnThread {
  constructor({ port, host = '127.0.0.1' }) {
    this.port = port;
    this.host = host;
    this.password = crypto.randomBytes(12).toString('hex');
    this.worker = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      const w = new Worker(__filename, { workerData: { turn: { port: this.port, host: this.host, password: this.password } } });
      this.worker = w;
      w.once('message', (m) => (m && m.ok ? resolve() : reject(new Error((m && m.error) || 'relay failed'))));
      w.once('error', reject);
      w.on('exit', () => { if (this.worker === w) this.worker = null; });
      w.unref(); // never keeps the app from quitting
    });
  }

  ice() {
    return new Turn({ port: this.port, host: this.host, password: this.password }).ice();
  }

  stop() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
  }
}

if (!isMainThread && workerData && workerData.turn) {
  const t = new Turn(workerData.turn);
  t.start().then(() => parentPort.postMessage({ ok: true }), (e) => parentPort.postMessage({ ok: false, error: e.message }));
}

module.exports = { Turn, TurnThread };
