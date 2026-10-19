// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Monitor 2: drop files onto the Mac's screen. Paths come from the preload
// (webUtils.getPathForFile); main sends them; progress comes back for the little status line.
(function () {
  const api = window.monitor;
  const status = document.getElementById('drop-status');
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');

  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) document.body.classList.remove('dragging');
  });
  window.addEventListener('drop', (e) => {
    document.body.classList.remove('dragging');
    if (!hasFiles(e)) return;
    e.preventDefault();
    const paths = [...e.dataTransfer.files].map((f) => api.pathFor(f)).filter(Boolean);
    const p = window.monitorNorm ? window.monitorNorm(e) : null;
    if (paths.length) api.drop(paths, p ? p.x : null, p ? p.y : null);
  });

  let hideTimer = null;
  const mb = (n) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
  api.onDropProgress((v) => {
    clearTimeout(hideTimer);
    if (v.current) {
      const c = v.current;
      const pct = c.size ? Math.floor((c.sent / c.size) * 100) : 100;
      status.textContent = 'Sending ' + c.name + (c.count > 1 ? ' (' + (c.index + 1) + ' of ' + c.count + ')' : '') +
        ', ' + pct + '%  ' + mb(c.sent) + ' / ' + mb(c.size);
      status.className = '';
    } else if (v.last) {
      status.textContent = (v.last.name ? v.last.name + ': ' : '') + v.last.text;
      status.className = v.last.ok ? 'ok' : 'bad';
      hideTimer = setTimeout(() => { status.className = 'hidden'; }, 6000);
    }
  });
})();
