// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// This computer's host identity: a self-signed TLS certificate made once with `openssl`
// (present on every desktop Linux) in userData/identity/{key,cert}.pem, and its fingerprint.
// The key file is readable by this user only.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { app } = require('electron');
const P = require('../shared/protocol.js');

const dir = () => path.join(app.getPath('userData'), 'identity');

function make(keyFile, certFile) {
  fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  return new Promise((resolve, reject) => {
    execFile('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650',
      '-subj', '/CN=MacShare', '-keyout', keyFile, '-out', certFile], { timeout: 60000 }, (err, _out, stderr) => {
      if (err) {
        try { fs.rmSync(keyFile, { force: true }); fs.rmSync(certFile, { force: true }); } catch (_) { /* a half-written pair */ }
        return reject(new Error(err.code === 'ENOENT' ? 'openssl is not installed' : err.killed ? 'openssl took too long'
          : String(stderr || err.message).trim().split('\n').filter((l) => !/^[.+*]*$/.test(l)).pop() || err.message)); // not its progress dots
      }
      try { fs.chmodSync(keyFile, 0o600); } catch (_) { /* best effort */ }
      resolve();
    });
  });
}

// Returns {key, cert, fp}; makes the certificate the first time.
async function load() {
  const keyFile = path.join(dir(), 'key.pem');
  const certFile = path.join(dir(), 'cert.pem');
  if (!fs.existsSync(keyFile) || !fs.existsSync(certFile)) await make(keyFile, certFile);
  const key = fs.readFileSync(keyFile);
  const cert = fs.readFileSync(certFile);
  const fp = P.normFingerprint(new crypto.X509Certificate(cert).fingerprint256);
  return { key, cert, fp };
}

module.exports = { load };
