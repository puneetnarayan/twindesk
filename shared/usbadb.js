// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Is a phone with USB debugging on the cable? Asked of the system, without adb: adb (and the
// server it starts) runs only once a phone is linked or plugged in, never just because the app
// is open.
//   macOS   ioreg: a USB interface of class 0xff, subclass 0x42, protocol 1 (adb's)
//   Linux   the same three numbers in /sys/bus/usb/devices/*/
//   Windows a present device on a driver adb uses (WinUSB, Samsung's), from the registry
// present() -> Promise<boolean>; cheap enough to ask every couple of seconds.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const run = (file, args) => new Promise((resolve) => {
  execFile(file, args, { timeout: 4000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, out) => resolve(err ? '' : String(out || '')));
});

async function mac() {
  const out = await run('/usr/sbin/ioreg', ['-r', '-c', 'IOUSBHostInterface', '-l', '-w0']);
  // One block per interface: its properties follow its "+-o" line.
  return out.split('+-o ').some((b) => /"bInterfaceClass" = 255\b/.test(b) && /"bInterfaceSubClass" = 66\b/.test(b) && /"bInterfaceProtocol" = 1\b/.test(b));
}

function linux() {
  const root = '/sys/bus/usb/devices';
  const read = (d, f) => {
    try {
      return fs.readFileSync(path.join(root, d, f), 'utf8').trim();
    } catch {
      return '';
    }
  };
  let dirs = [];
  try {
    dirs = fs.readdirSync(root).filter((d) => d.includes(':'));
  } catch {}
  return dirs.some((d) => read(d, 'bInterfaceClass') === 'ff' && read(d, 'bInterfaceSubClass') === '42' && read(d, 'bInterfaceProtocol') === '01');
}

async function windows() {
  // A driver's Enum key lists the devices it runs for now (Count > 0 while one is plugged in).
  for (const svc of ['WinUSB', 'ssudadb', 'AndroidUsbDeviceClass']) {
    const out = await run('reg', ['query', `HKLM\\SYSTEM\\CurrentControlSet\\Services\\${svc}\\Enum`, '/v', 'Count']);
    const m = /Count\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out);
    if (m && parseInt(m[1], 16) > 0) return true;
  }
  return false;
}

function present() {
  if (process.platform === 'darwin') return mac();
  if (process.platform === 'linux') return Promise.resolve(linux());
  if (process.platform === 'win32') return windows();
  return Promise.resolve(false);
}

module.exports = { present };
