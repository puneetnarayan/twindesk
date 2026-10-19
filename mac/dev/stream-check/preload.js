// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('rx', { on: (f) => ipcRenderer.on('m', (_e, m) => f(m)), send: (m) => ipcRenderer.send('out', m) });
