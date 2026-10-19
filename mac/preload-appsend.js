// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The hidden app-window sender's API: commands and rtc2.* in, rtc2.*, state and stats out.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appsend', {
  on: (fn) => ipcRenderer.on('appsend', (_e, m) => fn(m)),
  send: (m) => ipcRenderer.send('appsend-out', m),
  state: (s) => ipcRenderer.send('appsend-state', s),
  stats: (s) => ipcRenderer.send('appsend-stats', s),
  ready: () => ipcRenderer.send('appsend-ready'),
});
