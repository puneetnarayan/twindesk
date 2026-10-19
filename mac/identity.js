// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Mac's identity: macId/macName in settings.json, a self-signed TLS cert and its fingerprint.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const P = require('../shared/protocol.js');
const store = require('./store');

function ensureCert() {
  const dir = store.filePath('identity');
  const key = store.filePath('identity/key.pem');
  const cert = store.filePath('identity/cert.pem');
  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync(
      '/usr/bin/openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
        '-days', '3650', '-subj', '/CN=MacShare'],
      { stdio: 'ignore' },
    );
    fs.chmodSync(key, 0o600);
  }
  return { keyPem: fs.readFileSync(key, 'utf8'), certPem: fs.readFileSync(cert, 'utf8') };
}

// Returns {macId, macName, keyPem, certPem, fp}. Persists a new macId in settings if needed.
function load(settings) {
  if (!settings.macId) {
    settings.macId = crypto.randomUUID();
    store.saveSettings(settings);
  }
  // MACSHARE_DEV_NAME: dev only, tells two copies on one Mac apart.
  const macName = process.env.MACSHARE_DEV_NAME || os.hostname().replace(/\.local$/i, '');
  const { keyPem, certPem } = ensureCert();
  const fp = P.normFingerprint(new crypto.X509Certificate(certPem).fingerprint256);
  return { macId: settings.macId, macName, keyPem, certPem, fp };
}

module.exports = { load };
