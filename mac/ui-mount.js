// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Mount tab: the phone's storage as a drive in Finder (phonedrive.js). Off, TwinDesk doesn't look
// for the phone or touch its files at all; on, only Mount does, and only while it's mounted.
'use strict';

UI.tab({
  id: 'mount',
  group: 'Share',
  order: 55,
  title: 'Mount',
  desc: 'The phone’s storage as a drive in Finder, through the cable or wireless debugging.',
  color: 'linear-gradient(#ffd60a, #ff9f0a)',
  badge: (s) => (s.mount && s.mount.mounted ? 'on' : ''),
  build(body) {
    const { api } = UI;
    const onSw = UI.switch((v) => api.setMount({ on: v }), { label: 'Phone in Finder' });
    const onRow = UI.row('Phone in Finder', 'Off: TwinDesk never looks at the phone’s files', [onSw]);
    const mountBtn = UI.button('Mount', () => api.phoneMount(), 'small primary');
    const showBtn = UI.button('Show', () => api.phoneMount(), 'small');
    const unmountBtn = UI.button('Unmount', () => api.phoneUnmount(), 'small');
    const driveRow = UI.row('Show the phone in Finder', '', [mountBtn, showBtn, unmountBtn]);
    body.append(UI.card('Finder', [onRow, driveRow]));

    return (s) => {
      const d = s.mount || {};
      onSw.set(!!d.on);
      driveRow.hidden = !d.on;
      mountBtn.hidden = !!d.mounted;
      mountBtn.textContent = d.busy === 'mounting' ? 'Mounting…' : 'Mount';
      mountBtn.disabled = !!d.busy;
      showBtn.hidden = unmountBtn.hidden = !d.mounted;
      unmountBtn.disabled = !!d.busy;
      driveRow.setHint(d.message || (d.mounted ? `In Finder under Locations (${d.via === 'usb' ? 'through the cable' : 'over wireless debugging'}).`
        : 'Plug the phone in with USB debugging on, or connect it with wireless debugging, then Mount.'));
    };
  },
});
