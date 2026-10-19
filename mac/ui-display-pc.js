// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Display › PC → Mac: the PC's screen in a window on this Mac. Same structure as
// Mac → PC; the PC picks what it shares (Off / Mirror / Extend), this Mac picks how it shows it.
'use strict';

UI.tab({
  id: 'receive',
  hidden: (s) => UI.isPhone(s), // the Phone page has the phone's screen, sound and apps
  group: 'Display',
  order: 11,
  title: 'Receive screen',
  heading: '{name} on {me}',
  icon: 'receive',
  desc: 'See its screen in a window here.',
  color: 'linear-gradient(#5ac8fa, #0a84ff)',
  // The switch is the screen window (open = watching = the other side sends).
  master: { get: (s) => !!(s.receive && s.receive.open), set: (v) => (v ? UI.api.showPcView() : UI.api.closePcView()) },
  badge: (s) => (s.receive && s.receive.status === 'live' ? 'on' : ''),
  build(body) {
    const { el, api } = UI;
    const STATUS = { off: 'Off', connecting: 'Connecting…', new: 'Connecting…', live: 'Live', disconnected: 'Reconnecting…', failed: 'Waiting for {name}…', stopped: 'Stopped on the other computer', closed: 'Closed' };

    const fullSw = UI.switch((v) => api.setReceive({ fullScreen: v }), { label: 'Open full screen' });
    const inputSw = UI.switch((v) => api.setReceive({ input: v }), { label: 'Control it' });
    const ctlRow = UI.row('Control {name} from its window', '', [inputSw]);
    const showBtn = UI.button('Open', () => api.showPcView(), 'primary');
    const winRow = UI.row('Screen window', '', [showBtn]);
    // Run the other computer's sharing from here (screen.ctl), when it allows that.
    // One control, the same three choices as on the PC itself, kept in step (screen.state).
    const rMode = UI.segmented([
      { value: 'off', label: 'Off' },
      { value: 'mirror', label: 'Mirror' },
      { value: 'extend', label: 'Extend' },
    ], (v) => api.remoteScreen(v === 'off' ? { share: false } : { share: true, mode: v }));
    const rRow = UI.row('{name} shares', '', [rMode]);
    rRow.label.dataset.peer = '{name} shares';
    const paceRow = UI.paceRow();
    const fgSw = UI.switch((v) => api.setReceive({ framegen: v }), { label: 'Frame generation' });
    const fgRow = UI.row('Frame generation', 'Fills in late or dropped frames, and adds in-between frames when this screen is faster than the stream', [fgSw]);

    const live = {
      status: UI.row('Status', ''), picture: UI.row('Picture', ''), rate: UI.row('Speed', ''), rtt: UI.row('Round trip', ''),
      codec: UI.row('Codec', ''), decoder: UI.row('Decoder', ''), delay: UI.row('Delay', ''), smooth: UI.row('Smoothness', ''),
    };
    const vals = Object.fromEntries(Object.entries(live).map(([k, r]) => {
      const v = el('span', { class: 'value' });
      r.querySelector('.controls').append(v);
      return [k, v];
    }));

    body.append(
      UI.card('', [
        winRow,
        rRow,
        UI.row('Open full screen', 'Ctrl ⌘ F switches', [fullSw]),
        ctlRow,
        paceRow,
        fgRow,
      ], { cls: 'keep-on' }),
      UI.card('Details', Object.values(live), { cls: 'keep-on' }),
    );

    return (s) => {
      const r = s.receive;
      if (!r) return;
      fullSw.set(r.fullScreen);
      paceRow.render(s);
      fgSw.set(!!r.framegen);
      const rs = r.remote;
      rMode.set(rs ? (rs.on ? rs.mode : 'off') : '');
      rMode.disable(!s.client || !rs || !rs.remote);
      rRow.setHint(!s.client ? 'Connect to choose from here'
        : !rs ? 'Update TwinDesk on the other computer to choose from here'
          : !rs.remote ? 'The other computer doesn’t allow choosing from here'
            : rs.on ? (rs.mode === 'extend' ? 'An extra screen for it, shown here' : 'Its main screen, shown here') : 'Pick Mirror or Extend — or just press Open');
      inputSw.set(r.input);
      const p = UI.peer(s);
      const pc = p.name;
      showBtn.textContent = r.open ? 'Show' : 'Open';
      const canStart = r.remote && r.remote.remote;
      winRow.setHint(!s.client ? `Waiting for ${pc}`
        : r.session ? `Showing ${pc}` : canStart ? `Open starts it on ${pc}` : `Choose what to share in TwinDesk on ${pc}`);
      const st = r.stats;
      const isLive = r.status === 'live' && st;
      vals.status.textContent = UI.fill(STATUS[r.status] || r.status);
      vals.picture.textContent = isLive ? `${st.width} × ${st.height} · ${st.fps} fps` : '';
      vals.rate.textContent = isLive ? `${st.mbps} Mbps` : '';
      vals.rtt.textContent = s.client && s.client.rttMs != null ? `${s.client.rttMs} ms` : '';
      vals.codec.textContent = isLive && st.codec ? st.codec : '';
      vals.decoder.textContent = isLive && st.decoder ? st.decoder : '';
      vals.delay.textContent = isLive && st.bufferMs != null ? `${st.bufferMs} ms buffer · ${st.decodeMs} ms decode` : '';
      vals.smooth.textContent = isLive ? `${st.dropped || 0} dropped · ${st.freezes || 0} freezes${st.framegen ? ' · frame generation on' : ''}` : '';
      for (const k of ['picture', 'rate', 'rtt', 'codec', 'decoder', 'delay', 'smooth']) live[k].hidden = !vals[k].textContent;
    };
  },
});
