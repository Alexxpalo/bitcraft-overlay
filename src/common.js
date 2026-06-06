// Shared helpers for all overlay windows.
const T = window.__TAURI__;

// Centralized localStorage keys — avoids typos that would silently lose data.
const LS = {
  settlement:     'bc-settlement',
  dismissedUpdate:'bc-dismissed-update',
  activeTab:      'bc-active-tab',
  goals:          'bc-goals',
  iconsMap:       'bc-icons-map',
  itemsMap:       'bc-items-map',
  tasksPlayer:    'bc-tasks-player',
  tasksPlayerId:  'bc-tasks-player-id',
  buffNotify:     'bc-buff-notify',
  buffNotifyLead: 'bc-buff-notify-lead',
  craftNotify:    'bc-craft-notify',
  craftStallSec:  'bc-craft-stall-sec',
  posMain:        'bc-pos-main',
  hMain:          'bc-h-main',
  collapsed:      'bc-collapsed',
};

// Request queue: at most one request per 250 ms (~4 req/s ceiling). Identical
// paths still in flight collapse into a single queued request (see _reqWaiters).
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
    .then(r => { reportApi(true);  waiters.forEach(w => w.resolve(r)); })
    .catch(e => { reportApi(false); waiters.forEach(w => w.reject(e)); });
  setTimeout(_drainQueue, 250);
}

// API health indicator. Surface a header warning only after a sustained failure
// streak — a lone 404/transient blip resets on the next successful request.
let _apiFail = 0;
function reportApi(ok) {
  _apiFail = ok ? 0 : _apiFail + 1;
  const el = document.getElementById('api-health');
  if (el) el.style.display = _apiFail >= 2 ? '' : 'none';
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
function getSettlement() { try { return JSON.parse(localStorage.getItem(LS.settlement) || 'null'); } catch { return null; } }
function setSettlement(s) { localStorage.setItem(LS.settlement, JSON.stringify(s)); }

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Parse JSON from (possibly corrupt) localStorage without throwing.
function safeParse(json, fallback) {
  try { const v = JSON.parse(json ?? 'null'); return v == null ? fallback : v; }
  catch { return fallback; }
}

async function checkForUpdate() {
  if (!T?.core) return;
  try {
    const info = await T.core.invoke('check_for_update');
    const ver = info?.available;
    // Guard hard: only nag for a genuinely newer, non-empty version (the Rust
    // side already enforces this, but double-checking here makes the
    // "perpetual / blank update banner" class of bug impossible).
    if (!ver || ver === info.current) return;
    if (localStorage.getItem(LS.dismissedUpdate) === ver) return;
    document.getElementById('update-ver').textContent = ver;
    document.getElementById('update-banner').style.display = 'flex';
  } catch(e) {}
}

async function doInstallUpdate() {
  if (!T?.core) return;
  const banner = document.getElementById('update-banner');
  banner.innerHTML = '<span>Downloading update…</span>';
  // Rust emits this once the download finishes and the (possibly privileged)
  // install begins — on Linux .deb/.rpm this is when a password prompt appears.
  let unlisten;
  try {
    unlisten = await T?.event?.listen?.('update-installing', () => {
      banner.innerHTML = '<span>Installing… confirm any password prompt</span>';
    });
  } catch(e) {}
  try {
    await T.core.invoke('install_update');
  } catch(e) {
    banner.innerHTML = `<span>Error: ${esc(String(e))}</span><button id="update-err-dismiss">✕</button>`;
    // No inline onclick — blocked under CSP; bind explicitly.
    document.getElementById('update-err-dismiss')?.addEventListener('click', dismissUpdate);
  } finally {
    if (typeof unlisten === 'function') unlisten();
  }
}

// Short notification sound. Uses the bundled WAV; if it can't load/play
// (e.g. autoplay policy), falls back to a synthesized Web Audio chime.
let _notifyAudio = null;
function playNotifySound() {
  try {
    if (!_notifyAudio) { _notifyAudio = new Audio('notify.wav'); _notifyAudio.volume = 0.6; }
    _notifyAudio.currentTime = 0;
    const p = _notifyAudio.play();
    if (p && p.catch) p.catch(() => beepNotify());
  } catch(e) { beepNotify(); }
}

// Fallback two-tone chime via Web Audio, in case the WAV element can't play.
function beepNotify() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const tone = (freq, start, dur) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + start); osc.stop(ctx.currentTime + start + dur);
    };
    tone(880, 0, 0.14); tone(1318.51, 0.1, 0.22);
    setTimeout(() => ctx.close(), 500);
  } catch(e) {}
}

// Desktop notification via the notification plugin (global Tauri API).
// Requests permission on first use; silently no-ops if unavailable/denied.
// Always plays a sound so the alert is noticed even with the overlay hidden.
let _notifyPerm = null; // null=unknown, true/false once resolved
async function notify(title, body) {
  playNotifySound();
  const n = T?.notification;
  if (!n) return;
  try {
    if (_notifyPerm === null) {
      _notifyPerm = await n.isPermissionGranted();
      if (!_notifyPerm) _notifyPerm = (await n.requestPermission()) === 'granted';
    }
    if (_notifyPerm) n.sendNotification({ title, body });
  } catch(e) {}
}

// Resolve notification permission once at startup so later notify() calls fire immediately.
async function primeNotify() {
  const n = T?.notification;
  if (!n || _notifyPerm !== null) return;
  try {
    _notifyPerm = await n.isPermissionGranted();
    if (!_notifyPerm) _notifyPerm = (await n.requestPermission()) === 'granted';
  } catch(e) {}
}

function dismissUpdate() {
  const ver = document.getElementById('update-ver')?.textContent;
  if (ver) localStorage.setItem(LS.dismissedUpdate, ver);
  const banner = document.getElementById('update-banner');
  if (banner) banner.style.display = 'none';
}

function relTime(ts) {
  if (!ts) return '';
  // API timestamps look like "2026-06-01 17:30:36+00". The bare "+00"/"+0000"
  // offset isn't valid ISO 8601, so Date() rejects it — normalize to "+00:00".
  let str = String(ts).trim().replace(' ', 'T')
    .replace(/(T\d{2}:\d{2}(?::\d{2})?)([+-]\d{2})(\d{2})?$/, (m, t, h, mm) => `${t}${h}:${mm || '00'}`);
  const then = new Date(str).getTime();
  if (isNaN(then)) return ts;
  const s = Math.floor((Date.now() - then) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
