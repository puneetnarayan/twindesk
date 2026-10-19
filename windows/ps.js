// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Run PowerShell scripts: normally, or elevated (one UAC prompt, waits for it to finish). Each
// script goes in a .ps1 file in temp, run with -File, so nothing needs quoting. Not as an encoded command:
// base64 PowerShell is what droppers use, and antivirus heuristics flag the app for it.
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'"; // PowerShell single-quoted literal

// UTF-8 with a BOM: Windows PowerShell 5.1 reads a .ps1 without one as the ANSI code page.
function scriptFile(script) {
  const file = path.join(os.tmpdir(), 'twindesk-' + crypto.randomBytes(6).toString('hex') + '.ps1');
  fs.writeFileSync(file, '\ufeff' + script, 'utf8');
  return file;
}
const drop = (file) => fs.unlink(file, () => {});

// Started from a PowerShell 7 terminal, PSModulePath lists PowerShell 7's modules first and
// Windows PowerShell 5.1 then loads the wrong PKI/NetSecurity modules. Without it, 5.1 uses its own.
const env = { ...process.env };
delete env.PSModulePath;

function run(script, timeoutMs = 60000) {
  const file = scriptFile(script);
  return new Promise((resolve, reject) => {
    execFile(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env },
      (err, stdout, stderr) => {
        drop(file);
        if (err) reject(new Error(String(stderr || err.message).trim().split('\n')[0]));
        else resolve(String(stdout));
      });
  });
}

// Elevated: throws if the UAC prompt is declined. The script's errors can't be read back
// directly, so callers re-check the state afterwards.
async function runElevated(script, timeoutMs = 120000) {
  const file = scriptFile(script);
  try {
    return await run('Start-Process -FilePath ' + q(PS) + ' -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList ' +
      q("-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + file + '"'), timeoutMs);
  } finally {
    drop(file);
  }
}

module.exports = { run, runElevated, q, PS };
