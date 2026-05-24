const POLL_MS = 20000;
let watched = JSON.parse(localStorage.getItem('bc-watched') || '[]'); // lowercase usernames
const players = new Map(); // name → { username, signedIn, lastLogin } | null

async function fetchPlayer(name) {
  const j = await bitjita(`players?q=${encodeURIComponent(name)}`);
  const m = (j.players || []).find(p => (p.username || '').toLowerCase() === name);
  return m ? { username: m.username, signedIn: !!m.signedIn, lastLogin: m.lastLoginTimestamp } : null;
}

async function poll() {
  if (watched.length === 0) { render(); return; }
  setStatus('refreshing…');
  await Promise.all(watched.map(async n => {
    try { players.set(n, await fetchPlayer(n)); } catch (e) { /* keep old */ }
  }));
  setStatus('● live', 'ok');
  render();
}

function addWatch() {
  const inp = document.getElementById('name-input');
  const name = inp.value.trim().toLowerCase();
  if (name && !watched.includes(name)) {
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

function render() {
  const el = document.getElementById('list');
  if (watched.length === 0) { el.innerHTML = '<div class="hint">Add a friend\'s username.</div>'; return; }
  el.innerHTML = watched.map(name => {
    const p = players.get(name);
    const resolved = p !== undefined, found = !!p, online = found && p.signedIn;
    const dot = !resolved || !found ? 'unknown' : online ? '' : 'offline';
    const disp = found ? p.username : name;
    let st;
    if (!resolved) st = '…';
    else if (!found) st = 'not found';
    else if (online) st = 'online';
    else st = p.lastLogin ? `last seen ${relTime(p.lastLogin)}` : 'offline';
    return `<div class="row"><div class="row-head">
      <div class="dot ${dot}"></div>
      <span class="name">${esc(disp)}</span>
      <span class="row-sub">${esc(st)}</span>
      <button class="rm" data-n="${esc(name)}">✕</button>
    </div></div>`;
  }).join('');
  el.querySelectorAll('.rm').forEach(b => b.addEventListener('click', () => removeWatch(b.dataset.n)));
}

initChrome();
document.getElementById('add-btn').addEventListener('click', addWatch);
document.getElementById('name-input').addEventListener('keydown', e => { if (e.key === 'Enter') addWatch(); });
render();
poll();
setInterval(poll, POLL_MS);
