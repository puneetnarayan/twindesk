// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hud', { on: (fn) => ipcRenderer.on('hud', (_e, m) => fn(m)) });
