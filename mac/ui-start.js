// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Boots the control window: sidebar + one page per registered tab, pairing banner, rendering.
'use strict';

(() => {
  const { el, api } = UI;
  const $ = (id) => document.getElementById(id);
  const nav = $('nav');
  const pages = $('pages');
  const views = new Map(); // id -> { def, page, navBtn, stateEl, master, render }
  let current = null;

  let lastGroup = null;
  for (const def of UI.tabs.slice().sort((a, b) => (a.order ?? 50) - (b.order ?? 50))) {
    if (def.navHidden) { // reached another way (the phone tile)
      views.set(def.id, { def, ...buildPage(def), navBtn: el('button'), stateEl: el('span') });
      continue;
    }
    if (def.bottom && !nav.querySelector('.sep')) nav.append(el('li', { class: 'sep', attrs: { role: 'presentation' } })); // one line above General and About
    // Groups (System Settings style): a small gap before each, no heading, icons in one column.
    if (def.group !== lastGroup && !def.bottom && nav.children.length) nav.append(el('li', { class: 'gap', attrs: { role: 'presentation' } }));
    lastGroup = def.group;
    const stateEl = el('span', { class: 'state' });
    const tile = el('span', { class: 'tile' }, [UI.icon(def.icon || def.id)]);
    tile.style.background = def.color; // CSSOM, allowed by the CSP (inline style attributes aren't)
    const label = el('span', { class: 'label', text: def.title });
    if (def.title.includes('{')) label.dataset.peer = def.title; // peer-dependent (UI.names)
    const navBtn = el('button', { class: 'nav-item', attrs: { role: 'tab', 'aria-controls': `page-${def.id}` } }, [
      tile,
      label,
      stateEl,
    ]);
    navBtn.onclick = () => show(def.id, true);
    nav.append(el('li', {}, [navBtn]));
    views.set(def.id, { def, ...buildPage(def), navBtn, stateEl });
  }

  function buildPage(def) {
    const page = el('section', { class: 'page', id: `page-${def.id}`, hidden: true, attrs: { role: 'tabpanel' } });
    const h1Text = el('span', { text: def.heading || def.title });
    const descEl = el('p', { text: def.desc || '' });
    if ((def.heading || def.title).includes('{')) h1Text.dataset.peer = def.heading || def.title;
    if ((def.desc || '').includes('{')) descEl.dataset.peer = def.desc;
    const titles = el('div', { class: 'titles' }, [
      el('h1', {}, [h1Text, def.phase ? el('span', { class: 'pill muted', text: `Phase ${def.phase}` }) : null]),
      descEl,
    ]);
    let master = null;
    if (def.master) {
      master = UI.switch((v) => def.master.set(v), { label: def.title, disabled: !!def.master.disabled });
    }
    page.append(el('header', { class: 'page-head' }, [titles, master ? master.el : null]));
    const body = el('div', { class: 'page-body' });
    page.append(body);
    pages.append(page);
    const render = def.build(body, page) || (() => {});
    return { page, master, render };
  }

  function show(id, user) {
    const v = views.get(id) || views.get('overview');
    if (current === v) return;
    if (current) {
      current.page.hidden = true;
      current.navBtn.classList.remove('active');
      current.navBtn.setAttribute('aria-selected', 'false');
    }
    current = v;
    v.page.hidden = false;
    v.navBtn.classList.add('active');
    v.navBtn.setAttribute('aria-selected', 'true');
    $('content').scrollTop = 0;
    for (const t of $('phones').children) t.classList.toggle('active', v.def.id === 'phone' && t.dataset.connected === '1');
    if (user) api.setTab(v.def.id);
    if (UI.state) renderPage(v, UI.state);
  }

  function renderPage(v, s) {
    if (v.master) {
      const on = !!v.def.master.get(s);
      v.master.set(on);
      v.master.disable(!!v.def.master.disabled);
      v.page.classList.toggle('off', !on);
    }
    try {
      v.render(s);
    } catch (e) {
      console.error(`render ${v.def.id}:`, e);
    }
  }

  function renderSidebar(s) {
    const c = s.client;
    $('peer-dot').className = `dot ${c ? 'good' : s.pairing ? 'warn' : ''}`;
    const gs = s.guest && s.guest.status && s.guest.status.state;
    $('peer-text').textContent = c ? `${c.name}${c.rttMs != null ? ` · ${c.rttMs} ms` : ''}`
      : s.pairing || (s.guest && s.guest.pairing) ? 'Pairing…' : gs === 'connecting' || gs === 'reconnecting' ? 'Connecting…' : 'Not connected';
    renderPhones(s);
    // Tabs that don't apply to the peer (a phone has no terminal or screen to share to it…).
    for (const v of views.values()) {
      const hide = !!(v.def.hidden && v.def.hidden(s));
      if (v.navBtn.parentElement) v.navBtn.parentElement.hidden = hide;
      if (hide && current === v) show(s.phone && s.phone.connected ? 'phone' : 'overview', false);
    }
    for (const v of views.values()) {
      const b = v.def.badge ? v.def.badge(s) : v.def.phase ? `P${v.def.phase}` : '';
      v.stateEl.className = `state${b === 'on' ? ' on' : ''}`;
      v.stateEl.textContent = b === 'on' ? '' : b || '';
    }
  }

  // Paired phones nearby, above Overview: the phone's wallpaper, its name and the link. Clicking
  // one connects it (the computer steps aside); the connected one opens its page.
  let phonesKey = '';
  let assetsSeen = -1;
  function renderPhones(s) {
    const ph = s.phone || { nearby: [] };
    if (ph.assets !== assetsSeen) {
      assetsSeen = ph.assets;
      api.phoneAssets().then((a) => {
        UI.phoneAssets = a;
        UI.phoneWall = a.wallpaper ? `url("${a.wallpaper}")` : '';
        phonesKey = '';
        if (UI.state) render(UI.state);
      }, () => {});
    }
    const info = ph.info || {};
    const colors = info.colors && info.colors.length ? info.colors : null;
    const key = JSON.stringify([ph.nearby, ph.connecting, ph.connected && ph.connected.rttMs, ph.held, info.battery, info.charging, colors, UI.phoneWall ? UI.phoneWall.length : 0, current && current.def.id]);
    if (key === phonesKey) return;
    phonesKey = key;
    $('phones').replaceChildren(...ph.nearby.map((d) => {
      const wall = el('span', { class: 'phone-wall' }, [UI.icon('phone')]);
      if (d.connected && UI.phoneWall) wall.style.backgroundImage = UI.phoneWall;
      else if (d.connected && colors) wall.style.backgroundImage = `linear-gradient(160deg, ${colors.join(', ')}${colors.length === 1 ? `, ${colors[0]}` : ''})`;
      const connecting = ph.connecting && ph.connecting.id === d.id;
      const sub = d.connected
        ? `${ph.connected.rttMs != null ? `${ph.connected.rttMs} ms` : 'Connected'}${info.battery != null ? ` · ${info.battery}%${info.charging ? ' ⚡' : ''}` : ''}`
        : connecting ? 'Connecting…' : 'Nearby · Click to connect';
      const b = el('button', { class: `phone-tile${d.connected ? ' connected' : ''}`, title: d.connected ? `${d.name}` : `Connect to ${d.name}` }, [
        wall,
        el('span', { class: 'phone-text' }, [el('span', { class: 'phone-name', text: d.name }), el('span', { class: 'phone-sub', text: sub })]),
        d.connected ? el('span', { class: 'dot good' }) : null,
      ]);
      b.dataset.connected = d.connected ? '1' : '';
      b.classList.toggle('active', d.connected && current && current.def.id === 'phone');
      b.onclick = () => (d.connected ? show('phone', true) : api.connectPhone(d.id));
      return b;
    }));
  }

  // Two kinds of pairing request: someone pairs with this Mac (Allow / Deny), or this Mac pairs
  // with another Mac as its guest (Codes match / Cancel, like the PC app).
  let bannerMode = null;
  function renderBanner(s) {
    const p = s.pairing;
    const g = s.guest && s.guest.pairing;
    bannerMode = p ? 'host' : g ? 'guest' : null;
    $('banner').hidden = !bannerMode;
    if (!bannerMode) return;
    const code = (p || g).code;
    $('pair-code').textContent = code ? `${code.slice(0, 3)} ${code.slice(3)}` : '…';
    if (p) {
      $('pair-title').replaceChildren(el('strong', { text: p.name }), ' wants to pair');
      $('pair-allow').textContent = 'Allow';
      $('pair-deny').textContent = 'Deny';
      $('pair-allow').hidden = false;
      $('pair-allow').disabled = !p.code || p.allowed;
      const other = p.name;
      let hint = `Check that ${other} shows the same code.`;
      if (!p.code) hint = 'Waiting for the code…';
      else if (p.allowed && !p.confirmed) hint = `Allowed. Waiting for “Codes match” on ${other}…`;
      else if (p.confirmed && !p.allowed) hint = `${other[0].toUpperCase()}${other.slice(1)} confirmed the code. Click Allow if it matches.`;
      $('pair-hint').textContent = hint;
      return;
    }
    $('pair-title').replaceChildren('Pairing with ', el('strong', { text: g.name }));
    $('pair-allow').textContent = 'Codes match';
    $('pair-deny').textContent = g.phase === 'failed' ? 'OK' : 'Cancel';
    $('pair-allow').hidden = g.phase === 'failed';
    $('pair-allow').disabled = g.phase !== 'code';
    $('pair-hint').textContent = g.phase === 'failed' ? g.error
      : g.phase === 'code' ? `Check that ${g.name} shows the same code.`
        : g.phase === 'waiting' ? `Waiting for Allow on ${g.name}…` : 'Connecting…';
  }

  function render(s) {
    UI.state = s;
    UI.names(s);
    if (UI.setup.render(s)) {
      renderBanner(s);
      return;
    }
    renderSidebar(s);
    renderBanner(s);
    if (current) renderPage(current, s);
  }

  $('pair-allow').onclick = () => (bannerMode === 'guest' ? api.confirmGuestCode() : api.pairRespond(true));
  $('pair-deny').onclick = () => (bannerMode === 'guest' ? api.cancelGuestPair() : api.pairRespond(false));
  window.addEventListener('macshare-go', (e) => show(e.detail, true));

  // ↑/↓ move between tabs while the sidebar has focus.
  nav.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const ids = [...views.keys()];
    const i = ids.indexOf(current.def.id) + (e.key === 'ArrowDown' ? 1 : -1);
    const next = ids[(i + ids.length) % ids.length];
    show(next, true);
    views.get(next).navBtn.focus();
  });

  // Relative times ("2 min ago") age without a state push.
  setInterval(() => UI.state && current && renderPage(current, UI.state), 15000);

  api.onState(render);
  api.getState().then((s) => {
    const saved = s.ui && s.ui.tab;
    show(saved === 'display' ? 'share' : saved || 'overview', false); // 'display' = before the split
    render(s);
  });
})();
