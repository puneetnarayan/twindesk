// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Notifications tab: the other computer's notifications here as Windows
// toasts from TwinDesk, and this PC's on the other computer (read from Windows' notification
// database by the helper). Two direction cards, then the apps seen sending.
'use strict';

UI.tab({
  id: 'notifications',
  order: 45,
  title: 'Notifications',
  icon: 'bell',
  color: 'linear-gradient(#ff6961, #ff3b30)',
  desc: 'See one computer’s notifications on the other.',
  // One switch for the whole tab (both directions); each direction is shared with the
  // other computer per pair (pair.sync), so flipping it there flips it here.
  master: { get: (s) => s.notifs.send || s.notifs.receive, set: (v) => UI.api.setNotifs({ send: v, receive: v }) },
  badge: (s) => (s.notifs.send || s.notifs.receive ? 'on' : ''),
  build(body) {
    const { el, api } = UI;
    const hideSw = UI.switch((v) => api.setNotifs({ hideText: v }), { label: 'Hide message text' });
    const hideRow = UI.row('Hide message text', 'Only the app and the title', [hideSw]);
    const note = UI.note('info', '');
    const pair = UI.dirCards(
      { on: { get: (s) => s.notifs.receive, set: (v) => api.setNotifs({ receive: v }) }, label: 'Show {name}’s notifications on {me}', rows: [] },
      { on: { get: (s) => s.notifs.send, set: (v) => api.setNotifs({ send: v }) }, label: 'Show {me}’s notifications on {name}', rows: [hideRow] },
    );
    const recvRow = pair.a.main, sendRow = pair.b.main;
    const apps = el('div');

    body.append(note, pair.el, UI.card('Apps', [apps]));

    let key = '';
    return (s) => {
      const n = s.notifs;
      const p = UI.peer(s);
      const connected = s.link.state === 'connected';
      pair.update(s);
      note.set('');
      hideSw.set(n.hideText);
      recvRow.setHint(n.receive && n.shown ? n.shown + ' shown' : 'As desktop notifications, from TwinDesk');
      sendRow.setHint(n.readable === false ? 'Can’t read this desktop’s notifications (dbus-monitor missing)'
        : !n.send ? '' : !connected ? 'Also switches it on the other computer' : n.sent ? n.sent + ' sent' : 'As native notifications there');

      const k = JSON.stringify([n.apps.map((a) => a.app), n.muted]);
      if (k === key) return;
      key = k;
      apps.replaceChildren(...(n.apps.length
        ? n.apps.map((a) => {
          const sw = UI.switch((v) => api.muteNotifApp({ app: a.app, muted: !v }), { label: 'Send ' + a.appName });
          sw.set(!n.muted.includes(a.app));
          return UI.row(a.appName, '', [sw]);
        })
        : [UI.row('No notifications yet', 'Apps show up here after their first notification while sending is on')]));
    };
  },
});
