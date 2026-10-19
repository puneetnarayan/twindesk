// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Keys from a PC viewer window, taken in main via before-input-event: no renderer
// hop, and ⌘Q / ⌘W / ⌘H go to the PC instead of acting on TwinDesk.
'use strict';

const P = require('../shared/protocol.js');

const T = P.T;
const MODIFIERS = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'CapsLock']);

// send(msg) sends one in.kd / in.ku; enabled() says whether keys go out now; local(input) may
// handle a shortcut here and return true. Returns { release() } for blur / end.
function attachKeys(win, { send, enabled, local }) {
  const held = new Set();
  const up = (code) => {
    held.delete(code);
    send({ t: T.IN_KEY_UP, code });
  };
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' && input.type !== 'keyUp') return;
    e.preventDefault();
    if (local && local(input)) return;
    if (!input.code || !enabled()) return;
    if (input.type === 'keyDown') {
      held.add(input.code);
      send({ t: T.IN_KEY_DOWN, code: input.code });
    } else {
      up(input.code);
      // macOS sends no key-up for keys released while Command is down: let them go with Command.
      if (input.code === 'MetaLeft' || input.code === 'MetaRight') for (const c of [...held]) if (!MODIFIERS.has(c)) up(c);
    }
  });
  return { release: () => { for (const c of [...held]) up(c); } };
}

module.exports = { attachKeys };
