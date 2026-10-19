// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Clipboard text sharing: directions, switch/instant mode, concealed
// filter, size limit, clip.policy both ways, and the in-memory Recent list.
//
// Events: 'change' — this.view changed.
'use strict';

const { clipboard } = require('electron');
const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');

// Electron 44's clipboard.readText() returns a Promise in the main process (older: a string).
const readText = async () => String((await clipboard.readText()) || '');
const PREVIEW = 300; // characters kept per history item for the UI

class Clipboard extends EventEmitter {
  constructor(server, helper, getSettings) {
    super();
    this.server = server;
    this.helper = helper;
    this.getSettings = getSettings;
    this.lastSent = null;
    this.lastReceived = null;
    this.concealed = false; // last helper report for the current item
    this.peerAccepts = true; // the PC's last clip.policy
    this.history = []; // newest first: {dir: 'out'|'in', at, text, size}
    this.lastSkip = '';

    server.on('client', () => {
      this.peerAccepts = true;
      this.sendPolicy();
    });
    server.on(`t:${P.T.CLIP}`, (msg) => this._onClip(msg));
    server.on(`t:${P.T.CLIP_POLICY}`, (msg) => {
      this.peerAccepts = msg.accept !== false;
      this.emit('change');
    });
    server.on(`t:${P.T.CLIP_REQUEST}`, () => this.sendIfChanged('request'));
    helper.on('event', (name, ev) => {
      if (name !== 'clipboard') return;
      this.concealed = !!ev.concealed;
      // Instant mode sends new copies only, not what was already on the clipboard when it began.
      if (this.cfg.mode === 'instant' && !ev.initial) this.sendIfChanged('instant');
    });
    helper.on('ready', () => setTimeout(() => this.applySettings(), 100));
  }

  get cfg() {
    return this.getSettings().clipboard;
  }

  // Call after settings.clipboard changed (and once at start).
  applySettings() {
    const c = this.cfg;
    this.helper.send('clipboardWatch', { on: !!(c.enabled && c.send) });
    if (c.historySize < this.history.length) this.history.length = c.historySize;
    this.sendPolicy();
    this.emit('change');
  }

  sendPolicy() {
    const c = this.cfg;
    this.server.sendToClient({ t: P.T.CLIP_POLICY, accept: !!(c.enabled && c.receive) });
  }

  _remember(dir, text) {
    const n = this.cfg.historySize;
    if (!n) return;
    this.history = this.history.filter((h) => h.text !== text || h.dir !== dir);
    this.history.unshift({ dir, at: Date.now(), text, size: Buffer.byteLength(text, 'utf8') });
    if (this.history.length > n) this.history.length = n;
  }

  async _onClip(msg) {
    const c = this.cfg;
    if (!c.enabled || !c.receive || !P.clipAllowed(msg.text)) return;
    this.lastReceived = msg.text;
    if ((await readText()) !== msg.text) clipboard.writeText(msg.text);
    this._remember('in', msg.text);
    this.emit('change');
  }

  // Send our clipboard text if allowed and changed since it was last sent or received.
  async sendIfChanged(why) {
    const c = this.cfg;
    if (!c.enabled || !c.send || !this.server.current) return;
    if (!this.peerAccepts) return this._skip(`${this.server.current ? this.server.current.name : 'the other computer'} doesn’t take the clipboard`);
    const text = await readText();
    if (!text || text === this.lastSent || text === this.lastReceived) return;
    if (c.skipConcealed) {
      // The watcher's flag may be stale for a request; ask the helper about the current item.
      const info = why === 'instant' ? { concealed: this.concealed } : await this.helper.request('clipboardInfo').catch(() => ({}));
      if (info.concealed) {
        this.lastSent = text; // don't retry this item
        return this._skip('skipped a password (concealed item)');
      }
    }
    if (Buffer.byteLength(text, 'utf8') > c.maxKB * 1024 || !P.clipAllowed(text)) {
      this.lastSent = text;
      return this._skip(`skipped ${Math.round(Buffer.byteLength(text, 'utf8') / 1024)} KB (over ${c.maxKB} KB)`);
    }
    this.lastSent = text;
    this.server.sendToClient({ t: P.T.CLIP, text });
    this._remember('out', text);
    this.lastSkip = '';
    this.emit('change');
  }

  _skip(why) {
    if (this.lastSkip !== why) {
      this.lastSkip = why;
      this.emit('change');
    }
  }

  // Put a Recent item back on the clipboard (it then goes out by the normal rules).
  copyHistory(index) {
    const h = this.history[index];
    if (!h) return;
    clipboard.writeText(h.text);
    this.lastSent = h.dir === 'out' ? null : this.lastSent;
  }

  clearHistory() {
    this.history = [];
    this.emit('change');
  }

  get view() {
    return {
      peerAccepts: this.peerAccepts,
      lastSkip: this.lastSkip,
      history: this.history.map((h) => ({ dir: h.dir, at: h.at, size: h.size, text: h.text.slice(0, PREVIEW) })),
    };
  }
}

module.exports = { Clipboard };
