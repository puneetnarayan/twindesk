// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Fetches adb for Linux (Android platform-tools, x86-64) into a folder, linux/vendor/adb by
// default. installer/build.js runs it for the packages; run it once (`npm run fetch-adb`) for a
// dev copy that has no adb installed. Port of windows/scripts/fetch-adb.js; unpacks the zip with
// unzip, or Python's zipfile when unzip isn't there.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const ZIP_URL = 'https://dl.google.com/android/repository/platform-tools-latest-linux.zip';
const FILES = ['adb'];

function download(url, to, hops = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops > 0) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).href, to, hops - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('Download failed: HTTP ' + res.statusCode + ' for ' + url));
      }
      const out = fs.createWriteStream(to);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    }).on('error', reject);
  });
}

function unpack(zip, dir) {
  try {
    execFileSync('unzip', ['-q', '-o', zip, '-d', dir], { stdio: 'inherit' });
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    execFileSync('python3', ['-I', '-m', 'zipfile', '-e', zip, dir], { stdio: 'inherit' });
  }
}

async function fetchAdb(dest = path.join(__dirname, '..', 'vendor', 'adb')) {
  if (FILES.every((f) => fs.existsSync(path.join(dest, f)))) return dest;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-adb-'));
  try {
    const zip = path.join(tmp, 'platform-tools.zip');
    console.log('Downloading adb (Android platform-tools)…');
    await download(ZIP_URL, zip);
    unpack(zip, tmp);
    fs.mkdirSync(dest, { recursive: true });
    for (const f of FILES) {
      fs.copyFileSync(path.join(tmp, 'platform-tools', f), path.join(dest, f));
      fs.chmodSync(path.join(dest, f), 0o755); // Python's zipfile drops the mode
    }
    for (const f of ['NOTICE.txt', 'source.properties']) {
      const from = path.join(tmp, 'platform-tools', f);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dest, f));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return dest;
}

module.exports = { fetchAdb };

if (require.main === module) {
  fetchAdb(process.argv[2]).then((d) => console.log('adb is in ' + d), (e) => { console.error(e.message); process.exit(1); });
}
