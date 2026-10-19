// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Copy and paste files between the computers with two global shortcuts (default
// ⌃⌥C / ⌃⌥V, Files tab). Copy announces the files selected in Finder (else the files on the
// clipboard) with `fclip.offer`; paste on the other computer asks for them with `fclip.paste` and
// they arrive as a batch (filesend.js / drop.js, drop:'paste') in the folder that was in front.
//
// Events: 'change' — this.view changed; 'popup' (kind, text) — for hud.js.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { globalShortcut } = require('electron');
const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');

const T = P.T;
const DESKTOP = path.join(os.homedir(), 'Desktop');

function osascript(script) {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 3000 }, (err, out) => resolve(err ? '' : String(out).trim()));
  });
}

const finderSelection = () => osascript(
  'tell application "Finder"\nset out to ""\nrepeat with i in (get selection)\nset out to out & POSIX path of (i as alias) & linefeed\nend repeat\nreturn out\nend tell',
).then((o) => o.split('\n').map((l) => l.replace(/\/$/, '')).filter(Boolean));

const finderFolder = () => osascript(
  'tell application "Finder" to if (count of Finder windows) > 0 then return POSIX path of (target of front Finder window as alias)',
);

class FileClip extends EventEmitter {
  constructor({ server, helper, fileSend, drop, getSettings }) {
    super();
    Object.assign(this, { server, helper, fileSend, drop, getSettings });
    this.offer = null; // ours: { id, paths, items, files, bytes }
    this.incoming = null; // theirs: { id, items, files, bytes, at }
    this.pasting = null; // { id, files }
    this.error = '';

    server.on(`t:${T.FCLIP_OFFER}`, (m) => {
      if (typeof m.id !== 'string' || !Array.isArray(m.items)) return;
      const items = m.items.slice(0, 1000).map((i) => ({ name: String(i.name || '').slice(0, 200), dir: !!i.dir, size: Number(i.size) || 0 }));
      this.incoming = { id: m.id, items, files: Number(m.files) || 0, bytes: Number(m.bytes) || 0, at: Date.now() };
      this.emit('change');
    });
    server.on(`t:${T.FCLIP_GONE}`, (m) => {
      if (this.incoming && this.incoming.id === m.id) this.incoming = null;
      if (this.pasting && this.pasting.id === m.id) {
        this.pasting = null;
        this.emit('popup', 'home', 'Those files aren’t there any more');
      }
      this.emit('change');
    });
    server.on(`t:${T.FCLIP_PASTE}`, (m) => this._send(m.id));
    // The other computer's keyboard pressed its copy/paste shortcut while the pointer is here.
    server.on(`t:${T.FCLIP_KEY}`, (m) => {
      if (m.action === 'copy') this.copy();
      else if (m.action === 'paste') this.paste();
    });
    server.on('closed', () => {
      if (server.current) return;
      this.incoming = null;
      this.pasting = null;
      this.emit('change');
    });
    drop.on('batch', (b) => {
      if (b.kind !== 'paste') return;
      this.pasting = null;
      this.emit('popup', 'home', b.ok ? `Pasted ${plural(b.files, 'file')}` : `Pasted ${b.files} of ${b.count} files`);
      this.emit('change');
    });
    this.apply();
  }

  get cfg() {
    return this.getSettings().files;
  }

  get peerName() {
    return this.server.current ? this.server.current.name : 'the other computer';
  }

  // (Re)register the two shortcuts from settings.files.copyKeys / pasteKeys.
  apply() {
    globalShortcut.unregisterAll();
    this.error = '';
    if (this.cfg.shortcuts !== false) {
      const bad = [];
      for (const [acc, fn] of [[this.cfg.copyKeys, () => this.copy()], [this.cfg.pasteKeys, () => this.paste()]]) {
        try {
          if (!acc || !globalShortcut.register(acc, fn)) bad.push(acc);
        } catch {
          bad.push(acc);
        }
      }
      if (bad.length) this.error = `Couldn’t use ${bad.join(' and ')}. Another app may have it.`;
    }
    this.emit('change');
  }

  // While this Mac drives the other computer, its key events go through here (kvm.js) before they
  // are sent: our own copy/paste shortcut becomes `fclip.key`, so it happens where the pointer is.
  // Returns true when the event was used up.
  intercept(e) {
    const MODS = { ControlLeft: 'Control', ControlRight: 'Control', AltLeft: 'Alt', AltRight: 'Alt', ShiftLeft: 'Shift', ShiftRight: 'Shift', MetaLeft: 'Command', MetaRight: 'Command' };
    if (!this.held) this.held = new Set();
    if (!this.eaten) this.eaten = new Set();
    if (e.t !== T.K_KEY_DOWN && e.t !== T.K_KEY_UP) return false;
    if (MODS[e.code]) {
      if (e.t === T.K_KEY_DOWN) this.held.add(e.code);
      else this.held.delete(e.code);
      return false;
    }
    if (e.t === T.K_KEY_UP) return this.eaten.delete(e.code);
    if (this.cfg.shortcuts === false) return false;
    const mods = [...new Set([...this.held].map((c) => MODS[c]))].sort().join('+');
    const key = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : /^Digit\d$/.test(e.code) ? e.code.slice(5) : e.code;
    const match = (acc) => {
      const parts = String(acc || '').split('+');
      return parts.pop() === key && parts.sort().join('+') === mods;
    };
    const action = match(this.cfg.copyKeys) ? 'copy' : match(this.cfg.pasteKeys) ? 'paste' : '';
    if (!action) return false;
    this.eaten.add(e.code);
    this.server.sendToClient({ t: T.FCLIP_KEY, action });
    return true;
  }

  async copy() {
    if (!this.server.current) return this.emit('popup', 'home', 'Not connected');
    let paths = [];
    try {
      const src = await this.helper.request('fileSource');
      paths = src.front === 'com.apple.finder' ? await finderSelection() : [];
      if (!paths.length) paths = src.files || [];
    } catch { /* no helper: nothing to copy */ }
    paths = paths.filter((p) => fs.existsSync(p));
    if (!paths.length) return this.emit('popup', 'home', 'Select files in Finder first');
    const plan = this.fileSend.planDrag(paths);
    if (!plan) return this.emit('popup', 'home', 'Nothing to copy there');
    if (this.offer) this.server.sendToClient({ t: T.FCLIP_GONE, id: this.offer.id }); // newest copy wins
    this.offer = { id: crypto.randomUUID(), paths, items: plan.items, files: plan.files, bytes: plan.bytes };
    // list / dirs: the whole tree, so a PC pastes it with Windows' own copy dialog.
    this.server.sendToClient({
      t: T.FCLIP_OFFER, id: this.offer.id, items: plan.items, files: plan.files, bytes: plan.bytes,
      list: plan.list.map((f) => ({ rel: f.rel, size: f.size })), dirs: plan.dirs,
    });
    this.emit('popup', 'away', `Copied ${plan.items.length === 1 ? plan.items[0].name : plural(plan.items.length, 'item')} for ${this.peerName}`);
    this.emit('change');
  }

  async paste() {
    const inc = this.incoming;
    if (!this.server.current) return this.emit('popup', 'home', 'Not connected');
    if (!inc) return this.emit('popup', 'home', `Nothing copied on ${this.peerName}`);
    let dir = '';
    try {
      const src = await this.helper.request('fileSource');
      if (src.front === 'com.apple.finder') dir = await finderFolder();
    } catch { /* Desktop */ }
    dir = dir && fs.existsSync(dir) ? dir.replace(/\/$/, '') : DESKTOP;
    this.drop.expectBatch(inc.id, dir);
    this.pasting = { id: inc.id, files: inc.files };
    this.server.sendToClient({ t: T.FCLIP_PASTE, id: inc.id });
    this.emit('popup', 'driven', `Pasting ${plural(inc.files, 'file')}…`);
    this.emit('change');
  }

  // The peer pasted: send our copied files (or say they're gone).
  _send(id) {
    const o = this.offer;
    if (!o || o.id !== id || !o.paths.some((p) => fs.existsSync(p))) {
      return this.server.sendToClient({ t: T.FCLIP_GONE, id });
    }
    if (!this.fileSend.sendBatch(o.paths.filter((p) => fs.existsSync(p)), 'paste', id)) {
      this.server.sendToClient({ t: T.FCLIP_GONE, id });
    }
  }

  get view() {
    return {
      error: this.error,
      offer: this.offer && { files: this.offer.files, items: this.offer.items.length },
      incoming: this.incoming && { files: this.incoming.files, items: this.incoming.items.length, name: this.incoming.items.length === 1 ? this.incoming.items[0].name : '' },
      pasting: !!this.pasting,
    };
  }
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

module.exports = { FileClip };
