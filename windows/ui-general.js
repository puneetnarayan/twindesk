// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// General tab: start with Windows, the switching popup, firewall self-check (+ Fix), wake from the
// network, helper, the virtual display driver (Extend), this PC.
'use strict';

UI.tab({
  id: 'general',
  order: 100,
  title: 'General',
  color: 'linear-gradient(#aeaeb2, #636366)',
  desc: '',
  bottom: true,
  badge: (s) => (s.firewall && s.firewall.ok === false && !s.firewall.checking ? 'warn' : ''),
  build(body) {
    const { el, api } = UI;
    const startup = UI.switch((v) => api.setStartup(v), { label: 'Start with Windows' });
    const hudSw = UI.switch((v) => api.setApp({ hud: v }), { label: 'Show a popup when switching' });
    const fwPill = el('span', { class: 'pill' });
    const fwCheck = UI.button('Check again', () => api.checkFirewall(), 'small');
    const fwFix = UI.button('Fix', () => api.fixFirewall(), 'small primary');
    const fwRow = UI.row('Firewall', '', [fwPill, fwCheck, fwFix]);
    // (as the Mac): wake is a switch; Send to sends files from Explorer.
    const wakeSw = UI.switch((v) => api.setWake(v), { label: 'Wake from the network' });
    const wakeRow = UI.row('Let the other computer wake {me}', '', [wakeSw]);
    const sendToRow = UI.row('TwinDesk in Send to', '');
    const helperPill = el('span', { class: 'pill' });
    const helperRow = UI.row('Mouse and keyboard helper', '', [helperPill]);
    const vddPill = el('span', { class: 'pill' });
    const vddInstall = UI.button('Install', () => api.installVdd(), 'small primary');
    const vddRow = UI.row('Virtual display driver', '', [vddPill, vddInstall]); // Share screen › Extend (vdd.js)
    const deviceName = el('span', { class: 'value' });
    const deviceRow = UI.row('Computer name', 'How other computers see this one', [deviceName]);

    body.append(
      UI.card('App', [
        UI.row('Start with Windows', '', [startup]),
        UI.row('Show a popup when switching', 'When the mouse and keyboard move between computers', [hudSw]),
      ]),
      UI.card('Network and sharing', [fwRow, wakeRow, sendToRow]),
      UI.card('This computer', [deviceRow, helperRow, vddRow]),
    );

    return (s) => {
      startup.set(s.startup);
      hudSw.set(s.app.hud);
      const fw = s.firewall || {};
      fwPill.textContent = fw.checking ? 'Checking…' : fw.ok ? 'OK' : fw.ok === false ? 'Needs a fix' : '';
      fwPill.className = 'pill ' + (fw.checking ? 'muted' : fw.ok ? 'good' : 'bad');
      fwRow.setHint(fw.ok === false ? fw.message || '' : '');
      fwCheck.disabled = !!fw.checking;
      fwFix.hidden = fw.checking || fw.ok !== false || !!fw.error;
      const w = s.wake || {};
      wakeSw.set(w.on === true);
      wakeSw.disable(!w.checked || w.on == null || !!w.busy);
      wakeRow.setHint(w.error ? w.error : w.busy ? 'Changing…' : !w.checked ? 'Checking…'
        : w.on == null ? 'No network adapter here can wake {me}'
          : 'Its network adapter wakes {me} on a magic packet. Asks for administrator rights to change it');
      sendToRow.setHint(s.peer ? 'Right-click files › Send to › ' + s.peer.name + ' (TwinDesk)' : 'Shows up once a computer is paired');
      const h = s.kvmState.helper;
      helperPill.textContent = h ? (h === 'starting' ? 'Starting…' : 'Not running') : 'Running';
      helperPill.className = 'pill ' + (h ? (h === 'starting' ? 'muted' : 'bad') : 'good');
      helperRow.setHint(h && h !== 'starting' ? h : '');
      const v = s.pcScreen.vdd;
      vddPill.textContent = !v.checked ? 'Checking…' : v.busy === 'install' ? 'Installing…' : v.busy === 'remove' ? 'Removing…' : v.installed ? 'Installed' : 'Not installed';
      vddPill.className = 'pill ' + (!v.checked || v.busy ? 'muted' : v.installed ? 'good' : 'bad');
      vddInstall.hidden = !v.checked || v.installed;
      vddInstall.disabled = !!v.busy;
      vddRow.setHint(v.message ? v.message : v.installed ? 'Adds the extra screen for Share screen › Extend'
        : 'Needed for Share screen › Extend. Asks for administrator rights once');
      deviceName.textContent = s.device.name;
    };
  },
});
