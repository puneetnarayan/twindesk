// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// This computer's apps for Apps (pcapps.js): the desktop entries (*.desktop) the app menu shows,
// from $XDG_DATA_HOME and $XDG_DATA_DIRS (flatpak and snap exports included), their icons from
// the icon themes (PNG as is, SVG drawn to a PNG in a hidden window), and launching one with its
// Exec line (field codes dropped), so the new process and its windows can be told apart.
'use strict';

const { BrowserWindow, nativeImage } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const dataDirs = () => [
  process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'),
  ...(process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':'),
  '/var/lib/flatpak/exports/share', path.join(HOME, '.local/share/flatpak/exports/share'), '/var/lib/snapd/desktop',
].filter((d, i, a) => d && a.indexOf(d) === i);

// One [Desktop Entry] group as {key: value} (unlocalized keys, plus Name[<lang>]).
function parse(text) {
  const out = {};
  let inMain = false;
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (l.startsWith('[')) { inMain = l === '[Desktop Entry]'; continue; }
    if (!inMain || !l || l.startsWith('#')) continue;
    const i = l.indexOf('=');
    if (i > 0) out[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return out;
}

const lang = String(process.env.LANG || '').split(/[.@]/)[0]; // "de_DE"

// [{id, name, exec, icon, wmClass, file}], sorted by name. id = the desktop file id ("org.gnome.Calculator.desktop").
function list() {
  const seen = new Set();
  const apps = [];
  const desktop = String(process.env.XDG_CURRENT_DESKTOP || '').split(':').filter(Boolean);
  for (const base of dataDirs()) {
    const dir = path.join(base, 'applications');
    let files = [];
    const walk = (d, prefix) => {
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
      for (const e of ents) {
        if (e.isDirectory()) walk(path.join(d, e.name), prefix + e.name + '-');
        else if (e.name.endsWith('.desktop')) files.push({ file: path.join(d, e.name), id: prefix + e.name });
      }
    };
    walk(dir, '');
    for (const { file, id } of files) {
      if (seen.has(id)) continue; // the first data dir wins (a user's override hides the system one)
      seen.add(id);
      let e;
      try { e = parse(fs.readFileSync(file, 'utf8')); } catch (_) { continue; }
      if (e.Type !== 'Application' || e.NoDisplay === 'true' || e.Hidden === 'true' || !e.Exec) continue;
      if (e.OnlyShowIn && desktop.length && !e.OnlyShowIn.split(';').some((x) => desktop.includes(x))) continue;
      if (e.NotShowIn && e.NotShowIn.split(';').some((x) => desktop.includes(x))) continue;
      if (e.Terminal === 'true') continue; // no window of its own to show
      const name = e['Name[' + lang + ']'] || e['Name[' + lang.split('_')[0] + ']'] || e.Name || id;
      apps.push({ id, name, exec: e.Exec, icon: e.Icon || '', wmClass: e.StartupWMClass || '', file });
    }
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name));
}

// Exec line → argv (quoting per the Desktop Entry spec; %f %u %F %U %i %c %k dropped, %% kept).
function argv(exec, entry) {
  const args = [];
  let cur = '', q = false, any = false;
  for (let i = 0; i < exec.length; i++) {
    const c = exec[i];
    if (q) {
      if (c === '\\' && i + 1 < exec.length) cur += exec[++i];
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') { q = true; any = true; }
    else if (/\s/.test(c)) { if (cur || any) args.push(cur); cur = ''; any = false; }
    else cur += c;
  }
  if (cur || any) args.push(cur);
  const out = [];
  for (const a of args) {
    if (/^%[fFuUdDnNvm]$/.test(a)) continue;
    if (a === '%i') { if (entry.icon) out.push('--icon', entry.icon); continue; }
    if (a === '%c') { out.push(entry.name); continue; }
    if (a === '%k') { out.push(entry.file); continue; }
    out.push(a.replace(/%%/g, '%'));
  }
  return out;
}

// Starts the app; returns {pid, exe}: exe = the command's base name ("gnome-calculator").
function launch(entry) {
  const a = argv(entry.exec, entry);
  if (!a.length) throw new Error('No command to run');
  const p = spawn(a[0], a.slice(1), { detached: true, stdio: 'ignore', cwd: HOME });
  p.on('error', () => {});
  p.unref();
  // flatpak/snap/env wrappers: the real program is further along.
  let exe = path.basename(a[0]);
  if (exe === 'env') exe = path.basename(a.find((x, i) => i > 0 && !x.includes('=') && !x.startsWith('-')) || exe);
  if (exe === 'flatpak') exe = String(a[a.length - 1] || '').split('.').pop().toLowerCase();
  return { pid: p.pid, exe };
}

// ---- icons ----

const SIZES = ['256x256', '128x128', '96x96', '64x64', '48x48', 'scalable', '512x512', '32x32'];

function themeDirs() {
  const t = [];
  for (const base of [path.join(HOME, '.icons'), ...dataDirs().map((d) => path.join(d, 'icons'))]) {
    let themes = [];
    try { themes = fs.readdirSync(base); } catch (_) { continue; }
    // hicolor first (every app installs there), then the others.
    themes.sort((a, b) => (b === 'hicolor') - (a === 'hicolor'));
    for (const th of themes) t.push(path.join(base, th));
  }
  return t;
}

// The icon file for an Icon= value: an absolute path, else the best size in a theme, else pixmaps.
function iconFile(icon) {
  if (!icon) return '';
  if (path.isAbsolute(icon)) return fs.existsSync(icon) ? icon : '';
  for (const th of themeDirs()) {
    for (const size of SIZES) {
      for (const cat of ['apps', 'applications']) {
        for (const ext of ['.png', '.svg']) {
          const f = path.join(th, size, cat, icon + ext);
          if (fs.existsSync(f)) return f;
        }
      }
    }
  }
  for (const ext of ['.png', '.svg', '.xpm']) {
    const f = path.join('/usr/share/pixmaps', icon + ext);
    if (fs.existsSync(f)) return f;
  }
  return '';
}

let drawer = null; // hidden window that draws SVGs

async function svgToPng(file, px) {
  if (!drawer || drawer.isDestroyed()) {
    drawer = new BrowserWindow({ show: false, width: 64, height: 64, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await drawer.loadURL('data:text/html,<canvas></canvas>');
  }
  const svg = fs.readFileSync(file, 'utf8');
  const url = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  return drawer.webContents.executeJavaScript(`new Promise((ok) => {
    const img = new Image();
    img.onload = () => { const c = document.querySelector('canvas'); c.width = c.height = ${px};
      const g = c.getContext('2d'); g.clearRect(0, 0, ${px}, ${px}); g.drawImage(img, 0, 0, ${px}, ${px}); ok(c.toDataURL('image/png')); };
    img.onerror = () => ok('');
    img.src = ${JSON.stringify(url)};
  })`);
}

// data:image/png;base64,… at px × px, or '' when there's none.
async function icon(entry, px) {
  const f = iconFile(entry.icon);
  if (!f) return '';
  try {
    if (f.endsWith('.svg')) return await svgToPng(f, px);
    const img = nativeImage.createFromPath(f);
    return img.isEmpty() ? '' : img.resize({ width: px, height: px, quality: 'best' }).toDataURL();
  } catch (_) {
    return '';
  }
}

function shutdown() {
  if (drawer && !drawer.isDestroyed()) drawer.destroy();
  drawer = null;
}

module.exports = { list, launch, icon, argv, shutdown };
