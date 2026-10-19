// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// An Android phone in Finder: a WebDAV server on 127.0.0.1 in front of the phone's storage
// (/sdcard), reached through adb, which Finder mounts as a network volume (Locations, like any
// server). Through the USB cable when the phone allows USB debugging, else through wireless
// debugging (the network) while the phone is connected to TwinDesk; it switches between the two
// as the cable comes and goes, and unmounts when neither is there.
//
// Nothing runs until Mount is clicked on the Mount page: no polling, no adb, no server. It looks
// for the phone then, and only watches it while the volume is mounted.
//
// Finder's own files (.DS_Store, ._* AppleDouble) stay in memory here, so nothing of the Mac's
// lands on the phone. Basic auth with a password made per run keeps other local apps out.
//
// Events: 'change' — this.view changed.
'use strict';

const http = require('http');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { EventEmitter } = require('events');
const usbadb = require('../shared/usbadb.js');

const ROOT = '/sdcard';
const POLL_MS = 3000;
const LIST_CACHE_MS = 2000;
// Finder asks for these everywhere; they never exist on a phone (or live in memory: SIDECAR).
const MAC_ONLY = /^(\.metadata_never_index.*|\.Spotlight-V100|\.Trashes|\.fseventsd|\.hidden|\.localized|Backups\.backupdb|\.ql_disable.*|\.VolumeIcon\.icns|\.com\.apple\..*|mach_kernel|\.TemporaryItems)$/;
const SIDECAR = /^(\.DS_Store|\._.*)$/;

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`; // a single-quoted shell word
const xml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
const base = (p) => p.replace(/\/+$/, '').split('/').pop();
const dirOf = (p) => p.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/';
const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav', pdf: 'application/pdf', txt: 'text/plain', zip: 'application/zip', apk: 'application/vnd.android.package-archive' };
const typeOf = (name) => TYPES[(name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';

class PhoneDrive extends EventEmitter {
  constructor({ adb, bridge, phone }) {
    super();
    Object.assign(this, { adb, bridge, phone });
    this.usb = null; // {serial, state: 'device'|'unauthorized'|…, name}
    this.server = null;
    this.port = 0;
    this.user = 'twindesk';
    this.password = crypto.randomBytes(12).toString('hex');
    this.volume = ''; // the name Finder shows, the URL's one path segment
    this.mountPath = ''; // /Volumes/<name> while mounted
    this.busy = '';
    this.message = '';
    this.sidecars = new Map(); // phone path -> {data, mtime}
    this.lists = new Map(); // dir -> {at, entries}
    this.timer = null; // only while mounted
  }

  get view() {
    const via = this._via();
    return {
      usb: this.usb && { state: this.usb.state, name: this.usb.name },
      name: this._name(),
      via, // 'usb' | 'wifi' | ''
      mounted: this.mountPath, busy: this.busy, message: this.message,
    };
  }

  // ---- which way to the phone ----

  _via() {
    if (this.usb && this.usb.state === 'device') return 'usb';
    if (this.bridge.state === 'ready' && this.bridge.serial) return 'wifi';
    return '';
  }

  _serial() {
    const via = this._via();
    return via === 'usb' ? this.usb.serial : via === 'wifi' ? this.bridge.serial : null;
  }

  _name() {
    const c = this.phone.connected && this.bridge.server.current;
    return (this.usb && this.usb.name) || (c && c.name) || 'Phone';
  }

  // adb: is the phone on the cable? (Wireless debugging is the bridge's own.)
  async _detect() {
    // adb: devices on USB have no ':' in their serial (wireless ones are address:port).
    // adb only while a phone is linked or one is on the cable (asked of the system, not adb).
    const here = this.adb.available && (this.phone.connected || await usbadb.present());
    const list = here ? await this.adb.run(['devices', '-l'], { timeout: 5000 }) : { out: '' };
    const usb = list.out.split('\n').slice(1).map((l) => l.trim().split(/\s+/)).find((p) => p.length >= 2 && !p[0].includes(':') && !p[0].startsWith('emulator-'));
    if (usb) {
      const [serial, state] = usb;
      const model = (usb.find((w) => w.startsWith('model:')) || '').slice(6).replace(/_/g, ' ');
      if (!this.usb || this.usb.serial !== serial || this.usb.state !== state) {
        let name = model;
        if (state === 'device') {
          const r = await this.adb.shell(serial, 'getprop ro.product.marketname; getprop ro.product.model', { timeout: 4000 });
          name = r.out.split('\n').map((s) => s.trim()).find(Boolean) || model;
        }
        this.usb = { serial, state, name: name || 'Android phone' };
      }
    } else this.usb = null;
  }

  // While mounted: follow the cable, and notice an eject in Finder.
  async _poll() {
    const was = JSON.stringify(this.view);
    await this._detect();
    // Mounted, but no way to the phone any more (cable out and no wireless debugging): unmount.
    if (this.mountPath && !this._via() && !this.busy) await this.unmount('The phone went away.');
    if (this.mountPath && !(await mountedAt(this.port))) { this.mountPath = ''; this.message = ''; this._watch(false); } // ejected in Finder
    if (JSON.stringify(this.view) !== was) this.emit('change');
  }

  // ---- mount / unmount ----

  async mount() {
    if (this.busy) return;
    if (this.mountPath) return this.reveal();
    this._set('mounting', '');
    await this._detect().catch(() => {});
    this.busy = '';
    if (!this._via()) {
      this.message = this.usb && this.usb.state === 'unauthorized' ? 'Allow USB debugging on the phone (the prompt on its screen), then Mount again.'
        : this.usb ? 'Turn on USB debugging on the phone (Developer options), or connect it to TwinDesk with wireless debugging.'
          : 'Plug the phone in with a USB cable (USB debugging on), or connect it to TwinDesk.';
      return this.emit('change');
    }
    this._set('mounting', '');
    try {
      await this._listen();
      this.volume = this._name().replace(/[/:\\"]/g, ' ').trim().slice(0, 60) || 'Phone';
      const url = `http://127.0.0.1:${this.port}/${encodeURIComponent(this.volume)}`;
      this.mountPath = await mountVolume(url, this.user, this.password, this.port);
      this._set('', '');
      this._watch(true);
      this.reveal();
    } catch (e) {
      this._set('', `Couldn’t mount the phone: ${String(e.message).split('\n')[0]}`);
    }
  }

  async unmount(message = '') {
    this._watch(false);
    const at = this.mountPath || (await mountedAt(this.port));
    if (!at) return this.emit('change');
    this._set('unmounting', '');
    await new Promise((res) => execFile('/usr/sbin/diskutil', ['unmount', 'force', at], { timeout: 15000 }, () => res()));
    this.mountPath = '';
    this.sidecars.clear();
    this.lists.clear();
    this._set('', message);
  }

  // Mount page switched off: unmount, and the server goes too.
  async stop() {
    await this.unmount();
    if (this.server) this.server.close();
    this.server = null;
    this.port = 0;
    this.usb = null;
    this._set('', '');
  }

  _watch(on) {
    clearInterval(this.timer);
    this.timer = on ? setInterval(() => this._poll().catch(() => {}), POLL_MS) : null;
  }

  reveal() {
    if (this.mountPath) execFile('/usr/bin/open', [this.mountPath], () => {});
  }

  shutdown() {
    clearInterval(this.timer);
    // Before the server goes: a WebDAV volume left without its server hangs Finder for a while.
    if (this.mountPath) {
      try {
        require('child_process').execFileSync('/usr/sbin/diskutil', ['unmount', 'force', this.mountPath], { timeout: 5000, stdio: 'ignore' });
      } catch {}
    }
    if (this.server) this.server.close();
  }

  _set(busy, message) {
    this.busy = busy;
    this.message = message;
    this.emit('change');
  }

  // ---- WebDAV ----

  _listen() {
    if (this.server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        if (process.env.TWINDESK_DAV_DEBUG) {
          const t = Date.now();
          res.on('finish', () => console.log(`[dav] ${req.method} ${req.url} ${req.headers.depth || ''} ${res.statusCode} ${Date.now() - t}ms`));
        }
        this._handle(req, res).catch((e) => {
        console.log(`[phonedrive] ${req.method} ${req.url}: ${e.message}`);
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
      });
      srv.keepAliveTimeout = 30000;
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        this.server = srv;
        this.port = srv.address().port;
        resolve();
      });
    });
  }

  // URL path -> phone path ('' when it's outside our one volume).
  _path(urlPath) {
    let p;
    try {
      p = decodeURIComponent(urlPath.split('?')[0]);
    } catch {
      return '';
    }
    const prefix = `/${this.volume}`;
    if (p !== prefix && !p.startsWith(`${prefix}/`)) return '';
    const rel = p.slice(prefix.length).split('/').filter((s) => s && s !== '.' && s !== '..').join('/');
    return rel ? `${ROOT}/${rel}` : ROOT;
  }

  _href(phonePath, dir) {
    const rel = phonePath === ROOT ? '' : phonePath.slice(ROOT.length + 1);
    const segs = [this.volume, ...rel.split('/').filter(Boolean)].map(encodeURIComponent);
    return `/${segs.join('/')}${dir ? '/' : ''}`;
  }

  _sh(serial, cmd, timeout = 20000) {
    return this.adb.run(['-s', serial, 'shell', cmd], { timeout });
  }

  async _stat(serial, p) {
    const sc = this.sidecars.get(p);
    if (sc) return { dir: false, size: sc.data.length, mtime: sc.mtime, name: base(p) };
    if (MAC_ONLY.test(base(p)) || SIDECAR.test(base(p))) return null;
    // Finder asks about every entry right after listing the folder: answer from that listing.
    const c = p !== ROOT && this.lists.get(dirOf(p));
    if (c && Date.now() - c.at < LIST_CACHE_MS) return c.entries.find((e) => e.name === base(p)) || null;
    const r = await this._sh(serial, `stat -L -c '%F\t%s\t%Y' ${q(p === ROOT ? `${ROOT}/` : p)}`);
    const m = /^([^\t]+)\t(\d+)\t(\d+)/.exec(r.out.trim());
    return m ? { dir: m[1] === 'directory', size: Number(m[2]), mtime: Number(m[3]) * 1000, name: p === ROOT ? this.volume : base(p) } : null;
  }

  async _list(serial, dir) {
    const c = this.lists.get(dir);
    if (c && Date.now() - c.at < LIST_CACHE_MS) return c.entries;
    const r = await this._sh(serial, `find ${q(`${dir}/`)} -maxdepth 1 -mindepth 1 -exec stat -L -c '%F\t%s\t%Y\t%n' {} + 2>/dev/null`, 60000);
    const entries = [];
    for (const line of r.out.split('\n')) {
      const m = /^([^\t]+)\t(\d+)\t(\d+)\t(.+)$/.exec(line.replace(/\r$/, ''));
      if (m) entries.push({ dir: m[1] === 'directory', size: Number(m[2]), mtime: Number(m[3]) * 1000, name: base(m[4]) });
    }
    for (const [p, sc] of this.sidecars) if (dirOf(p) === dir) entries.push({ dir: false, size: sc.data.length, mtime: sc.mtime, name: base(p) });
    this.lists.set(dir, { at: Date.now(), entries });
    return entries;
  }

  _changed(p) {
    this.lists.delete(dirOf(p));
    this.lists.delete(p);
  }

  // Free and used space, for Finder's status bar (asked with every look at the top folder).
  async _quota(serial) {
    if (this.quota && Date.now() - this.quota.at < 15000) return this.quota;
    const r = await this._sh(serial, `stat -f -c '%a %b %S' ${q(`${ROOT}/`)}`, 5000);
    const [avail, total, bs] = r.out.trim().split(/\s+/).map(Number);
    this.quota = bs ? { avail: avail * bs, used: (total - avail) * bs, at: Date.now() } : null;
    return this.quota;
  }

  _entryXml(p, st, quota) {
    const d = new Date(st.mtime || Date.now());
    return `<D:response><D:href>${xml(this._href(p, st.dir))}</D:href><D:propstat><D:prop>`
      + `<D:displayname>${xml(st.name)}</D:displayname>`
      + `<D:resourcetype>${st.dir ? '<D:collection/>' : ''}</D:resourcetype>`
      + (st.dir ? '' : `<D:getcontentlength>${st.size}</D:getcontentlength><D:getcontenttype>${typeOf(st.name)}</D:getcontenttype>`)
      + `<D:getlastmodified>${d.toUTCString()}</D:getlastmodified><D:creationdate>${d.toISOString()}</D:creationdate>`
      + `<D:getetag>"${st.size.toString(16)}-${Math.floor(st.mtime / 1000).toString(16)}"</D:getetag>`
      + (quota ? `<D:quota-available-bytes>${quota.avail}</D:quota-available-bytes><D:quota-used-bytes>${quota.used}</D:quota-used-bytes>` : '')
      + '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>';
  }

  async _handle(req, res) {
    const auth = Buffer.from(String(req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString();
    if (auth !== `${this.user}:${this.password}`) {
      req.resume();
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="TwinDesk"', 'Content-Length': 0 });
      return res.end();
    }
    const done = (code, headers = {}, body = '') => {
      req.resume();
      res.writeHead(code, { 'Content-Length': Buffer.byteLength(body), ...headers });
      res.end(body);
    };
    if (req.method === 'OPTIONS') return done(200, { DAV: '1, 2', 'MS-Author-Via': 'DAV', Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK' });
    const p = this._path(req.url);
    if (!p) return done(404);
    const serial = this._serial();
    if (!serial) return done(503);
    const name = base(p);

    switch (req.method) {
      case 'PROPFIND': {
        const st = await this._stat(serial, p);
        if (!st) return done(404);
        const depth = req.headers.depth === '0' ? 0 : 1;
        const quota = p === ROOT ? await this._quota(serial) : null;
        let body = this._entryXml(p, st, quota);
        if (st.dir && depth) {
          for (const e of await this._list(serial, p)) body += this._entryXml(`${p}/${e.name}`, e);
        }
        return done(207, { 'Content-Type': 'application/xml; charset=utf-8' }, `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${body}</D:multistatus>`);
      }
      case 'PROPPATCH':
        return done(207, { 'Content-Type': 'application/xml; charset=utf-8' },
          `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>${xml(this._href(p, false))}</D:href><D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`);
      case 'LOCK': {
        const token = `opaquelocktoken:${crypto.randomUUID()}`;
        return done(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Lock-Token': `<${token}>` },
          `<?xml version="1.0" encoding="utf-8"?><D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>0</D:depth><D:timeout>Second-600</D:timeout><D:locktoken><D:href>${token}</D:href></D:locktoken></D:activelock></D:lockdiscovery></D:prop>`);
      }
      case 'UNLOCK':
        return done(204);
      case 'GET':
      case 'HEAD': {
        const st = await this._stat(serial, p);
        if (!st) return done(404);
        if (st.dir) return done(200, { 'Content-Type': 'text/plain' }, '');
        const headers = { 'Content-Type': typeOf(name), 'Last-Modified': new Date(st.mtime).toUTCString(), 'Accept-Ranges': 'bytes' };
        let start = 0;
        let end = st.size - 1;
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
        if (range && st.size) {
          if (range[1]) start = Number(range[1]);
          if (range[2]) end = range[1] ? Math.min(Number(range[2]), end) : st.size - 1;
          if (!range[1] && range[2]) start = Math.max(0, st.size - Number(range[2]));
          if (start > end) return done(416, { 'Content-Range': `bytes */${st.size}` });
          headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
        }
        const len = st.size ? end - start + 1 : 0;
        res.writeHead(range && st.size ? 206 : 200, { ...headers, 'Content-Length': len });
        if (req.method === 'HEAD' || !len) return res.end();
        const sc = this.sidecars.get(p);
        if (sc) return res.end(sc.data.subarray(start, end + 1));
        const cmd = start || len !== st.size ? `tail -c +${start + 1} ${q(p)} | head -c ${len}` : `cat ${q(p)}`;
        const child = spawn(this.adb.bin, ['-s', serial, 'exec-out', cmd], { stdio: ['ignore', 'pipe', 'ignore'] });
        child.stdout.pipe(res);
        res.on('close', () => child.kill());
        return undefined;
      }
      case 'PUT': {
        if (SIDECAR.test(name)) {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          this.sidecars.set(p, { data: Buffer.concat(chunks), mtime: Date.now() });
          this._changed(p);
          return done(201);
        }
        if (MAC_ONLY.test(name)) return done(403);
        const empty = req.headers['content-length'] === '0';
        if (empty) {
          req.resume();
          const r = await this._sh(serial, `: > ${q(p)}`);
          this._changed(p);
          return done(r.code === 0 ? 201 : 409);
        }
        const code = await new Promise((resolve) => {
          const child = spawn(this.adb.bin, ['-s', serial, 'exec-in', `cat > ${q(p)}`], { stdio: ['pipe', 'ignore', 'ignore'] });
          req.pipe(child.stdin);
          child.stdin.on('error', () => {});
          child.on('close', (c) => resolve(c));
          req.on('aborted', () => child.kill());
        });
        this._changed(p);
        return done(code === 0 ? 201 : 409);
      }
      case 'MKCOL': {
        const r = await this._sh(serial, `[ -e ${q(p)} ] && echo exists || mkdir ${q(p)}`);
        this._changed(p);
        return done(/exists/.test(r.out) ? 405 : r.code === 0 ? 201 : 409);
      }
      case 'DELETE': {
        if (this.sidecars.delete(p)) {
          this._changed(p);
          return done(204);
        }
        if (p === ROOT) return done(403);
        const r = await this._sh(serial, `rm -rf ${q(p)}`, 120000);
        for (const k of [...this.sidecars.keys()]) if (k.startsWith(`${p}/`)) this.sidecars.delete(k);
        this._changed(p);
        return done(r.code === 0 ? 204 : 409);
      }
      case 'MOVE':
      case 'COPY': {
        let dest = '';
        try {
          dest = this._path(new URL(String(req.headers.destination || ''), 'http://127.0.0.1').pathname);
        } catch {}
        if (!dest || dest === ROOT || p === ROOT) return done(400);
        const overwrite = String(req.headers.overwrite || 'T').toUpperCase() !== 'F';
        const sc = this.sidecars.get(p);
        if (sc || SIDECAR.test(base(dest))) {
          if (sc) this.sidecars.set(dest, { ...sc });
          if (req.method === 'MOVE') this.sidecars.delete(p);
          this._changed(p);
          this._changed(dest);
          return done(201);
        }
        const exists = (await this._sh(serial, `[ -e ${q(dest)} ] && echo yes`)).out.includes('yes');
        if (exists && !overwrite) return done(412);
        const cmd = `${exists ? `rm -rf ${q(dest)} && ` : ''}${req.method === 'MOVE' ? 'mv' : 'cp -r'} ${q(p)} ${q(dest)}`;
        const r = await this._sh(serial, cmd, 600000);
        this._changed(p);
        this._changed(dest);
        return done(r.code === 0 ? (exists ? 204 : 201) : 409);
      }
      default:
        return done(405);
    }
  }
}

// Where the volume served on this port is mounted ('' if it isn't).
function mountedAt(port) {
  return new Promise((resolve) => {
    if (!port) return resolve('');
    execFile('/sbin/mount', [], { timeout: 5000 }, (err, out) => {
      const line = String(out || '').split('\n').find((l) => l.includes(`127.0.0.1:${port}/`));
      const m = line && / on (.+?) \(/.exec(line);
      resolve(m ? m[1] : '');
    });
  });
}

// Finder's "Connect to Server" by AppleScript. osascript often doesn't come back after a WebDAV
// mount that worked, so the mount table says when it's there; resolves to the mount point.
function mountVolume(url, user, password, port) {
  return new Promise((resolve, reject) => {
    let err = '';
    const child = execFile('/usr/bin/osascript', ['-e', `mount volume "${url}" as user name "${user}" with password "${password}"`], (e, out, errOut) => {
      if (e && !e.killed) err = String(errOut || e.message).trim();
    });
    const started = Date.now();
    const tick = async () => {
      const at = await mountedAt(port);
      if (at) {
        child.kill();
        return resolve(at);
      }
      if (err || Date.now() - started > 30000) {
        child.kill();
        return reject(new Error(err || 'Finder didn’t mount it'));
      }
      setTimeout(tick, 500);
    };
    setTimeout(tick, 500);
  });
}

module.exports = { PhoneDrive };
