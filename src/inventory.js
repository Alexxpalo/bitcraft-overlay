const settlement = getSettlement();
let allRows = null;   // full unfiltered list after poll
let sortKey = 'name-asc';

async function poll() {
  if (!settlement) { render(); return; }
  setStatus('refreshing…');
  try {
    const j = await bitjita(`claims/${settlement.id}/inventories`);

    // Build id → name map from both items and cargos arrays
    const itemsMap = {};
    for (const it of (j.items  || [])) itemsMap[it.id] = it.name;
    for (const it of (j.cargos || [])) itemsMap[it.id] = it.name;

    // Aggregate quantities across all buildings
    const totals = {};
    for (const b of (j.buildings || [])) {
      for (const slot of (b.inventory || [])) {
        const c = slot.contents;
        if (!c || !c.item_id) continue;
        totals[c.item_id] = (totals[c.item_id] || 0) + (c.quantity || 0);
      }
    }

    allRows = Object.entries(totals)
      .map(([id, qty]) => ({ name: itemsMap[id] || `#${id}`, qty }));

    // Share items map with other panels (e.g. construction material names)
    localStorage.setItem('bc-items-map', JSON.stringify(itemsMap));

    setStatus('● live', 'ok');
  } catch(e) {
    setStatus('error: ' + e, 'err');
  }
  render();
}

function getVisible() {
  if (!allRows) return null;
  const q = (document.getElementById('inv-search')?.value || '').trim().toLowerCase();
  let rows = q ? allRows.filter(r => r.name.toLowerCase().includes(q)) : allRows;

  rows = [...rows]; // don't mutate allRows
  switch (sortKey) {
    case 'name-asc':  rows.sort((a, b) => a.name.localeCompare(b.name)); break;
    case 'name-desc': rows.sort((a, b) => b.name.localeCompare(a.name)); break;
    case 'qty-desc':  rows.sort((a, b) => b.qty - a.qty); break;
    case 'qty-asc':   rows.sort((a, b) => a.qty - b.qty); break;
  }
  return rows;
}

function render() {
  const el = document.getElementById('list');
  if (!settlement) {
    el.innerHTML = '<div class="hint">No settlement selected.</div>';
    fitWindow(500); return;
  }
  if (allRows === null) {
    el.innerHTML = '<div class="hint">loading…</div>';
    fitWindow(500); return;
  }
  const rows = getVisible();
  if (rows.length === 0) {
    el.innerHTML = '<div class="hint">No items found.</div>';
    fitWindow(500); return;
  }
  el.innerHTML = rows.map(r =>
    `<div class="row"><div class="row-head">
      <span class="name">${esc(r.name)}</span>
      <span class="qty">×${r.qty.toLocaleString()}</span>
    </div></div>`
  ).join('');
  fitWindow(500);
}

// Wire up sort buttons
document.querySelectorAll('.sort-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    sortKey = btn.dataset.sort;
    document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    render();
  });
});

// Live search
document.getElementById('inv-search').addEventListener('input', render);

initChrome();
render();
poll();
onPollTick(poll);
