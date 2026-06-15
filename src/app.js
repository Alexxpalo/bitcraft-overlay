// ─── State ────────────────────────────────────────────────────────────────
let settlement = getSettlement();
let activeTab = localStorage.getItem(LS.activeTab) || 'storage';
let storageMode = 'plan'; // 'plan' | 'items'
let buffsMode = 'active'; // 'active' | 'food' (Buffs tab sub-mode)
let allItems = null;
let chestsData = null;   // [{ entityId, nickname, typeName, icon, contents: Map(String(item_id)->qty) }]
let _storageSig = null;  // signature of last-rendered storage data (skip no-op re-renders)
let _planSearchTimer = null;  // debounce timer for the craft-plan item search
let buildsData = null;
let jobsData = null;
let membersData = null;
let tasksData = null;  // null=idle, 'loading', 'noplayer', { tasks, items, cargo, skillMap, expiration }
let buffsData = null;  // null=idle, 'loading', 'noplayer', { buffs, isOnline }
let skillsData = null; // null=idle, 'loading', 'noplayer', { rankings, totalPlayers, skillMap }
let _foodResults = null;     // null=idle, 'loading', []=results
let _foodSearchTimer = null; // debounce timer for the food search
let _allFood = null;         // null=idle, 'loading', []=full food catalogue (for the in-storage default view)
let _foodById = null;        // Map itemId -> food entry, built alongside _allFood
let _levels = null;          // bundled XP thresholds [{level, xp}] (lazy-loaded)
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
const STALE_OVERRIDE = { members: { active: 15000, bg: 60000 }, gatherrate: { active: 12000, bg: 15000 } };
const activeStale = tab => STALE_OVERRIDE[tab]?.active || ACTIVE_STALE_MS;
const bgStale     = tab => STALE_OVERRIDE[tab]?.bg     || BG_STALE_MS;
function _poll(tab) {
  _lastPoll[tab] = Date.now();
  ({ storage: pollStorage, chests: pollStorage, builds: pollBuilds, jobs: pollJobs, members: pollMembers, tasks: pollTasks, buffs: pollBuffs, skills: pollSkills, claim: pollClaim, gatherrate: pollGatherRate })[tab]?.();
}
function _pollIfStale(tab, staleMs) {
  if (Date.now() - (_lastPoll[tab] || 0) > staleMs) _poll(tab);
}

const TAB_ORDER = ['storage', 'chests', 'builds', 'jobs', 'tasks', 'buffs', 'skills', 'members', 'settings'];
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

// ─── Chest nickname → item resolution ────────────────────────────────────
// A chest's player-set nickname (buildingNickname) is treated as an item name.
// Map it to an item id (+ recipe) so the Chests tab can show what's missing.
// { [lowercased nickname]: { itemId } | { itemId: null } }  (negative caching)
let _nicknameCache = null;
function nicknameCache() { return _nicknameCache ?? (_nicknameCache = JSON.parse(localStorage.getItem(LS.nicknameMap) || '{}')); }
function saveNickname(key, val) {
  const c = nicknameCache(); c[key] = val;
  localStorage.setItem(LS.nicknameMap, JSON.stringify(capMap(c, 2000)));
}

// "Advanced Codex x3" / "…×3" / "…*3" → { name:"Advanced Codex", mult:3 }. The
// item is resolved from `name`; `mult` scales the whole recipe tree's needs.
function parseNickname(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(.*?)\s*[x×*]\s*(\d+)\s*$/i);
  if (m && m[1].trim()) return { name: m[1].trim(), mult: Math.max(1, parseInt(m[2], 10) || 1) };
  return { name: s, mult: 1 };
}

const _nickInFlight = new Map();
async function resolveNicknameToItemId(nickname) {
  const key = parseNickname(nickname).name.toLowerCase();
  if (!key) return null;
  const cache = nicknameCache();
  if (key in cache) return cache[key].itemId;        // cached (incl. negatives)
  if (_nickInFlight.has(key)) return _nickInFlight.get(key);
  const p = (async () => {
    // Fast path: a name we already know — no API call.
    for (const [id, nm] of Object.entries(itemsMap))
      if (nm && nm.toLowerCase() === key) { saveNickname(key, { itemId: id }); return id; }
    // Search the API, accept only an exact (case-insensitive) name match.
    try {
      const j = await bitwasp('items?q=' + encodeURIComponent(key));
      const arr = j.items || j.results || (Array.isArray(j) ? j : []);
      const hit = arr.find(it => (it.name || it.displayName || '').toLowerCase() === key);
      if (hit) {
        const id = String(hit.id ?? hit.entityId ?? hit.item_id);
        _saveName(id, hit.name || hit.displayName);
        saveIcon(id, hit.iconAssetName);
        saveNickname(key, { itemId: id });
        return id;
      }
    } catch(e) {}
    saveNickname(key, { itemId: null });             // no match — stop retrying
    return null;
  })();
  _nickInFlight.set(key, p);
  try { return await p; } finally { _nickInFlight.delete(key); }
}

// Pre-resolve every nicknamed chest (nickname→item→recipe→ingredient names) so
// the Chests tab never renders a half-resolved card. Mirrors loadGoalTrees().
let _chestsResolveInFlight = false;
const _chestTreeLoaded = new Set();   // itemIds whose FULL recipe tree is cached
async function resolveChestNicknames() {
  if (_chestsResolveInFlight || !chestsData) return;
  const named = chestsData.filter(c => c.nickname);
  if (!named.length) { window._chestsLoading = false; return; }
  const nc = nicknameCache();
  const allCached = named.every(c => {
    const k = parseNickname(c.nickname).name.toLowerCase();
    if (!(k in nc)) return false;
    const id = nc[k].itemId;
    return !id || _chestTreeLoaded.has(id);
  });
  if (allCached) { window._chestsLoading = false; return; } // nothing to resolve — avoids a renderTab→bindTabEvents→resolve loop
  _chestsResolveInFlight = true;
  window._chestsLoading = true;
  if (activeTab === 'chests') renderTab('chests');
  try {
    const visited = new Set();
    await Promise.all(named.map(async c => {
      const id = await resolveNicknameToItemId(c.nickname);
      if (!id) return;
      await ensureGoalTree(id, 0, visited);   // fetch the WHOLE recipe tree (names, icons, sub-recipes)
      _chestTreeLoaded.add(id);
    }));
  } finally {
    _chestsResolveInFlight = false;
    window._chestsLoading = false;
    if (activeTab === 'chests') renderTab('chests');
  }
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
    const chests = [];
    for (const b of (j.buildings || [])) {
      const contents = new Map();
      for (const slot of (b.inventory || [])) {
        const c = slot.contents;
        if (!c?.item_id) continue;
        const cid = String(c.item_id);
        totals[c.item_id] = (totals[c.item_id] || 0) + (c.quantity || 0);
        contents.set(cid, (contents.get(cid) || 0) + (c.quantity || 0));
      }
      chests.push({
        entityId: String(b.entityId),
        nickname: (b.buildingNickname || '').trim() || null,
        typeName: b.buildingName || 'Chest',
        icon: b.iconAssetName || '',
        contents,
      });
    }
    chestsData = chests;
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
    const chestSig = chests.map(c => c.entityId + '~' + (c.nickname || '') + '~' +
      [...c.contents].map(([i, q]) => i + ':' + q).sort().join(',')).sort().join('|');
    const sig = allItems.map(i => `${i.id}:${i.qty}`).sort().join('|') + '#' + chestSig;
    if (sig === _storageSig) return;
    _storageSig = sig;
  } catch(e) { console.error('storage poll:', e); }
  resolveChestNicknames();
  if (activeTab === 'storage' || activeTab === 'chests') renderTab(activeTab);
  // The food browser's default view lists in-storage foods — keep it (and the
  // held quantities) fresh too, touching only the list so the search caret survives.
  else if (activeTab === 'buffs' && buffsMode === 'food') {
    const l = document.getElementById('food-list'); if (l) l.innerHTML = foodListHtml();
  }
}

async function pollBuilds() {
  if (!settlement) return;
  try {
    const j = await bitwasp(`claims/${settlement.id}/construction`);
    buildsData = j.projects || [];
  } catch(e) { buildsData = []; console.error('builds poll:', e); }
  updateBadges();
  if (activeTab === 'builds') renderTab('builds');
}

async function pollJobs() {
  if (!settlement) return;
  try {
    const j = await bitwasp(`crafts?claimEntityId=${encodeURIComponent(settlement.id)}`);
    for (const it of (j.items || [])) itemsMap[it.id] = it.name;
    jobsData = (j.craftResults || []).filter(x => !x.completed);
  } catch(e) { jobsData = []; console.error('jobs poll:', e); }
  updateBadges();
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
  updateBadges();
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
  updateBadges();
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
  updateBadges();
  if (activeTab === 'buffs' && buffsMode === 'active') renderTab('buffs');
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

// Format a buff/food `stats[]` array ("+9 Passive Health …" · "+15% …"). Shared
// by the active-buff cards and the food browser (same {name,value,is_pct,suffix}).
function fmtStats(stats) {
  return (stats || []).map(s => {
    const v = s.is_pct ? `${Math.round(s.value * 100)}%` : `${s.value}${esc(s.suffix || '')}`;
    const sign = s.value > 0 ? '+' : '';
    return `${sign}${v} ${esc(s.name || '')}`.trim();
  }).join(' · ');
}

function renderBuffs() {
  const toggle = `<div class="mode-toggle">
    <button class="${buffsMode==='active'?'on':''}" data-bmode="active">Active buffs</button>
    <button class="${buffsMode==='food'?'on':''}" data-bmode="food">Food browser</button>
  </div>`;
  return toggle + (buffsMode === 'food' ? renderFoodBrowser() : renderActiveBuffs());
}

function renderActiveBuffs() {
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
    const stats = fmtStats(b.stats);
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

// ─── Food browser (Buffs sub-mode) ───────────────────────────────────────────
// Search /api/food and show each food's buffs + stat modifiers. The list call
// already returns full buff+stat data, so there's no per-item detail fetch.
function renderFoodBrowser() {
  const q = window._foodSearch || '';
  return `<div class="food-wrap">
    <input class="inp" id="food-search" dir="ltr" autocomplete="off" placeholder="Search food (e.g. pie)…" value="${esc(q)}">
    <div class="food-list" id="food-list">${foodListHtml()}</div>
  </div>`;
}

// One food card. `qty`, when given, shows a "×N held" badge (storage view).
function foodCardHtml(f, qty) {
  const nut = [];
  if (f.hunger) nut.push(`🍖 ${fmt(f.hunger)}`);
  if (f.hp) nut.push(`♥ ${fmt(f.hp)}`);
  if (f.stamina) nut.push(`⚡ ${fmt(f.stamina)}`);
  const nutLine = nut.length ? `<div class="food-nut">${nut.join(' · ')}</div>` : '';
  const buffs = (f.buffs || []).map(b => {
    const st = fmtStats(b.stats);
    return `<div class="food-buff ${b.beneficial ? 'good' : 'bad'}">
      <span class="food-buff-name">${esc(b.buffName || 'Buff')}${b.duration ? ` · ${esc(fmtDur(b.duration))}` : ''}</span>
      ${st ? `<div class="buff-stats">${st}</div>` : ''}
    </div>`;
  }).join('');
  return `<div class="food-card">
    <div class="food-head">
      ${iconImg(f.iconAssetName, 'item-icon cp-icon')}
      <span class="food-name" title="${esc(f.itemName || '')}">${esc(f.itemName || 'Food')}</span>
      ${f.tier != null ? `<span class="food-tier">T${esc(f.tier)}</span>` : ''}
      ${qty != null ? `<span class="food-qty">×${fmt(qty)}</span>` : ''}
    </div>
    ${nutLine}
    ${buffs || '<div class="food-nobuff">No buffs</div>'}
  </div>`;
}

// Full food catalogue (one call, no query → every food). Cached in-memory so the
// in-storage view can match inventory item ids against known foods.
async function ensureAllFood() {
  if (_allFood === 'loading' || Array.isArray(_allFood)) return;
  _allFood = 'loading';
  try {
    const j = await bitwasp('food');
    const arr = j.food || [];
    arr.forEach(f => saveIcon(String(f.itemId), f.iconAssetName));
    _allFood = arr;
    _foodById = new Map(arr.map(f => [String(f.itemId), f]));
  } catch(e) { _allFood = []; _foodById = new Map(); }
  if (activeTab === 'buffs' && buffsMode === 'food') {
    const l = document.getElementById('food-list'); if (l) l.innerHTML = foodListHtml();
  }
}

function foodListHtml() {
  const q = (window._foodSearch || '').trim();
  // Search mode: query the food catalogue by name (existing behaviour).
  if (q.length >= 2) {
    if (!Array.isArray(_foodResults)) return '<div class="hint">Searching…</div>';
    if (!_foodResults.length) return '<div class="hint">No food found.</div>';
    return _foodResults.map(f => foodCardHtml(f)).join('');
  }
  // Default (empty search): buff-giving foods currently in the settlement's storage.
  if (allItems === null) return '<div class="hint">Loading inventory…</div>';
  if (!Array.isArray(_allFood)) { ensureAllFood(); return '<div class="hint">Loading food data…</div>'; }
  const inStock = allItems
    .filter(it => it.qty > 0 && _foodById.has(String(it.id)))
    .map(it => ({ f: _foodById.get(String(it.id)), qty: it.qty }))
    .filter(c => (c.f.buffs || []).length > 0);   // only foods that actually grant a buff
  if (!inStock.length) return '<div class="hint">No buff-giving food in your storage.</div>';
  // Tier filter bar — only when more than one tier is in stock (else it's pointless).
  const tiers = [...new Set(inStock.map(c => c.f.tier).filter(t => t != null))].sort((a, b) => a - b);
  const sel = window._foodTier ?? null;
  const bar = tiers.length > 1 ? '<div class="food-tiers">' +
    `<button class="food-tierbtn ${sel == null ? 'on' : ''}" data-tier="all">All</button>` +
    tiers.map(t => `<button class="food-tierbtn ${sel === t ? 'on' : ''}" data-tier="${t}">T${t}</button>`).join('') +
    '</div>' : '';
  const shown = (sel == null ? inStock : inStock.filter(c => c.f.tier === sel))
    .sort((a, b) => (b.f.tier || 0) - (a.f.tier || 0) || b.qty - a.qty);
  const cards = shown.length ? shown.map(({ f, qty }) => foodCardHtml(f, qty)).join('')
    : `<div class="hint">No T${sel} food in storage.</div>`;
  return bar + cards;
}

async function doFoodSearch(q) {
  if (q.length < 2) { _foodResults = null; const l = document.getElementById('food-list'); if (l) l.innerHTML = foodListHtml(); return; }
  _foodResults = 'loading';
  try {
    const j = await bitwasp('food?q=' + encodeURIComponent(q));
    if ((window._foodSearch || '').trim() !== q) return; // stale, discard
    const arr = j.food || [];
    arr.forEach(f => saveIcon(String(f.itemId), f.iconAssetName));
    _foodResults = arr.slice(0, 40);
  } catch(e) { _foodResults = []; }
  // Only the list updates (not the input) so the search caret survives.
  if ((window._foodSearch || '').trim() === q && activeTab === 'buffs' && buffsMode === 'food') {
    const l = document.getElementById('food-list'); if (l) l.innerHTML = foodListHtml();
  }
}

function tickBuffs() {
  updateBuffBadge();   // keep the tab badge ticking down even on another tab
  if (activeTab !== 'buffs' || buffsMode !== 'active') return;
  const now = Date.now();
  document.querySelectorAll('.buff-time[data-expires]').forEach(el => {
    const ms = Number(el.dataset.expires) - now;
    el.textContent = ms <= 0 ? 'expired' : fmtDur(ms / 1000);
    el.classList.toggle('low', ms > 0 && ms <= 60000);
  });
}

// ─── Skills & XP tracker ─────────────────────────────────────────────────────
// skill-rankings gives per-skill { rank, totalPlayers, xp } but no name/level.
// Names come from the skills endpoint (getSkillMap); level is derived from the
// cumulative xp against the bundled XP thresholds (src/levels.json).
async function loadLevels() {
  if (_levels) return _levels;
  try { _levels = await (await fetch('levels.json')).json(); }
  catch(e) { _levels = []; console.error('levels load:', e); }
  return _levels;
}
// Progress within the current level: current level + 0–1 fraction toward next.
function xpProgress(xp) {
  const L = _levels || [];
  let cur = L[0] || { level: 1, xp: 0 }, next = null;
  for (let i = 0; i < L.length; i++) {
    if (xp >= L[i].xp) { cur = L[i]; next = L[i + 1] || null; }
    else break;
  }
  if (!next) return { level: cur.level, pct: 1, next: null };       // max level
  const span = next.xp - cur.xp, into = xp - cur.xp;
  return { level: cur.level, pct: span > 0 ? Math.min(1, into / span) : 0, next: next.xp };
}

async function pollSkills() {
  if (!localStorage.getItem(LS.tasksPlayer)) { skillsData = 'noplayer'; if (activeTab === 'skills') renderTab('skills'); return; }
  const id = await resolveTasksPlayerId();
  if (!id) { skillsData = 'noplayer'; if (activeTab === 'skills') renderTab('skills'); return; }
  try {
    const [j, skillMap] = await Promise.all([ bitwasp(`players/${id}/skill-rankings`), getSkillMap(), loadLevels() ]);
    skillsData = { rankings: j.rankings || {}, totalPlayers: j.totalPlayers || 0, skillMap };
  } catch(e) { skillsData = { rankings: {}, totalPlayers: 0, skillMap: {} }; console.error('skills poll:', e); }
  if (activeTab === 'skills') renderTab('skills');
}

function renderSkills() {
  const name = localStorage.getItem(LS.tasksPlayer) || '';
  if (!name || skillsData === 'noplayer') return '<div class="hint">Set your player name in Settings to track skills.</div>';
  if (skillsData === null || skillsData === 'loading') { if (skillsData === null) { skillsData = 'loading'; setTimeout(pollSkills, 0); } return '<div class="hint">Loading…</div>'; }
  const { rankings, skillMap } = skillsData;
  const rows = Object.entries(rankings).map(([sid, r]) => {
    const xp = Number(r.xp) || 0;
    const p = xpProgress(xp);
    return { name: skillMap[sid] || `Skill ${sid}`, level: p.level, xp, p, rank: r.rank, total: r.totalPlayers };
  });
  if (!rows.length) return '<div class="hint">No skill data for this player.</div>';
  rows.sort((a, b) => b.level - a.level || b.xp - a.xp);
  const totalLvl = rows.reduce((n, r) => n + r.level, 0);
  const head = `<div class="sk-head"><b>${rows.length}</b> skills · combined level <b>${fmt(totalLvl)}</b></div>`;
  const body = rows.map(r => {
    const pct = Math.round(r.p.pct * 100);
    const xpStr = r.p.next ? `${fmt(r.xp)} / ${fmt(r.p.next)} XP` : `${fmt(r.xp)} XP · max`;
    return `<div class="sk-row">
      <div class="sk-line">
        <span class="sk-name">${esc(r.name)}</span>
        <span class="sk-lvl">Lv ${r.level}</span>
      </div>
      <div class="track"><span class="track-fill" style="width:${pct}%;display:block;height:100%;border-radius:3px"></span></div>
      <div class="sk-sub">
        <span class="sk-xp">${xpStr}</span>
        ${r.rank ? `<span class="sk-rank">#${fmt(r.rank)}${r.total ? ` / ${fmt(r.total)}` : ''}</span>` : ''}
      </div>
    </div>`;
  }).join('');
  return head + '<div class="skills">' + body + '</div>';
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

// Set a tab badge's text/visibility; empty text hides it. `warn` swaps to the red variant.
function setBadge(id, text, warn = false) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!text) { el.style.display = 'none'; return; }
  el.textContent = text;
  el.classList.toggle('warn', !!warn);
  el.style.display = '';
}

// Soonest-expiring beneficial *timed* buff → { remaining ms, warn } or null.
function soonestBuff() {
  if (!buffsData || typeof buffsData !== 'object') return null;
  const now = Date.now();
  const lead = (Number(localStorage.getItem(LS.buffNotifyLead)) || 60) * 1000;
  let best = null;
  for (const b of (buffsData.buffs || [])) {
    if (!b.beneficial || !(b.buffDuration > 0)) continue;
    const ms = (b.buffStartTimestamp + b.buffDuration) * 1000 - now;
    if (ms > 0 && (best === null || ms < best)) best = ms;
  }
  return best === null ? null : { remaining: best, warn: best <= lead };
}

function updateBuffBadge() {
  const s = soonestBuff();
  if (!s) { setBadge('buffs-badge', ''); return; }
  const sec = Math.floor(s.remaining / 1000);          // compact: largest unit only
  const txt = sec >= 3600 ? Math.floor(sec / 3600) + 'h' : sec >= 60 ? Math.floor(sec / 60) + 'm' : sec + 's';
  setBadge('buffs-badge', txt, s.warn);
}

// Refresh every tab badge from in-memory poll data. Called from each poll (so
// badges stay current in the background) and from the 1s buff ticker.
function updateBadges() {
  const builds = (buildsData || []).length;
  setBadge('builds-badge', builds > 0 ? String(builds) : '');
  const jobs = (jobsData || []).length;
  setBadge('jobs-badge', jobs > 0 ? String(jobs) : '');
  const left = (tasksData && typeof tasksData === 'object')
    ? tasksData.tasks.filter(t => !t.completed).length : 0;
  setBadge('tasks-badge', left > 0 ? String(left) : '');
  const online = (membersData || []).filter(m => m.online).length;
  setBadge('online-badge', online > 0 ? String(online) : '');
  updateBuffBadge();
}

function pollAll() {
  for (const tab of ['storage', 'builds', 'jobs', 'members', 'tasks', 'buffs', 'skills', 'claim', 'gatherrate']) _poll(tab);
}

// ─── Tab rendering ────────────────────────────────────────────────────────
function setTabContent(html) {
  const el = document.getElementById('tab-content');
  if (el) el.innerHTML = html;
}

function renderTab(id) {
  const html = {
    storage:  renderStorage,
    chests:   renderChests,
    builds:   renderBuilds,
    jobs:     renderJobs,
    tasks:    renderTasks,
    buffs:    renderBuffs,
    skills:   renderSkills,
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
    <button class="${storageMode==='gather'?'on':''}" data-mode="gather">Gather</button>
    <button class="${storageMode==='rate'?'on':''}" data-mode="rate">Rate</button>
  </div>`;
  if (storageMode === 'plan') out += renderCraftPlan();
  else if (storageMode === 'items') out += renderAllItems();
  else if (storageMode === 'rate') out += renderGatherRate();
  else out += renderGather();
  return out;
}

// ─── Gather-to-Sell advisor (Storage sub-mode) ──────────────────────────────
// Ranks gatherable raw materials by expected sell-revenue per gather-effort,
// gated on live buy orders so the recommended resource definitely sells.
// Conservative allowlist of world-gatherable raw tags — a miss just omits a
// resource; we never want to recommend selling a *crafted* item.
const GATHER_TAGS = new Set([
  'Plant Fiber','Wood Log','Ore','Precious Metal Ore','Rock Boulder','Stone','Gem','Rough Gem',
  'Hide','Pelt','Clay','Salt','Sand','Resin','Bait','Baitfish',
  'Berry','Citric Berry','Blossom','Flower','Mushroom','Rare Mushroom','Vegetable',
  'Grain Plant','Filament Plant','Tree Seed','Grain Seeds','Vegetable Seeds','Filament Seeds',
  'Lake Fish','Ocean Fish','Raw Meat','Domesticated Animal Materials',
]);
const PRICE_TTL = 30 * 60 * 1000;   // per-item market price freshness
const MARKET_TTL = 15 * 60 * 1000;  // candidate list freshness
let gatherData = null;       // null=idle, 'loading', 'error', { ranked, sellNow, ts }
let _gatherInFlight = false;
let _priceCache = null;
function priceCache() { return _priceCache ?? (_priceCache = safeParse(localStorage.getItem(LS.price), {})); }
function savePrice(id, val) { const c = priceCache(); c[id] = val; localStorage.setItem(LS.price, JSON.stringify(capMap(c, 1500))); }

// Items people are actively buying (1 call), filtered to gatherable raws and
// pre-ranked by how many distinct buyers want them. Cached ~15 min.
async function fetchMarketCandidates(force) {
  if (!force) {
    const c = safeParse(localStorage.getItem(LS.market), null);
    if (c && Date.now() - c.ts < MARKET_TTL) return c.items;
  }
  let items;
  try { const j = await bitwasp('market?hasBuyOrders=true'); items = j.data?.items || j.items || []; }
  catch(e) { const c = safeParse(localStorage.getItem(LS.market), null); return c?.items || []; }
  const cands = items
    .filter(it => GATHER_TAGS.has(it.tag) && Number(it.tier) > 0 && (it.buyOrders || 0) > 0)
    .map(it => {
      saveIcon(String(it.id), it.iconAssetName);
      _saveName(String(it.id), it.name);
      return { id: String(it.id), name: it.name, tag: it.tag, tier: Number(it.tier) || 1, itemType: it.itemType || 0, icon: it.iconAssetName || '', buyOrders: it.buyOrders || 0 };
    })
    .sort((a, b) => b.buyOrders - a.buyOrders);
  localStorage.setItem(LS.market, JSON.stringify({ ts: Date.now(), items: cands }));
  return cands;
}

// Live order book for one item: highestBuy (guaranteed sale price) + how many
// units buyers want now (totalAvailableBuy) + seller competition. Cached ~30 min.
async function fetchOrders(id, itemType) {
  const cur = priceCache()[id];
  if (cur && Date.now() - cur.ts < PRICE_TTL) return cur;
  const path = itemType === 1 ? 'cargo' : 'item';
  try {
    const j = await bitwasp(`market/${path}/${id}`);
    const s = j.stats || {};
    const val = { highestBuy: s.highestBuy ?? null, availBuy: s.totalAvailableBuy || 0, availSell: s.totalAvailableSell || 0, sellCount: s.sellOrderCount || 0, buyCount: s.buyOrderCount || 0, ts: Date.now() };
    savePrice(id, val);
    return val;
  } catch(e) { return cur || { highestBuy: null, availBuy: 0, availSell: 0, sellCount: 0, buyCount: 0, ts: Date.now() }; }
}

// Ready sell-revenue per gather-effort. Hard gate: a live buyer must exist
// (availBuy>0) so the pick definitely sells. More distinct buyers → more reliable.
function scoreGather(c, price) {
  const unit = (price.highestBuy != null && price.highestBuy > 0) ? price.highestBuy : 0;
  const guaranteed = price.availBuy || 0;
  if (unit <= 0 || guaranteed <= 0) return null;
  const readyRevenue = unit * guaranteed;
  const demandBreadth = 1 + 0.05 * Math.min(c.buyOrders, 10);
  const effort = 1 + 0.15 * (c.tier - 1);
  return { unit, guaranteed, readyRevenue, score: readyRevenue * demandBreadth / effort };
}

// Combined demand (craft plan + builds + incomplete tasks) → ids you still need,
// so we never tell you to sell a material your own plan is short on. Uses cached
// recipes only (no new fetches).
function gatherGoals() {
  const goals = {};
  for (const [id, q] of Object.entries(craftGoals)) goals[id] = (goals[id] || 0) + (q || 0);
  for (const p of (buildsData || [])) for (const m of [...(p.items || []), ...(p.cargos || [])]) {
    const id = String(m.item_id); goals[id] = (goals[id] || 0) + (m.quantity || 0);
  }
  if (tasksData && typeof tasksData === 'object') for (const t of tasksData.tasks) {
    if (t.completed) continue;
    for (const r of (t.requiredItems || [])) { const id = String(r.item_id); goals[id] = (goals[id] || 0) + (r.quantity || 0); }
  }
  return goals;
}
function keepSet() {
  const invById = Object.fromEntries((allItems || []).map(i => [String(i.id), i.qty]));
  const { needs } = computeNeeds(gatherGoals(), invById);
  const keep = new Set();
  for (const [id, n] of Object.entries(needs)) if (n > (invById[id] || 0)) keep.add(String(id));
  return keep;
}

async function buildGather(force) {
  if (_gatherInFlight) return;
  _gatherInFlight = true;
  gatherData = 'loading'; window._gatherLoading = true;
  if (activeTab === 'storage' && storageMode === 'gather') renderTab('storage');
  try {
    const cands = (await fetchMarketCandidates(force)).slice(0, 15);
    const keep = keepSet();
    const scored = [];
    for (const c of cands) {
      const price = await fetchOrders(c.id, c.itemType);
      const s = scoreGather(c, price);
      if (s) scored.push({ ...c, ...s, price, needed: keep.has(c.id) });
    }
    scored.sort((a, b) => b.score - a.score);
    const invQty = Object.fromEntries((allItems || []).map(i => [String(i.id), i.qty]));
    const sellNow = scored.filter(r => (invQty[r.id] || 0) > 0).map(r => ({ ...r, have: invQty[r.id] })).slice(0, 6);
    gatherData = { ranked: scored.slice(0, 12), sellNow, ts: Date.now() };
  } catch(e) { gatherData = 'error'; console.error('gather build:', e); }
  finally {
    _gatherInFlight = false; window._gatherLoading = false;
    if (activeTab === 'storage' && storageMode === 'gather') renderTab('storage');
  }
}

function renderGather() {
  if (gatherData === null) { setTimeout(() => buildGather(false), 0); return '<div class="hint">Finding what sells best…</div>'; }
  if (gatherData === 'loading' || window._gatherLoading) return '<div class="hint">Finding what sells best…</div>';
  if (gatherData === 'error') return '<div class="hint">Couldn’t load market data.</div><div class="ga-foot"><span></span><button class="ga-refresh">Retry</button></div>';
  const { ranked, sellNow, ts } = gatherData;
  if (!ranked.length) return '<div class="hint">No gatherable resources have active buyers right now.</div><div class="ga-foot"><span></span><button class="ga-refresh">Refresh</button></div>';
  const icons = iconMap();
  const rows = ranked.map(r => {
    const comp = r.price.availSell > r.guaranteed * 2 ? `<span class="ga-comp" title="Many sellers competing">⚠${fmtK(r.price.availSell)}</span>` : '';
    const keep = r.needed ? `<span class="ga-keep" title="Your craft plan still needs this">⚠ needed</span>` : '';
    return `<div class="cp-row ga-row">
      ${iconImg(r.icon || icons[r.id], 'item-icon cp-icon')}
      <span class="cp-name" title="${esc(r.name)}">${esc(r.name)}<span class="ga-tier">T${r.tier}</span>${keep}</span>
      <span class="cp-right ga-right">
        <span class="ga-price">◆${fmtK(r.unit)}</span>
        <span class="ga-dem">${fmt(r.guaranteed)} want</span>${comp}
      </span>
    </div>`;
  }).join('');
  let sellHtml = '';
  if (sellNow.length) {
    sellHtml = '<div class="plan-divider">Sell from storage now</div>' + sellNow.map(r => {
      const sellQty = Math.min(r.have, r.guaranteed);
      return `<div class="cp-row ga-row">
        ${iconImg(r.icon || icons[r.id], 'item-icon cp-icon')}
        <span class="cp-name" title="${esc(r.name)}">${esc(r.name)}</span>
        <span class="cp-right"><span class="ga-have">${fmt(r.have)} held</span><span class="ga-price">◆${fmtK(sellQty * r.unit)}</span></span>
      </div>`;
    }).join('');
  }
  const age = Math.max(0, Math.round((Date.now() - ts) / 60000));
  const note = '<div class="ga-note">Ranked by sell-revenue per effort — only resources with live buyers (so they sell). The API can’t show gather locations.</div>';
  const foot = `<div class="ga-foot"><span class="ga-fresh">prices ~${age}m old</span><button class="ga-refresh">Refresh</button></div>`;
  return '<div class="ga-list">' + rows + '</div>' + sellHtml + note + foot;
}

function bindGatherEvents() {
  const btn = document.querySelector('.ga-refresh');
  if (btn) btn.addEventListener('click', () => { if (!_gatherInFlight) buildGather(true); });
}

// ─── Gather-rate tracker (Storage sub-mode "Rate") ──────────────────────────
// Samples the player's own inventory (carried + owned deployables) on a timer
// and logs per-item positive deltas, so we can show how much of each resource
// was gathered in the last 5/10/30/60 min. A session-level "gathering stopped"
// notification fires when all raw gains go idle for a configurable gap.
const GR_KEY = LS.gatherRate;
const GR_WINDOWS = [5, 10, 30, 60];      // minutes (selector)
const GR_RETAIN_MS = 60 * 60 * 1000;     // keep the last 60 min of gain events
const GR_MAX_EVENTS = 1500;              // safety cap on the event log
let _grInFlight = false;
let _grState = null;                     // { playerId, startTs, lastTotals, events:[{ts,id,n}], online }
let _grMeta = {};                        // id -> { name, tag, icon, type }; refreshed each poll (in-memory)
let _grSession = { firstTs: 0, lastTs: 0, gained: {}, polls: 0, warned: false }; // current gathering episode
let grView = { window: 30, rawsOnly: true };

function grState() {
  if (_grState) return _grState;
  const s = safeParse(localStorage.getItem(GR_KEY), null) || { playerId: null, startTs: 0, lastTotals: {}, events: [], online: null };
  const cut = Date.now() - GR_RETAIN_MS;
  s.events = (s.events || []).filter(e => e.ts >= cut);
  return (_grState = s);
}
function grSave() {
  const s = _grState; if (!s) return;
  const cut = Date.now() - GR_RETAIN_MS;
  s.events = s.events.filter(e => e.ts >= cut);
  if (s.events.length > GR_MAX_EVENTS) s.events = s.events.slice(-GR_MAX_EVENTS);
  s.lastTotals = capMap(s.lastTotals, 2000);
  localStorage.setItem(GR_KEY, JSON.stringify(s));
}

// Sum item quantities across the player's carried inventory + owned deployables
// (carts). Shared claim banks are excluded so other members can't skew the count.
function grContainerTotals(inv, playerId) {
  const pid = String(playerId), totals = {};
  for (const c of (inv.inventories || [])) {
    const carried    = String(c.ownerEntityId) === pid && String(c.playerOwnerEntityId ?? '0') === '0';
    const deployable = String(c.playerOwnerEntityId) === pid && c.buildingName == null;
    if (!carried && !deployable) continue;
    for (const p of (c.pockets || [])) {
      const ct = p && p.contents; if (!ct || !ct.itemId) continue;
      const k = String(ct.itemId); totals[k] = (totals[k] || 0) + (ct.quantity || 0);
    }
  }
  return totals;
}

async function pollGatherRate() {
  const reRender = () => { if (activeTab === 'storage' && storageMode === 'rate') renderTab('storage'); };
  if (!localStorage.getItem(LS.tasksPlayer)) { reRender(); return; }
  if (_grInFlight) return;
  const id = await resolveTasksPlayerId();
  if (!id) { reRender(); return; }
  _grInFlight = true;
  try {
    const s = grState();
    if (s.playerId !== id) { s.playerId = id; s.startTs = 0; s.lastTotals = {}; s.events = []; _grSession = { firstTs: 0, lastTs: 0, gained: {}, polls: 0, warned: false }; }
    const j = await bitwasp('players/' + id + '/inventories');
    // Embedded metadata join (items + cargos are itemId -> {name, tag, icon} maps).
    for (const [iid, m] of Object.entries(j.items || {}))  { _grMeta[iid] = { name: m.name, tag: m.tag || '', icon: m.iconAssetName || '', type: 0 }; if (m.iconAssetName) saveIcon(iid, m.iconAssetName); if (m.name) _saveName(iid, m.name); }
    for (const [iid, m] of Object.entries(j.cargos || {})) { _grMeta[iid] = { name: m.name, tag: m.tag || '', icon: m.iconAssetName || '', type: 1 }; if (m.iconAssetName) saveIcon(iid, m.iconAssetName); if (m.name) _saveName(iid, m.name); }
    // Online: prefer a field on the response, else reuse the buffs poll's flag.
    s.online = (j.signedIn != null) ? !!j.signedIn : ((buffsData && typeof buffsData === 'object') ? buffsData.isOnline : s.online);
    const now = Date.now();
    const cur = grContainerTotals(j, id);
    const gap = now - (s.lastPollTs || 0);
    s.lastPollTs = now;
    // First poll ever, or resuming after a long gap (app closed/suspended/slept):
    // re-seed the baseline without emitting phantom gains for unobserved changes.
    if (!s.startTs || gap > 90000) {
      if (!s.startTs) s.startTs = now;
      s.lastTotals = cur;
      _grSession = { firstTs: 0, lastTs: 0, gained: {}, polls: 0, warned: false };
      grSave(); reRender(); return;
    }
    // Positive deltas → gain events; raw-tagged gains also drive the stall detector.
    const rawGains = {};
    for (const [k, q] of Object.entries(cur)) {
      const prev = s.lastTotals[k] || 0;
      if (q > prev) {
        const n = q - prev;
        s.events.push({ ts: now, id: k, n });
        if (GATHER_TAGS.has(_grMeta[k]?.tag)) rawGains[k] = (rawGains[k] || 0) + n;
      }
    }
    s.lastTotals = cur;
    grStallCheck(rawGains, now);
    grSave();
    reRender();
  } catch(e) { console.error('gather-rate poll:', e); }
  finally { _grInFlight = false; }
}

// Session-level "gathering stopped" detector. Arms while raw resources flow in;
// once they stop for the configured gap, fires one summary ping (then resets).
function grStallCheck(rawGains, now) {
  if (localStorage.getItem(LS.gatherNotify) === '0') return;
  const gap = (Number(localStorage.getItem(LS.gatherStallSec)) || 60) * 1000;
  const sess = _grSession;
  if (Object.keys(rawGains).length) {
    if (!sess.firstTs) { sess.firstTs = now; sess.gained = {}; sess.polls = 0; }
    sess.lastTs = now; sess.warned = false; sess.polls += 1;
    for (const [k, n] of Object.entries(rawGains)) sess.gained[k] = (sess.gained[k] || 0) + n;
    return;
  }
  if (!sess.firstTs || sess.warned || now - sess.lastTs < gap) return;
  const total = Object.values(sess.gained).reduce((a, b) => a + b, 0);
  if (total < 2 || sess.polls < 2) { sess.firstTs = 0; return; } // ignore trivial one-off pickups
  const parts = Object.entries(sess.gained).sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${fmt(n)} ${_grMeta[k]?.name || itemsMap[k] || ('#' + k)}`);
  const summary = parts.slice(0, 4).join(', ') + (parts.length > 4 ? ', …' : '');
  const dur = fmtDur(Math.max(0, (sess.lastTs - sess.firstTs) / 1000));
  notify('Gathering stopped', `No gathering for ${Math.round(gap / 1000)}s — ${summary} (${dur})`);
  sess.warned = true; sess.firstTs = 0; // reset episode; next gain starts a fresh summary
}

function grWindowQuery(minutes) {
  const cut = Date.now() - minutes * 60000;
  const agg = {};
  for (const e of grState().events) if (e.ts >= cut) agg[e.id] = (agg[e.id] || 0) + e.n;
  return Object.entries(agg).map(([id, gained]) => ({ id, gained }))
    .sort((a, b) => b.gained - a.gained);
}

function renderGatherRate() {
  if (!localStorage.getItem(LS.tasksPlayer)) return '<div class="hint">Set your player name in Settings to track gather rate.</div>';
  const s = grState();
  if (!s.startTs) { setTimeout(() => pollGatherRate(), 0); return '<div class="hint">Collecting… keep gathering.</div>'; }
  const icons = iconMap();
  const win = grView.window;
  let rows = grWindowQuery(win);
  if (grView.rawsOnly) rows = rows.filter(r => GATHER_TAGS.has(_grMeta[r.id]?.tag));
  const winBar = '<div class="food-tiers">' + GR_WINDOWS.map(w =>
    `<button class="food-tierbtn ${win === w ? 'on' : ''}" data-grwin="${w}">${w}m</button>`).join('') + '</div>';
  const filtBar = '<div class="food-tiers">' +
    `<button class="food-tierbtn ${grView.rawsOnly ? 'on' : ''}" data-grfilter="raws">Raws</button>` +
    `<button class="food-tierbtn ${!grView.rawsOnly ? 'on' : ''}" data-grfilter="all">All</button>` + '</div>';
  let body;
  if (!rows.length) {
    body = `<div class="hint">No gathering in the last ${win}m.</div>`;
  } else {
    const list = rows.map(r => {
      const name = _grMeta[r.id]?.name || itemsMap[r.id] || ('#' + r.id);
      const icon = _grMeta[r.id]?.icon || icons[r.id];
      return `<div class="cp-row ga-row">
        ${iconImg(icon, 'item-icon cp-icon')}
        <span class="cp-name" title="${esc(name)}">${esc(name)}</span>
        <span class="cp-right ga-right"><span class="ga-price">+${fmt(r.gained)}</span></span>
      </div>`;
    }).join('');
    const total = rows.reduce((a, b) => a + b.gained, 0);
    const totLine = `<div class="plan-divider">Total: ${fmt(total)} gathered in last ${win}m</div>`;
    body = '<div class="ga-list">' + list + '</div>' + totLine;
  }
  const notes = [];
  const elapsed = Date.now() - s.startTs;
  if (elapsed < win * 60000) notes.push(`<div class="ga-note">Only ${fmtDur(elapsed / 1000)} tracked so far — the ${win}m window isn't full yet.</div>`);
  if (s.online === false) notes.push('<div class="ga-note">Player offline — inventory not syncing; rate is static.</div>');
  const foot = `<div class="ga-foot"><span class="ga-fresh">tracking ${fmtDur(elapsed / 1000)}</span><button class="ga-refresh gr-reset">Reset</button></div>`;
  return winBar + filtBar + body + notes.join('') + foot;
}

function bindGatherRateEvents() {
  const root = document.getElementById('tab-content');
  if (!root) return;
  root.querySelectorAll('[data-grwin]').forEach(b => b.addEventListener('click', () => { grView.window = Number(b.dataset.grwin); renderTab('storage'); }));
  root.querySelectorAll('[data-grfilter]').forEach(b => b.addEventListener('click', () => { grView.rawsOnly = b.dataset.grfilter === 'raws'; renderTab('storage'); }));
  const rst = root.querySelector('.gr-reset');
  // Keep lastTotals so the next poll doesn't count the whole inventory as "gained".
  if (rst) rst.addEventListener('click', () => { const s = grState(); s.startTs = Date.now(); s.events = []; _grSession = { firstTs: 0, lastTs: 0, gained: {}, polls: 0, warned: false }; grSave(); renderTab('storage'); });
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

// Depth of an item in its recipe tree (0 = base material). Caller passes a fresh
// memo so a partially-loaded tree in one render never poisons another.
function recipeDepth(id, cache, memo, seen = new Set()) {
  if (id in memo) return memo[id];
  if (seen.has(id)) return 0;
  seen.add(id);
  const r = cache[id];
  if (!r?.ingredients?.length) return (memo[id] = 0);
  const d = Math.max(...r.ingredients.map(ing => recipeDepth(ing.id, cache, memo, new Set(seen)))) + 1;
  return (memo[id] = d);
}

// Walk the recipe tree(s) of `goals` (id→target qty) against `invById` (id→qty on
// hand) and return gross needs + items covered because an ancestor product is in stock.
function computeNeeds(goals, invById) {
  if (!goals || !Object.keys(goals).length) return { needs: {}, satisfied: {} };
  const cache = recipeCache();
  const nameById = Object.fromEntries((allItems || []).map(i => [i.id, i.name]));
  const nameOf = id => nameById[id] || itemsMap[id] || cache[id]?.name || `Item ${String(id).slice(-6)}`;
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

  for (const [id, qty] of Object.entries(goals)) if (qty > 0) cascade(id, qty, null, new Set());
  for (const id of Object.keys(needs)) delete satisfied[id]; // genuinely-needed wins over satisfied
  return { needs, satisfied };
}

function renderByStage() {
  const invByQty = Object.fromEntries((allItems || []).map(i => [i.id, i.qty]));
  const { needs, satisfied } = computeNeeds(craftGoals, invByQty);
  const ids = [...new Set([...Object.keys(needs), ...Object.keys(satisfied)])];
  if (!ids.length) return '';
  const cache = recipeCache();
  const icons = iconMap();
  const invById = Object.fromEntries((allItems || []).map(i => [i.id, i]));

  // Compute depth (0 = base material) from recipe tree
  const depthMemo = {};

  const byStage = {};
  for (const id of ids) {
    const inv = invById[id];
    const r = cache[id];
    const name = inv?.name || itemsMap[id] || r?.name || `Item ${id.slice(-6)}`;
    const tag  = inv?.tag  || r?.tag  || 'Other';
    const qty  = inv?.qty  ?? 0;
    const s = recipeDepth(id, cache, depthMemo);
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

// ─── Chests tab ───────────────────────────────────────────────────────────
// A chest named (in-game) after a craftable item shows that item's FULL recipe
// tree broken down by production stage (like the craft plan), with a per-item
// status: 🟢 enough in THIS chest · 🟡 not here but in the settlement (move it) ·
// 🔴 missing everywhere. Chests whose nickname isn't a craftable item are hidden.
function renderChests() {
  if (chestsData === null) return '<div class="hint">Loading chests…</div>';
  const named = chestsData.filter(c => c.nickname);
  if (!named.length) return '<div class="hint">No nicknamed chests. Name a chest after an item (e.g. "Rough Plank") in-game to track craft readiness.</div>';
  if (window._chestsLoading) return '<div class="hint">Resolving recipes…</div>';

  const rc = recipeCache(), nc = nicknameCache(), icons = iconMap();
  const craftable = named.filter(c => {
    const id = nc[parseNickname(c.nickname).name.toLowerCase()]?.itemId;
    const r = id ? rc[id] : null;
    return r && r.ingredients?.length;
  });
  if (!craftable.length) return '<div class="hint">No chests named after a craftable item.</div>';

  const settle = Object.fromEntries((allItems || []).map(i => [String(i.id), i.qty]));
  return '<div class="chests">' + craftable.map(chest => {
    const { name, mult } = parseNickname(chest.nickname);
    const itemId = nc[name.toLowerCase()].itemId;
    return renderChestCard(chest, itemId, rc[itemId], settle, icons, rc, mult);
  }).join('') + '</div>';
}

function renderChestCard(chest, itemId, recipe, settle, icons, cache, mult = 1) {
  const chestInv = Object.fromEntries([...chest.contents]); // String(id) → qty in THIS chest
  // Expand the full tree against what's in THIS chest, so anything already staged
  // here prunes its sub-ingredients and everything else is shown to base materials.
  // `mult` (a "x N" suffix on the nickname) scales the whole tree's needs.
  const { needs, satisfied } = computeNeeds({ [String(itemId)]: mult }, chestInv);
  delete needs[String(itemId)]; delete satisfied[String(itemId)]; // the target is the card title
  const ids = [...new Set([...Object.keys(needs), ...Object.keys(satisfied)])];

  const memo = {}, byStage = {};
  for (const id of ids) {
    const r = cache[id];
    const name = itemsMap[id] || r?.name || `Item ${String(id).slice(-6)}`;
    const tag  = r?.tag || 'Other';
    const s = recipeDepth(id, cache, memo);
    ((byStage[s] ??= {})[tag] ??= []).push({ id, name });
  }

  let anyMissing = false, anyElsewhere = false, body = '';
  const maxStage = ids.length ? Math.max(...Object.keys(byStage).map(Number)) : 0;
  for (let s = 0; s <= maxStage; s++) {
    if (!byStage[s]) continue;
    const groups = byStage[s];
    const total = Object.values(groups).reduce((n, g) => n + g.length, 0);
    const label = s === 0 ? 'Base Materials' : `Production Stage ${s}`;
    let inner = '';
    for (const [tag, items] of Object.entries(groups).sort()) {
      items.sort((a, b) => (satisfied[a.id] ? 1 : 0) - (satisfied[b.id] ? 1 : 0));
      let rows = '';
      for (const item of items) {
        const id = item.id;
        let right;
        if (needs[id] != null) {
          const need = needs[id] || 0;
          const inChest = chestInv[id] || 0, inSettle = settle[id] || 0;
          let state, chip = '';
          if (inChest >= need) state = 'here';
          else if (inSettle >= need) { state = 'elsewhere'; anyElsewhere = true; chip = `<span class="ch-chip elsewhere">in storage ${fmt(inSettle)}</span>`; }
          else { state = 'missing'; anyMissing = true; chip = `<span class="ch-chip missing">missing ${fmt(need - inSettle)}</span>`; }
          right = `${chip}<span class="ch-need ${state}">${fmt(inChest)}/${fmt(need)}</span>`;
        } else {
          const sat = satisfied[id];
          right = `<span class="cp-need sat" title="Covered — chest already has enough ${esc(sat.by)}">✓ ${fmt(chestInv[id] || 0)}/${fmt(sat.qty)}</span>`;
        }
        rows += `<div class="cp-row">
          ${iconImg(icons[id], 'item-icon cp-icon')}
          <span class="cp-name" title="${esc(item.name)}">${esc(item.name)}</span>
          <span class="cp-right">${right}</span>
        </div>`;
      }
      inner += `<div class="cp-group"><div class="cp-gtag">${esc(tag)}<span class="cp-gbadge">${items.length}</span></div>${rows}</div>`;
    }
    body += `<div class="cp-stage"><div class="cp-shd"><span>${esc(label)}</span><span class="cp-sbadge">${total} total</span></div>${inner}</div>`;
  }

  const status = anyMissing ? '<span class="ch-st missing">Missing materials</span>'
    : anyElsewhere ? '<span class="ch-st elsewhere">Move materials here</span>'
    : '<span class="ch-st here">Ready to craft ✓</span>';
  const done = !anyMissing && !anyElsewhere ? ' ch-done' : '';
  const title = recipe.name || itemsMap[itemId] || parseNickname(chest.nickname).name;
  const multBadge = mult > 1 ? ` <span class="ch-mult">×${mult}</span>` : '';
  return `<div class="card ch-card${done}">
    <div class="card-head">
      ${iconImg(icons[itemId], 'item-icon cp-icon')}
      <span class="card-title" title="${esc(chest.nickname)}">${esc(title)}${multBadge}</span>
      ${status}
    </div>
    <div class="ch-type">${esc(chest.typeName)}</div>
    ${body}
  </div>`;
}

// Just the filtered/sorted rows — re-rendered on its own while typing so the
// search input element (and its caret) survive each keystroke.
function aiListHtml() {
  const q = (window._aiSearch || '').toLowerCase();
  const sort = window._aiSort || 'qty';
  const rows = (allItems || []).filter(r => !q || r.name.toLowerCase().includes(q));
  rows.sort((a, b) => sort === 'qty' ? b.qty - a.qty : a.name.localeCompare(b.name));
  if (!rows.length) return '<div class="hint">No items found.</div>';
  return rows.map(r => `<div class="ai-row">
    ${iconImg(r.icon)}
    <span class="ai-name">${esc(r.name)}</span>
    <span class="ai-qty">${fmt(r.qty)}</span>
  </div>`).join('');
}

function renderAllItems() {
  if (!allItems) return '<div class="hint">Loading…</div>';
  const q = (window._aiSearch || '').toLowerCase();
  const sort = window._aiSort || 'qty';
  const ctrl = `<div class="ai-ctrl">
    <input class="inp" id="ai-search" dir="ltr" autocomplete="off" placeholder="Search items…" value="${esc(q)}">
    <div class="seg">
      <button class="${sort === 'qty' ? 'on' : ''}" data-sort="qty">Qty</button>
      <button class="${sort === 'name' ? 'on' : ''}" data-sort="name">A–Z</button>
    </div>
  </div>`;
  return ctrl + `<div class="ai-list" id="ai-list">${aiListHtml()}</div>`;
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

let _tkCollapsed = new Set();   // NPC names whose task group is collapsed (in-memory, per session)
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
    const collapsed = _tkCollapsed.has(npc);
    const header = `<div class="tk-npc" data-npc="${esc(npc)}"><span class="tk-npc-lbl"><span class="tk-caret">${collapsed ? '▸' : '▾'}</span>${esc(npc)}</span><span class="tk-npc-count">${ndone}/${list.length}</span></div>`;
    return header + (collapsed ? '' : list.map(taskCard).join(''));
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
      <label class="settings-check"><input type="checkbox" id="cfg-gather-notify" ${localStorage.getItem(LS.gatherNotify) === '0' ? '' : 'checked'}> Notify when gathering stops</label>
      <div class="settings-row">
        <span class="settings-value">Idle threshold (s)</span>
        <input class="inp settings-inp settings-num" id="cfg-gather-stall" type="number" min="15" value="${esc(localStorage.getItem(LS.gatherStallSec) || '60')}">
      </div>
      <button class="settings-save" id="cfg-test-notify" style="margin-top:6px">Test notification</button>
    </div>
    <div class="settings-section">
      <div class="settings-label">Display</div>
      <div class="settings-row">
        <span class="settings-value">Opacity</span>
        <span class="settings-num-lbl" id="cfg-opacity-val">${Math.round((parseFloat(localStorage.getItem(LS.opacity)) || 1) * 100)}%</span>
      </div>
      <input class="settings-range" id="cfg-opacity" type="range" min="40" max="100" step="5" value="${Math.round((parseFloat(localStorage.getItem(LS.opacity)) || 1) * 100)}">
      <div class="settings-row">
        <span class="settings-value">UI scale</span>
        <span class="settings-num-lbl" id="cfg-scale-val">${Math.round((parseFloat(localStorage.getItem(LS.scale)) || 1) * 100)}%</span>
      </div>
      <input class="settings-range" id="cfg-scale" type="range" min="80" max="130" step="5" value="${Math.round((parseFloat(localStorage.getItem(LS.scale)) || 1) * 100)}">
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
    if (storageMode === 'gather') bindGatherEvents();
    if (storageMode === 'rate') bindGatherRateEvents();
  }
  if (id === 'chests') resolveChestNicknames();
  if (id === 'buffs') {
    document.querySelectorAll('.mode-toggle button[data-bmode]').forEach(btn =>
      btn.addEventListener('click', () => { buffsMode = btn.dataset.bmode; renderTab('buffs'); }));
    if (buffsMode === 'food') {
      const inp = document.getElementById('food-search');
      if (inp) {
        inp.addEventListener('mousedown', e => e.stopPropagation());
        // Update ONLY the list while typing (caret-preserving); debounce the API call.
        inp.addEventListener('input', e => {
          window._foodSearch = e.target.value;
          const l = document.getElementById('food-list');
          if (l) l.innerHTML = foodListHtml();
          clearTimeout(_foodSearchTimer);
          _foodSearchTimer = setTimeout(() => doFoodSearch((window._foodSearch || '').trim()), 250);
        });
        inp.focus();
        const len = inp.value.length; inp.setSelectionRange(len, len);
      }
      // Delegated tier-filter clicks. Bound on the stable #food-list element so it
      // survives the innerHTML swaps done while typing / on storage polls.
      const fl = document.getElementById('food-list');
      if (fl) fl.addEventListener('click', e => {
        const b = e.target.closest('.food-tierbtn');
        if (!b) return;
        window._foodTier = b.dataset.tier === 'all' ? null : Number(b.dataset.tier);
        fl.innerHTML = foodListHtml();
      });
    }
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
    // Collapse/expand each NPC's task group.
    document.querySelectorAll('.tk-npc').forEach(h => {
      h.addEventListener('mousedown', e => e.stopPropagation());
      h.addEventListener('click', () => {
        const npc = h.dataset.npc;
        if (_tkCollapsed.has(npc)) _tkCollapsed.delete(npc); else _tkCollapsed.add(npc);
        renderTab('tasks');
      });
    });
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
    const gatherChk = document.getElementById('cfg-gather-notify');
    if (gatherChk) gatherChk.addEventListener('change', () => localStorage.setItem(LS.gatherNotify, gatherChk.checked ? '1' : '0'));
    const gatherStall = document.getElementById('cfg-gather-stall');
    if (gatherStall) {
      gatherStall.addEventListener('mousedown', e => e.stopPropagation());
      gatherStall.addEventListener('change', () => localStorage.setItem(LS.gatherStallSec, String(Math.max(15, parseInt(gatherStall.value) || 60))));
    }
    const testBtn = document.getElementById('cfg-test-notify');
    if (testBtn) testBtn.addEventListener('click', () => notify('BitCraft Overlay', 'Notifications are working'));
    const opRange = document.getElementById('cfg-opacity');
    if (opRange) {
      opRange.addEventListener('mousedown', e => e.stopPropagation());
      opRange.addEventListener('input', () => {
        const v = Math.max(40, Math.min(100, parseInt(opRange.value) || 100)) / 100;
        localStorage.setItem(LS.opacity, String(v));
        const lbl = document.getElementById('cfg-opacity-val'); if (lbl) lbl.textContent = Math.round(v * 100) + '%';
        applyDisplayPrefs();
      });
    }
    const scRange = document.getElementById('cfg-scale');
    if (scRange) {
      scRange.addEventListener('mousedown', e => e.stopPropagation());
      scRange.addEventListener('input', () => {
        const v = Math.max(80, Math.min(130, parseInt(scRange.value) || 100)) / 100;
        localStorage.setItem(LS.scale, String(v));
        const lbl = document.getElementById('cfg-scale-val'); if (lbl) lbl.textContent = Math.round(v * 100) + '%';
        applyDisplayPrefs();
      });
    }
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
    inp.addEventListener('mousedown', e => e.stopPropagation());
    // Update ONLY the list while typing — re-rendering the whole tab per keystroke
    // replaced the input mid-type and scrambled the text / jumped the caret.
    inp.addEventListener('input', e => {
      window._aiSearch = e.target.value;
      const list = document.getElementById('ai-list');
      if (list) list.innerHTML = aiListHtml();
    });
    // Restore focus + caret to the end after an external re-render (e.g. a 5s poll).
    inp.focus();
    const len = inp.value.length;
    inp.setSelectionRange(len, len);
  }
  document.querySelectorAll('.seg button').forEach(btn => {
    btn.addEventListener('click', () => { window._aiSort = btn.dataset.sort; renderTab('storage'); });
  });
}

// ─── App init ─────────────────────────────────────────────────────────────
// Apply persisted overlay opacity (CSS var on #app) and UI scale (CSS zoom).
function applyDisplayPrefs() {
  const op = parseFloat(localStorage.getItem(LS.opacity));
  const opacity = (op >= 0.4 && op <= 1) ? op : 1;
  const app = document.getElementById('app');
  if (app) app.style.setProperty('--app-opacity', String(opacity));
  const sc = parseFloat(localStorage.getItem(LS.scale));
  const scale = (sc >= 0.8 && sc <= 1.3) ? sc : 1;
  document.documentElement.style.zoom = String(scale);
}

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
    for (const tab of ['storage', 'builds', 'jobs', 'members', 'tasks', 'buffs', 'skills', 'gatherrate']) {
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
applyDisplayPrefs();
if (settlement) startMain();
else showView('setup');
checkForUpdate();
primeNotify();
T?.core?.invoke('app_version').then(v => {
  window._appVersion = v;
  if (activeTab === 'settings') renderTab('settings');
}).catch(() => {});
