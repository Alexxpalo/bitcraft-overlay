const settlement = getSettlement();
let craftsData = null;
let itemsMap = {};

async function poll() {
  if (!settlement) { render(); return; }
  setStatus('refreshing…');
  try {
    const j = await bitjita(`crafts?claimEntityId=${encodeURIComponent(settlement.id)}`);
    craftsData = j.craftResults || [];
    itemsMap = {};
    for (const item of (j.items || [])) itemsMap[item.id] = item.name;
    setStatus('● live', 'ok');
  } catch(e) {
    setStatus('error: ' + e, 'err');
  }
  render();
}

function craftName(job) {
  const first = (job.craftedItem || [])[0];
  if (first) {
    const id = first.item_id ?? first.id ?? first.entityId;
    if (id && itemsMap[id]) return itemsMap[id];
  }
  return job.recipeName || job.buildingName || (job.recipeId ? `#${job.recipeId}` : 'Craft');
}

function render() {
  const el = document.getElementById('list');
  if (!settlement) {
    el.innerHTML = '<div class="hint">No settlement selected.</div>';
    fitWindow(); return;
  }
  if (craftsData === null) {
    el.innerHTML = '<div class="hint">loading…</div>';
    fitWindow(); return;
  }
  const active = craftsData.filter(j => !j.completed);
  if (active.length === 0) {
    el.innerHTML = '<div class="hint">No active crafts.</div>';
    fitWindow(); return;
  }
  el.innerHTML = active.map(job => {
    const name   = craftName(job);
    const member = job.ownerUsername || job.memberName || '';
    const qty    = job.craftCount || 0;
    const prog   = job.progress || 0;
    const total  = job.totalActionsRequired || 0;
    const pct    = total > 0 ? Math.round(prog / total * 100) : 0;
    return `<div class="row">
      <div class="row-head">
        <span class="name">${esc(name)}${qty > 1 ? ` ×${qty}` : ''}</span>
        ${member ? `<span class="badge">${esc(member)}</span>` : ''}
        ${total > 0 ? `<span class="sub">${pct}%</span>` : ''}
      </div>
      ${total > 0 ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}
    </div>`;
  }).join('');
  fitWindow();
}

initChrome();
render();
poll();
onPollTick(poll);
