const settlement = getSettlement();
let allRows   = null;
let sortKey   = 'name-asc';
let activeGroup = null;
let activeTag   = null;

// â”€â”€ Crafting chain cache â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Persists across sessions. Stores { tag, parentId } per item id.
function chainCache() {
  return JSON.parse(localStorage.getItem('bc-chain-v3') || '{}');
}
function saveChainCache(c) {
  localStorage.setItem('bc-chain-v3', JSON.stringify(c));
}

async function fetchChainMeta(id) {
  const cache = chainCache();
  if (cache[id] !== undefined) return cache[id];
  try {
    const j = await bitwasp(`items/${id}`);
    const recipes = j.craftingRecipes || [];
    // Find the most "relevant" ingredient â€” the one with the highest discovery_score
    // (secondary items like tools/catalysts have score 0)
    let parentId = null;
    if (recipes.length > 0) {
      const stacks = (recipes[0].consumedItemStacks || [])
        .filter(s => (s.discovery_score ?? 1) > 0);
      if (stacks.length > 0) parentId = String(stacks[0].item_id);
    }
    const meta = { tag: j.item?.tag || '', parentId };
    // Always re-read cache before writing to avoid race condition overwriting other entries
    const fresh = chainCache();
    fresh[id] = meta;
    saveChainCache(fresh);
    return meta;
  } catch(e) {
    const meta = { tag: '', parentId: null };
    const fresh = chainCache();
    fresh[id] = meta;
    saveChainCache(fresh);
    return meta;
  }
}

async function getRootTag(id, depth = 0) {
  if (depth > 6) return null;
  const meta = await fetchChainMeta(id);
  if (!meta.parentId) return meta.tag || null;
  return getRootTag(meta.parentId, depth + 1);
}

// Fetch in small batches to avoid hammering the API
async function batchRootTags(ids) {
  const result = {};
  const BATCH = 6;
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    const resolved = await Promise.all(slice.map(async id => ({
      id, root: await getRootTag(id)
    })));
    for (const { id, root } of resolved) result[id] = root;
  }
  return result;
}

// â”€â”€ Poll â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function poll() {
  if (!settlement) { render(); return; }
  setStatus('refreshing…');
  try {
    const j = await bitwasp(`claims/${settlement.id}/inventories`);

    const itemsMap = {};
    for (const it of (j.items  || [])) itemsMap[it.id] = { name: it.name, tag: it.tag || '' };
    for (const it of (j.cargos || [])) itemsMap[it.id] = { name: it.name, tag: it.tag || '' };

    const totals = {};
    for (const b of (j.buildings || [])) {
      for (const slot of (b.inventory || [])) {
        const c = slot.contents;
        if (!c || !c.item_id) continue;
        totals[c.item_id] = (totals[c.item_id] || 0) + (c.quantity || 0);
      }
    }

    // Resolve root groups (cached after first run)
    const ids = Object.keys(totals);
    setStatus('building groups…');
    const rootMap = await batchRootTags(ids);

    allRows = ids.map(id => {
      const m = itemsMap[id] || { name: `#${id}`, tag: '' };
      const rootTag = rootMap[id] || m.tag || '';
      const group = rootTag.split(' ')[0] || '?';
      // Stage: strip group prefix from own tag if present ("Wood Log" â†’ "Log"), else use full tag
      const stage = m.tag.startsWith(group + ' ') ? m.tag.slice(group.length + 1) : (m.tag || '?');
      return { name: m.name, qty: totals[id], tag: stage, group };
    });

    // Share name map with construction panel
    const nameOnly = {};
    for (const [id, m] of Object.entries(itemsMap)) nameOnly[id] = m.name;
    localStorage.setItem('bc-items-map', JSON.stringify(nameOnly));

    setStatus('● live', 'ok');
    rebuildFilters();
  } catch(e) {
    setStatus('error: ' + e, 'err');
  }
  render();
}

// â”€â”€ Filters â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function rebuildFilters() {
  if (!allRows) return;

  const gSel = document.getElementById('group-filter');
  const prevGroup = gSel.value;
  const groups = [...new Set(allRows.map(r => r.group).filter(Boolean))].sort();
  gSel.innerHTML = '<option value="">All</option>' +
    groups.map(g => `<option value="${esc(g)}"${g === prevGroup ? ' selected' : ''}>${esc(g)}</option>`).join('');
  activeGroup = gSel.value || null;

  rebuildStages();
}

function rebuildStages() {
  const tSel = document.getElementById('tag-filter');
  const prevTag = tSel.value;
  const source = activeGroup ? allRows.filter(r => r.group === activeGroup) : allRows;
  const tags = [...new Set(source.map(r => r.tag).filter(Boolean))].sort();
  tSel.innerHTML = '<option value="">All stages</option>' +
    tags.map(t => `<option value="${esc(t)}"${t === prevTag ? ' selected' : ''}>${esc(t)}</option>`).join('');
  if ([...tSel.options].some(o => o.value === prevTag)) tSel.value = prevTag;
  activeTag = tSel.value || null;
}

// â”€â”€ Render â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function getVisible() {
  if (!allRows) return null;
  const q = (document.getElementById('inv-search')?.value || '').trim().toLowerCase();
  let rows = allRows;
  if (q)           rows = rows.filter(r => r.name.toLowerCase().includes(q));
  if (activeGroup) rows = rows.filter(r => r.group === activeGroup);
  if (activeTag)   rows = rows.filter(r => r.tag   === activeTag);
  rows = [...rows];
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

// â”€â”€ Wire up controls â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
document.querySelectorAll('#inv-sort .sort-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    sortKey = btn.dataset.sort;
    document.querySelectorAll('#inv-sort .sort-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    render();
  });
});

document.getElementById('inv-search').addEventListener('input', render);

document.getElementById('group-filter').addEventListener('change', (e) => {
  activeGroup = e.target.value || null;
  activeTag   = null;
  rebuildStages();
  render();
});

document.getElementById('tag-filter').addEventListener('change', (e) => {
  activeTag = e.target.value || null;
  render();
});

initChrome();
render();
poll();
onPollTick(poll);

