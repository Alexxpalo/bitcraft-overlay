const settlement = getSettlement();
let projectsData = null;

async function poll() {
  if (!settlement) { render(); return; }
  setStatus('refreshing…');
  try {
    const j = await bitjita(`claims/${settlement.id}/construction`);
    projectsData = j.projects || [];
    setStatus('● live', 'ok');
  } catch(e) {
    setStatus('error: ' + e, 'err');
  }
  render();
}

function matLine(items, cargos) {
  const all = [...(items || []), ...(cargos || [])];
  if (all.length === 0) return '';
  const nameMap = JSON.parse(localStorage.getItem('bc-items-map') || '{}');
  return '<div style="margin-top:2px">' +
    all.map(m => {
      const name = nameMap[m.item_id] || `#${m.item_id}`;
      return `<span class="mat">${esc(name)} ×${m.quantity}</span>`;
    }).join('') + '</div>';
}

function render() {
  const el = document.getElementById('list');
  if (!settlement) {
    el.innerHTML = '<div class="hint">No settlement selected.</div>';
    fitWindow(); return;
  }
  if (projectsData === null) {
    el.innerHTML = '<div class="hint">loading…</div>';
    fitWindow(); return;
  }
  if (projectsData.length === 0) {
    el.innerHTML = '<div class="hint">No active builds.</div>';
    fitWindow(); return;
  }
  el.innerHTML = projectsData.map(p => {
    const req  = p.actionsRequired || 0;
    const prog = p.progress || 0;
    const pct  = req ? Math.round(prog / req * 100) : 0;
    const mats = matLine(p.items, p.cargos);
    return `<div class="row">
      <div class="row-head">
        <span class="name">${esc(p.buildingName || p.recipeName || 'Build')}</span>
        <span class="sub">${pct}%</span>
      </div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      ${mats}
    </div>`;
  }).join('');
  fitWindow();
}

initChrome();
render();
poll();
onPollTick(poll);
