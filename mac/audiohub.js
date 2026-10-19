// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// One system-audio capture (mac-helper ScreenCaptureKit -> fd 3), shared by whoever needs it:
// the screen session ("Share sound with the screen") and the standalone audio session (Audio tab).
// Forwards whole stereo float32 frames to each consumer window, mutes this Mac while capturing if
// asked (the capture taps app audio, so the system mute doesn't affect what is sent).
'use strict';

const { execFile, execFileSync } = require('child_process');

class AudioHub {
  constructor(helper, getSettings) {
    this.helper = helper;
    this.getSettings = getSettings;
    this.consumers = new Map(); // name -> webContents
    this.capturing = false;
    this.error = null;
    this.rest = null; // bytes of a split frame from the last pipe read
    this.mutedByUs = false;
    helper.on('pcm', (buf) => this._onPcm(buf));
    helper.on('exit', () => {
      this.capturing = false;
    });
    helper.on('ready', () => {
      if (this.consumers.size) this._sync();
    });
  }

  // Start feeding `webContents` ('pcm' IPC messages); resolves false if capture failed.
  async acquire(name, webContents) {
    this.consumers.set(name, webContents);
    await this._sync();
    return this.capturing;
  }

  release(name) {
    if (!this.consumers.delete(name)) return;
    this._sync();
  }

  async _sync() {
    const want = this.consumers.size > 0;
    if (want && !this.capturing) {
      try {
        await this.helper.request('audioCapture', { on: true });
        this.capturing = true;
        this.error = null;
      } catch (e) {
        this.error = e.message;
        console.error(`[audio] capture: ${e.message}`);
      }
    } else if (!want && this.capturing) {
      this.capturing = false;
      this.helper.request('audioCapture', { on: false }).catch(() => {});
    }
    this.rest = null;
    this.applyMute();
  }

  // "Mute this Mac while sending".
  applyMute() {
    const on = this.capturing && !!this.getSettings().audio.muteLocal;
    if (on === this.mutedByUs) return;
    this.mutedByUs = on;
    execFile('/usr/bin/osascript', ['-e', on ? 'set volume with output muted' : 'set volume without output muted'], () => {});
  }

  // App quitting: give the sound back synchronously.
  shutdown() {
    if (this.mutedByUs) execFileSync('/usr/bin/osascript', ['-e', 'set volume without output muted']);
    this.mutedByUs = false;
  }

  _onPcm(buf) {
    if (!this.capturing || !this.consumers.size) return;
    if (this.rest) buf = Buffer.concat([this.rest, buf]);
    const whole = buf.length - (buf.length % 8);
    this.rest = whole < buf.length ? Buffer.from(buf.subarray(whole)) : null;
    if (!whole) return;
    const frames = buf.subarray(0, whole);
    for (const [name, wc] of this.consumers) {
      if (wc.isDestroyed()) this.consumers.delete(name);
      else wc.send('pcm', frames);
    }
  }
}

module.exports = { AudioHub };
