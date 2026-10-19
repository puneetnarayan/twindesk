// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const $ = (id) => document.getElementById(id);
const pill = $('pill');
const card = $('card');
window.hud.on(({ kind, text, sub }) => {
  if (kind === 'hide') {
    pill.classList.remove('on');
    card.classList.remove('on');
    return;
  }
  const big = kind === 'linkOn' || kind === 'linkOff';
  document.body.classList.toggle('big', big);
  const el = big ? card : pill;
  if (big) {
    $('card-text').textContent = text;
    $('card-sub').textContent = sub || '';
  } else {
    $('text').textContent = text;
  }
  el.className = `${big ? 'card' : 'pill'} ${kind}`;
  void el.offsetWidth; // restart the animation
  el.classList.add('on');
});
