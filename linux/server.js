// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Host role (Linux ↔ Linux, Linux ↔ PC): HTTPS + WebSocket server on PORT: sessions,
// liveness, routing of authenticated messages. Copy of windows/server.js; the certificate comes
// from identity.js (PEM made by openssl).
//
// Events:
//   'preauth' (ctx, msg)  — hello / pair.* before auth (pairing.js handles them)
//   'client'  (ctx)       — a client got `welcome`
//   'message' (msg, ctx)  — any message from the authenticated client except ping/pong (peer.js routes)
//   'closed'  (ctx)       — a socket closed (authed or not)
//   'rtt'     (ctx)       — ctx.rttMs updated
//   'listening' / 'listenError' (err)
//   'phoneFree'           — a phone's hold on the session ended (computers may connect again)
'use strict';

const https = require('https');
const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');
const P = require('../shared/protocol.js');

const ICE_OFFERS = new Set([P.T.RTC_OFFER, P.T.AUDIO_OFFER]);

// Dev only: listen elsewhere (a second copy on the same computer).
const LISTEN_PORT = Number(process.env.MACSHARE_DEV_PORT) || P.PORT;

class Server extends EventEmitter {
  constructor({ key, cert }) {
    super();
    this.current = null; // ctx of the authenticated client
    this.phoneGrace = null; // {id, until}: a phone's session just dropped, it may come back (P.PHONE_GRACE_MS)
    this.sockets = new Set();
    this.https = https.createServer({ key, cert });
    this.wss = new WebSocketServer({ server: this.https, maxPayload: P.MAX_PAYLOAD });
    this.wss.on('connection', (ws, req) => this._onConnection(ws, req));
    this.wss.on('error', () => {}); // ws repeats the server's errors here; listenError below reports them
    this.https.on('error', (err) => this.emit('listenError', err)); // e.g. EADDRINUSE: another copy listens
    this.port = LISTEN_PORT;
    this.https.listen(LISTEN_PORT, '0.0.0.0', () => this.emit('listening'));
    this.tick = setInterval(() => this._liveness(), P.PING_MS);
  }

  _onConnection(ws, req) {
    const now = Date.now();
    const ctx = {
      ws,
      authed: false,
      deviceId: null,
      name: null,
      address: (req.socket.remoteAddress || '').replace(/^::ffff:/, ''),
      connectedAt: now,
      lastRx: now,
      rttMs: null,
    };
    this.sockets.add(ctx);
    ws.on('message', (data, isBinary) => this._onMessage(ctx, data, isBinary));
    ws.on('close', () => {
      this.sockets.delete(ctx);
      if (this.current === ctx) {
        this.current = null;
        if (ctx.os === P.OS.ANDROID && !ctx.released) this._phoneGrace(ctx.deviceId);
      }
      this.emit('closed', ctx);
    });
    ws.on('error', (err) => console.error(`[server] socket ${ctx.address}: ${err.message}`));
  }

  _onMessage(ctx, data, isBinary) {
    ctx.lastRx = Date.now();
    let msg;
    try {
      if (isBinary) throw new Error('binary');
      msg = JSON.parse(data.toString('utf8'));
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') throw new Error('no t');
    } catch (e) {
      return this.fail(ctx, P.E.BAD_MESSAGE, 'Expected a JSON object with a "t" field');
    }

    if (!ctx.authed) {
      if (msg.t === P.T.HELLO || msg.t.startsWith('pair.')) return this.emit('preauth', ctx, msg);
      return this.fail(ctx, P.E.BAD_MESSAGE, `"${msg.t}" is not allowed before welcome`);
    }

    if (msg.t === P.T.PING) return this.send(ctx, { t: P.T.PONG, ts: msg.ts });
    if (msg.t === P.T.PONG) {
      if (typeof msg.ts === 'number') {
        ctx.rttMs = Math.max(0, Date.now() - msg.ts);
        this.emit('rtt', ctx);
      }
      return;
    }
    this.emit('message', msg, ctx); // peer.js routes it by type
  }

  _liveness() {
    const now = Date.now();
    for (const ctx of this.sockets) {
      if (ctx.authed) {
        if (now - ctx.lastRx > P.TIMEOUT_MS) {
          console.log(`[server] ${ctx.name || ctx.address} silent for ${P.TIMEOUT_MS} ms, closing`);
          ctx.ws.terminate();
        } else {
          this.send(ctx, { t: P.T.PING, ts: now });
        }
      } else if (now - ctx.connectedAt > P.UNAUTH_TIMEOUT_MS) {
        ctx.ws.terminate();
      }
    }
  }

  send(ctx, msg) {
    if (!ctx || ctx.ws.readyState !== ctx.ws.OPEN) return;
    // A phone on the USB cable: its WebRTC goes through the relay too (wired.js).
    if (ctx.ice && ICE_OFFERS.has(msg.t)) msg = { ...msg, ice: ctx.ice };
    ctx.ws.send(JSON.stringify(msg));
  }

  // Send to the authenticated client, if any.
  sendToClient(msg) {
    this.send(this.current, msg);
  }

  // Send an error and close the socket.
  fail(ctx, code, message) {
    this.send(ctx, { t: P.T.ERROR, code, message });
    ctx.ws.close();
  }

  // Mark ctx authenticated; a newer client replaces the older one.
  authenticate(ctx, { deviceId, name, os }, welcome) {
    if (this.current && this.current !== ctx) {
      const old = this.current;
      this.current = null;
      this.fail(old, P.E.REPLACED, 'Another connection from a paired device replaced this one');
    }
    ctx.authed = true;
    ctx.deviceId = deviceId;
    ctx.name = name;
    ctx.os = os;
    ctx.ice = this.iceFor ? this.iceFor(ctx) : null; // a phone through adb reverse: the relay's RTCConfiguration
    this.current = ctx;
    this.send(ctx, welcome);
    this.emit('client', ctx);
  }

  // A phone holds the session (or just dropped it and may resume): computers are refused.
  phoneHolds() {
    if (this.current && this.current.os === P.OS.ANDROID) return true;
    return !!this.phoneGrace && Date.now() < this.phoneGrace.until;
  }

  _phoneGrace(id) {
    clearTimeout(this.graceTimer);
    this.phoneGrace = { id, until: Date.now() + P.PHONE_GRACE_MS };
    this.graceTimer = setTimeout(() => this.endPhoneGrace(), P.PHONE_GRACE_MS);
  }

  // The computers may connect again (the phone's grace ran out, or it was let go).
  endPhoneGrace() {
    clearTimeout(this.graceTimer);
    if (!this.phoneGrace) return;
    this.phoneGrace = null;
    this.emit('phoneFree');
  }

  // Disconnect the phone on purpose: it won't resume, and the computers may connect at once.
  releasePhone() {
    const c = this.current;
    if (c && c.os === P.OS.ANDROID) {
      c.released = true;
      this.fail(c, P.E.RELEASED, 'This computer disconnected the phone');
      setTimeout(() => c.ws.terminate(), 1000); // an older phone app never answers the close
    }
    this.endPhoneGrace();
  }

  // Close every socket that belongs to a device id (used by Forget).
  closeDevice(deviceId, code, message) {
    for (const ctx of this.sockets) if (ctx.deviceId === deviceId) this.fail(ctx, code, message);
  }

  close() {
    clearInterval(this.tick);
    clearTimeout(this.graceTimer);
    for (const ctx of this.sockets) ctx.ws.terminate();
    this.wss.close();
    this.https.close();
  }
}

module.exports = { Server };
