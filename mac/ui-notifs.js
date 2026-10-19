// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Notifications tab: this Mac's notifications on the other computer, and theirs here
// as native notifications. Sending needs Full Disk Access (there is no API for it on macOS).
'use strict';

UI.tab({
  id: 'notifications',
  group: 'Share',
  order: 45,
  title: 'Notifications',
  icon: 'bell',
  desc: 'See one computer’s notifications on the other.',
  color: 'linear-gradient(#ff6961, #ff3b30)',
  // One switch for the whole tab (both directions); each direction is shared with the
  // other computer per pair (pairsync.js), so flipping it there flips it here.
  master: { get: (s) => !!(s.notifs && (s.notifs.send || s.notifs.receive)), set: (v) => UI.api.setNotifs({ send: v, receive: v }) },
  badge: (s) => (s.notifs && (s.notifs.send || s.notifs.receive) ? 'on' : ''),
  build(body) {
    const { el, api } = UI;
    const sendSw = UI.switch((v) => api.setNotifs({ send: v }), { label: 'Send notifications' });
    const sendRow = UI.row('Show {me}’s notifications on {name}', '', [sendSw]);
    const hideSw = UI.switch((v) => api.setNotifs({ hideText: v }), { label: 'Hide message text' });
    const hideRow = UI.row('Hide message text', 'Only the app and the title', [hideSw]);
    const fdaBtn = UI.button('Allow', () => api.allowFullDisk(), 'small primary');
    const fdaRow = UI.row('Allow Full Disk Access', 'Click +, or drag TwinDesk into the list', [fdaBtn]);
    const recvSw = UI.switch((v) => api.setNotifs({ receive: v }), { label: 'Show notifications here' });
    const recvRow = UI.row('Show {name}’s notifications on {me}', '', [recvSw]);
    const apps = el('div');

    body.append(
      UI.pair(UI.dir('m2w', [sendRow, fdaRow, hideRow]), UI.dir('w2m', [recvRow])),
      UI.card('Apps', [apps]),
    );

    let key = '';
    return (s) => {
      const n = s.notifs;
      if (!n) return;
      const p = UI.peer(s);
      sendSw.set(n.send);
      hideSw.set(n.hideText);
      recvSw.set(n.receive);
      fdaRow.hidden = n.access !== 'noAccess';
      sendRow.setHint(!n.send ? '' : n.access === 'noAccess' ? 'Needs Full Disk Access'
        : !s.client ? 'Also switches it on the other computer' : n.sent ? `${n.sent} sent` : 'As native notifications there');
      recvRow.setHint(n.receive && n.shown ? `${n.shown} shown` : 'As native notifications, from TwinDesk');
      void p;

      const k = JSON.stringify([n.apps.map((a) => a.app), n.muted]);
      if (k === key) return;
      key = k;
      apps.replaceChildren(...(n.apps.length
        ? n.apps.map((a) => {
          const sw = UI.switch((v) => api.muteNotifApp({ app: a.app, muted: !v }), { label: `Send ${a.appName}` });
          sw.set(!(n.muted || []).includes(a.app));
          return UI.row(a.appName, '', [sw]);
        })
        : [UI.row('No notifications yet', 'Apps show up here after their first notification')]));
    };
  },
});
