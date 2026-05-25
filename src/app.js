const POLL_MS = 20000;

let watched = JSON.parse(localStorage.getItem('bc-watched') || '[]'); // lowercase usernames
const players = new Map(); // lowercase name â†’ { username, signedIn, lastLogin } | null (not found)
let pollTimer = null;

// â”€â”€ data â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function fetchPlayer(name) {
  // Go through the Rust backend to avoid CORS on bitwasp.com
  const j = await window.__TAURI__.core.invoke('fetch_player', { name });
  const match = (j.players || []).find(p => (p.username || '').toLowerCase() === name);
  return match
    ? { username: match.username, signedIn: !!match.signedIn, lastLogin: match.lastLoginTimestamp }
    : null;
}

async function poll() {
  if (watched.length === 0) { render(); return; }
  setStatus('refreshingâ€¦', '');
  await Promise.all(watched.map(async name => {
    try { players.set(name, await fetchPlayer(name)); }
    catch (e) { log(`${name}: ${e.message}`); }
  }));
  setStatus('â— live', 'connected');
  render();
}

// â”€â”€ watch list â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function addWatch() {
  const inp = document.getElementById('name-input');
  const name = inp.value.trim().toLowerCase();
  if (!name) return;
  if (!watched.includes(name)) {
    watched.push(name);
    localStorage.setItem('bc-watched', JSON.stringify(watched));
    fetchPlayer(name).then(p => { players.set(name, p); render(); }).catch(() => {});
  }
  inp.value = '';
  render();
}

function removeWatch(name) {
  watched = watched.filter(n => n !== name);
  players.delete(name);
  localStorage.setItem('bc-watched', JSON.stringify(watched));
  render();
}

// â”€â”€ UI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function render() {
  const el = document.getElementById('players');
  if (watched.length === 0) {
    el.innerHTML = '<div class="hint">Add a friend\'s username to see if they\'re online.</div>';
    return;
  }
  el.innerHTML = watched.map(name => {
    const p = players.get(name);
    const resolved = p !== undefined;
    const found = !!p;
    const online = found && p.signedIn;
    const dotCls = !resolved ? 'unknown' : !found ? 'unknown' : online ? '' : 'offline';
    const disp = found ? p.username : name;
    let status;
    if (!resolved) status = 'â€¦';
    else if (!found) status = 'not found';
    else if (online) status = 'online';
    else status = p.lastLogin ? `last seen ${relTime(p.lastLogin)}` : 'offline';
    return `<div class="player">
      <div class="dot ${dotCls}"></div>
      <span class="pname">${esc(disp)}</span>
      <span class="pstatus">${esc(status)}</span>
      <button class="rm" data-n="${esc(name)}">âœ•</button>
    </div>`;
  }).join('');
  el.querySelectorAll('.rm').forEach(b => b.addEventListener('click', () => removeWatch(b.dataset.n)));
}

function relTime(ts) {
  const then = new Date(ts.replace(' ', 'T')).getTime();
  if (isNaN(then)) return ts;
  const s = Math.floor((Date.now() - then) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}

function setStatus(text, cls) {
  const el = document.getElementById('status');
  el.textContent = text;
  el.className = cls;
}

function log(msg) {
  const el = document.getElementById('raw');
  el.textContent += msg + '\n';
  el.scrollTop = el.scrollHeight;
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }

// â”€â”€ init â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
document.getElementById('add-btn').addEventListener('click', addWatch);
document.getElementById('name-input').addEventListener('keydown', e => { if (e.key === 'Enter') addWatch(); });

document.getElementById('drag-bar').addEventListener('mousedown', (e) => {
  if (e.button === 0) window.__TAURI__?.window?.getCurrentWindow()?.startDragging();
});
document.getElementById('close-btn').addEventListener('click', () => {
  window.__TAURI__?.window?.getCurrentWindow()?.close();
});

render();
poll();
pollTimer = setInterval(poll, POLL_MS);

