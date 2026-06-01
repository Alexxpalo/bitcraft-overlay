// Shared helpers for all overlay windows.
const T = window.__TAURI__;

// Rate-limited request queue: ~30 req/min (one per 250 ms).
// Duplicate paths collapse into a single queued request.
const _reqQueue   = [];
const _reqWaiters = new Map();
let _reqScheduled = false;

function _drainQueue() {
  if (_reqQueue.length === 0) { _reqScheduled = false; return; }
  _reqScheduled = true;
  const path = _reqQueue.shift();
  const waiters = _reqWaiters.get(path) || [];
  _reqWaiters.delete(path);
  T.core.invoke('bitwasp', { path })
    .then(r => waiters.forEach(w => w.resolve(r)))
    .catch(e => waiters.forEach(w => w.reject(e)));
  setTimeout(_drainQueue, 250);
}

async function bitwasp(path) {
  return new Promise((resolve, reject) => {
    if (_reqWaiters.has(path)) {
      _reqWaiters.get(path).push({ resolve, reject });
    } else {
      _reqWaiters.set(path, [{ resolve, reject }]);
      _reqQueue.push(path);
      if (!_reqScheduled) _drainQueue();
    }
  });
}

// Selected settlement, shared across all windows via localStorage.
function getSettlement() { return JSON.parse(localStorage.getItem('bc-settlement') || 'null'); }
function setSettlement(s) { localStorage.setItem('bc-settlement', JSON.stringify(s)); }

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function checkForUpdate() {
  if (!T?.core) return;
  try {
    const ver = await T.core.invoke('check_for_update');
    if (!ver) return;
    if (localStorage.getItem('bc-dismissed-update') === ver) return;
    document.getElementById('update-ver').textContent = ver;
    document.getElementById('update-banner').style.display = 'flex';
  } catch(e) {}
}

async function doInstallUpdate() {
  if (!T?.core) return;
  document.getElementById('update-banner').innerHTML = '<span>Ladataan päivitystä…</span>';
  try {
    await T.core.invoke('install_update');
  } catch(e) {
    document.getElementById('update-banner').innerHTML =
      `<span>Virhe: ${esc(String(e))}</span><button onclick="dismissUpdate()">✕</button>`;
  }
}

function dismissUpdate() {
  const ver = document.getElementById('update-ver')?.textContent;
  if (ver) localStorage.setItem('bc-dismissed-update', ver);
  const banner = document.getElementById('update-banner');
  if (banner) banner.style.display = 'none';
}

function relTime(ts) {
  if (!ts) return '';
  const then = new Date(String(ts).replace(' ', 'T')).getTime();
  if (isNaN(then)) return ts;
  const s = Math.floor((Date.now() - then) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
