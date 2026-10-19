// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Renders icon.html (the sidebar's app mark) to a 1024 px PNG: electron dev/icon/main.js <out.png>
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.dock?.hide();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024, height: 1024, show: false, frame: false, transparent: true, useContentSize: true,
    webPreferences: { zoomFactor: 1 },
  });
  win.webContents.setZoomFactor(1);
  await win.loadFile(path.join(__dirname, 'icon.html'));
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  fs.writeFileSync(process.argv[process.argv.length - 1], img.resize({ width: 1024, height: 1024 }).toPNG());
  app.quit();
});
