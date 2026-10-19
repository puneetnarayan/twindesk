// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The hidden sender window's API: commands and rtc2.* in, rtc2.*, state and stats out.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sender', {
  on: (fn) => ipcRenderer.on('sender', (_e, m) => fn(m)),
  send: (m) => ipcRenderer.send('sender-out', m),
  state: (s) => ipcRenderer.send('sender-state', s),
  stats: (s) => ipcRenderer.send('sender-stats', s),
  ready: () => ipcRenderer.send('sender-ready'),
});
