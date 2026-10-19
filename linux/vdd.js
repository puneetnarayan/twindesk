// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Extend: a virtual monitor for this computer that only the other one shows (windows/vdd.js's
// interface for pcscreen.js):
//   GNOME on Wayland — Mutter's own virtual monitors (org.gnome.Mutter.ScreenCast RecordVirtual,
//     what GNOME Remote Desktop uses). Nothing to install. A small Python process (Gio + GStreamer's
//     pipewiresrc) asks for one and keeps its PipeWire stream open: the monitor lives as long as that
//     stream, at the stream's size. Sharing it goes through the portal like any screen (pick
//     "Virtual remote monitor").
//   X11 — a spare (disconnected) output of the graphics driver, made to count as connected while
//     Extend is on: the X server, Chromium and Mutter all skip a disconnected output, so a mode on
//     it alone gives an area nothing captures and no window may enter. That takes root (the DRM
//     connector's sysfs `status`): HELPER, run through pkexec under a polkit action that needs no
//     password from the person at the computer (the .deb installs both; Install does it once
//     otherwise). The output then gets a mode of the size wanted (xrandr --newmode / --addmode) and
//     goes right of the main monitor, through Mutter's DisplayConfig on GNOME (Mutter undoes raw
//     xrandr changes to a monitor it manages) and xrandr --output elsewhere. Drivers with no spare
//     output (NVIDIA's) can't.
// It is on only while Extend is on, like the Mac's TwinDesk display.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const WAYLAND = process.env.XDG_SESSION_TYPE === 'wayland';

const HELPER = '/usr/libexec/twindesk-connector';
const POLICY = '/usr/share/polkit-1/actions/org.twindesk.linux.connector.policy';
const HELPER_SH = String.raw`#!/bin/sh
# TwinDesk: makes a spare display output count as connected while Extend is on, and gives it back
# to the driver's detection after (the DRM connector's status). Run through pkexec: the polkit
# action org.twindesk.linux.connector lets the person at the computer do it without a password.
# Usage: twindesk-connector on|detect <connector, e.g. HDMI-A-2 or Virtual-2>
case "$1" in on|detect) ;; *) echo "usage: twindesk-connector on|detect <connector>" >&2; exit 2 ;; esac
case "$2" in ''|*[!A-Za-z0-9-]*) echo "bad connector name: $2" >&2; exit 2 ;; esac
for f in /sys/class/drm/card[0-9]-"$2"/status /sys/class/drm/card[0-9][0-9]-"$2"/status; do
  [ -f "$f" ] && { echo "$1" > "$f"; exit; }
done
echo "no connector $2" >&2
exit 1
`;
const POLICY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE policyconfig PUBLIC "-//freedesktop//DTD PolicyKit Policy Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/PolicyKit/1/policyconfig.dtd">
<policyconfig>
  <vendor>TwinDesk</vendor>
  <vendor_url>https://github.com/InukaAsith/TwinDesk</vendor_url>
  <action id="org.twindesk.linux.connector">
    <description>Switch a spare display output on for TwinDesk's Extend</description>
    <message>TwinDesk wants to switch a spare display output on or off</message>
    <defaults>
      <allow_any>auth_admin</allow_any>
      <allow_inactive>auth_admin</allow_inactive>
      <allow_active>yes</allow_active>
    </defaults>
    <annotate key="org.freedesktop.policykit.exec.path">${HELPER}</annotate>
  </action>
</policyconfig>
`;

const CHECK = String.raw`
import json, gi
r = {'mutter': False, 'displayconfig': False, 'pipewiresrc': False}
try:
    from gi.repository import Gio
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    has = lambda name: bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'NameHasOwner',
        gi.repository.GLib.Variant('(s)', (name,)), None, 0, 3000, None).unpack()[0]
    r['mutter'] = has('org.gnome.Mutter.ScreenCast')
    r['displayconfig'] = has('org.gnome.Mutter.DisplayConfig')
    gi.require_version('Gst', '1.0')
    from gi.repository import Gst
    Gst.init(None)
    r['pipewiresrc'] = Gst.ElementFactory.find('pipewiresrc') is not None
except Exception:
    pass
print(json.dumps(r))
`;

// Asks Mutter for a virtual monitor of argv[1] × argv[2] and keeps it until stdin closes.
// Prints JSON lines: {"monitor": {name, x, y, scale}} once it's on the desktop, {"error"}, {"closed"}.
const VIRTUAL = String.raw`
import json, sys
import gi
gi.require_version('Gst', '1.0')
from gi.repository import Gio, GLib, Gst
Gst.init(None)
w, h = int(sys.argv[1]), int(sys.argv[2])
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
def out(**k):
    print(json.dumps(k), flush=True)
def call(path, iface, method, args, ret=None):
    return bus.call_sync('org.gnome.Mutter.ScreenCast', path, iface, method, args, GLib.VariantType(ret) if ret else None, 0, 10000, None)
def virtual_connectors():
    r = bus.call_sync('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig', 'org.gnome.Mutter.DisplayConfig', 'GetCurrentState', None, None, 0, 5000, None).unpack()
    found = {}
    for (x, y, scale, transform, primary, mons, props) in r[2]:
        for (conn, vendor, product, serial) in mons:
            if vendor == 'MetaVendor' or conn.startswith('Meta-'):
                found[conn] = {'name': conn, 'x': x, 'y': y, 'scale': scale}
    return found
try:
    before = set(virtual_connectors())
    sess = call('/org/gnome/Mutter/ScreenCast', 'org.gnome.Mutter.ScreenCast', 'CreateSession', GLib.Variant('(a{sv})', ({},)), '(o)')[0]
    stream = call(sess, 'org.gnome.Mutter.ScreenCast.Session', 'RecordVirtual',
                  GLib.Variant('(a{sv})', ({'cursor-mode': GLib.Variant('u', 1), 'is-platform': GLib.Variant('b', True)},)), '(o)')[0]
except GLib.Error as e:
    out(error=e.message.split(': ')[-1])
    sys.exit(1)
loop = GLib.MainLoop()
state = {'pipe': None, 'tries': 0}
def fail(text):
    out(error=text)
    loop.quit()
def find():
    try:
        new = [m for c, m in virtual_connectors().items() if c not in before]
    except GLib.Error:
        new = []
    if new:
        out(monitor=new[0])
        return False
    state['tries'] += 1
    if state['tries'] > 40:
        fail('The virtual monitor didn’t appear')
        return False
    return True
def added(conn, sender, path, iface, sig, params):
    pipe = Gst.parse_launch('pipewiresrc path=%d always-copy=false ! video/x-raw,width=%d,height=%d,max-framerate=60/1 ! fakesink sync=false' % (params[0], w, h))
    b = pipe.get_bus()
    b.add_signal_watch()
    b.connect('message::error', lambda b, m: fail(m.parse_error()[0].message))
    pipe.set_state(Gst.State.PLAYING)
    state['pipe'] = pipe
    GLib.timeout_add(250, find)
bus.signal_subscribe('org.gnome.Mutter.ScreenCast', 'org.gnome.Mutter.ScreenCast.Stream', 'PipeWireStreamAdded', stream, None, 0, added)
bus.signal_subscribe('org.gnome.Mutter.ScreenCast', 'org.gnome.Mutter.ScreenCast.Session', 'Closed', sess, None, 0, lambda *a: (out(closed=True), loop.quit()))
GLib.io_add_watch(GLib.IOChannel.unix_new(0), GLib.PRIORITY_DEFAULT, GLib.IO_HUP | GLib.IO_ERR, lambda *a: loop.quit() or False)
call(sess, 'org.gnome.Mutter.ScreenCast.Session', 'Start', None)
loop.run()
if state['pipe']:
    state['pipe'].set_state(Gst.State.NULL)
try:
    call(sess, 'org.gnome.Mutter.ScreenCast.Session', 'Stop', None)
except GLib.Error:
    pass
`;

// X11 on GNOME: through Mutter, output argv[1] on with a mode of argv[2] × argv[3] right of the
// monitors that are on, or off (argv[2] 0); the others stay as they are. Prints {"ok"} or {"error"}.
const LAYOUT = String.raw`
import json, sys, time
from gi.repository import Gio, GLib
name, w, h = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
D = ('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig', 'org.gnome.Mutter.DisplayConfig')
def current(monitors, conn):
    for (spec, modes, props) in monitors:
        if spec[0] == conn:
            return next((m for m in modes if m[6].get('is-current')), None)
def wanted(monitors):
    for (spec, modes, props) in monitors:
        if spec[0] == name:
            fits = [m for m in modes if m[1] == w and m[2] == h]
            return min(fits, key=lambda m: abs(m[3] - 60)) if fits else None
def apply():
    for i in range(30): # a monitor just connected reaches Mutter with the next screen change
        serial, monitors, logical, props = bus.call_sync(*D, 'GetCurrentState', None, None, 0, 5000, None).unpack()
        mode = wanted(monitors) if w else None
        if mode or not w:
            break
        time.sleep(0.1)
    if w and not mode:
        raise Exception('the desktop has no %d × %d mode for %s' % (w, h, name))
    physical = props.get('layout-mode', 1) == 2
    lms, right, top, scale = [], 0, 0, None
    for (x, y, s, transform, primary, mons, p) in logical:
        specs = [(m[0], current(monitors, m[0])) for m in mons if m[0] != name]
        specs = [(c, m) for (c, m) in specs if m]
        if not specs:
            continue
        cw, ch = specs[0][1][1], specs[0][1][2]
        if transform in (1, 3, 5, 7):
            cw, ch = ch, cw
        right = max(right, x + (cw if physical else int(round(cw / s))))
        if primary or scale is None:
            top, scale = y, s
        lms.append((x, y, s, transform, primary, [(c, m[0], {}) for (c, m) in specs]))
    if w:
        lms.append((right, top, scale or 1.0, 0, False, [(name, mode[0], {})]))
    bus.call_sync(*D, 'ApplyMonitorsConfig', GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})', (serial, 1, lms, {})), None, 0, 10000, None)
try:
    for i in range(5): # the layout changed between reading and applying (Mutter's own hotplug layout): again
        try:
            apply()
            break
        except GLib.Error as e:
            if 'stale' not in e.message or i == 4:
                raise
            time.sleep(0.3)
    print(json.dumps({'ok': True}))
except Exception as e:
    print(json.dumps({'error': str(e).split(': ')[-1]}))
`;

// An X error's own line (BadMatch, BadName…) says more than xrandr's last line (the serial number).
function run(cmd, args, timeout = 10000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
      if (!err) return resolve(String(stdout));
      const lines = String(stderr || err.message).trim().split('\n');
      const e = new Error((lines.find((l) => /^X Error/.test(l)) || lines.pop()).trim());
      e.code = err.code;
      reject(e);
    });
  });
}

const markFile = () => path.join(require('electron').app.getPath('userData'), 'extend-output.json');

// The helper's files are there (and the same as this version's).
function helperReady() {
  try {
    return fs.readFileSync(HELPER, 'utf8') === HELPER_SH && fs.existsSync(POLICY);
  } catch (_) {
    return false;
  }
}

// The kernel's name for an X output (what HELPER takes): the connector with its CONNECTOR_ID,
// else the same name (kernels without connector_id in sysfs).
function connectorName(out) {
  try {
    for (const n of fs.readdirSync('/sys/class/drm')) {
      const m = /^card\d+-(.+)$/.exec(n);
      if (m && out.id && fs.readFileSync('/sys/class/drm/' + n + '/connector_id', 'utf8').trim() === String(out.id)) return m[1];
    }
  } catch (_) { /* no ids */ }
  return out.name;
}

async function waitFor(fn, ms) {
  for (const end = Date.now() + ms; ;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
}

// VESA CVT reduced-blanking timings (what `cvt -r` prints) for an X mode of w × h at 60 Hz.
function cvtRB(w, h) {
  const hDisp = Math.floor(w / 8) * 8;
  const r = hDisp / h;
  const near = (a) => Math.abs(r - a) < 0.02;
  const vSync = near(4 / 3) ? 4 : near(16 / 9) ? 5 : near(16 / 10) ? 6 : near(5 / 4) || near(15 / 9) ? 7 : 10;
  const hPeriod = (1e6 / 60 - 460) / h; // µs, 460 µs minimum vertical blank
  const vTotal = h + Math.max(Math.floor(460 / hPeriod) + 1, 3 + vSync + 6);
  const hTotal = hDisp + 160;
  const clock = Math.floor((60 * hTotal * vTotal) / 1e6 / 0.25) * 0.25;
  return { width: hDisp, args: [clock.toFixed(2), hDisp, hDisp + 48, hDisp + 80, hTotal, h, h + 3, h + 3 + vSync, vTotal, '+hsync', '-vsync'].map(String) };
}

// `xrandr --verbose`: outputs with their state, geometry (physical px), DRM connector id and how
// many CRTCs could drive them (none: the output can't come on at all).
async function outputs() {
  const text = await run('xrandr', ['--verbose']);
  const list = [];
  for (const line of text.split('\n')) {
    const m = /^(\S+) (connected|disconnected)( primary)?(?: (\d+)x(\d+)\+(-?\d+)\+(-?\d+))?/.exec(line);
    if (m) list.push({ name: m[1], connected: m[2] === 'connected', primary: !!m[3], active: !!m[4], width: +m[4] || 0, height: +m[5] || 0, x: +m[6] || 0, y: +m[7] || 0, id: 0, crtcs: 0 });
    const out = list[list.length - 1];
    if (!out) continue;
    const id = /^\s+CONNECTOR_ID:\s*(\d+)/.exec(line);
    if (id) out.id = +id[1];
    const crtcs = /^\s+CRTCs:(.*)$/.exec(line);
    if (crtcs) out.crtcs = crtcs[1].trim().split(/\s+/).filter(Boolean).length;
  }
  return list;
}

const spareOf = (outs) => outs.filter((o) => !o.connected && o.crtcs > 0);
const SWITCHED_OFF = 'something on this computer switched it off again (in a virtual machine, its guest tools do that)';
const modeName = (w, h) => 'TwinDesk_' + cvtRB(w, h).width + 'x' + h;

class Vdd {
  // opts: onChange(), popup?(kind, text)
  constructor(opts) {
    Object.assign(this, opts);
    // setup: X11 with a spare output, HELPER missing (Install); removable: Install put it there
    this.state = { checked: false, installed: false, on: false, busy: '', message: '', kind: '', setup: false, removable: false };
    this.mon = null;
    this.size = [1920, 1080];
    this.proc = null; // the Python process keeping Mutter's virtual monitor (Wayland)
    this.output = ''; // the X output we drive (X11)
    this.connector = ''; // its kernel name, forced connected while on
    this.mode = ''; // its mode name
    this.gnome = false; // X11 under Mutter: outputs go on and off through its DisplayConfig
  }

  view() {
    return { ...this.state };
  }

  _set(p) {
    Object.assign(this.state, p);
    this.onChange();
  }

  // Can this desktop make a virtual monitor? Checked at start (and gives back an output a crash
  // left on), after Install and Remove.
  async check() {
    try {
      if (WAYLAND) {
        const r = JSON.parse(await run('python3', ['-c', CHECK]));
        this._set({ checked: true, kind: 'mutter', installed: !!(r.mutter && r.pipewiresrc),
          message: !r.mutter ? 'Extend on Wayland needs GNOME (its virtual monitors)' : !r.pipewiresrc ? 'Extend needs GStreamer’s PipeWire plugin (gstreamer1.0-pipewire)' : '' });
      } else {
        this.gnome = await run('python3', ['-c', CHECK]).then((t) => JSON.parse(t).displayconfig === true).catch(() => false);
        if (!this.state.on) await this._xLeftover();
        const outs = await outputs();
        for (const o of outs) if (o.active && !o.connected) await run('xrandr', ['--output', o.name, '--off']).catch(() => {}); // older versions' mode on a spare output
        const spare = spareOf(outs).length > 0 || (this.state.on && !!this.output);
        const ready = helperReady();
        const { app } = require('electron');
        this._set({ checked: true, kind: 'xrandr', installed: spare && ready, setup: spare && !ready,
          removable: ready && !(app.isPackaged && !process.env.APPIMAGE), // the .deb's own files stay
          message: spare ? '' : 'Your graphics driver has no spare output for a virtual monitor' });
      }
    } catch (e) {
      this._set({ checked: true, installed: false, message: WAYLAND ? 'Extend needs Python 3 with GObject (python3-gi)' : 'Couldn’t check the monitors: ' + e.message });
    }
  }

  // The size the next virtual monitor gets. Returns true when the one that's on must be made again.
  addMode(width, height) {
    const changed = this.size[0] !== width || this.size[1] !== height;
    this.size = [width, height];
    // Mutter reads an output's modes as it comes on: on GNOME a new size means off and on again.
    return changed && this.state.on && (this.state.kind === 'mutter' || this.gnome);
  }

  // Switch the virtual monitor on/off. Resolves to the monitor (on) or true (off), false on failure.
  // One at a time: Extend switched off and straight back on (a viewer restarting it) must not
  // meet halfway (X11's steps take a second or two).
  setOn(on) {
    this.wanted = on;
    const step = () => this._setOn(on);
    this.queue = (this.queue || Promise.resolve()).then(step, step);
    return this.queue;
  }

  async _setOn(on) {
    if (!this.state.installed) return false;
    try {
      if (on) {
        const mon = this.state.kind === 'mutter' ? await this._mutterOn() : await this._xOn();
        this._set({ on: true, message: '' });
        return mon;
      }
      if (this.state.kind === 'mutter') this._mutterOff();
      else await this._xOff();
      this.mon = null;
      this._set({ on: false });
      return true;
    } catch (e) {
      this.mon = null;
      this._set({ on: false, message: (on ? 'Couldn’t add the virtual monitor: ' : 'Couldn’t remove the virtual monitor: ') + e.message });
      return false;
    }
  }

  _mutterOn() {
    this._mutterOff();
    const [w, h] = this.size;
    return new Promise((resolve, reject) => {
      const p = spawn('python3', ['-c', VIRTUAL, String(w), String(h)], { stdio: ['pipe', 'pipe', 'pipe'] });
      this.proc = p;
      let buf = '';
      let settled = false;
      const timer = setTimeout(() => done(new Error('it took too long')), 20000);
      const done = (err, mon) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) { this._mutterOff(); reject(err); } else resolve(mon);
      };
      p.stdout.setEncoding('utf8');
      p.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let m;
          try { m = JSON.parse(line); } catch (_) { continue; }
          if (m.monitor) {
            const s = m.monitor.scale || 1;
            this.mon = { name: m.monitor.name, x: m.monitor.x, y: m.monitor.y, width: Math.round(w / s), height: Math.round(h / s) };
            done(null, this.mon);
          } else if (m.error) done(new Error(m.error));
        }
      });
      p.stderr.on('data', (d) => console.warn('[vdd]', String(d).trim()));
      p.stdin.on('error', () => {});
      p.on('error', (e) => done(e));
      p.on('exit', () => {
        if (this.proc !== p) return;
        this.proc = null;
        done(new Error('the virtual monitor stopped'));
        if (this.state.on) { this.mon = null; this._set({ on: false, message: 'The virtual monitor went away' }); }
      });
    });
  }

  _mutterOff() {
    const p = this.proc;
    this.proc = null;
    if (p) { p.stdin.end(); setTimeout(() => p.kill(), 3000).unref(); }
  }

  // X11: a spare output given our mode, forced connected and placed right of the others.
  async _xOn() {
    const spare = spareOf(await outputs());
    const out = spare.find((o) => o.name === this.output) || spare[0];
    if (!out) throw new Error('no spare output');
    this.output = out.name;
    const [w, h] = this.size;
    this.mode = await this._xAddMode(w, h); // before it comes on: Mutter reads its modes then
    try {
      await this._force('on', connectorName(out));
      this.connector = connectorName(out); // forced: given back by _xOff, or after a crash (_xLeftover)
      this._mark();
      // `xrandr --verbose` also makes the X server look at the outputs again (and tell Mutter).
      if (!(await waitFor(async () => (await outputs()).some((o) => o.name === this.output && o.connected), 5000))) throw new Error(this.output + ' didn’t come on');
      await this._xPlace(w, h);
      if (!(await waitFor(() => this.find(), 5000))) throw new Error('the desktop didn’t switch ' + this.output + ' on');
      // Something else may switch it straight back off: a virtual machine's guest tools keep its
      // screens as the host shows them (Parallels Tools does, within a second).
      await new Promise((r) => setTimeout(r, 1500));
      const mon = await this.find();
      if (!mon) throw new Error(SWITCHED_OFF);
      return mon;
    } catch (e) {
      await this._xOff().catch(() => {});
      throw e;
    }
  }

  // Our mode of w × h on our output (made if needed). Returns its name.
  async _xAddMode(w, h) {
    const t = cvtRB(w, h);
    const name = modeName(w, h);
    await run('xrandr', ['--newmode', name, ...t.args]).catch((e) => { if (!/already exists|BadName/i.test(e.message)) throw e; });
    await run('xrandr', ['--addmode', this.output, name]).catch(() => {}); // already added
    return name;
  }

  // Our output on in this.mode (w × h), right of the other monitors.
  async _xPlace(w, h) {
    if (this.gnome) return this._layout(cvtRB(w, h).width, h);
    const outs = await outputs();
    const main = outs.find((o) => o.primary && o.active && o.name !== this.output) || outs.find((o) => o.connected && o.active && o.name !== this.output);
    await run('xrandr', ['--output', this.output, '--mode', this.mode, ...(main ? ['--right-of', main.name] : [])]);
  }

  // Our output off, back to the driver's detection (disconnected) and our mode gone.
  async _xOff() {
    if (!this.output) return;
    if (this.gnome) await this._layout(0, 0).catch(() => {});
    else await run('xrandr', ['--output', this.output, '--off']).catch(() => {});
    if (this.connector) await this._force('detect', this.connector);
    if (this.mode) {
      await run('xrandr', ['--delmode', this.output, this.mode]).catch(() => {});
      await run('xrandr', ['--rmmode', this.mode]).catch(() => {});
    }
    this.connector = '';
    this.mode = '';
    try { fs.unlinkSync(markFile()); } catch (_) { /* none */ }
  }

  // An output a crash (or a quit before it was given back) left forced on.
  async _xLeftover() {
    let m;
    try { m = JSON.parse(fs.readFileSync(markFile(), 'utf8')); } catch (_) { return; }
    if (typeof m.output !== 'string' || typeof m.connector !== 'string') return;
    Object.assign(this, { output: m.output, connector: m.connector, mode: typeof m.mode === 'string' ? m.mode : '' });
    await this._xOff().catch((e) => console.warn('[vdd] leftover', m.output, e.message));
  }

  _mark() {
    try { fs.writeFileSync(markFile(), JSON.stringify({ output: this.output, connector: this.connector, mode: this.mode })); } catch (_) { /* best effort */ }
  }

  // HELPER through pkexec: no prompt for the person at the computer (the polkit action).
  async _force(state, connector) {
    try {
      await run('pkexec', [HELPER, state, connector], 60000);
    } catch (e) {
      throw new Error(e.code === 126 ? 'the password prompt was closed' : e.code === 127 ? 'not allowed to switch the output' : e.message);
    }
  }

  // GNOME: our output on at w × h (or off, w 0) through Mutter.
  async _layout(w, h) {
    const out = await run('python3', ['-c', LAYOUT, this.output, String(w), String(h)], 20000);
    const r = JSON.parse(out.trim().split('\n').pop() || '{}');
    if (!r.ok) throw new Error(r.error || 'the desktop didn’t answer');
  }

  // X11: HELPER and its polkit action, once (pkexec asks for the password).
  async install() {
    if (this.state.busy) return;
    this._set({ busy: 'install', message: '' });
    const put = (file, text, mode) => `echo ${Buffer.from(text).toString('base64')} | base64 -d > ${file} && chmod ${mode} ${file}`;
    try {
      await run('pkexec', ['sh', '-c', [`mkdir -p ${path.dirname(HELPER)}`, put(HELPER, HELPER_SH, 755), put(POLICY, POLICY_XML, 644)].join(' && ')], 120000);
    } catch (e) {
      this.state.message = e.code === 126 ? 'The password prompt was closed' : 'Installing the virtual display helper failed: ' + e.message;
    } finally {
      this.state.busy = '';
      await this.check();
    }
  }

  async remove() {
    if (this.state.busy) return;
    this._set({ busy: 'remove', message: '' });
    try {
      if (this.state.on) await this.setOn(false);
      await run('pkexec', ['rm', '-f', HELPER, POLICY], 120000);
    } catch (e) {
      this.state.message = e.code === 126 ? 'The password prompt was closed' : 'Removing the virtual display helper failed: ' + e.message;
    } finally {
      this.state.busy = '';
      await this.check();
    }
  }

  // The virtual monitor on the desktop: {name, x, y, width, height} in the helper's pixels, or null.
  async find() {
    if (this.state.kind === 'mutter') return this.proc ? this.mon : null;
    if (!this.output) return (this.mon = null);
    const o = (await outputs()).find((x) => x.name === this.output && x.active);
    this.mon = o ? { name: o.name, x: o.x, y: o.y, width: o.width, height: o.height } : null;
    if (!o && this.state.on && !this.state.message) this._set({ message: 'Something on this computer switched the extra screen off (in a virtual machine, its guest tools do that)' });
    return this.mon;
  }

  // Once on, set the size (X11 off GNOME; Mutter's monitors are made again at the new size, addMode).
  async setMode(mon, width, height) {
    if (this.state.kind === 'xrandr' && !this.gnome && this.state.on && this.output && this.mode !== modeName(width, height)) {
      const old = this.mode;
      try {
        this.mode = await this._xAddMode(width, height);
        this._mark();
        await this._xPlace(width, height);
        if (old) {
          await run('xrandr', ['--delmode', this.output, old]).catch(() => {});
          await run('xrandr', ['--rmmode', old]).catch(() => {});
        }
      } catch (e) {
        this._set({ message: 'Couldn’t resize the virtual monitor: ' + e.message });
      }
      await waitFor(() => this.find(), 3000);
    }
    return this.find();
  }
}

// What the .deb installs (installer/build.js) and Install writes.
Vdd.FILES = [{ path: HELPER, mode: 0o755, text: HELPER_SH }, { path: POLICY, mode: 0o644, text: POLICY_XML }];

module.exports = Vdd;
