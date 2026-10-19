// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Mac's sound on the phone (mac/audio.js, direction m2w): the Mac offers an audio-only
// WebRTC connection; this page, in a WebView the app keeps without a window, answers and plays it.
'use strict';

const out = document.getElementById('out');
let recv = null; // {session, pc, pending, remoteSet}

const send = (m) => window.TD.send(JSON.stringify(m));

// Opus: stereo, music-grade bitrate (system sound, not a voice call) — as on the Mac.
function withOpus(sdp) {
  const pt = /a=rtpmap:(\d+) opus\/48000\/2/i.exec(sdp);
  if (!pt) return sdp;
  return sdp.split('\r\n').map((l) => {
    if (!l.startsWith(`a=fmtp:${pt[1]} `)) return l;
    const keep = l.slice(`a=fmtp:${pt[1]} `.length).split(';').filter((x) => x && !/^(stereo|sprop-stereo|maxaveragebitrate)=/.test(x));
    return `a=fmtp:${pt[1]} ${[...keep, 'stereo=1', 'sprop-stereo=1', 'maxaveragebitrate=128000'].join(';')}`;
  }).join('\r\n');
}

function stop() {
  if (recv && recv.pc) recv.pc.close();
  recv = null;
  out.srcObject = null;
}

async function onOffer(m) {
  stop();
  const me = { session: m.session, pending: [], remoteSet: false };
  recv = me;
  const pc = new RTCPeerConnection(m.ice || { iceServers: [] }); // m.ice: through the USB cable
  me.pc = pc;
  pc.ontrack = (e) => {
    if (e.receiver.jitterBufferTarget !== undefined) e.receiver.jitterBufferTarget = 0;
    out.srcObject = new MediaStream([e.track]);
    out.play().catch(() => {});
  };
  pc.onicecandidate = (e) => e.candidate && recv === me && send({ t: 'audio.ice', dir: 'm2w', session: m.session, candidate: e.candidate.toJSON() });
  try {
    await pc.setRemoteDescription({ type: 'offer', sdp: withOpus(m.sdp) });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription({ type: 'answer', sdp: withOpus(answer.sdp) });
    if (recv !== me) return;
    send({ t: 'audio.answer', dir: 'm2w', session: m.session, sdp: pc.localDescription.sdp });
    me.remoteSet = true;
    for (const c of me.pending.splice(0)) await pc.addIceCandidate(c);
  } catch (e) {
    console.error('audio offer', e.message);
  }
}

window.tdRecv = (m) => {
  if (m.dir !== 'm2w') return;
  if (m.t === 'audio.offer') onOffer(m);
  else if (m.t === 'audio.stop') stop();
  else if (m.t === 'audio.ice' && recv && m.session === recv.session && m.candidate) {
    if (recv.remoteSet) recv.pc.addIceCandidate(m.candidate).catch(() => {});
    else recv.pending.push(m.candidate);
  } else if (m.t === 'volume') out.volume = Math.max(0, Math.min(1, Number(m.v)));
};
window.TD.ready();
