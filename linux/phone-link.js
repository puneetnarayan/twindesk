// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The phone's end of the session, shaped like the Mac's peer.js as mac/phone.js, phone-bridge.js
// and phoneview.js use it, so their ports here stay the same line for line: 'client' / 'closed'
// (ctx) from our server, 't:<type>' (msg, ctx) for what the peer sends, sendToClient(), inject()
// and keySwap(). A phone is always a guest of this computer (our server's current client). Copy of windows/phone-link.js.
'use strict';

const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');

class PhoneLink extends EventEmitter {
  // link: peer.js; server: server.js (our host role)
  constructor(link, server) {
    super();
    this.link = link;
    this.raw = server;
    this.wired = new Set();
    server.on('client', (ctx) => this.emit('client', ctx));
    server.on('closed', (ctx) => this.emit('closed', ctx));
    // 't:<type>' listeners: the peer layer delivers the type (only while we host), with our client.
    this.on('newListener', (ev) => {
      if (typeof ev !== 'string' || !ev.startsWith('t:') || this.wired.has(ev)) return;
      this.wired.add(ev);
      link.on(ev.slice(2), (m) => this.emit(ev, m, server.current));
    });
  }

  get current() {
    return this.raw.current;
  }

  // Only to a client of ours: as a guest of another computer we have no phone.
  sendToClient(msg) {
    if (this.link.hosting) this.link.send(msg);
  }

  // A message as if the peer had sent it (the phone bridge answers for the phone's input).
  inject(msg) {
    this.link.inject(msg);
  }

  keySwap(settings) {
    const c = this.current;
    return settings.keys.swapCtrlCmd !== false && P.keySwapNeeded(P.OS.LINUX, c && c.os);
  }
}

module.exports = { PhoneLink };
