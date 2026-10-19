// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Keyboard tab: keyboard sharing switch, the hotkey (double-tap = mouse and keyboard back here),
// keyboard-only switching with the hotkey, Ctrl <-> Cmd mapping (only between a Mac and a PC).
'use strict';

UI.tab({
  id: 'keyboard',
  group: 'Input',
  order: 30,
  title: 'Keyboard',
  desc: 'Type on whichever computer the pointer is on.',
  color: 'linear-gradient(#d1d1d6, #8e8e93)',
  master: { get: (s) => s.kvm && s.kvm.keyboard, set: (v) => UI.api.setKvm({ keyboard: v }) },
  badge: (s) => (s.kvm && s.kvm.keyboard ? 'on' : ''),
  build(body) {
    const { el, api } = UI;
    const status = UI.note('info', '');
    const hotkey = UI.select(Object.entries(UI.HOTKEYS).map(([value, label]) => ({ value, label })), (v) => api.setKeys({ hotkey: v }));
    const hotkeyRow = UI.row('Hotkey', 'Double-tap to turn cursor sharing on or off', [hotkey]);
    const switchSw = UI.switch((v) => api.setKvm({ hotkeySwitch: v }), { label: 'Switch the keyboard with the hotkey' });
    const switchRow = UI.row('Switch the keyboard with the hotkey', '', [switchSw]);
    const swap = UI.switch((v) => api.setKeys({ swapCtrlCmd: v }), { label: 'Swap Ctrl and Command' });
    const shortcutsRow = UI.row('Shortcuts on {name}', '⌘ works as Ctrl, so ⌘C copies there');
    const swapRow = UI.row('Ctrl works as ⌘', 'So Ctrl+C copies here', [swap]);
    const otherHotkey = UI.row('Hotkey on {name}', '');

    body.append(
      status,
      UI.card('Hotkey', [hotkeyRow, switchRow], { cls: 'keep-on' }),
      UI.pair(UI.dir('m2w', [shortcutsRow]), UI.dir('w2m', [otherHotkey, swapRow])),
    );

    return (s) => {
      if (!s.kvm) return;
      const p = UI.peer(s);
      const [kind, text] = UI.kvmStatus(s);
      status.className = `note ${kind}`;
      status.set(text);
      hotkey.set((s.keys && s.keys.hotkey) || 'AltRight');
      // Keyboard-only switching exists only while the pointer isn't shared (Cursor off).
      switchSw.set(s.kvm.hotkeySwitch);
      switchSw.disable(!!s.kvm.mouse);
      switchRow.setHint(s.kvm.mouse ? 'Only when Cursor is off' : `Double-tap to type on ${p.name} and back`);
      // Ctrl/Cmd swapping only between a Mac and a PC or Linux.
      shortcutsRow.hidden = p.same;
      swapRow.hidden = p.same;
      swap.set(s.keys && s.keys.swapCtrlCmd);
      otherHotkey.setHint(`Set in TwinDesk on ${p.name}`);
    };
  },
});
