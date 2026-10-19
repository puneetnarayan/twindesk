// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Files and folders dragged in from the PC as a native drag here ("Drag files
// across the screen edge"). `drag.start` → the helper starts an NSDraggingSession with
// one file promise per top-level item; the files stream into a private temp tree as they arrive
// (drop.js does the transfer, `drop:'drag'` offers land at <tmp>/<rel>). When the drop target asks
// for an item (`dragWrite`), we wait until all of its files are here, move the tree to the target's
// path and answer `dragWritten`; then `file.done` per file and `drag.end {dropped, where}`.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const P = require('../shared/protocol.js');

const ROOT = path.join(os.tmpdir(), 'macshare-incoming', 'drag');
const MAX_FILES = 10000;
const MAX_DEPTH = 32;
const NO_WRITE_MS = 120000; // accepted but never asked for the files

// 'Photos/2024/b.jpg' → ['Photos', '2024', 'b.jpg'], or null when it isn't a safe relative path.
function splitRel(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 4096) return null;
  const parts = rel.split('/');
  if (parts.length > MAX_DEPTH) return null;
  for (const s of parts) {
    if (!s || s === '.' || s === '..' || /[\u0000-\u001f:\\]/.test(s) || s.length > 255) return null;
  }
  return parts;
}

function moveSync(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(from, to);
    fs.rmSync(from, { force: true });
  }
}

class DragIn {
  constructor({ server, helper, getSettings, remember }) {
    Object.assign(this, { server, helper, getSettings, remember });
    this.cur = null; // the drag in progress (one at a time)
    this.isDriven = () => false; // set by kvm.js

    server.on(`t:${P.T.DRAG_START}`, (m) => this._start(m));
    server.on(`t:${P.T.DRAG_CANCEL}`, (m) => this.cur && m.drag === this.cur.id && this.cancel());
    server.on('closed', () => !server.current && this.cancel());
    helper.on('event', (name, ev) => {
      const d = this.cur;
      if (!d || !ev || ev.drag !== d.id) return;
      console.log(`[dragin] ${name} ${JSON.stringify(ev)}`);
      if (name === 'dragEnded') this._sessionEnded(ev.result);
      else if (name === 'dragWrite') this._write(Number(ev.index), String(ev.path || ''));
    });
    helper.on('exit', () => this.cur && this._end('failed'));
  }

  _start(m) {
    const fail = () => this.server.sendToClient({ t: P.T.DRAG_END, drag: m.drag, result: 'failed' });
    if (typeof m.drag !== 'string' || !m.drag || m.drag.length > 64) return;
    if (this.cur) this.cancel();
    console.log(`[dragin] drag.start ${m.drag} (driven: ${this.isDriven()})`);
    if (this.getSettings().files.dragEdge === false) return this.server.sendToClient({ t: P.T.DRAG_END, drag: m.drag, result: 'cancelled' });
    if (!this.isDriven()) {
      // Sent just before its kvm.take: start it as soon as the take arrives (onDriven).
      clearTimeout(this.early && this.early.timer);
      const early = { m, offers: [] };
      early.timer = setTimeout(() => {
        this.early = null;
        fail();
        for (const o of early.offers) this.server.sendToClient({ t: P.T.FILE_REFUSE, id: o.id, why: 'not_allowed' });
      }, 1500);
      this.early = early;
      return;
    }
    if (!this.getSettings().files.acceptDrops) return fail();
    const items = Array.isArray(m.items) ? m.items : [];
    const list = Array.isArray(m.list) ? m.list : [];
    const dirs = Array.isArray(m.dirs) ? m.dirs : [];
    if (!items.length || items.length > MAX_FILES || list.length > MAX_FILES || dirs.length > MAX_FILES) return fail();
    const names = new Set();
    for (const it of items) {
      const p = splitRel(it && it.name);
      if (!p || p.length !== 1 || names.has(it.name)) return fail();
      names.add(it.name);
    }
    const files = new Map(); // rel -> {size, state: 'waiting'|'here'|'failed', id}
    for (const f of list) {
      const p = splitRel(f && f.rel);
      const size = Number(f && f.size);
      if (!p || !names.has(p[0]) || files.has(f.rel) || !(size >= 0) || size > P.FILE_MAX_BYTES) return fail();
      files.set(f.rel, { size, state: 'waiting', id: null });
    }
    for (const r of dirs) {
      const p = splitRel(r);
      if (!p || !names.has(p[0])) return fail();
    }
    const id = m.drag;
    const root = path.join(ROOT, crypto.createHash('sha1').update(id).digest('hex').slice(0, 12));
    try {
      fs.rmSync(root, { recursive: true, force: true });
      for (const r of dirs) fs.mkdirSync(path.join(root, ...r.split('/')), { recursive: true });
    } catch (e) {
      console.error(`[dragin] ${e.message}`);
      return fail();
    }
    this.cur = {
      id, root, files, dirs,
      items: items.map((it) => ({ name: it.name, dir: !!it.dir })),
      writes: new Map(), // index -> dest path, until written
      written: 0,
      where: null,
      accepted: false,
      timer: null,
    };
    this.helper.request('dragStart', { drag: id, items: this.cur.items }).catch(() => this._end('failed'));
    console.log(`[dragin] ${id}: ${items.length} item(s), ${files.size} file(s)`);
  }

  // kvm.js: the PC just took this Mac over; a drag.start that came first starts now.
  onDriven() {
    const e = this.early;
    if (!e) return;
    clearTimeout(e.timer);
    this.early = null;
    this._start(e.m);
    for (const o of e.offers) this.replayOffer(o); // its files, offered before the take
  }

  // drop.js: an offer for a drag that is waiting for its kvm.take is answered later.
  holdOffer(m) {
    if (!this.early || this.early.m.drag !== m.drag) return false;
    this.early.offers.push(m);
    return true;
  }

  // drop.js: where a `drop:'drag'` file goes while it arrives, or null to refuse it.
  tmpFor(m) {
    const d = this.cur;
    if (!d || m.drag !== d.id) return null;
    const f = d.files.get(m.rel);
    if (!f || f.id || Number(m.size) !== f.size) return null;
    f.id = m.id;
    return path.join(d.root, ...m.rel.split('/'));
  }

  // drop.js: a drag file finished (ok) or was aborted.
  arrived(m, ok) {
    const d = this.cur;
    if (!d || m.drag !== d.id) return;
    const f = d.files.get(m.rel);
    if (!f || f.id !== m.id) return;
    f.state = ok ? 'here' : 'failed';
    for (const i of [...d.writes.keys()]) this._tryWrite(i);
  }

  // Ours: is this file of the current drag?
  owns(m) {
    return !!(this.cur && m.drag === this.cur.id);
  }

  // The PC pressed Esc / went home / we stop being driven.
  cancel() {
    const d = this.cur;
    if (!d) return;
    if (d.accepted) return; // already dropped; let the files finish
    this.helper.request('dragCancel').catch(() => {});
    this._end('cancelled');
  }

  get dragging() {
    return !!(this.cur && !this.cur.accepted);
  }

  _sessionEnded(result) {
    const d = this.cur;
    if (result !== 'dropped') return this._end(result === 'failed' ? 'failed' : 'cancelled');
    d.accepted = true;
    clearTimeout(d.timer);
    d.timer = setTimeout(() => this.cur === d && this._end(d.written ? 'dropped' : 'failed'), NO_WRITE_MS);
  }

  _write(index, dest) {
    const d = this.cur;
    if (!d.items[index] || !path.isAbsolute(dest)) return this.helper.send('dragWritten', { drag: d.id, index, error: 'bad request' });
    d.accepted = true;
    d.writes.set(index, dest);
    this._tryWrite(index);
  }

  _tryWrite(index) {
    const d = this.cur;
    const it = d.items[index];
    const dest = d.writes.get(index);
    const mine = [...d.files.entries()].filter(([rel]) => rel === it.name || rel.startsWith(`${it.name}/`));
    if (mine.some(([, f]) => f.state === 'waiting')) return; // still streaming in
    d.writes.delete(index);
    const failed = mine.filter(([, f]) => f.state === 'failed');
    let error = failed.length ? `${failed.length} file(s) didn’t arrive` : null;
    try {
      if (it.dir) {
        fs.mkdirSync(dest, { recursive: true });
        for (const r of d.dirs) if (r.startsWith(`${it.name}/`)) fs.mkdirSync(path.join(dest, ...r.split('/').slice(1)), { recursive: true });
      }
      for (const [rel, f] of mine) {
        if (f.state !== 'here') continue;
        const to = it.dir ? path.join(dest, ...rel.split('/').slice(1)) : dest;
        moveSync(path.join(d.root, ...rel.split('/')), to);
        this.server.sendToClient({ t: P.T.FILE_DONE, id: f.id, ok: true, path: to.replace(os.homedir(), '~') });
      }
      for (const [, f] of failed) this.server.sendToClient({ t: P.T.FILE_DONE, id: f.id, ok: false, error: 'not received' });
      this.remember({ name: it.name, size: mine.reduce((s, [, f]) => s + f.size, 0), path: dest, ok: !error, error });
    } catch (e) {
      error = e.message;
      this.remember({ name: it.name, size: 0, path: null, ok: false, error });
    }
    this.helper.send('dragWritten', { drag: d.id, index, ...(error ? { error } : {}) });
    d.written++;
    d.where = path.dirname(dest);
    if (d.written >= d.items.length) this._end(error ? 'failed' : 'dropped');
  }

  _end(result) {
    const d = this.cur;
    if (!d) return;
    this.cur = null;
    clearTimeout(d.timer);
    for (const i of d.writes.keys()) this.helper.send('dragWritten', { drag: d.id, index: i, error: 'cancelled' });
    const msg = { t: P.T.DRAG_END, drag: d.id, result };
    if (result === 'dropped' && d.where) msg.where = d.where.replace(os.homedir(), '~');
    this.server.sendToClient(msg);
    if (result !== 'dropped') this.onAbort && this.onAbort(d.id); // drop.js drops the transfers
    setTimeout(() => fs.rm(d.root, { recursive: true, force: true }, () => {}), result === 'dropped' ? 0 : 1000);
  }
}

module.exports = { DragIn, splitRel };
