// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Cursor tab: where the PC is (layout picker), directions, edge resistance, speed, scrolling.
'use strict';

UI.tab({
  id: 'cursor',
  group: 'Input',
  order: 20,
  title: 'Cursor',
  desc: 'Move the pointer off the edge of the screen to go to the other computer.',
  color: 'linear-gradient(#ffb340, #ff9500)',
  // One switch: cursor sharing, the same one the hotkey's double-tap and the other
  // computer flip (kvm.link keeps both in step).
  master: { get: (s) => !!(s.kvm && s.kvm.mouse && s.kvm.linked !== false), set: (v) => UI.api.setKvm(v ? { mouse: true, linked: true } : { linked: false }) },
  badge: (s) => (s.kvm && s.kvm.mouse && s.kvm.linked !== false ? 'on' : ''),
  build(body) {
    const { el, api } = UI;
    const status = UI.note('info', '');

    // Layout picker: the Mac in the middle, a slot on each side for the PC.
    const slots = {};
    let meLabel = null;
    const grid = el('div', { class: 'layout-grid' });
    const cell = (side) => {
      const b = el('button', { class: 'slot', title: `Put it ${side === 'top' ? 'above' : side === 'bottom' ? 'below' : `on the ${side}`}`, attrs: { 'aria-label': `Other computer ${side}` } });
      b.onclick = () => api.setKvm({ pcSide: side });
      slots[side] = b;
      return b;
    };
    grid.append(
      el('span'), cell('top'), el('span'),
      cell('left'), el('div', { class: 'screen mac-screen' }, [meLabel = el('span', { text: 'This Mac' })]), cell('right'),
      el('span'), cell('bottom'), el('span'),
    );
    const layoutHint = el('div', { class: 'layout-hint' });

    const drive = UI.switch((v) => api.setKvm({ driveOther: v }), { label: 'Use here, control there' });
    const driven = UI.switch((v) => api.setKvm({ beDriven: v }), { label: 'Let it control this computer' });
    const resistance = UI.slider({ min: 0, max: 400, step: 10, format: (v) => `${v} px` }, (v) => api.setKvm({ resistancePx: v }));
    const speed = UI.slider({ min: 0.25, max: 4, step: 0.25, format: (v) => `${v.toFixed(2)}×` }, (v) => api.setKvm({ speed: v }));
    const reverse = UI.switch((v) => api.setKvm({ reverseScroll: v }), { label: 'Reverse scrolling' });
    const gestures = UI.switch((v) => api.setKvm({ gestures: v }), { label: 'Trackpad gestures' });
    const gestureRow = UI.row('Trackpad gestures', 'Pinch to zoom, swipe between desktops, Mission Control / Task View, back and forward — done the native way on {name}. The same on both', [gestures]);

    // A row whose label follows the other computer's name (UI.names fills it on render).
    const peerRow = (label, hint, controls) => {
      const r = UI.row(label, hint, controls);
      r.label.dataset.peer = label;
      return r;
    };
    let driven2 = null;
    body.append(
      status,
      UI.pair(
        UI.dir('m2w', [peerRow('Use {me}’s mouse and keyboard on {name}', 'Push the pointer past the edge', [drive])]),
        UI.dir('w2m', [driven2 = peerRow('Use {name}’s mouse and keyboard on {me}', '', [driven])]),
      ),
      UI.card('Where the other computer is', [el('div', { class: 'layout' }, [grid, layoutHint])]),
      UI.card('Feel', [
        UI.row('Edge resistance', 'Push a little further to cross', [resistance]),
        peerRow('Pointer speed on {name}', '', [speed]),
        peerRow('Reverse scrolling from {name}', '', [reverse]),
        gestureRow,
      ]),
    );

    return (s) => {
      const k = s.kvm;
      if (!k) return;
      const p = UI.peer(s);
      const [kind, text] = UI.kvmStatus(s);
      status.className = `note ${kind}`;
      status.set(text);
      for (const [side, b] of Object.entries(slots)) {
        b.classList.toggle('on', k.pcSide === side);
        b.textContent = k.pcSide === side ? p.name : '';
        meLabel.textContent = p.me;
      }
      const where = { left: 'to the left of', right: 'to the right of', top: 'above', bottom: 'below' }[k.pcSide];
      layoutHint.textContent = `${p.Name} is ${where} ${p.me}. Click a side to move it.`;
      driven2.setHint('Double-tap the hotkey to take everything back');
      drive.set(k.driveOther);
      driven.set(k.beDriven);
      resistance.set(k.resistancePx);
      speed.set(k.speed);
      reverse.set(k.reverseScroll);
      gestures.set(k.gestures !== false);
    };
  },
});
