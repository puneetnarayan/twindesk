// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Mac apps on the PC: app list, launch, and the windows of launched
// apps as rectangles normalized over the stream picture, so the PC crops each into its own window.
//
// Events: 'change' — this.view changed.
'use strict';

const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');

const POLL_MS = 100; // ≤ 10 app.windows per second, only when something changed
const IDLE_OFF_MS = 8000; // no app windows this long: the screen share we turned on goes off again

class Apps extends EventEmitter {
  constructor({ server, helper, displays, stream, getSettings }) {
    super();
    Object.assign(this, { server, helper, displays, stream, getSettings });
    this.launched = new Map(); // bundle id -> { pid, name }
    this.lastKey = '';
    this.windows = [];
    this.timer = null;
    // Opening an app turns screen sharing on if it was off; it goes off again when the apps are
    // done. setSharing(on) is wired by main (ipc actions).
    this.setSharing = null;
    this.autoShare = false;
    this.emptySince = 0;

    const on = (t, fn) => server.on(`t:${t}`, fn);
    on(P.T.APPS_LIST, () => this._list());
    on(P.T.APP_LAUNCH, (m) => this._launch(String(m.id || '')));
    on(P.T.APP_FOCUS, (m) => this.helper.request('appFocus', { wid: Number(m.wid) }).catch(() => {}));
    on(P.T.APP_CLOSE, (m) => this.helper.request('appClose', { wid: Number(m.wid) }).catch(() => {}));
    server.on('closed', () => {
      if (!server.current) {
        this._stopPolling();
        if (this.autoShare && this.setSharing) this.setSharing(false, 'apps');
        this.autoShare = false;
      }
    });
  }

  get enabled() {
    return this.getSettings().apps.offer !== false;
  }

  async _list() {
    if (!this.enabled) return this.server.sendToClient({ t: P.T.APPS_RESULT, apps: [], why: 'off' });
    try {
      const r = await this.helper.request('appsList', {}, 20000);
      this.server.sendToClient({ t: P.T.APPS_RESULT, apps: r.apps });
    } catch (e) {
      this.server.sendToClient({ t: P.T.APPS_RESULT, apps: [], why: e.message });
    }
  }

  async _launch(id) {
    const reply = (ok, why) => this.server.sendToClient({ t: P.T.APP_LAUNCHED, id, ok, ...(why ? { why } : {}) });
    if (!this.enabled) return reply(false, 'off');
    if (!/^[A-Za-z0-9.-]{1,200}$/.test(id) || /^com\.apple\.(Siri|siri)/.test(id)) return reply(false, 'not offered');
    if (!this.getSettings().sharing.on && this.setSharing) {
      this.autoShare = true;
      this.setSharing(true, 'apps');
    }
    this.emptySince = 0;
    try {
      const { pid } = await this.helper.request('appLaunch', { appId: id }, 20000);
      this.launched.set(id, { pid });
      reply(true);
      this.lastKey = '';
      this._startPolling();
      // New windows appear a moment after launch: move them onto the shared display a few times.
      for (const ms of [300, 1000, 2500]) setTimeout(() => this._moveOnto(pid), ms);
      this.emit('change');
    } catch (e) {
      reply(false, e.message);
    }
  }

  _moveOnto(pid) {
    const t = this.displays.target();
    if (t) this.helper.request('appMove', { pid, bounds: t.bounds }).catch(() => {});
  }

  _startPolling() {
    if (!this.timer) this.timer = setInterval(() => this._poll(), POLL_MS);
  }

  _stopPolling() {
    clearInterval(this.timer);
    this.timer = null;
  }

  // The apps are done (all quit, or no windows for a while): undo the screen share we turned on.
  _idle(empty) {
    if (!empty) {
      this.emptySince = 0;
      return;
    }
    if (!this.emptySince) this.emptySince = Date.now();
    if (this.autoShare && Date.now() - this.emptySince > IDLE_OFF_MS) {
      this.autoShare = false;
      if (this.setSharing) this.setSharing(false, 'apps');
      console.log('[apps] no app windows left: screen sharing off again');
    }
    if (!this.launched.size && !this.autoShare) this._stopPolling();
  }

  async _poll() {
    if (!this.launched.size || !this.server.current) return this._idle(true);
    const t = this.displays.target();
    if (!t) return;
    let r;
    try {
      r = await this.helper.request('appWindows', { pids: [...this.launched.values()].map((a) => a.pid) });
    } catch {
      return;
    }
    const idOf = new Map([...this.launched].map(([id, a]) => [a.pid, id]));
    const b = t.bounds;
    const wins = r.windows
      .filter((w) => w.x < b.x + b.width && w.x + w.w > b.x && w.y < b.y + b.height && w.y + w.h > b.y) // on the shared display
      .map((w) => ({
        wid: w.wid, id: idOf.get(w.pid), title: w.title,
        x: (w.x - b.x) / b.width, y: (w.y - b.y) / b.height, w: w.w / b.width, h: w.h / b.height,
      }));
    // Apps that quit are forgotten.
    const alive = new Set(r.windows.map((w) => w.pid));
    for (const [id, a] of this.launched) if (!alive.has(a.pid) && !(await this._running(a.pid))) this.launched.delete(id);
    // Compare at ~1/1000 of the picture so 1 px jitter while resizing doesn't resend.
    this._idle(!wins.length);
    const key = JSON.stringify(wins.map((w) => [w.wid, w.title, w.x.toFixed(3), w.y.toFixed(3), w.w.toFixed(3), w.h.toFixed(3)]));
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.windows = wins;
    // pw/ph: pixel size of the stream picture, so the PC opens each app window at 1:1 (no scaling).
    const pw = this.stream.view.width || t.pixelWidth;
    const ph = this.stream.view.height || t.pixelHeight;
    this.server.sendToClient({ t: P.T.APP_WINDOWS, windows: wins, pw, ph });
    this.emit('change');
  }

  _running(pid) {
    try {
      process.kill(pid, 0);
      return Promise.resolve(true);
    } catch {
      return Promise.resolve(false);
    }
  }

  applySettings() {
    if (!this.enabled) {
      this.launched.clear();
      this._stopPolling();
      this.server.sendToClient({ t: P.T.APP_WINDOWS, windows: [] });
    }
    this.emit('change');
  }

  get view() {
    return { launched: [...this.launched.keys()], windows: this.windows.length };
  }
}

module.exports = { Apps };
