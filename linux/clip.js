// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Clipboard text sharing: directions, switch/instant mode, concealed
// filter, size limit, clip.policy both ways, and the in-memory Recent list (never on disk).
const { clipboard } = require('electron');
const P = require('../shared/protocol.js');

// Newer Electron returns a Promise from clipboard.readText() in main; await works for both.
const readText = async () => String((await clipboard.readText()) || '');
const POLL_MS = 500; // instant mode: how often the clipboard is checked for a new copy
const PREVIEW = 300; // characters kept per history item for the UI

// Password managers mark secrets so clipboard tools leave them alone. clipboard.has() doesn't see
// these registered formats; readBuffer() does (empty buffer = format absent).
function isConcealed() {
  try {
    if (clipboard.readBuffer('ExcludeClipboardContentFromMonitorProcessing').length) return true;
    if (clipboard.readBuffer('Clipboard Viewer Ignore').length) return true;
    const b = clipboard.readBuffer('CanIncludeInClipboardHistory');
    if (b && b.length >= 4 && b.readUInt32LE(0) === 0) return true;
  } catch (_) { /* unknown format: not concealed */ }
  return false;
}

class Clip {
  // getSettings() → settings.clipboard; onChange() → the view changed
  constructor(link, getSettings, onChange) {
    this.link = link;
    this.getSettings = getSettings;
    this.onChange = onChange;
    this.lastSync = { sent: null, received: null };
    this.peerAccepts = true; // the Mac's last clip.policy
    this.history = []; // newest first: {dir: 'out'|'in', at, text, size}
    this.lastSkip = '';
    this.poll = null;
    this.seen = null; // last clipboard text the instant poll saw

    link.on(P.T.CLIP, (m) => this._onClip(m));
    link.on(P.T.CLIP_POLICY, (m) => {
      this.peerAccepts = m.accept !== false;
      this.onChange();
    });
    link.on('welcome', () => {
      this.peerAccepts = true;
      this.applySettings(); // sends clip.policy, starts the instant poll if on
    });
    link.on(P.T.CLIP_REQUEST, () => this.sendIfChanged());
    link.on('closed', () => this._stopPoll());
  }

  get cfg() {
    return this.getSettings();
  }

  // Call after settings.clipboard changed.
  applySettings() {
    const c = this.cfg;
    if (c.historySize < this.history.length) this.history.length = c.historySize;
    if (c.enabled && c.send && c.mode === 'instant' && this.link.status.state === 'connected') this._startPoll();
    else this._stopPoll();
    this.sendPolicy();
    this.onChange();
  }

  sendPolicy() {
    const c = this.cfg;
    this.link.send({ t: P.T.CLIP_POLICY, accept: !!(c.enabled && c.receive) });
  }

  _startPoll() {
    if (this.poll) return;
    // New copies only: what is already on the clipboard when instant mode starts stays here.
    readText().then((t) => { this.seen = t; });
    this.poll = setInterval(async () => {
      const t = await readText();
      if (t === this.seen) return;
      this.seen = t;
      this.sendIfChanged('instant');
    }, POLL_MS);
  }

  _stopPoll() {
    clearInterval(this.poll);
    this.poll = null;
  }

  _remember(dir, text) {
    const n = this.cfg.historySize;
    if (!n) return;
    this.history = this.history.filter((h) => h.text !== text || h.dir !== dir);
    this.history.unshift({ dir, at: Date.now(), text, size: Buffer.byteLength(text, 'utf8') });
    if (this.history.length > n) this.history.length = n;
  }

  async _onClip(m) {
    const c = this.cfg;
    if (!c.enabled || !c.receive || !P.clipAllowed(m.text)) return;
    this.lastSync.received = m.text;
    this.seen = m.text; // so instant mode doesn't bounce it back
    if ((await readText()) !== m.text) clipboard.writeText(m.text);
    this._remember('in', m.text);
    this.onChange();
  }

  // Send this PC's clipboard text if allowed and changed since it was last sent or received.
  async sendIfChanged(why) {
    const c = this.cfg;
    if (!c.enabled || !c.send || this.link.status.state !== 'connected') return;
    if (!this.peerAccepts) return this._skip("{name} doesn't accept {me}’s clipboard");
    const text = await readText();
    if (!text || text === this.lastSync.sent || text === this.lastSync.received) return;
    if (c.skipConcealed && isConcealed()) {
      this.lastSync.sent = text; // don't retry this item
      return this._skip('skipped a password (concealed item)');
    }
    const size = Buffer.byteLength(text, 'utf8');
    if (size > c.maxKB * 1024 || !P.clipAllowed(text)) {
      this.lastSync.sent = text;
      return this._skip('skipped ' + Math.round(size / 1024) + ' KB (over ' + c.maxKB + ' KB)');
    }
    if (!this.link.send({ t: P.T.CLIP, text })) return;
    this.lastSync.sent = text;
    this._remember('out', text);
    this.lastSkip = '';
    this.onChange();
  }

  // Monitor 2 lost focus: ask the Mac for its text (it answers only if it changed).
  request() {
    this.link.send({ t: P.T.CLIP_REQUEST });
  }

  _skip(why) {
    if (this.lastSkip === why) return;
    this.lastSkip = why;
    this.onChange();
  }

  // Put a Recent item back on the clipboard (it then goes out by the normal rules).
  copyHistory(index) {
    const h = this.history[index];
    if (!h) return;
    clipboard.writeText(h.text);
    this.seen = h.text;
    if (h.dir === 'out') this.lastSync.sent = null;
  }

  clearHistory() {
    this.history = [];
    this.onChange();
  }

  get view() {
    return {
      peerAccepts: this.peerAccepts,
      lastSkip: this.lastSkip,
      history: this.history.map((h) => ({ dir: h.dir, at: h.at, size: h.size, text: h.text.slice(0, PREVIEW) })),
    };
  }
}

module.exports = Clip;
