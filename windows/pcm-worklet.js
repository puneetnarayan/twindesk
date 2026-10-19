// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// AudioWorklet: plays raw PCM pushed from main (48 kHz stereo float32 interleaved) with a small
// jitter buffer. Keeps ~40–60 ms queued; drops the oldest audio if it falls >160 ms behind. (More
// than the Mac's: the phone's sound comes over Wi-Fi and adb, and Windows' timers are coarser, so
// a 20 ms cushion ran dry and crackled.)
'use strict';

class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(48000 * 2); // 1 s ring, interleaved
    this.r = 0;
    this.w = 0;
    this.n = 0; // frames queued
    this.primed = false;
    this.port.onmessage = (e) => this.push(e.data);
  }

  push(f) {
    const frames = f.length >> 1;
    const cap = this.buf.length >> 1;
    for (let i = 0; i < frames; i++) {
      this.buf[this.w * 2] = f[i * 2];
      this.buf[this.w * 2 + 1] = f[i * 2 + 1];
      this.w = (this.w + 1) % cap;
    }
    this.n = Math.min(cap, this.n + frames);
    const max = 7680; // 160 ms
    if (this.n > max) {
      const drop = this.n - 2880; // back to 60 ms
      this.r = (this.r + drop) % cap;
      this.n -= drop;
    }
  }

  process(_inputs, outputs) {
    const [l, r] = outputs[0];
    const cap = this.buf.length >> 1;
    if (!this.primed && this.n >= 1920) this.primed = true; // start once 40 ms is queued
    for (let i = 0; i < l.length; i++) {
      if (this.primed && this.n > 0) {
        l[i] = this.buf[this.r * 2];
        if (r) r[i] = this.buf[this.r * 2 + 1];
        this.r = (this.r + 1) % cap;
        this.n--;
      } else {
        l[i] = 0;
        if (r) r[i] = 0;
        if (this.n === 0) this.primed = false;
      }
    }
    return true;
  }
}

registerProcessor('pcm-player', PcmPlayer);
