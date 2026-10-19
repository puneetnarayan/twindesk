// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Copy and paste files between the computers with two global shortcuts (default
// Ctrl+Alt+C / Ctrl+Alt+V, Files tab).
// Copy announces the files selected in the Explorer window in front (else the files on the
// clipboard) with `fclip.offer`; paste on the other computer asks for them with `fclip.paste` and
// they arrive as a batch (filedrop.js / filerecv.js, drop:'paste') in the folder that was in front.
// Port of mac/fclip.js. When the offer lists every file (`list`, `dirs`), the paste is
// done by Windows itself — dragrecv.js drops the files as virtual files onto the folder, so the
// native copy dialog (progress, replace/skip) shows, as for a drag.
const { app, globalShortcut } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const P = require('../shared/protocol.js');

const T = P.T;

class FileClip {
  // opts: link, helper, fileDrop, fileRecv, dragRecv, settings (shared), peerName(), popup(kind, text), onChange()
  constructor(opts) {
    Object.assign(this, opts);
    this.offer = null; // ours: {id, paths, items, files, bytes}
    this.incoming = null; // theirs: {id, items, files, bytes, at}
    this.pasting = null; // {id, files}
    this.error = '';
    this.held = new Set(); // modifiers held while driving (intercept)
    this.eaten = new Set(); // shortcut keys whose release isn't sent

    const link = this.link;
    link.on(T.FCLIP_OFFER, (m) => {
      if (typeof m.id !== 'string' || !Array.isArray(m.items)) return;
      const items = m.items.slice(0, 1000).map((i) => ({ name: String((i && i.name) || '').slice(0, 200), dir: !!(i && i.dir), size: Number(i && i.size) || 0 }));
      this.incoming = { id: m.id, items, files: Number(m.files) || 0, bytes: Number(m.bytes) || 0, at: Date.now(),
        list: Array.isArray(m.list) ? m.list : null, dirs: Array.isArray(m.dirs) ? m.dirs : [] }; // The whole tree
      this.onChange();
    });
    link.on(T.FCLIP_GONE, (m) => {
      if (this.incoming && this.incoming.id === m.id) this.incoming = null;
      if (this.pasting && this.pasting.id === m.id) {
        this.pasting = null;
        this.popup('home', 'Those files aren’t there any more');
      }
      this.onChange();
    });
    link.on(T.FCLIP_PASTE, (m) => this._send(m.id));
    // The other computer's keyboard pressed its copy/paste shortcut while the pointer
    // is here (it drives this PC): do it here.
    link.on(T.FCLIP_KEY, (m) => {
      if (m.action === 'copy') this.copy();
      else if (m.action === 'paste') this.paste();
    });
    link.on('closed', () => {
      this.incoming = null;
      this.pasting = null;
      this.onChange();
    });
    this.apply();
  }

  get cfg() {
    return this.settings.files;
  }

  get connected() {
    return this.link.status.state === 'connected';
  }

  // The paste batch landed (filerecv.js onBatch).
  pasted(b) {
    this.pasting = null;
    this.popup('home', b.ok ? 'Pasted ' + plural(b.files, 'file') : 'Pasted ' + b.files + ' of ' + b.count + ' files');
    this.onChange();
  }

  // (Re)register the two shortcuts from settings.files.copyKeys / pasteKeys. Ctrl+Alt is AltGr on
  // many layouts: if Windows won't give us a key, the Files tab says so (pick another).
  apply() {
    for (const acc of this.registered || []) globalShortcut.unregister(acc);
    this.registered = [];
    this.error = '';
    if (this.cfg.shortcuts) {
      const bad = [];
      for (const [acc, fn] of [[this.cfg.copyKeys, () => this.copy()], [this.cfg.pasteKeys, () => this.paste()]]) {
        let ok = false;
        try { ok = globalShortcut.register(acc, fn); } catch (_) { /* invalid */ }
        if (ok) this.registered.push(acc);
        else bad.push(keysLabel(acc));
      }
      if (bad.length) this.error = 'Couldn’t use ' + bad.join(' and ') + '. Another app may have it.';
    }
    this.onChange();
  }

  // While this PC drives the other computer its key events pass through here (kvm.js) before they
  // are sent: our own copy/paste shortcut becomes `fclip.key`, so it happens where the pointer is.
  // Modifiers still go over as keys; the shortcut's key and its release are used up. Returns true
  // when the event was used up.
  intercept(e) {
    const MODS = { ControlLeft: 'Control', ControlRight: 'Control', AltLeft: 'Alt', AltRight: 'Alt', ShiftLeft: 'Shift', ShiftRight: 'Shift', MetaLeft: 'Super', MetaRight: 'Super' };
    if (e.t !== T.K_KEY_DOWN && e.t !== T.K_KEY_UP) return false;
    if (MODS[e.code]) {
      if (e.t === T.K_KEY_DOWN) this.held.add(e.code);
      else this.held.delete(e.code);
      return false;
    }
    if (e.t === T.K_KEY_UP) return this.eaten.delete(e.code);
    if (!this.cfg.shortcuts) return false;
    const mods = [...new Set([...this.held].map((c) => MODS[c]))].sort().join('+');
    const key = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : /^Digit\d$/.test(e.code) ? e.code.slice(5) : e.code;
    const match = (acc) => {
      const parts = String(acc || '').split('+');
      return parts.pop() === key && parts.sort().join('+') === mods;
    };
    const action = match(this.cfg.copyKeys) ? 'copy' : match(this.cfg.pasteKeys) ? 'paste' : '';
    if (!action) return false;
    this.eaten.add(e.code);
    this.link.send({ t: T.FCLIP_KEY, action });
    return true;
  }

  // Capture ended: nothing is held any more.
  resetKeys() {
    this.held.clear();
    this.eaten.clear();
  }

  async copy() {
    if (!this.connected) return this.popup('home', 'Not connected');
    let paths = [];
    try {
      const src = await this.helper.request('fileSource');
      paths = src.explorer && src.selection.length ? src.selection : src.files || [];
    } catch (_) { /* no helper: nothing to copy */ }
    paths = paths.filter((p) => typeof p === 'string' && fs.existsSync(p));
    if (!paths.length) return this.popup('home', 'Select files in File Explorer first');
    const plan = this.fileDrop.plan(paths);
    if (!plan || !plan.jobs.length) return this.popup('home', 'Nothing to copy there');
    if (this.offer) this.link.send({ t: T.FCLIP_GONE, id: this.offer.id }); // newest copy wins
    const files = plan.jobs.length;
    this.offer = { id: crypto.randomUUID(), paths, items: plan.items, files, bytes: plan.bytes };
    // list/dirs: every file and folder, so a PC can paste it with Windows' own copy.
    this.link.send({ t: T.FCLIP_OFFER, id: this.offer.id, items: plan.items, files, bytes: plan.bytes, list: plan.list, dirs: plan.dirs });
    this.popup('away', 'Copied ' + (plan.items.length === 1 ? plan.items[0].name : plural(plan.items.length, 'item')) + ' for ' + this.peerName());
    this.onChange();
  }

  async paste() {
    const inc = this.incoming;
    if (!this.connected) return this.popup('home', 'Not connected');
    if (!inc) return this.popup('home', 'Nothing copied on ' + this.peerName());
    let dir = '';
    try {
      dir = (await this.helper.request('frontFolder')).path || '';
    } catch (_) { /* Desktop */ }
    if (!dir || !fs.existsSync(dir)) dir = app.getPath('desktop');
    // Windows' own copy (its dialog) when we know the whole tree; else straight in.
    const native = inc.list && this.dragRecv && this.dragRecv.startPaste({ batch: inc.id, list: inc.list, dirs: inc.dirs, items: inc.items, dir });
    if (!native) this.fileRecv.expectBatch(inc.id, dir, inc.bytes);
    this.pasting = { id: inc.id, files: inc.files };
    this.link.send({ t: T.FCLIP_PASTE, id: inc.id });
    if (!native) this.popup('driven', 'Pasting ' + plural(inc.files, 'file') + '…');
    this.onChange();
  }

  // The other side pasted: send our copied files (or say they're gone).
  _send(id) {
    const o = this.offer;
    const there = o && o.id === id ? o.paths.filter((p) => fs.existsSync(p)) : [];
    if (!there.length || !this.fileDrop.sendBatch(there, 'paste', id)) this.link.send({ t: T.FCLIP_GONE, id });
  }

  shutdown() {
    for (const acc of this.registered || []) globalShortcut.unregister(acc);
  }

  view() {
    return {
      error: this.error,
      offer: this.offer && { files: this.offer.files, items: this.offer.items.length },
      incoming: this.incoming && { files: this.incoming.files, items: this.incoming.items.length, name: this.incoming.items.length === 1 ? this.incoming.items[0].name : '' },
      pasting: !!this.pasting,
    };
  }
}

function plural(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

// "Control+Alt+C" → "Ctrl+Alt+C".
function keysLabel(acc) {
  return String(acc || '').replace('Control', 'Ctrl').replace('Super', 'Win');
}

module.exports = FileClip;
