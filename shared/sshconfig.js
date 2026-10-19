// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The `Host twindesk` entry in ~/.ssh/config, so `ssh twindesk` opens a shell on the paired
// computer on every OS. Only our marked block is touched; the rest of the file stays byte for byte,
// and a one-time backup is kept. Blocks written by older versions (`macshare-pc`) are removed too.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ALIAS = 'twindesk';
const SSH_DIR = path.join(os.homedir(), '.ssh');
const CONFIG = path.join(SSH_DIR, 'config');
const BEGIN = '# >>> twindesk (managed by TwinDesk, do not edit)';
const END = '# <<< twindesk';
const OLD = [['# >>> macshare', '# <<< macshare']];

// A value for the config file, quoted when it has spaces (Windows paths often do).
const quote = (v) => (/[\s"]/.test(v) ? `"${String(v).replace(/"/g, '')}"` : String(v));

function strip(text, begin, end) {
  const start = text.indexOf(begin);
  const stop = start < 0 ? -1 : text.indexOf(end, start);
  if (start < 0 || stop < 0) return text;
  let a = start;
  if (text[a - 1] === '\n' && text[a - 2] === '\n') a--; // the blank line we added before it
  let b = stop + end.length;
  if (text[b] === '\r') b++;
  if (text[b] === '\n') b++;
  return text.slice(0, a) + text.slice(b);
}

// host: {address, port, user, identityFile, knownHostsFile}, or null to remove the entry.
function setHost(host) {
  let text = '';
  try {
    text = fs.readFileSync(CONFIG, 'utf8');
  } catch { /* no config yet */ }
  const before = text;
  for (const [b, e] of [[BEGIN, END], ...OLD]) text = strip(text, b, e);
  if (host) {
    const lines = [
      `Host ${ALIAS}`,
      `  HostName ${host.address}`,
      `  Port ${Number(host.port) || 22}`,
      `  User ${quote(host.user)}`,
      `  IdentityFile ${quote(host.identityFile)}`,
      '  IdentitiesOnly yes',
      `  HostKeyAlias ${ALIAS}`,
      `  UserKnownHostsFile ${quote(host.knownHostsFile)}`,
      '  StrictHostKeyChecking yes',
    ];
    text = `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}${BEGIN}\n${lines.join('\n')}\n${END}\n`;
  }
  if (text === before) return;
  fs.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
  const backup = `${CONFIG}.before-twindesk`;
  if (fs.existsSync(CONFIG) && !fs.existsSync(backup) && !fs.existsSync(`${CONFIG}.before-macshare`)) fs.copyFileSync(CONFIG, backup);
  const mode = fs.existsSync(CONFIG) ? fs.statSync(CONFIG).mode & 0o777 : 0o600;
  fs.writeFileSync(CONFIG, text, { mode });
}

// Pinned host keys for the alias, one per line.
function knownHosts(keys) {
  return keys.map((k) => `${ALIAS} ${k}`).join('\n') + '\n';
}

module.exports = { ALIAS, setHost, knownHosts };
