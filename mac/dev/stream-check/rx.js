// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Receiver like Windows' Monitor 2 (answerer, jitterBufferTarget 0) + clock decoding.
const BITS = 24, B = 48;
const v = document.getElementById('v');
const cv = document.createElement('canvas');
const g = cv.getContext('2d', { willReadFrequently: true });
let pc, q = [], ready = false, sess, lat = [], last = null, lastAt = 0;

rx.on(async (m) => {
  if (m.t === 'stream.info') console.log(`stream.info ${m.name} ${m.width}x${m.height}`);
  if (m.t === 'rtc.offer') {
    if (pc) pc.close();
    sess = m.session; ready = false; q = [];
    pc = new RTCPeerConnection({ iceServers: [] });
    pc.onicecandidate = (e) => e.candidate && rx.send({ t: 'rtc.ice', session: sess, candidate: e.candidate.toJSON() });
    pc.ontrack = (e) => {
      if (e.track.kind === 'audio') { // measure what actually arrives (the <video> is muted)
        const ctx = new AudioContext(); const an = ctx.createAnalyser();
        ctx.createMediaStreamSource(new MediaStream([e.track])).connect(an);
        const b = new Float32Array(2048);
        setInterval(() => { an.getFloatTimeDomainData(b); let p = 0; for (const v of b) p = Math.max(p, Math.abs(v)); window.peakRx = Math.max(window.peakRx || 0, p); }, 20);
        setInterval(() => { console.log(`audio rx peak ${(window.peakRx || 0).toFixed(3)}`); window.peakRx = 0; }, 2000);
      }
      if (e.receiver.jitterBufferTarget !== undefined) e.receiver.jitterBufferTarget = 0;
      v.srcObject = e.streams[0];
    };
    pc.onconnectionstatechange = () => console.log(`session ${sess}: ${pc.connectionState}`);
    await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    rx.send({ t: 'rtc.answer', session: sess, sdp: pc.localDescription.sdp });
    ready = true; for (const c of q) await pc.addIceCandidate(c);
  } else if (m.t === 'rtc.ice' && m.session === sess) {
    ready ? pc.addIceCandidate(m.candidate) : q.push(m.candidate);
  }
});

function onFrame() {
  const now = Date.now();
  if (v.videoWidth) {
    const sx = v.videoWidth / screenW(); // video pixels per CSS px of the pattern
    cv.width = Math.ceil((BITS + 1) * B * sx); cv.height = Math.ceil(B * sx);
    g.drawImage(v, OX * sx, OY * sx, cv.width, cv.height, 0, 0, cv.width, cv.height);
    const d = g.getImageData(0, 0, cv.width, cv.height).data;
    const at = (x) => { const i = (Math.round(B * sx / 2) * cv.width + Math.round(x)) * 4; return [d[i], d[i + 1], d[i + 2]]; };
    const m = at((BITS + 0.5) * B * sx);
    if (m[0] > 150 && m[1] < 100) { // red end marker found
      let t = 0;
      for (let i = 0; i < BITS; i++) if (at((i + 0.5) * B * sx)[0] > 128) t |= 1 << i;
      const l = ((now % 2 ** BITS) - t + 2 ** BITS) % 2 ** BITS;
      if (l < 5000) lat.push(l);
    }
  }
  v.requestVideoFrameCallback(onFrame);
}
const qs = new URLSearchParams(location.search);
const screenW = () => Number(qs.get('w')) || v.videoWidth; // shared display width in points
const OX = Number(qs.get('ox')) || 0, OY = Number(qs.get('oy')) || 0; // pattern window offset
v.requestVideoFrameCallback(onFrame);

setInterval(async () => {
  if (!pc) return;
  let r = null;
  let a = null;
  (await pc.getStats()).forEach((x) => {
    if (x.type === 'inbound-rtp' && x.kind === 'video') r = x;
    if (x.type === 'inbound-rtp' && x.kind === 'audio') a = x;
  });
  if (a) console.log(`audio: level ${(a.audioLevel || 0).toFixed(3)} samples ${a.totalSamplesReceived} jitterbuf ${a.jitterBufferEmittedCount ? Math.round((a.jitterBufferDelay / a.jitterBufferEmittedCount) * 1000) : '-'} ms concealed ${a.concealedSamples}`);
  if (!r) return;
  const s = lat.slice().sort((a, b) => a - b);
  const med = s.length ? s[s.length >> 1] : '-';
  const p90 = s.length ? s[Math.floor(s.length * 0.9)] : '-';
  let jb = '-', dec = '-', mbps = '-';
  if (last) {
    const e = r.jitterBufferEmittedCount - last.jitterBufferEmittedCount;
    if (e > 0) jb = Math.round(((r.jitterBufferDelay - last.jitterBufferDelay) / e) * 1000);
    const f = r.framesDecoded - last.framesDecoded;
    if (f > 0) dec = Math.round(((r.totalDecodeTime - last.totalDecodeTime) / f) * 1000 * 10) / 10;
    mbps = Math.round(((r.bytesReceived - last.bytesReceived) * 8) / ((performance.now() - lastAt) * 1000) * 10) / 10;
  }
  last = r; lastAt = performance.now();
  console.log(`rx ${r.frameWidth}x${r.frameHeight} ${r.framesPerSecond || 0}fps ${mbps}Mbps | latency med ${med} p90 ${p90} ms (n=${s.length}) | jitterbuf ${jb}ms decode ${dec}ms | dropped ${r.framesDropped} nack ${r.nackCount} pli ${r.pliCount} | ${r.decoderImplementation}`);
  lat = [];
}, 2000);
