// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Guest role: this Mac connects to another Mac that hosts.
// WSS client with certificate pinning, pairing as the initiator, hello, liveness, reconnect.
// Same protocol as windows/link.js; stored hosts live in hosts.json.
//
// Events: 'change' — status/pairing changed; 'welcome' (msg); 'closed'; 'message' (msg); 'rtt'.
'use strict';

const WebSocket = require('ws');
const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');
const store = require('./store');

const T = P.T;
const PAIR_ERRORS = {
  [P.E.PAIR_REFUSED]: 'Pairing was refused.',
  [P.E.PAIR_TIMEOUT]: 'Pairing timed out.',
  [P.E.BUSY]: 'That computer is busy with another device.',
  [P.E.VERSION_MISMATCH]: 'That computer runs a different TwinDesk version. Update both.',
};

class Link extends EventEmitter {
  // id: {macId, macName}; canConnect() -> false while this Mac hosts a session
  constructor(id, { canConnect = () => true, resolve = () => null } = {}) {
    super();
    this.id = id;
    this.canConnect = canConnect;
    this.resolve = resolve; // hostId -> {address, port} seen by discovery
    this.hosts = store.read('hosts.json', []); // [{id, name, os, address, port, fp, token, lastSeen}]
    this.pairState = null; // {phase, address, port, name, code, error}
    this.status = { state: 'idle', message: '' };
    this.ws = null;
    this.mode = null; // 'session' | 'pair'
    this.authed = false;
    this.host = null; // the stored host we are connected/connecting to
    this.ctx = null; // peer context while authed
    this.attempt = 0;
    this.timers = {};
  }

  start() {
    this._scheduleReconnect(500);
  }

  stop() {
    clearTimeout(this.timers.reconnect);
    this._closeSocket();
  }

  view() {
    return {
      status: { ...this.status },
      pairing: this.pairState ? { ...this.pairState } : null,
      hosts: this.hosts.map(({ id, name, os, address, lastSeen }) => ({ id, name, os, address, lastSeen })),
    };
  }

  send(obj) {
    if (!this.authed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(obj));
  }

  startPairing({ address, port, name }) {
    clearTimeout(this.timers.reconnect);
    this.pairState = { phase: 'connecting', address, port: port || P.PORT, name: name || address, code: '', error: '' };
    this._connect('pair');
    this._changed();
  }

  confirmCode() {
    const ps = this.pairState;
    if (!ps || ps.phase !== 'code' || this.mode !== 'pair') return;
    this._raw({ t: T.PAIR_CONFIRM });
    ps.phase = 'waiting';
    this._changed();
  }

  cancelPair() {
    if (!this.pairState) return;
    if (this.mode === 'pair' && this.pairState.phase !== 'failed') this._raw({ t: T.PAIR_CANCEL });
    this.pairState = null;
    if (this.mode === 'pair') this._closeSocket();
    this._changed();
    this._scheduleReconnect();
  }

  forget(hostId) {
    if (this.host && this.host.id === hostId) this._closeSocket();
    this.hosts = this.hosts.filter((h) => h.id !== hostId);
    this._save();
    this._changed();
  }

  // Another session ended or started on this Mac: try again / stand back.
  poke() {
    if (!this.ws && !this.pairState) this._scheduleReconnect(300);
  }

  // ---- connection ----

  _save() {
    store.write('hosts.json', this.hosts);
  }

  _connect(mode, host) {
    this._closeSocket();
    clearTimeout(this.timers.reconnect);
    this.mode = mode;
    this.host = host || null;
    this.nw = this.nm = null;
    const target = mode === 'pair' ? this.pairState : host;
    const ws = new WebSocket(`wss://${target.address}:${target.port}`, {
      rejectUnauthorized: false, // self-signed; the fingerprint is pinned instead
      maxPayload: P.MAX_PAYLOAD,
      handshakeTimeout: 5000,
    });
    this.ws = ws;
    let seenFp = '';
    ws.on('upgrade', (res) => { seenFp = P.normFingerprint(res.socket.getPeerCertificate().fingerprint256); });
    ws.on('open', () => ws === this.ws && this._onOpen(seenFp, target.address));
    ws.on('message', (data, isBinary) => ws === this.ws && !isBinary && this._onMessage(String(data)));
    ws.on('error', (err) => { if (ws === this.ws) this.lastError = err.code || err.message; });
    ws.on('close', () => ws === this.ws && this._onClose());
  }

  _onOpen(seenFp, address) {
    this.seenFp = seenFp;
    this.address = address;
    this.lastRx = Date.now();
    this.lastError = '';
    if (this.mode === 'pair') {
      this.nw = P.randomHex(16);
      this._raw({ t: T.PAIR_START, v: P.PROTOCOL_VERSION, id: this.id.macId, name: this.id.macName, os: P.OS.MAC, commit: P.commitOf(this.nw) });
      this.pairState.phase = 'starting';
      return this._changed();
    }
    if (!seenFp || seenFp !== this.host.fp) {
      this._closeSocket();
      return this._setStatus('identity_changed', `${this.host.name} looks different now. Forget it and pair again.`);
    }
    this._hello();
  }

  _hello() {
    this._raw({ t: T.HELLO, v: P.PROTOCOL_VERSION, id: this.id.macId, name: this.id.macName, os: P.OS.MAC, token: this.host.token });
    this.timers.hello = setTimeout(() => {
      this.lastError = 'No answer';
      if (this.ws) this.ws.terminate();
    }, P.TIMEOUT_MS);
  }

  _onMessage(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;
    this.lastRx = Date.now();
    if (this.ctx) this.ctx.lastRx = this.lastRx;
    switch (msg.t) {
      case T.PAIR_NONCE: return this._onNonce(msg);
      case T.PAIR_OK: return this._onPairOk(msg);
      case T.PAIR_CANCEL: return this._pairFailed('Pairing was cancelled on the other computer.');
      case T.WELCOME: return this._onWelcome(msg);
      case T.ERROR: return this._onError(msg);
      case T.PING: return this.authed && this._raw({ t: T.PONG, ts: msg.ts });
      case T.PONG:
        if (typeof msg.ts === 'number' && this.ctx) {
          this.ctx.rttMs = Math.max(0, Date.now() - msg.ts);
          this.emit('rtt', this.ctx);
        }
        return;
    }
    if (this.authed) this.emit('message', msg);
  }

  _onNonce(msg) {
    const ps = this.pairState;
    if (this.mode !== 'pair' || !ps || !this.nw || this.nm) return;
    if (typeof msg.nonce !== 'string' || !/^[0-9a-f]{32,128}$/.test(msg.nonce) || msg.nonce.length % 2) {
      return this._pairFailed('The other computer sent a bad pairing message.');
    }
    if (msg.os && msg.os !== P.OS.MAC) return this._pairFailed('That computer isn’t a Mac. Pair from TwinDesk on it instead.');
    this.nm = msg.nonce;
    this._raw({ t: T.PAIR_REVEAL, nonce: this.nw });
    ps.code = P.sasCode(this.seenFp, this.nw, this.nm);
    ps.phase = 'code';
    this._changed();
    this.emit('request');
  }

  _onPairOk(msg) {
    const ps = this.pairState;
    if (this.mode !== 'pair' || !ps || ps.phase !== 'waiting') return;
    if (typeof msg.token !== 'string' || !msg.token || typeof msg.macId !== 'string') {
      return this._pairFailed('The other computer sent a bad pairing message.');
    }
    const host = {
      id: msg.macId,
      name: typeof msg.macName === 'string' && msg.macName ? msg.macName.slice(0, 64) : ps.name,
      os: msg.os || P.OS.MAC,
      address: ps.address,
      port: ps.port,
      fp: this.seenFp,
      token: msg.token,
      lastSeen: Date.now(),
    };
    this.hosts = [host, ...this.hosts.filter((h) => h.id !== host.id)];
    this._save();
    this.pairState = null;
    this.mode = 'session';
    this.host = host;
    this._setStatus('connecting', '');
    this._hello();
  }

  _onWelcome(msg) {
    if (this.mode !== 'session' || this.authed) return;
    clearTimeout(this.timers.hello);
    this.authed = true;
    this.attempt = 0;
    const h = this.host;
    if (typeof msg.macName === 'string' && msg.macName) h.name = msg.macName.slice(0, 64);
    h.lastSeen = Date.now();
    this._save();
    this.ctx = {
      ws: this.ws, authed: true, deviceId: h.id, name: h.name, os: msg.os || P.OS.MAC, role: 'host',
      address: this.address, lastRx: Date.now(), rttMs: null,
    };
    this.timers.ping = setInterval(() => {
      if (Date.now() - this.lastRx > P.TIMEOUT_MS) {
        this.lastError = 'Stopped answering';
        if (this.ws) this.ws.terminate();
        return;
      }
      this._raw({ t: T.PING, ts: Date.now() });
    }, P.PING_MS);
    this._setStatus('connected', '');
    this.emit('welcome', this.ctx);
  }

  _onError(msg) {
    const code = msg.code;
    if (this.mode === 'pair') return this._pairFailed(PAIR_ERRORS[code] || `Pairing failed (${code}).`);
    if (code === P.E.BAD_TOKEN && this.host) {
      const name = this.host.name;
      this.forget(this.host.id);
      return this._setStatus('idle', `${name} forgot this Mac. Pair again.`);
    }
    this.lastError = code === P.E.BUSY ? 'Busy with another device' : `Closed (${code})`;
  }

  _pairFailed(error) {
    const ps = this.pairState;
    if (!ps) return;
    Object.assign(ps, { phase: 'failed', error, code: '' });
    this._closeSocket();
    this._changed();
    this._scheduleReconnect();
  }

  _onClose() {
    this._clearSocketTimers();
    this.ws = null;
    this._dropSession();
    if (this.mode === 'pair') {
      const ps = this.pairState;
      if (ps && ps.phase !== 'failed') {
        this._pairFailed(ps.phase === 'connecting'
          ? `Couldn’t connect to ${ps.address}${this.lastError ? ` (${this.lastError})` : ''}.`
          : 'The connection closed.');
      }
      return;
    }
    if (this.status.state !== 'identity_changed') this._scheduleReconnect();
  }

  _dropSession() {
    if (!this.authed) return;
    this.authed = false;
    const ctx = this.ctx;
    this.ctx = null;
    this.emit('closed', ctx);
  }

  // Reconnect to the most recently used stored host that discovery sees (else the last address).
  _scheduleReconnect(delay) {
    clearTimeout(this.timers.reconnect);
    if (!this.hosts.length || this.pairState) {
      if (!this.hosts.length && this.status.state !== 'idle') this._setStatus('idle', this.status.message);
      return;
    }
    const delays = P.RECONNECT_MS;
    const d = delay !== undefined ? delay : delays[Math.min(this.attempt, delays.length - 1)];
    this.attempt++;
    if (this.status.state === 'connected') this._setStatus('reconnecting', this.lastError || '');
    this.timers.reconnect = setTimeout(() => {
      if (this.pairState || this.ws) return;
      if (!this.canConnect()) return this._setStatus('standby', '');
      const seen = this.hosts.find((h) => this.resolve(h.id)) || this.hosts[0];
      const at = this.resolve(seen.id);
      if (at && (at.address !== seen.address || at.port !== seen.port)) {
        Object.assign(seen, { address: at.address, port: at.port });
        this._save();
      }
      this._setStatus('connecting', this.lastError || '');
      this._connect('session', seen);
    }, d);
  }

  _closeSocket() {
    const ws = this.ws;
    this._clearSocketTimers();
    this.ws = null;
    this._dropSession();
    if (!ws) return;
    if (ws.readyState === WebSocket.OPEN) ws.close();
    else ws.terminate();
  }

  _clearSocketTimers() {
    clearInterval(this.timers.ping);
    clearTimeout(this.timers.hello);
  }

  _raw(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  _setStatus(state, message) {
    this.status = { state, message: message || '' };
    this._changed();
  }

  _changed() {
    this.emit('change');
  }
}

module.exports = { Link };
