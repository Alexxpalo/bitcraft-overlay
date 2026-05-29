// Shared helpers for all overlay windows.
const T = window.__TAURI__;

// Shared poll clock via BroadcastChannel.
// Main window calls startPollClock(); panels call onPollTick(fn).
const _pollBus = new BroadcastChannel('bc-poll');
function onPollTick(fn) { _pollBus.addEventListener('message', () => fn()); }
function startPollClock(ms = 30000) { setInterval(() => _pollBus.postMessage('tick'), ms); }

// Call the bitwasp REST API via the Rust backend (avoids CORS).
async function bitwasp(path) {
  return T.core.invoke('bitwasp', { path });
}

// Auto-hide overlay when BitCraft loses focus.
// Polls every 700ms; respects the pin button (watcher disabled when unpinned).
(async function startFocusWatcher() {
  if (!T?.window) return;
  const win = T.window.getCurrentWindow();
  await win.setAlwaysOnTop(true);
  setInterval(async () => {
    if (window._pinned) return;
    try {
      const active = await T.core.invoke('is_game_focused');
      await win.setAlwaysOnTop(active);
    } catch(e) {}
  }, 700);
})();

// Wire up the standard window chrome: drag bar, close, pin, optional collapse.
function initChrome() {
  // Collapse button works without Tauri
  const collapse = document.getElementById('collapse-btn');
  if (collapse) collapse.addEventListener('click', () => toggleCollapse(collapse));

  if (!T?.window) return;
  const win = T.window.getCurrentWindow();

  // Save position to localStorage whenever the window is moved (debounced).
  let _posTimer;
  win.listen('tauri://move', () => {
    clearTimeout(_posTimer);
    _posTimer = setTimeout(async () => {
      try {
        const pos = await win.outerPosition();
        const sf  = await win.scaleFactor();
        localStorage.setItem('bc-pos-' + win.label, JSON.stringify({
          x: Math.round(pos.x / sf),
          y: Math.round(pos.y / sf),
        }));
      } catch(e) {}
    }, 400);
  });

  const bar = document.getElementById('drag-bar');
  if (bar) bar.addEventListener('mousedown', (e) => {
    if (e.button === 0 && e.target.closest('.win-btn') === null) {
      win.startDragging();
    }
  });
  const close = document.getElementById('close-btn');
  if (close) close.addEventListener('click', () => win.close());
  const min = document.getElementById('min-btn');
  if (min) min.addEventListener('click', () => win.minimize());
}

// Collapse the window to just the drag bar, or expand it back.
async function toggleCollapse(btn) {
  const win = T.window.getCurrentWindow();
  const HKEY = 'bc-h-' + win.label;
  const isCollapsed = btn.textContent.trim() === '▼';
  if (isCollapsed) {
    const h = parseInt(localStorage.getItem(HKEY) || '340');
    const sz = await win.innerSize();
    const sf = await win.scaleFactor();
    const w = Math.round(sz.width / sf);
    await T.core.invoke('set_window_size', { width: w, height: h });
    btn.textContent = '▲';
    document.querySelectorAll('.collapsible').forEach(el => el.style.display = '');
  } else {
    const sz = await win.innerSize();
    const sf = await win.scaleFactor();
    localStorage.setItem(HKEY, Math.round(sz.height / sf));
    await T.core.invoke('set_window_size', { width: Math.round(sz.width / sf), height: 30 });
    btn.textContent = '▼';
    document.querySelectorAll('.collapsible').forEach(el => el.style.display = 'none');
  }
}

// Open a panel window (or focus it if already open).
async function openPanel(label, url, opts = {}) {
  const all = await T.webviewWindow.getAllWebviewWindows();
  const existing = all.find(w => w.label === label);
  if (existing) { existing.setFocus(); return; }
  const saved = JSON.parse(localStorage.getItem('bc-pos-' + label) || 'null');
  const winOpts = {
    url,
    width:       opts.width  ?? 360,
    height:      opts.height ?? 480,
    minWidth:    240,
    minHeight:   30,
    decorations: false,
    transparent: false,
    shadow:      false,
    alwaysOnTop: true,
    resizable:   true,
    skipTaskbar: true,
    title:       opts.title ?? label,
  };
  if (saved) { winOpts.x = saved.x; winOpts.y = saved.y; }
  new T.webviewWindow.WebviewWindow(label, winOpts);
}

// Selected settlement, shared across all windows via localStorage.
function getSettlement() { return JSON.parse(localStorage.getItem('bc-settlement') || 'null'); }
function setSettlement(s) { localStorage.setItem('bc-settlement', JSON.stringify(s)); }

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function setStatus(text, cls = '') {
  const dot = document.getElementById('status-dot');
  if (dot) { dot.className = 'status-dot ' + cls; dot.title = text; }
}

// Resize the window height to exactly fit its content (up to maxH).
async function fitWindow(maxH = 420) {
  try {
    const btn = document.getElementById('collapse-btn');
    if (btn && btn.textContent.trim() === '▼') return; // collapsed, don't touch
    const body = document.querySelector('.collapsible');
    if (!body) return;
    const h = Math.min(body.scrollHeight + 26 + 1, maxH); // 26 = drag bar
    const win = T.window.getCurrentWindow();
    const sz  = await win.innerSize();
    const sf  = await win.scaleFactor();
    await T.core.invoke('set_window_size', { width: Math.round(sz.width / sf), height: h });
  } catch(e) {}
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

