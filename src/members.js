const settlement = getSettlement();
let membersData = null;

async function fetchStatus(userName) {
  try {
    const j = await bitwasp(`players?q=${encodeURIComponent(userName)}`);
    const p = (j.players || []).find(pl =>
      (pl.username || '').toLowerCase() === userName.toLowerCase()
    );
    return p ? { signedIn: !!p.signedIn, lastLogin: p.lastLoginTimestamp } : null;
  } catch(e) { return null; }
}

async function poll() {
  if (!settlement) { render(); return; }
  setStatus('refreshingâ€¦');
  try {
    const j = await bitwasp(`claims/${settlement.id}/citizens`);
    const citizens = j.citizens || [];
    const results = await Promise.all(citizens.map(async c => {
      const status = await fetchStatus(c.userName);
      return { userName: c.userName, signedIn: status?.signedIn ?? false, lastLogin: status?.lastLogin ?? null };
    }));
    membersData = results;
    setStatus('â— live', 'ok');
  } catch(e) {
    setStatus('error: ' + e, 'err');
  }
  render();
}

function render() {
  const el = document.getElementById('list');
  if (!settlement) {
    el.innerHTML = '<div class="hint">No settlement selected.</div>';
    fitWindow(); return;
  }
  if (membersData === null) {
    el.innerHTML = '<div class="hint">loadingâ€¦</div>';
    fitWindow(); return;
  }
  if (membersData.length === 0) {
    el.innerHTML = '<div class="hint">No members found.</div>';
    fitWindow(); return;
  }
  const sorted = [...membersData].sort((a, b) => {
    if (a.signedIn !== b.signedIn) return a.signedIn ? -1 : 1;
    return (a.userName || '').localeCompare(b.userName || '');
  });
  const onlineCount = sorted.filter(m => m.signedIn).length;
  const counter = document.getElementById('member-count');
  if (counter) counter.textContent = `${onlineCount}/${sorted.length}`;
  el.innerHTML = sorted.map(m => {
    const st = m.signedIn ? 'online' : m.lastLogin ? relTime(m.lastLogin) : 'offline';
    return `<div class="row"><div class="row-head">
      <div class="dot ${m.signedIn ? '' : 'offline'}"></div>
      <span class="name">${esc(m.userName)}</span>
      <span class="sub">${esc(st)}</span>
    </div></div>`;
  }).join('');
  fitWindow();
}

initChrome();
render();
poll();
onPollTick(poll);

