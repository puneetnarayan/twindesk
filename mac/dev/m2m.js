// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Dev check for Mac ↔ Mac: two copies on one Mac, each with its own profile and port.
//   MACSHARE_PROFILE=/tmp/a MACSHARE_DEV_PORT=47810 MACSHARE_DEV_TEST=host  npm start
//   MACSHARE_PROFILE=/tmp/b MACSHARE_DEV_PORT=47820 MACSHARE_DEV_TEST=guest:127.0.0.1:47810 npm start
// They pair by themselves (code accepted on both), cursor sharing stays off. Then: the guest views the
// host's screen (Mirror), the host views the guest's, and the guest opens Calculator from the host
// as an app window. Results are printed as `[m2m] …` lines; each copy quits after ~60 s.
'use strict';

module.exports = function m2m({ role, svc, actions, link, pairing, peer }) {
  const log = (...a) => console.log(`[m2m ${role}]`, ...a);
  const later = (s, fn) => setTimeout(fn, s * 1000);
  actions.setKvm({ linked: false }); // never take the real mouse
  actions.setDisplayMode('mirror'); // no virtual display for a test
  actions.setApps({ offer: true });
  actions.setPcApps({ on: true });

  if (role === 'host') {
    pairing.on('change', () => {
      const p = pairing.pendingView();
      if (p && p.code && !p.allowed) {
        log('pair request, code', p.code, '→ Allow');
        pairing.respond(true);
      }
    });
  } else {
    const [address, port] = role.split(':').slice(1);
    link.on('change', () => {
      const ps = link.view().pairing;
      if (ps && ps.phase === 'code') {
        log('code', ps.code, '→ confirm');
        link.confirmCode();
      }
    });
    link.startPairing({ address, port: Number(port), name: 'host copy' });
  }

  peer.once('client', (ctx) => {
    log('session with', ctx.name, ctx.os, ctx.role === 'host' ? '(we are its guest)' : '(it is our guest)');
    actions.setSharing(true); // both share; each starts sending only when the other's viewer opens
    const first = role !== 'host';
    later(first ? 3 : 20, () => {
      log('opening the other screen');
      actions.showPcView();
    });
    later(first ? 15 : 32, () => {
      const v = svc.pcView.view;
      log('viewer:', v.status, v.stats ? `${v.stats.width}x${v.stats.height} ${v.stats.fps} fps ${v.stats.mbps} Mbps ${v.stats.codec}` : 'no stats');
      log('my sender:', svc.stream.view.status, `${svc.stream.view.fps} fps`);
      actions.closePcView();
    });
    if (first) {
      later(18, () => svc.pcApps.list());
      later(24, () => {
        const apps = svc.pcApps.view.apps || [];
        log('apps listed:', apps.length);
        const calc = apps.find((a) => a.id === 'com.apple.calculator');
        if (calc) svc.pcApps.open(calc.id);
      });
      later(36, () => {
        const w = svc.pcApps.view.windows;
        log('app windows here:', JSON.stringify(w));
      });
    } else {
      later(36, () => log('appsend:', JSON.stringify(svc.appSend.view)));
    }
    later(50, () => {
      log('done');
      require('electron').app.quit();
    });
  });
  later(90, () => require('electron').app.exit(2)); // never hang
};
