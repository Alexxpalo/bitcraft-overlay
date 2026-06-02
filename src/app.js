// ─── State ────────────────────────────────────────────────────────────────
let settlement = getSettlement();
let activeTab = localStorage.getItem(LS.activeTab) || 'storage';
let storageMode = 'plan'; // 'plan' | 'items'
let allItems = null;
let _storageSig = null;  // signature of last-rendered storage data (skip no-op re-renders)
let _planSearchTimer = null;  // debounce timer for the craft-plan item search
let buildsData = null;
let jobsData = null;
let membersData = null;
let tasksData = null;  // null=idle, 'loading', 'noplayer', { tasks, items, cargo, skillMap, expiration }
let buffsData = null;  // null=idle, 'loading', 'noplayer', { buffs, isOnline }
const _buffWarned = new Set();   // buffIds already warned this episode (re-armed when the buff disappears)
const _craftTrack = new Map();   // craft entityId → { progress, changeTs, armed, warned }
let claimData = null;
let _skillMap = null;
let itemsMap = safeParse(localStorage.getItem(LS.itemsMap), {}); // id → name, single in-memory cache
let craftGoals = safeParse(localStorage.getItem(LS.goals), {});
let _planSearchResults = null; // null=idle, 'loading', []=results

const _lastPoll = {};
const ACTIVE_STALE_MS = 5000;
const BG_STALE_MS = 30000;
// Members do N per-citizen player lookups per refresh; online status doesn't need
// 5s granularity, so poll that tab less often to cut request volume.
const STALE_OVERRIDE = { members: { active: 15000, bg: 60000 } };
const activeStale = tab => STALE_OVERRIDE[tab]?.active || ACTIVE_STALE_MS;
const bgStale     = tab => STALE_OVERRIDE[tab]?.bg     || BG_STALE_MS;
function _poll(tab) {
  _lastPoll[tab] = Date.now();
  ({ storage: pollStorage, builds: pollBuilds, jobs: pollJobs, members: pollMembers, tasks: pollTasks, buffs: pollBuffs, claim: pollClaim })[tab]?.();
}
function _pollIfStale(tab, staleMs) {
  if (Date.now() - (_lastPoll[tab] || 0) > staleMs) _poll(tab);
}

const TAB_ORDER = ['storage', 'builds', 'jobs', 'tasks', 'buffs', 'members', 'settings'];
function switchTab(id) {
  if (!TAB_ORDER.includes(id) || id === activeTab) return;
  activeTab = id;
  localStorage.setItem(LS.activeTab, id);
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === id));
  renderTab(id);
  _pollIfStale(id, activeStale(id));
}

const fmt = n => Number(n).toLocaleString('en-US');
// Compact thousands: 4865 → "4.9k", 150000 → "150k", 999 → "999".
const fmtK = n => {
  n = Number(n) || 0;
  if (n < 1000) return fmt(n);
  const v = n / 1000;
  return (v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')) + 'k';
};
// esc() comes from common.js

// ─── Item icons ───────────────────────────────────────────────────────────
// iconAssetName comes in two shapes depending on endpoint:
//   inventories → "GeneratedIcons/Items/Bait"   (with prefix)
//   item search → "Items/FishFilet"             (without prefix)
// Normalize to a bare "Items/Bait" path, then serve the webp from:
const ICON_BASE = 'https://bitjita.com/GeneratedIcons/';
function normIcon(asset) {
  return String(asset || '').replace(/^\/+/, '').replace(/^GeneratedIcons\//, '');
}
let _iconMap = null;
// Cap a growing id→value cache so it can't bloat localStorage forever. JS keeps
// string-key insertion order, so dropping the first keys ≈ evicting the oldest.
function capMap(m, max) {
  const k = Object.keys(m);
  if (k.length > max) for (const key of k.slice(0, k.length - max)) delete m[key];
  return m;
}
function iconMap() { return _iconMap ?? (_iconMap = JSON.parse(localStorage.getItem(LS.iconsMap) || '{}')); }
function saveIcon(id, asset) {
  if (!id || !asset) return;
  const a = normIcon(asset);
  const m = iconMap();
  if (m[id] !== a) { m[id] = a; localStorage.setItem(LS.iconsMap, JSON.stringify(capMap(m, 5000))); }
}
function iconImg(asset, cls = 'item-icon') {
  const a = normIcon(asset);
  if (!a) return `<span class="${cls} blank"></span>`;
  return `<img class="${cls}" src="${esc(ICON_BASE + a + '.webp')}" alt="" loading="lazy">`;
}

// ─── Full recipe cache (craft planner) ───────────────────────────────────
// { [id]: { name, tag, outputQty, ingredients:[{id,qty}] } | null }
const RECIPE_KEY = 'bc-recipe-v3'; // v3: skip package-unpack recipes (invalidates old v2 cache)
let _recipeCache = null;
function recipeCache() { return _recipeCache ?? (_recipeCache = JSON.parse(localStorage.getItem(RECIPE_KEY) || '{}')); }
function saveRecipeEntry(id, val) {
  const c = recipeCache(); c[id] = val;
  localStorage.setItem(RECIPE_KEY, JSON.stringify(capMap(c, 4000)));
}

function _saveName(id, name) {
  if (!name || itemsMap[id]) return;
  itemsMap[id] = name;
  localStorage.setItem(LS.itemsMap, JSON.stringify(capMap(itemsMap, 5000)));
}

const _recipeInFlight = new Map();
async function fetchRecipe(id) {
  const cache = recipeCache();
  if (id in cache) return cache[id];
  if (_recipeInFlight.has(id)) return _recipeInFlight.get(id);
  const p = (async () => {
  // Try items endpoint
  try {
    const j = await bitwasp(`items/${id}`);
    if (!j.error) {
      const name = j.item?.name || j.name || null;
      const tag  = j.item?.tag  || '';
      _saveName(id, name);
      saveIcon(id, j.item?.iconAssetName);
      const recipes = j.craftingRecipes || [];
      let result;
      // Ingredients that actually count toward a craft (discovery_score>0).
      const ingredientsOf = r => (r.consumedItemStacks || [])
        .filter(s => (s.discovery_score ?? 1) > 0 && s.item_id);
      // "Unpack from a package": a single bundle item (qty 1) producing a large
      // stack. Skipping these stops raw materials (Plant Fiber, Sand, …) from
      // pulling their packages into the plan as fake requirements.
      const isPackaging = r => {
        const ing = ingredientsOf(r);
        const out = r.producedQuantity || r.outputQuantity || 1;
        return ing.length === 1 && (ing[0].quantity || 1) === 1 && out >= 25;
      };
      const recipe = recipes.find(r => !isPackaging(r) && ingredientsOf(r).length > 0);
      if (recipe) {
        const stacks = ingredientsOf(recipe);
        result = {
          name, tag,
          outputQty: recipe.producedQuantity || recipe.outputQuantity || 1,
          ingredients: stacks.map(s => ({ id: String(s.item_id), qty: s.quantity || 1 }))
        };
      }
      if (!result) result = { name, tag, outputQty: 1, ingredients: [] };
      saveRecipeEntry(id, result);
      return result;
    }
  } catch(e) {}

  // Try cargo endpoint as fallback
  try {
    const j = await bitwasp(`cargo/${id}`);
    if (!j.error) {
      const name = j.cargo?.name || j.name || null;
      const tag  = j.cargo?.tag  || '';
      _saveName(id, name);
      saveIcon(id, j.cargo?.iconAssetName);
      const result = { name, tag, outputQty: 1, ingredients: [] };
      saveRecipeEntry(id, result);
      return result;
    }
  } catch(e) {}

  // Unknown item — save placeholder so we stop retrying
  const fallback = { name: null, tag: '', outputQty: 1, ingredients: [] };
  saveRecipeEntry(id, fallback);
  return fallback;
  })();
  _recipeInFlight.set(id, p);
  try { return await p; } finally { _recipeInFlight.delete(id); }
}

// ─── Poll functions ───────────────────────────────────────────────────────
async function pollStorage() {
  if (!settlement) return;
  // Don't wipe to a "Refreshing…" placeholder on every 5s background poll — it
  // flickers. renderStorage() already shows a loading hint while allItems is null.
  try {
    const j = await bitwasp(`claims/${settlement.id}/inventories`);
    const im = {};
    for (const it of [...(j.items || []), ...(j.cargos || [])]) {
      im[it.id] = { name: it.name, tag: it.tag || '', icon: it.iconAssetName || '' };
      saveIcon(it.id, it.iconAssetName);
    }
    const totals = {};
    for (const b of (j.buildings || [])) {
      for (const slot of (b.inventory || [])) {
        const c = slot.contents;
        if (c?.item_id) totals[c.item_id] = (totals[c.item_id] || 0) + (c.quantity || 0);
      }
    }
    const ids = Object.keys(totals);
    // Merge (don't wipe) so names learned from jobs/recipes/tasks survive.
    for (const [id, m] of Object.entries(im)) itemsMap[id] = m.name;
    localStorage.setItem(LS.itemsMap, JSON.stringify(capMap(itemsMap, 5000)));

    allItems = ids.map(id => {
      const m = im[id] || { name: `#${id}`, tag: '', icon: '' };
      return { id, name: m.name, qty: totals[id], tag: m.tag, icon: m.icon };
    });
    // Skip re-render when nothing changed, so idle 5s polls don't rebuild the
    // list (which would reset scroll position and the search input cursor).
    const sig = allItems.map(i => `${i.id}:${i.qty}`).sort().join('|');
    if (sig === _storageSig) return;
    _storageSig = sig;
  } catch(e) { console.error('storage poll:', e); }
  if (activeTab === 'storage') renderTab('storage');
}

async function pollBuilds() {
  if (!settlement) return;
  try {
    const j = await bitwasp(`claims/${settlement.id}/construction`);
    buildsData = j.projects || [];
  } catch(e) { buildsData = []; console.error('builds poll:', e); }
  if (activeTab === 'builds') renderTab('builds');
}

async function pollJobs() {
  if (!settlement) return;
  try {
    const j = await bitwasp(`crafts?claimEntityId=${encodeURIComponent(settlement.id)}`);
    for (const it of (j.items || [])) itemsMap[it.id] = it.name;
    jobsData = (j.craftResults || []).filter(x => !x.completed);
  } catch(e) { jobsData = []; console.error('jobs poll:', e); }
  if (activeTab === 'jobs') renderTab('jobs');
}

async function pollMembers() {
  if (!settlement) return;
  try {
    const j = await bitwasp(`claims/${settlement.id}/citizens`);
    const citizens = j.citizens || [];
    membersData = await Promise.all(citizens.map(async c => {
      try {
        const pj = await bitwasp(`players?q=${encodeURIComponent(c.userName)}`);
        const p = (pj.players || []).find(pl => (pl.username || '').toLowerCase() === c.userName.toLowerCase());
        return { name: c.userName, online: !!p?.signedIn, last: p?.lastLoginTimestamp ?? null };
      } catch { return { name: c.userName, online: false, last: null }; }
    }));
  } catch(e) { membersData = []; console.error('members poll:', e); }
  updateOnlineBadge();
  if (activeTab === 'members') renderTab('members');
}

// ─── Traveler tasks ───────────────────────────────────────────────────────
async function resolveTasksPlayerId() {
  const name = localStorage.getItem(LS.tasksPlayer);
  if (!name) return null;
  const cached = localStorage.getItem(LS.tasksPlayerId);
  if (cached) return cached;
  try {
    const j = await bitwasp(`players?q=${encodeURIComponent(name)}`);
    const p = (j.players || []).find(pl => (pl.username || '').toLowerCase() === name.toLowerCase());
    if (!p) return null;
    const id = String(p.entityId || '');
    if (id) localStorage.setItem(LS.tasksPlayerId, id);
    return id || null;
  } catch { return null; }
}

async function getSkillMap() {
  if (_skillMap) return _skillMap;
  try {
    const j = await bitwasp('skills');
    const m = {};
    for (const cat of Object.values(j)) {
      if (Array.isArray(cat)) for (const s of cat) m[s.id] = s.name;
    }
    _skillMap = m;
  } catch { _skillMap = {}; }
  return _skillMap;
}

async function pollTasks() {
  if (!localStorage.getItem(LS.tasksPlayer)) { tasksData = null; if (activeTab === 'tasks') renderTab('tasks'); return; }
  const id = await resolveTasksPlayerId();
  if (!id) { tasksData = 'noplayer'; if (activeTab === 'tasks') renderTab('tasks'); return; }
  try {
    const [j, skillMap] = await Promise.all([ bitwasp(`players/${id}/traveler-tasks`), getSkillMap() ]);
    tasksData = {
      tasks: j.tasks || [],
      items: j.items || {},
      cargo: j.cargo || {},
      skillMap,
      expiration: j.expirationTimestamp || null,
    };
  } catch(e) { tasksData = { tasks: [], items: {}, cargo: {}, skillMap: {}, expiration: null }; console.error('tasks poll:', e); }
  if (activeTab === 'tasks') renderTab('tasks');
}

function taskItemName(td, ref) {
  const src = ref.item_type === 'cargo' ? td.cargo : td.items;
  const meta = src[ref.item_id] || td.items[ref.item_id] || td.cargo[ref.item_id];
  return meta ? meta.name : `#${ref.item_id}`;
}

// ─── Buffs ──────────────────────────────────────────────────────────────────
const fmtDur = secs => {
  secs = Math.max(0, Math.floor(secs));
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
};
// Coarse countdown from a millisecond delta: "13d" (>3d), "3d 5h", or "5h".
const fmtCountdown = ms => {
  const h = Math.floor(Math.max(0, ms) / 3600000), d = Math.floor(h / 24);
  return d > 3 ? `${d}d` : d > 0 ? `${d}d ${h % 24}h` : `${h}h`;
};

async function pollBuffs() {
  if (!localStorage.getItem(LS.tasksPlayer)) { buffsData = 'noplayer'; if (activeTab === 'buffs') renderTab('buffs'); return; }
  const id = await resolveTasksPlayerId();
  if (!id) { buffsData = 'noplayer'; if (activeTab === 'buffs') renderTab('buffs'); return; }
  try {
    const j = await bitwasp(`players/${id}/buffs`);
    const buffs = (j.buffs || []).filter(b => b.status !== 'expired' && (b.timeRemaining > 0 || b.buffDuration === 0));
    buffsData = { buffs, isOnline: !!j.isOnline };
  } catch(e) { buffsData = { buffs: [], isOnline: false }; console.error('buffs poll:', e); }
  checkBuffExpiry();
  if (activeTab === 'buffs') renderTab('buffs');
}

function checkBuffExpiry() {
  if (localStorage.getItem(LS.buffNotify) === '0') return;
  if (!buffsData || typeof buffsData !== 'object') return;
  const lead = Number(localStorage.getItem(LS.buffNotifyLead)) || 60;
  const present = new Set();
  for (const b of buffsData.buffs) {
    // Only warn for buffs long enough that crossing the lead window is a real
    // "about to expire" event — short/recurring buffs would always be ≤ lead.
    if (!b.beneficial || !(b.buffDuration > lead)) continue;
    present.add(b.buffId);
    if (b.timeRemaining > 0 && b.timeRemaining <= lead && !_buffWarned.has(b.buffId)) {
      _buffWarned.add(b.buffId);
      notify('Buff expiring', `${b.buffName} — ${fmtDur(b.timeRemaining)} left`);
    }
  }
  // Re-arm a buff only once it has disappeared (e.g. expired, then re-applied).
  for (const id of [..._buffWarned]) if (!present.has(id)) _buffWarned.delete(id);
}

function renderBuffs() {
  const name = localStorage.getItem(LS.tasksPlayer) || '';
  if (!name || buffsData === 'noplayer') return '<div class="hint">Set your player name in Settings to track buffs.</div>';
  if (buffsData === null || buffsData === 'loading') { if (buffsData === null) { buffsData = 'loading'; setTimeout(pollBuffs, 0); } return '<div class="hint">Loading…</div>'; }
  const buffs = buffsData.buffs || [];
  if (!buffs.length) return `<div class="hint">No active buffs${buffsData.isOnline ? '' : ' (player offline)'}.</div>`;
  const sorted = [...buffs].sort((a, b) => {
    const pa = a.buffDuration === 0, pb = b.buffDuration === 0;
    if (pa !== pb) return pa ? 1 : -1;            // permanent buffs last
    return (a.timeRemaining || 0) - (b.timeRemaining || 0);
  });
  const cards = sorted.map(b => {
    const perm = b.buffDuration === 0;
    const expires = (b.buffStartTimestamp + b.buffDuration) * 1000;
    const stats = (b.stats || []).map(s => {
      const v = s.is_pct ? `${Math.round(s.value * 100)}%` : `${s.value}${esc(s.suffix || '')}`;
      const sign = (!s.is_pct && s.value > 0) ? '+' : (s.is_pct && s.value > 0 ? '+' : '');
      return `${sign}${v} ${esc(s.name || '')}`.trim();
    }).join(' · ');
    const timeHtml = perm
      ? '<span class="buff-time">∞</span>'
      : `<span class="buff-time" data-expires="${expires}">${esc(fmtDur(b.timeRemaining))}</span>`;
    return `<div class="buff-card ${b.beneficial ? 'good' : 'bad'}">
      <div class="buff-head">
        <span class="buff-name" title="${esc(b.buffName || '')}">${esc(b.buffName || 'Buff')}</span>
        ${timeHtml}
      </div>
      ${b.description ? `<div class="buff-desc">${esc(b.description)}</div>` : ''}
      ${stats ? `<div class="buff-stats">${stats}</div>` : ''}
    </div>`;
  }).join('');
  return `<div class="buffs">${cards}</div>`;
}

function tickBuffs() {
  if (activeTab !== 'buffs') return;
  const now = Date.now();
  document.querySelectorAll('.buff-time[data-expires]').forEach(el => {
    const ms = Number(el.dataset.expires) - now;
    el.textContent = ms <= 0 ? 'expired' : fmtDur(ms / 1000);
    el.classList.toggle('low', ms > 0 && ms <= 60000);
  });
}

// ─── Craft-stall detection (background notification) ─────────────────────────
async function pollCraftStall() {
  if (localStorage.getItem(LS.craftNotify) === '0') return;
  if (!localStorage.getItem(LS.tasksPlayer)) return;
  const id = await resolveTasksPlayerId();
  if (!id) return;
  let crafts;
  try {
    const j = await bitwasp(`players/${id}/crafts?completed=false`);
    crafts = j.craftResults || [];
    for (const it of (j.items || [])) itemsMap[it.id] = it.name;
  } catch(e) { console.error('craft-stall poll:', e); return; }
  const now = Date.now();
  const stallMs = (Number(localStorage.getItem(LS.craftStallSec)) || 5) * 1000;
  const present = new Set();
  for (const c of crafts) {
    if (c.completed) continue;
    const key = String(c.entityId);
    present.add(key);
    const progress = Number(c.progress) || 0;
    const prev = _craftTrack.get(key);
    if (!prev) { _craftTrack.set(key, { progress, changeTs: now, armed: false, warned: false }); continue; }
    if (progress > prev.progress) {
      // Advancing. Any observed progress arms — and re-arms — the detector.
      // (Progress commits in bursts, so requiring consecutive advancing polls
      // would almost never arm and the alert would never fire.)
      prev.progress = progress;
      prev.changeTs = now;
      prev.armed = true;
      prev.warned = false;
    } else {
      // Frozen this poll. Warn once per stop episode (warned), and only if we
      // saw it advance at least once (armed). A later advance re-arms it.
      if (prev.armed && !prev.warned && now - prev.changeTs >= stallMs) {
        const item = (c.craftedItem || [])[0];
        const name = (item && itemsMap[item.item_id]) || c.buildingName || 'Craft';
        const stallSec = Math.round(stallMs / 1000);
        notify('Crafting stopped', `${name} — no progress for ${stallSec}s (out of stamina?)`);
        prev.warned = true;
      }
    }
  }
  for (const key of [..._craftTrack.keys()]) if (!present.has(key)) _craftTrack.delete(key);
}

async function pollClaim() {
  if (!settlement) return;
  try {
    const j = await bitwasp(`claims/${settlement.id}`);
    claimData = j.claim || null;
  } catch(e) { console.error('claim poll:', e); }
  updateSupplies();
}

function updateSupplies() {
  const el = document.getElementById('settlement-tier');
  if (!el) return;
  if (!claimData) { el.style.display = 'none'; return; }
  const supplies = Number(claimData.supplies) || 0;
  const tier = claimData.tier || '';
  const runOut = claimData.suppliesRunOut; // epoch-ms
  let timeStr = '';
  let low = false;
  if (runOut) {
    const ms = runOut - Date.now();
    if (ms <= 0) { timeStr = 'empty'; low = true; }
    else { low = ms < 86400000; /* < 24 h */ timeStr = fmtCountdown(ms); }
  }
  el.className = 'settle-tier' + (low ? ' low' : '');
  el.style.display = '';
  el.textContent = `T${tier} · ◆ ${fmtK(supplies)}${timeStr ? ' · ' + timeStr : ''}`;
}

function updateOnlineBadge() {
  const badge = document.getElementById('online-badge');
  if (!badge) return;
  const online = (membersData || []).filter(m => m.online).length;
  if (online > 0) { badge.textContent = online; badge.style.display = ''; }
  else badge.style.display = 'none';
}

function pollAll() {
  for (const tab of ['storage', 'builds', 'jobs', 'members', 'tasks', 'buffs', 'claim']) _poll(tab);
}

// ─── Tab rendering ────────────────────────────────────────────────────────
function setTabContent(html) {
  const el = document.getElementById('tab-content');
  if (el) el.innerHTML = html;
}

function renderTab(id) {
  const html = {
    storage:  renderStorage,
    builds:   renderBuilds,
    jobs:     renderJobs,
    tasks:    renderTasks,
    buffs:    renderBuffs,
    members:  renderMembers,
    settings: renderSettings,
  }[id]?.() || '';
  setTabContent(html);
  bindTabEvents(id);
}

function renderStorage() {
  let out = `<div class="mode-toggle">
    <button class="${storageMode==='plan'?'on':''}" data-mode="plan">Craft plan</button>
    <button class="${storageMode==='items'?'on':''}" data-mode="items">All items</button>
  </div>`;
  if (storageMode === 'plan') out += renderCraftPlan();
  else out += renderAllItems();
  return out;
}

function renderCraftPlan() {
  if (!allItems) return '<div class="hint">Loading inventory…</div>';
  // Keep the plan editor (search + goals) live, but hold the requirements
  // breakdown until the whole recipe tree has loaded.
  const body = window._planLoading ? '<div class="hint">Loading requirements…</div>' : renderByStage();
  return renderPlanEditor() + body;
}

async function doPlanSearch(q) {
  if (q.length < 2) { _planSearchResults = null; renderTab('storage'); return; }
  // No loading re-render — keeps input alive while typing
  try {
    const j = await bitwasp(`items?q=${encodeURIComponent(q)}`);
    if ((window._planSearch || '') !== q) return; // stale, discard
    const arr = j.items || j.results || (Array.isArray(j) ? j : []);
    const invById = Object.fromEntries((allItems || []).map(i => [String(i.id), i.qty]));
    _planSearchResults = arr.slice(0, 10).map(it => {
      const rid = String(it.id ?? it.entityId ?? it.item_id);
      saveIcon(rid, it.iconAssetName);
      return {
        id: rid,
        name: it.name || it.displayName || `#${it.id}`,
        qty: invById[rid] ?? 0,
        icon: it.iconAssetName || '',
      };
    });
    for (const r of _planSearchResults) _saveName(r.id, r.name);
  } catch(e) { _planSearchResults = []; }
  if ((window._planSearch || '') === q) renderTab('storage');
}

// Recursively fetch ALL ingredients in the recipe tree for a goal item.
async function ensureGoalTree(id, depth = 0, visited = new Set()) {
  if (depth > 15 || visited.has(id)) return;
  visited.add(id);
  const recipe = await fetchRecipe(id);
  if (!recipe?.ingredients?.length) return;
  await Promise.all(recipe.ingredients.map(ing => ensureGoalTree(ing.id, depth + 1, visited)));
}

// Fetch every goal's full recipe tree, showing a loading state until done so the
// craft plan never renders a half-resolved tree (placeholder names, missing icons).
let _planLoadInFlight = false;
async function loadGoalTrees() {
  if (_planLoadInFlight) return;
  const goals = Object.keys(craftGoals);
  if (!goals.length) { window._planLoading = false; return; }
  _planLoadInFlight = true;
  window._planLoading = true;
  if (activeTab === 'storage') renderTab('storage');
  try { const visited = new Set(); await Promise.all(goals.map(id => ensureGoalTree(id, 0, visited))); }
  finally {
    _planLoadInFlight = false;
    window._planLoading = false;
    if (activeTab === 'storage') renderTab('storage');
  }
}

function renderPlanEditor() {
  const q = window._planSearch || '';
  const invById = Object.fromEntries((allItems || []).map(i => [i.id, i.qty]));
  let resultsHtml = '';
  if (q.length >= 1) {
    if (Array.isArray(_planSearchResults) && _planSearchResults.length) {
      resultsHtml = `<div class="plan-results">${_planSearchResults.map(i =>
        `<div class="plan-result" data-id="${esc(i.id)}">
          ${iconImg(i.icon, 'item-icon cp-icon')}
          <span>${esc(i.name)}</span>
          <span class="plan-result-have">${fmt(i.qty)} in stock</span>
        </div>`).join('')}</div>`;
    } else if (Array.isArray(_planSearchResults)) {
      resultsHtml = `<div class="plan-results"><div class="hint" style="padding:6px 9px">No match</div></div>`;
    }
  }
  const icons = iconMap();
  const planItems = Object.entries(craftGoals).map(([id, qty]) => {
    const inv = (allItems || []).find(i => i.id === id);
    const name = inv?.name || itemsMap[id];
    return name ? { id, name, qty, icon: icons[id] || inv?.icon || '' } : null;
  }).filter(Boolean);
  let planHtml = '';
  if (planItems.length) {
    planHtml = `<div class="plan-items">
      <div class="plan-items-head">
        <span>Plan (${planItems.length})</span>
        <button class="cp-clear-goals">Clear all</button>
      </div>
      ${planItems.map(item => `<div class="plan-item">
        ${iconImg(item.icon, 'item-icon cp-icon')}
        <span class="plan-item-name" title="${esc(item.name)}">${esc(item.name)}</span>
        <input class="cp-goal-inp plan-qty" data-id="${esc(item.id)}" type="number" min="1" value="${item.qty}">
        <button class="plan-remove" data-id="${esc(item.id)}">✕</button>
      </div>`).join('')}
    </div>
    <div class="plan-divider">Requirements</div>`;
  }
  return `<div class="plan-editor">
    <input class="inp plan-search-inp" id="plan-search" dir="ltr" placeholder="Add items to plan…" value="${esc(window._planSearch || '')}" autocomplete="off">
    ${resultsHtml}${planHtml}
  </div>`;
}

function computeNeeds() {
  if (!Object.keys(craftGoals).length) return { needs: {}, satisfied: {} };
  const cache = recipeCache();
  const invById = Object.fromEntries((allItems || []).map(i => [i.id, i.qty]));
  const nameById = Object.fromEntries((allItems || []).map(i => [i.id, i.name]));
  const nameOf = id => nameById[id] || itemsMap[id] || cache[id]?.name || `Item ${id.slice(-6)}`;
  const needs = {};       // id → gross amount you still need to obtain/craft
  const satisfied = {};   // id → { qty, by } : not needed because an ancestor product is in stock

  function cascade(id, needed, coveredBy, visited) {
    if (visited.has(id)) return;
    visited.add(id);
    const recipe = cache[id];
    if (coveredBy) {
      // An ancestor product is already in stock → this whole subtree is covered.
      const prev = satisfied[id];
      satisfied[id] = { qty: (prev?.qty || 0) + needed, by: prev?.by || coveredBy };
      if (recipe?.ingredients?.length) {
        const batches = Math.ceil(needed / (recipe.outputQty || 1));
        for (const ing of recipe.ingredients)
          cascade(ing.id, ing.qty * batches, coveredBy, new Set(visited));
      }
      return;
    }
    needs[id] = (needs[id] || 0) + needed;
    if (!recipe?.ingredients?.length) return; // base material
    const haveQty = invById[id] || 0;
    const toCraft = Math.max(0, needed - haveQty);
    if (toCraft <= 0) {
      // Enough of this product on hand → its ingredients don't need crafting.
      const batches = Math.ceil(needed / (recipe.outputQty || 1));
      for (const ing of recipe.ingredients)
        cascade(ing.id, ing.qty * batches, nameOf(id), new Set(visited));
      return;
    }
    const batches = Math.ceil(toCraft / (recipe.outputQty || 1));
    for (const ing of recipe.ingredients)
      cascade(ing.id, ing.qty * batches, null, new Set(visited));
  }

  for (const [id, qty] of Object.entries(craftGoals)) if (qty > 0) cascade(id, qty, null, new Set());
  for (const id of Object.keys(needs)) delete satisfied[id]; // genuinely-needed wins over satisfied
  return { needs, satisfied };
}

function renderByStage() {
  const { needs, satisfied } = computeNeeds();
  const ids = [...new Set([...Object.keys(needs), ...Object.keys(satisfied)])];
  if (!ids.length) return '';
  const cache = recipeCache();
  const icons = iconMap();
  const invById = Object.fromEntries((allItems || []).map(i => [i.id, i]));

  // Compute depth (0 = base material) from recipe tree
  const depthMemo = {};
  function depth(id, seen = new Set()) {
    if (id in depthMemo) return depthMemo[id];
    if (seen.has(id)) return 0;
    seen.add(id);
    const r = cache[id];
    if (!r?.ingredients?.length) return (depthMemo[id] = 0);
    const d = Math.max(...r.ingredients.map(ing => depth(ing.id, new Set(seen)))) + 1;
    return (depthMemo[id] = d);
  }

  const byStage = {};
  for (const id of ids) {
    const inv = invById[id];
    const r = cache[id];
    const name = inv?.name || itemsMap[id] || r?.name || `Item ${id.slice(-6)}`;
    const tag  = inv?.tag  || r?.tag  || 'Other';
    const qty  = inv?.qty  ?? 0;
    const s = depth(id);
    ((byStage[s] ??= {})[tag] ??= []).push({ id, name, qty });
  }
  if (!Object.keys(byStage).length) return '';

  const maxStage = Math.max(...Object.keys(byStage).map(Number));
  let html = '';
  for (let s = 0; s <= maxStage; s++) {
    if (!byStage[s]) continue;
    const groups = byStage[s];
    const total = Object.values(groups).reduce((n, g) => n + g.length, 0);
    const label = s === 0 ? 'Base Materials' : `Production Stage ${s}`;
    let inner = '';
    for (const [tag, items] of Object.entries(groups).sort()) {
      // Needed items first, then satisfied ones.
      items.sort((a, b) => (satisfied[a.id] ? 1 : 0) - (satisfied[b.id] ? 1 : 0));
      let rows = '';
      for (const item of items) {
        let right;
        if (needs[item.id] != null) {
          const need = needs[item.id] || 0;
          right = `<span class="cp-need ${item.qty >= need ? 'ok' : 'short'}">${fmt(item.qty)}/${fmt(need)}</span>`;
        } else {
          const sat = satisfied[item.id];
          right = `<span class="cp-need sat" title="Covered — you already have enough ${esc(sat.by)}">✓ ${fmt(item.qty)}/${fmt(sat.qty)}</span>`;
        }
        rows += `<div class="cp-row">
          ${iconImg(icons[item.id] || invById[item.id]?.icon, 'item-icon cp-icon')}
          <span class="cp-name" title="${esc(item.name)}">${esc(item.name)}</span>
          <span class="cp-right">${right}</span>
        </div>`;
      }
      inner += `<div class="cp-group">
        <div class="cp-gtag">${esc(tag)}<span class="cp-gbadge">${items.length}</span></div>
        ${rows}
      </div>`;
    }
    html += `<div class="cp-stage">
      <div class="cp-shd"><span>${esc(label)}</span><span class="cp-sbadge">${total} total</span></div>
      ${inner}
    </div>`;
  }
  return html;
}

function renderAllItems() {
  if (!allItems) return '<div class="hint">Loading…</div>';
  const q = (window._aiSearch || '').toLowerCase();
  const sort = window._aiSort || 'qty';
  let rows = allItems.filter(r => !q || r.name.toLowerCase().includes(q));
  rows.sort((a, b) => sort === 'qty' ? b.qty - a.qty : a.name.localeCompare(b.name));
  const ctrl = `<div class="ai-ctrl">
    <input class="inp" id="ai-search" placeholder="Search items…" value="${esc(q)}">
    <div class="seg">
      <button class="${sort === 'qty' ? 'on' : ''}" data-sort="qty">Qty</button>
      <button class="${sort === 'name' ? 'on' : ''}" data-sort="name">A–Z</button>
    </div>
  </div>`;
  if (!rows.length) return ctrl + '<div class="hint">No items found.</div>';
  return ctrl +
  rows.map(r => `<div class="ai-row">
    ${iconImg(r.icon)}
    <span class="ai-name">${esc(r.name)}</span>
    <span class="ai-qty">${fmt(r.qty)}</span>
  </div>`).join('');
}

function renderBuilds() {
  if (!buildsData) return '<div class="hint">Loading…</div>';
  if (!buildsData.length) return '<div class="hint">No active builds.</div>';
  return '<div class="builds">' + buildsData.map(p => {
    const req = p.actionsRequired || 0;
    const prog = p.progress || 0;
    const done = req > 0 && prog >= req;
    const pct = req ? Math.min(100, Math.floor(prog / req * 100)) : 0;
    const mats = [...(p.items || []), ...(p.cargos || [])].map(m => {
      const name = itemsMap[m.item_id] || `#${m.item_id}`;
      return `<span class="need"><span>${esc(name)}</span><b>${fmt(m.quantity)}</b></span>`;
    }).join('');
    return `<div class="card">
      <div class="card-head">
        <span class="card-title">${esc(p.buildingName || p.recipeName || 'Build')}</span>
        <span class="card-pct${done?' pct-done':''}">${done?'done':pct+'%'}</span>
      </div>
      <div class="track"><span class="track-fill${done?' done':''}" style="width:${pct}%;display:block;height:100%;border-radius:3px"></span></div>
      ${mats ? `<div class="needs">${mats}</div>` : ''}
    </div>`;
  }).join('') + '</div>';
}

function renderJobs() {
  if (!jobsData) return '<div class="hint">Loading…</div>';
  if (!jobsData.length) return '<div class="hint">No active crafts.</div>';
  return '<div class="jobs">' + jobsData.map(job => {
    const first = (job.craftedItem || [])[0];
    const id = first ? (first.item_id ?? first.id ?? first.entityId) : null;
    const name = (id && itemsMap[id]) ? itemsMap[id] : (job.recipeName || job.buildingName || 'Craft');
    const member = job.ownerUsername || job.memberName || '';
    const qty = job.craftCount || 0;
    const prog = job.progress || 0;
    const total = job.totalActionsRequired || 0;
    const done = total > 0 && prog >= total;
    const pct = total > 0 ? Math.min(100, Math.floor(prog / total * 100)) : 0;
    return `<div class="card">
      <div class="card-head">
        <span class="card-title">${esc(name)}${qty > 1 ? ` <span class="job-count">×${qty}</span>` : ''}</span>
        ${member ? `<span class="job-owner">${esc(member)}</span>` : ''}
        ${total > 0 ? `<span class="card-pct${done?' pct-done':''}">${done?'ready':pct+'%'}</span>` : ''}
      </div>
      ${total > 0 ? `<div class="track"><span class="track-fill${done?' done':''}" style="width:${pct}%;display:block;height:100%;border-radius:3px"></span></div>` : ''}
    </div>`;
  }).join('') + '</div>';
}

function renderTasks() {
  const name = localStorage.getItem(LS.tasksPlayer) || '';
  const setRow = `<div class="tk-setrow">
    <input class="inp tk-inp" id="tk-inp" placeholder="Your player name…" value="${esc(name)}" autocomplete="off">
    <button class="tk-setbtn" id="tk-setbtn">Set</button>
  </div>`;
  if (!name) return setRow + '<div class="hint">Set your player name to load traveler tasks.</div>';
  if (tasksData === null) { tasksData = 'loading'; setTimeout(pollTasks, 0); return setRow + '<div class="hint">Loading…</div>'; }
  if (tasksData === 'loading') return setRow + '<div class="hint">Loading…</div>';
  if (tasksData === 'noplayer') return setRow + `<div class="hint">Player “${esc(name)}” not found.</div>`;
  const td = tasksData;
  if (!td.tasks.length) return setRow + '<div class="hint">No active traveler tasks.</div>';
  const done = td.tasks.filter(t => t.completed).length;
  let expStr = '';
  if (td.expiration) {
    const ms = td.expiration * 1000 - Date.now();
    expStr = ms <= 0 ? 'expired' : fmtCountdown(ms);
  }
  const head = `<div class="tk-head"><b>${done}</b>/${td.tasks.length} done${expStr ? ` · resets in ${expStr}` : ''}</div>`;
  const taskCard = t => {
    const reqs = (t.requiredItems || []).map(r => `${esc(taskItemName(td, r))} ×${fmt(r.quantity)}`).join(', ');
    const rewards = (t.rewardedItems || []).map(r => `${esc(taskItemName(td, r))} ×${fmt(r.quantity)}`).join(', ');
    const xp = t.rewardedExperience ? `+${fmt(t.rewardedExperience.quantity)} ${esc(td.skillMap[t.rewardedExperience.skill_id] || 'XP')}` : '';
    const lvl = t.levelRequirement;
    const lvlStr = lvl && lvl.min_level > 1 ? ` · lvl ${lvl.min_level}+ ${esc(td.skillMap[lvl.skill_id] || '')}` : '';
    return `<div class="task-card ${t.completed?'done':''}">
      <div class="task-desc">${t.completed ? '✓ ' : ''}${esc(t.description)}</div>
      <div class="task-meta">
        <span class="task-need">Need: ${reqs}${lvlStr}</span>
        <span class="task-reward">→ ${rewards}${xp ? ` · ${xp}` : ''}</span>
      </div>
    </div>`;
  };
  // Group by NPC — the traveler's name is the first word of the description
  const npcOf = t => (t.description || '').split(' ')[0] || `Traveler ${t.travelerId}`;
  const groups = {};
  for (const t of td.tasks) (groups[npcOf(t)] = groups[npcOf(t)] || []).push(t);
  const body = Object.keys(groups).sort((a, b) => a.localeCompare(b)).map(npc => {
    const list = groups[npc].sort((a, b) => (a.completed?1:0) - (b.completed?1:0));
    const ndone = list.filter(t => t.completed).length;
    return `<div class="tk-npc">${esc(npc)}<span class="tk-npc-count">${ndone}/${list.length}</span></div>` + list.map(taskCard).join('');
  }).join('');
  return setRow + head + '<div class="tasks">' + body + '</div>';
}

function renderMembers() {
  if (!membersData) return '<div class="hint">Loading…</div>';
  if (!membersData.length) return '<div class="hint">No members found.</div>';
  const sorted = [...membersData].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const online = sorted.filter(m => m.online).length;
  return `<div class="members">
    <div class="members-count"><b>${online}</b> of ${sorted.length} online</div>
    ${sorted.map(m => {
      const st = m.online ? 'online' : m.last ? relTime(m.last) : 'offline';
      return `<div class="m-row">
        <span class="dot${m.online?'':' off'}"></span>
        <span class="m-name">${esc(m.name)}</span>
        <span class="m-status">${esc(st)}</span>
      </div>`;
    }).join('')}
  </div>`;
}

function renderSettings() {
  const playerName = localStorage.getItem(LS.tasksPlayer) || '';
  const sett = getSettlement();
  return `<div class="settings-page">
    <div class="settings-section">
      <div class="settings-label">Player name</div>
      <div class="settings-row">
        <input class="inp settings-inp" id="cfg-player" placeholder="Your in-game name…" value="${esc(playerName)}" autocomplete="off">
        <button class="settings-save" id="cfg-player-save">Save</button>
      </div>
      <div class="settings-hint">Used for Traveler Tasks lookup.</div>
    </div>
    <div class="settings-section">
      <div class="settings-label">Settlement</div>
      <div class="settings-row">
        <span class="settings-value">${sett ? esc(sett.name) : '—'}</span>
        <button class="change-btn" id="cfg-change-sett">Change</button>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-label">Notifications</div>
      <label class="settings-check"><input type="checkbox" id="cfg-buff-notify" ${localStorage.getItem(LS.buffNotify) === '0' ? '' : 'checked'}> Notify before buffs expire</label>
      <div class="settings-row">
        <span class="settings-value">Lead time (s)</span>
        <input class="inp settings-inp settings-num" id="cfg-buff-lead" type="number" min="5" value="${esc(localStorage.getItem(LS.buffNotifyLead) || '60')}">
      </div>
      <label class="settings-check"><input type="checkbox" id="cfg-craft-notify" ${localStorage.getItem(LS.craftNotify) === '0' ? '' : 'checked'}> Notify on craft stall</label>
      <div class="settings-row">
        <span class="settings-value">Stall threshold (s)</span>
        <input class="inp settings-inp settings-num" id="cfg-craft-stall" type="number" min="1" value="${esc(localStorage.getItem(LS.craftStallSec) || '5')}">
      </div>
      <button class="settings-save" id="cfg-test-notify" style="margin-top:6px">Test notification</button>
    </div>
    <div class="settings-version">${window._appVersion ? 'v' + esc(window._appVersion) : ''}</div>
  </div>`;
}

// ─── Event binding ────────────────────────────────────────────────────────
function bindTabEvents(id) {
  if (id === 'storage') {
    document.querySelectorAll('.mode-toggle button').forEach(btn => {
      btn.addEventListener('click', () => {
        storageMode = btn.dataset.mode;
        renderTab('storage');
      });
    });
    if (storageMode === 'plan') bindGoalEvents();
    if (storageMode === 'items') bindAllItemsEvents();
  }
  if (id === 'tasks') {
    const inp = document.getElementById('tk-inp');
    const btn = document.getElementById('tk-setbtn');
    if (inp) inp.addEventListener('mousedown', e => e.stopPropagation());
    const apply = () => {
      const v = inp.value.trim();
      if (!v) {
        localStorage.removeItem(LS.tasksPlayer);
        localStorage.removeItem(LS.tasksPlayerId);
        tasksData = null;
      } else {
        localStorage.setItem(LS.tasksPlayer, v);
        localStorage.removeItem(LS.tasksPlayerId); // force re-lookup
        tasksData = 'loading';
      }
      renderTab('tasks');
      pollTasks();
    };
    if (btn) btn.addEventListener('click', apply);
    if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') apply(); });
  }
  if (id === 'settings') {
    const inp = document.getElementById('cfg-player');
    const saveBtn = document.getElementById('cfg-player-save');
    if (inp) inp.addEventListener('mousedown', e => e.stopPropagation());
    const apply = () => {
      const v = inp.value.trim();
      if (!v) {
        localStorage.removeItem(LS.tasksPlayer);
        localStorage.removeItem(LS.tasksPlayerId);
      } else {
        localStorage.setItem(LS.tasksPlayer, v);
        localStorage.removeItem(LS.tasksPlayerId);
      }
      tasksData = null;
      saveBtn.textContent = 'Saved!';
      setTimeout(() => { saveBtn.textContent = 'Save'; }, 1500);
    };
    if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') apply(); });
    if (saveBtn) saveBtn.addEventListener('click', apply);
    const buffChk = document.getElementById('cfg-buff-notify');
    if (buffChk) buffChk.addEventListener('change', () => localStorage.setItem(LS.buffNotify, buffChk.checked ? '1' : '0'));
    const buffLead = document.getElementById('cfg-buff-lead');
    if (buffLead) {
      buffLead.addEventListener('mousedown', e => e.stopPropagation());
      buffLead.addEventListener('change', () => localStorage.setItem(LS.buffNotifyLead, String(Math.max(5, parseInt(buffLead.value) || 60))));
    }
    const craftChk = document.getElementById('cfg-craft-notify');
    if (craftChk) craftChk.addEventListener('change', () => localStorage.setItem(LS.craftNotify, craftChk.checked ? '1' : '0'));
    const craftStall = document.getElementById('cfg-craft-stall');
    if (craftStall) {
      craftStall.addEventListener('mousedown', e => e.stopPropagation());
      craftStall.addEventListener('change', () => localStorage.setItem(LS.craftStallSec, String(Math.max(1, parseInt(craftStall.value) || 5))));
    }
    const testBtn = document.getElementById('cfg-test-notify');
    if (testBtn) testBtn.addEventListener('click', () => notify('BitCraft Overlay', 'Notifications are working'));
    const changeBtn = document.getElementById('cfg-change-sett');
    if (changeBtn) changeBtn.addEventListener('click', () => {
      setSettlement(null); settlement = null;
      allItems = null; buildsData = null; jobsData = null; membersData = null; claimData = null;
      updateSupplies();
      document.getElementById('search-input').value = '';
      document.getElementById('search-results').innerHTML = '';
      showView('setup');
    });
  }
}

function bindGoalEvents() {
  const searchInp = document.getElementById('plan-search');
  if (searchInp) {
    searchInp.addEventListener('mousedown', e => e.stopPropagation());
    searchInp.addEventListener('input', e => {
      window._planSearch = e.target.value;
      _planSearchResults = null;
      // Debounce: one API search ~250ms after typing stops, not per keystroke.
      clearTimeout(_planSearchTimer);
      _planSearchTimer = setTimeout(() => doPlanSearch(window._planSearch), 250);
    });
    if (window._planSearch) {
      searchInp.focus();
      const len = searchInp.value.length;
      searchInp.setSelectionRange(len, len);
    }
  }
  document.querySelectorAll('.plan-result').forEach(el => {
    el.addEventListener('mousedown', e => e.preventDefault());
    el.addEventListener('click', async () => {
      const id = el.dataset.id;
      if (!craftGoals[id]) craftGoals[id] = 1;
      window._planSearch = '';
      _planSearchResults = null;
      localStorage.setItem(LS.goals, JSON.stringify(craftGoals));
      // Show loading, fetch full recipe tree, then reveal the requirements.
      window._planLoading = true;
      renderTab('storage');
      await ensureGoalTree(id);
      window._planLoading = false;
      renderTab('storage');
    });
  });
  document.querySelectorAll('.plan-qty').forEach(inp => {
    inp.addEventListener('mousedown', e => e.stopPropagation());
    inp.addEventListener('change', e => {
      const id = e.target.dataset.id;
      const val = parseInt(e.target.value) || 1;
      craftGoals[id] = Math.max(1, val);
      localStorage.setItem(LS.goals, JSON.stringify(craftGoals));
      renderTab('storage');
    });
  });
  document.querySelectorAll('.plan-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      delete craftGoals[btn.dataset.id];
      localStorage.setItem(LS.goals, JSON.stringify(craftGoals));
      renderTab('storage');
    });
  });
  const clearBtn = document.querySelector('.cp-clear-goals');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    craftGoals = {};
    window._planSearch = '';
    _planSearchResults = null;
    localStorage.removeItem(LS.goals);
    renderTab('storage');
  });
  // Load recipe trees for any goals not yet cached (guarded against re-entry).
  const needLoad = Object.keys(craftGoals).some(id => !(id in recipeCache()));
  if (needLoad) loadGoalTrees();
}

function bindAllItemsEvents() {
  const inp = document.getElementById('ai-search');
  if (inp) {
    inp.addEventListener('input', e => { window._aiSearch = e.target.value; renderTab('storage'); });
    inp.focus();
  }
  document.querySelectorAll('.seg button').forEach(btn => {
    btn.addEventListener('click', () => { window._aiSort = btn.dataset.sort; renderTab('storage'); });
  });
}

// ─── App init ─────────────────────────────────────────────────────────────
function showView(id) {
  document.getElementById('view-setup').style.display = id === 'setup' ? '' : 'none';
  document.getElementById('view-main').style.display  = id === 'main'  ? '' : 'none';
}

function startMain() {
  updateSupplies();
  showView('main');
  // Restore collapsed state on boot/reload so the window size matches the button.
  if (localStorage.getItem(LS.collapsed) === '1') applyCollapse(true, false);
  else if (win) {
    // Heal a window left stuck at the collapsed height by an earlier desync bug.
    win.innerSize().then(async sz => {
      const sf = await win.scaleFactor();
      if (sz.height / sf < 80) applyCollapse(false, false);
    }).catch(() => {});
  }
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === activeTab));
  // If any goal's recipe tree isn't cached yet, start in the loading state so the
  // craft plan doesn't flash a half-resolved tree before loadGoalTrees() kicks in.
  window._planLoading = Object.keys(craftGoals).some(id => !(id in recipeCache()));
  renderTab(activeTab);
  pollAll();
  setInterval(() => {
    _pollIfStale(activeTab, activeStale(activeTab));
    for (const tab of ['storage', 'builds', 'jobs', 'members', 'tasks', 'buffs']) {
      if (tab !== activeTab) _pollIfStale(tab, bgStale(tab));
    }
    _pollIfStale('claim', BG_STALE_MS);
  }, 5000);
  setInterval(tickBuffs, 1000);          // live buff countdown
  setInterval(pollCraftStall, 2000);     // background craft-stall detector (polls every 2s; alerts after the stall threshold)
}

// Settlement search
async function search() {
  const q = document.getElementById('search-input').value.trim();
  if (q.length < 2) return;
  const res = document.getElementById('search-results');
  res.innerHTML = '<div class="hint">Searching…</div>';
  try {
    const j = await bitwasp(`claims?q=${encodeURIComponent(q)}&limit=8`);
    const hits = j.claims || [];
    if (!hits.length) { res.innerHTML = '<div class="hint">No settlements found.</div>'; return; }
    res.innerHTML = hits.map(c =>
      `<div class="search-result">
        <span class="res-name">${esc(c.name)}</span>
        <button class="res-pick" data-id="${c.entityId}" data-name="${esc(c.name)}">Select</button>
      </div>`
    ).join('');
    res.querySelectorAll('.res-pick').forEach(btn => btn.addEventListener('click', () => {
      settlement = { id: btn.dataset.id, name: btn.dataset.name };
      setSettlement(settlement);
      startMain();
    }));
  } catch(e) { res.innerHTML = `<div class="hint" style="color:var(--bad)">${esc(String(e))}</div>`; }
}

// Tab switching
document.getElementById('tabs').addEventListener('click', e => {
  const btn = e.target.closest('.tab');
  if (btn) switchTab(btn.dataset.tab);
});

document.addEventListener('keydown', e => {
  if (!e.ctrlKey) return;
  if (e.key === 'Tab') {
    e.preventDefault();
    const cur = TAB_ORDER.indexOf(activeTab);
    const next = e.shiftKey
      ? (cur - 1 + TAB_ORDER.length) % TAB_ORDER.length
      : (cur + 1) % TAB_ORDER.length;
    switchTab(TAB_ORDER[next]);
    return;
  }
  const n = parseInt(e.key);
  if (n >= 1 && n <= TAB_ORDER.length) {
    e.preventDefault();
    switchTab(TAB_ORDER[n - 1]);
  }
});

// Window chrome — T is declared in common.js
let win = T?.window?.getCurrentWindow?.();

document.getElementById('drag-bar-main').addEventListener('mousedown', e => {
  if (e.button === 0 && !e.target.closest('.winbtn')) win?.startDragging?.();
});
document.getElementById('drag-bar-setup').addEventListener('mousedown', e => {
  if (e.button === 0 && !e.target.closest('.winbtn')) win?.startDragging?.();
});
document.getElementById('close-btn-main').addEventListener('click', () => win?.close?.());
document.getElementById('close-btn-setup').addEventListener('click', () => win?.close?.());
document.getElementById('min-btn').addEventListener('click', () => win?.minimize?.());
document.getElementById('search-btn').addEventListener('click', search);
document.getElementById('search-input').addEventListener('keydown', e => { if (e.key === 'Enter') search(); });

// Save position
if (win) {
  let _posTimer;
  win.listen('tauri://move', () => {
    clearTimeout(_posTimer);
    _posTimer = setTimeout(async () => {
      try {
        const pos = await win.outerPosition();
        const sf = await win.scaleFactor();
        localStorage.setItem(LS.posMain, JSON.stringify({ x: Math.round(pos.x / sf), y: Math.round(pos.y / sf) }));
      } catch {}
    }, 400);
  });
  // Remember a manually resized (expanded) height, so it persists across restarts.
  let _sizeTimer;
  win.listen('tauri://resize', () => {
    clearTimeout(_sizeTimer);
    _sizeTimer = setTimeout(async () => {
      if (localStorage.getItem(LS.collapsed) === '1') return; // ignore collapse-driven resizes
      try {
        const sz = await win.innerSize();
        const sf = await win.scaleFactor();
        const h = Math.round(sz.height / sf);
        if (h > 120) localStorage.setItem(LS.hMain, h);
      } catch {}
    }, 400);
  });
}

// Collapse — state is persisted (LS.collapsed) and derived from storage, not the
// button glyph, so a dev hot-reload (location.reload) can't desync them and save
// the collapsed height as the expanded one. Expanded height is clamped so a bad
// value self-heals.
const COLLAPSED_H = 34, EXPANDED_W = 360;
async function applyCollapse(collapsed, snapshot) {
  const btn = document.getElementById('collapse-btn');
  const col = document.getElementById('main-collapsible');
  if (!btn || !col) return;
  if (collapsed) {
    if (snapshot && win) {
      try {
        const sz = await win.innerSize(), sf = await win.scaleFactor();
        const h = Math.round(sz.height / sf);
        if (h > COLLAPSED_H + 20) localStorage.setItem(LS.hMain, h); // never store the collapsed height
      } catch {}
    }
    localStorage.setItem(LS.collapsed, '1');
    btn.textContent = '▼';
    col.style.display = 'none';
    await T?.core?.invoke('set_window_size', { width: EXPANDED_W, height: COLLAPSED_H });
  } else {
    const sh = parseInt(localStorage.getItem(LS.hMain));
    const h = (sh && sh > 120) ? sh : 500; // clamp away corrupted/tiny heights
    localStorage.removeItem(LS.collapsed);
    btn.textContent = '▲';
    col.style.display = '';
    await T?.core?.invoke('set_window_size', { width: EXPANDED_W, height: h });
  }
}
document.getElementById('collapse-btn').addEventListener('click', () => {
  const collapsed = localStorage.getItem(LS.collapsed) === '1';
  applyCollapse(!collapsed, !collapsed); // snapshot the expanded size only when collapsing
});

// Focus watcher
(async () => {
  if (!win) return;
  await win.setAlwaysOnTop(true);
  setInterval(async () => {
    try {
      const active = await T.core.invoke('is_game_focused');
      await win.setAlwaysOnTop(active);
    } catch {}
  }, 700);
})();

// Icon load-failure fallback — replaces the inline onerror so a strict CSP
// (no 'unsafe-inline') still hides broken icons. 'error' doesn't bubble, so
// listen in the capture phase.
document.addEventListener('error', e => {
  const t = e.target;
  if (t && t.tagName === 'IMG' && t.classList?.contains('item-icon')) t.classList.add('blank');
}, true);
// Update-banner buttons (no inline handlers under CSP).
document.getElementById('update-install')?.addEventListener('click', doInstallUpdate);
document.getElementById('update-dismiss')?.addEventListener('click', dismissUpdate);

// Boot
if (settlement) startMain();
else showView('setup');
checkForUpdate();
primeNotify();
T?.core?.invoke('app_version').then(v => {
  window._appVersion = v;
  if (activeTab === 'settings') renderTab('settings');
}).catch(() => {});
