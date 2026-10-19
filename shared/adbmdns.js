// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The phone's wireless debugging services (_adb-tls-connect, _adb-tls-pairing) asked for over
// mDNS ourselves, next to `adb mdns services`: adb's own mDNS (Openscreen) often sees nothing on
// the same network where the system's Bonjour sees the phone, and then a phone that just paired
// (or came back on at a new port after a screen lock) couldn't be connected to.
//
// The answer's (or announcement's) sender is the phone's address; its SRV record has the port.
//   query({ timeout }) -> [{name, type: 'pairing'|'connect', address, port, ttl}]; watcher.start() early
'use strict';

const dgram = require('dgram');
const os = require('os');

const TYPES = { '_adb-tls-connect._tcp.local': 'connect', '_adb-tls-pairing._tcp.local': 'pairing' };

function encodeName(name) {
  const parts = name.split('.').filter(Boolean).map((l) => Buffer.concat([Buffer.from([Buffer.byteLength(l)]), Buffer.from(l)]));
  return Buffer.concat([...parts, Buffer.from([0])]);
}

function packet() {
  const qs = Object.keys(TYPES).map((n) => Buffer.concat([encodeName(n), Buffer.from([0, 12, 0, 1])])); // PTR, IN
  const head = Buffer.alloc(12);
  head.writeUInt16BE(Object.keys(TYPES).length, 4);
  return Buffer.concat([head, ...qs]);
}

// A (possibly compressed) name at off: [name, next offset].
function readName(buf, off) {
  const labels = [];
  let next = -1;
  for (let guard = 0; guard < 64 && off < buf.length; guard++) {
    const len = buf[off];
    if (len === 0) {
      off++;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (next < 0) next = off + 2;
      off = ((len & 0x3f) << 8) | buf[off + 1];
      continue;
    }
    labels.push(buf.toString('utf8', off + 1, off + 1 + len));
    off += 1 + len;
  }
  return [labels.join('.'), next < 0 ? off : next];
}

// Every record in a response: [{name, type, data, rdata offset}].
function records(buf) {
  const out = [];
  const qd = buf.readUInt16BE(4);
  const total = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let off = 12;
  for (let i = 0; i < qd; i++) off = readName(buf, off)[1] + 4;
  for (let i = 0; i < total && off + 10 <= buf.length; i++) {
    const [name, o] = readName(buf, off);
    const type = buf.readUInt16BE(o);
    const len = buf.readUInt16BE(o + 8);
    out.push({ name, type, ttl: buf.readUInt32BE(o + 4), at: o + 10, len });
    off = o + 10 + len;
  }
  return out;
}

const pick = (list, from) => (!list || list.includes(from) ? from : list[0]);

function parse(buf, from, found) {
  let recs;
  try {
    recs = records(buf);
  } catch {
    return;
  }
  const srv = new Map(); // instance -> {port, host, ttl}
  const ptr = []; // [service type, instance]
  const addr = new Map(); // host -> [IPv4]
  for (const r of recs) {
    if (r.type === 12) ptr.push([r.name, readName(buf, r.at)[0]]);
    else if (r.type === 33) srv.set(r.name, { port: buf.readUInt16BE(r.at + 4), host: readName(buf, r.at + 6)[0], ttl: r.ttl });
    else if (r.type === 1 && r.len === 4) addr.set(r.name, [...(addr.get(r.name) || []), [...buf.subarray(r.at, r.at + 4)].join('.')]);
  }
  for (const [name, s] of srv) {
    const service = (ptr.find((p) => p[1] === name) || [])[0] || name.split('.').slice(1).join('.');
    const type = TYPES[service];
    if (!type || (!s.port && s.ttl)) continue;
    found.set(`${type} ${name}`, { name: name.split('.')[0], type, address: pick(addr.get(s.host), from), port: s.port, ttl: s.ttl });
  }
}

// Listens on the mDNS port next to the system's responder (shared), so the phone's own
// announcements count too: it announces the new port when wireless debugging comes on, and often
// doesn't answer a query while its screen is off. What it said stays for its TTL; a goodbye
// (TTL 0) drops it.
class Watcher {
  constructor() {
    this.seen = new Map(); // key -> {service, until}
    this.socks = [];
    this.started = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    const ifaces = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal);
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s.on('error', () => {});
    s.on('message', (buf, rinfo) => this._message(buf, rinfo.address));
    s.bind(5353, () => {
      for (const i of ifaces) try { s.addMembership('224.0.0.251', i.address); } catch {}
    });
    this.socks.push(s);
    this.ifaces = ifaces;
  }

  _message(buf, from) {
    if (!buf.includes('_adb-tls')) return;
    const found = new Map();
    parse(buf, from, found);
    for (const [k, v] of found) {
      if (v.ttl === 0) this.seen.delete(k);
      else this.seen.set(k, { service: v, until: Date.now() + Math.min(v.ttl || 120, 600) * 1000 });
    }
  }

  // Ask (multicast and legacy unicast, each network), wait a little, and say what's known.
  async query(timeout = 1200) {
    this.start();
    const extra = [];
    for (const i of this.ifaces.length ? this.ifaces : [{}]) {
      const u = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      extra.push(u);
      u.on('error', () => {});
      u.on('message', (buf, rinfo) => this._message(buf, rinfo.address));
      u.bind(0, i.address, () => {
        try {
          if (i.address) u.setMulticastInterface(i.address);
          u.send(packet(), 5353, '224.0.0.251');
        } catch {}
      });
    }
    await new Promise((r) => setTimeout(r, timeout));
    for (const u of extra) try { u.close(); } catch {}
    const now = Date.now();
    for (const [k, v] of this.seen) if (v.until < now) this.seen.delete(k);
    return [...this.seen.values()].map((v) => v.service);
  }
}

const watcher = new Watcher();
const query = (opts = {}) => watcher.query(opts.timeout);

module.exports = { query, watcher };
