// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Notifications both ways: this Mac's notifications go to the peer
// while it accepts them (`notif.policy`); the peer's show here as native notifications from
// TwinDesk. Reading needs Full Disk Access (the helper reads the Notification Center database).
//
// Events: 'change' — this.view changed; 'click' ({app, appName}) — one of the peer's was clicked.
'use strict';

const { Notification } = require('electron');
const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');

const T = P.T;
const str = (v, n = 500) => (typeof v === 'string' ? v.slice(0, n) : '');

class Notifs extends EventEmitter {
  constructor({ server, helper, getSettings, saveSettings }) {
    super();
    Object.assign(this, { server, helper, getSettings, saveSettings });
    this.peerAccepts = false;
    this.access = 'unknown'; // 'ok' | 'noAccess' (Full Disk Access) | 'unknown'
    this.apps = new Map(); // app -> {app, appName, at} seen here (newest first in the view)
    this.sent = 0;
    this.shown = 0;
    this.live = []; // keep shown Notification objects alive until closed

    server.on('client', () => {
      this.peerAccepts = false;
      this.sendPolicy();
      this._watch();
    });
    server.on('closed', () => {
      if (server.current) return;
      this.peerAccepts = false;
      this._watch();
    });
    server.on(`t:${T.NOTIF_POLICY}`, (m) => {
      this.peerAccepts = !!m.accept;
      this._watch();
      this.emit('change');
    });
    server.on(`t:${T.NOTIF}`, (m) => this._show(m));
    helper.on('ready', () => this._watch());
    helper.on('event', (name, ev) => {
      if (name === 'notif') this._local(ev);
      else if (name === 'notifState') this._setAccess(ev.state === 'ok' ? 'ok' : 'noAccess');
    });
  }

  get cfg() {
    return this.getSettings().notifs;
  }

  sendPolicy() {
    this.server.sendToClient({ t: T.NOTIF_POLICY, accept: !!this.cfg.receive });
  }

  applySettings() {
    this.sendPolicy();
    this._watch();
    this.emit('change');
  }

  setMuted(app, muted) {
    const list = new Set(this.cfg.muted || []);
    if (muted) list.add(String(app));
    else list.delete(String(app));
    this.cfg.muted = [...list].slice(0, 500);
    this.saveSettings();
    this.emit('change');
  }

  // Read the database only while something would be sent; else just check access for the tab.
  _watch() {
    if (!this.helper.running) return;
    const on = !!(this.cfg.send && this.peerAccepts && this.server.current);
    this.helper.request('notifWatch', { on }).then((r) => this._setAccess(r.readable ? 'ok' : 'noAccess'), () => {});
  }

  _setAccess(a) {
    if (this.access === a) return;
    this.access = a;
    this.emit('change');
  }

  _local(ev) {
    const app = str(ev.app, 200);
    this.apps.set(app, { app, appName: str(ev.appName, 100) || app, at: Date.now() });
    if (!this.cfg.send || !this.peerAccepts || !this.server.current || (this.cfg.muted || []).includes(app)) return this.emit('change');
    this.server.sendToClient({
      t: T.NOTIF, id: str(ev.id, 64), app, appName: str(ev.appName, 100), title: str(ev.title), subtitle: str(ev.subtitle),
      body: this.cfg.hideText ? '' : str(ev.body), at: Number(ev.at) || Date.now(),
    });
    this.sent++;
    this.emit('change');
  }

  _show(m) {
    if (!this.cfg.receive || !Notification.isSupported()) return;
    const peer = this.server.current ? this.server.current.name : '';
    const appName = str(m.appName, 100);
    const n = new Notification({
      title: str(m.title, 200) || appName || peer,
      subtitle: [appName, peer].filter(Boolean).join(' · '),
      body: [str(m.subtitle, 200), str(m.body)].filter(Boolean).join('\n'),
    });
    this.live.push(n);
    const drop = () => { this.live = this.live.filter((x) => x !== n); };
    n.on('close', drop);
    n.on('click', () => this.emit('click', { app: str(m.app, 200), appName }));
    setTimeout(drop, 60000);
    n.show();
    this.shown++;
    this.emit('change');
  }

  get view() {
    return {
      access: this.access,
      peerAccepts: this.peerAccepts,
      sent: this.sent,
      shown: this.shown,
      apps: [...this.apps.values()].sort((a, b) => b.at - a.at).slice(0, 40),
    };
  }
}

module.exports = { Notifs };
