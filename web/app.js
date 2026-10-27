'use strict';

/* EconRadar 网页版
   数据由 GitHub Actions 定时抓取为 data/latest.json，前端只负责展示。
   约定：上涨红色、下跌绿色（A 股惯例）；数字前始终带 + / - 号。 */

/* ---------- 基础引用 ---------- */

const grids = {
  cn: document.getElementById('grid-cn'),
  global: document.getElementById('grid-global'),
  usmacro: document.getElementById('grid-usmacro'),
  commodity: document.getElementById('grid-commodity'),
  cnIndex: document.getElementById('grid-cn-index'),
  cnCni: document.getElementById('grid-cn-cni'),
  usIndustry: document.getElementById('grid-us-industry'),
};

const pages = {
  market: document.getElementById('page-market'),
  industry: document.getElementById('page-industry'),
  fundflow: document.getElementById('page-fundflow'),
};

// 置顶区：每个页面一块，卡片可从该页任意板块移入
const pinnedGrids = {
  market: document.getElementById('grid-pinned-market'),
  industry: document.getElementById('grid-pinned-industry'),
};
const pinnedSections = {
  market: document.getElementById('pinned-market'),
  industry: document.getElementById('pinned-industry'),
};

// 普通板块 -> 所属页面，决定置顶卡片放在哪一页
const PAGE_GRIDS = {
  market: ['cn', 'global', 'commodity', 'usmacro'],
  industry: ['cnIndex', 'cnCni', 'usIndustry'],
};
const GRID_PAGE = {};
for (const [page, keys] of Object.entries(PAGE_GRIDS)) {
  for (const key of keys) GRID_PAGE[grids[key].id] = page;
}

const tabButtons = Array.from(document.querySelectorAll('.tab, .bottom-tab'));
const updateTimeEl = document.getElementById('update-time');
const statusDot = document.getElementById('status-dot');
const refreshBtn = document.getElementById('refresh-btn');
const toastEl = document.getElementById('toast');
const marketCountEl = document.getElementById('market-count');
const industryCountEl = document.getElementById('industry-count');

const CACHE_KEY = 'econradar-web-latest-v1';
const ORDER_PREFIX = 'econradar-web-card-order:';
const PIN_KEY = 'econradar-web-pinned-v1';
const AUTO_REFRESH_MS = 5 * 60 * 1000;
const STALE_AFTER_MS = 45 * 60 * 1000;

// 跨设备排序同步：Cloudflare Pages Functions + KV，固定共享 key
const SYNC_URL = 'https://econradar-sync.pages.dev/api/order';
const SYNC_TIME_KEY = 'econradar-web-order-updated-at';
const SYNC_PULL_MS = 30 * 1000;

let state = { data: null, loading: false, fromCache: false };
let toastTimer = null;

/* ---------- 页面切换 ---------- */

function switchPage(page, { updateHash = true } = {}) {
  if (!pages[page]) page = 'market';
  for (const [key, el] of Object.entries(pages)) el.hidden = key !== page;
  for (const btn of tabButtons) {
    const active = btn.dataset.page === page;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  }
  if (updateHash) history.replaceState(null, '', `#${page}`);

  // 切页回到顶部
  const rootEl = document.documentElement;
  const prevBehavior = rootEl.style.scrollBehavior;
  rootEl.style.scrollBehavior = 'auto';
  window.scrollTo(0, 0);
  rootEl.style.scrollBehavior = prevBehavior;

  // 刚切到可见的页面此前无法测量宽度，需要补一次字号适配
  refitAllTitles();
  refitAllPills();
}

for (const btn of tabButtons) {
  btn.addEventListener('click', () => switchPage(btn.dataset.page));
}

// 首屏固定进「市场」：浏览器 / 移动端恢复会话时地址栏可能残留 #industry，
// 不沿用 hash，避免一打开就落在行业页
switchPage('market');

// 支持浏览器前进/后退与手动改 hash 切页
window.addEventListener('hashchange', () => {
  const page = location.hash.replace('#', '');
  if (pages[page]) switchPage(page, { updateHash: false });
});

/* ---------- 格式化 ---------- */

function fmtPrice(v) {
  if (v == null) return '--';
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

/** 始终带正负号：+1.23 / -0.45 */
function fmtSigned(v, suffix = '', digits = 2) {
  if (v == null) return '--';
  const sign = v > 0 ? '+' : v < 0 ? '-' : '+';
  return `${sign}${Math.abs(v).toFixed(digits)}${suffix}`;
}

function directionOf(pct) {
  if (pct == null || pct === 0) return 'flat';
  return pct > 0 ? 'up' : 'down';
}

/** ISO 时间 -> 北京时间 "MM-DD HH:mm" */
function fmtBeijing(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--';
  return d
    .toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    .replace(/\//g, '-');
}

/** 数据快照时间 -> 只取 "HH:mm"（同一天时更简洁） */
function fmtBeijingClock(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--';
  return d.toLocaleTimeString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/* ---------- 标题与 pill 的自适应字号 ---------- */

function applyTitle(titleEl, name) {
  titleEl.querySelector('.name').textContent = name;
  fitTitle(titleEl);
}

function fitTitle(titleEl) {
  titleEl.classList.remove('title-md', 'title-sm');
  if (!titleEl.isConnected || titleEl.clientWidth === 0) return;
  if (titleEl.scrollWidth <= titleEl.clientWidth + 1) return;
  titleEl.classList.add('title-md');
  if (titleEl.scrollWidth <= titleEl.clientWidth + 1) return;
  titleEl.classList.replace('title-md', 'title-sm');
}

function refitAllTitles() {
  document.querySelectorAll('.card-title').forEach(fitTitle);
}

function fitPill(rowEl) {
  const pill = rowEl.querySelector('.pill');
  if (!pill) return;
  pill.classList.remove('pill-md', 'pill-sm', 'pill-xs');
  if (!rowEl.isConnected || rowEl.clientWidth === 0) return;
  if (rowEl.scrollWidth <= rowEl.clientWidth + 1) return;
  pill.classList.add('pill-md');
  if (rowEl.scrollWidth <= rowEl.clientWidth + 1) return;
  pill.classList.replace('pill-md', 'pill-sm');
  if (rowEl.scrollWidth <= rowEl.clientWidth + 1) return;
  pill.classList.replace('pill-sm', 'pill-xs');
}

function refitAllPills() {
  document.querySelectorAll('.card-row').forEach(fitPill);
}

let refitRaf = 0;
window.addEventListener('resize', () => {
  if (refitRaf) return;
  refitRaf = requestAnimationFrame(() => {
    refitRaf = 0;
    refitAllTitles();
    refitAllPills();
    // 手机端状态文案更短，跨断点时重新生成
    if (state.data) updateStatus({ fromCache: state.fromCache });
  });
});

/* ---------- 拖拽排序（桌面鼠标 + 移动端长按） ---------- */

let isDragging = false;

function orderKey(grid) {
  return `${ORDER_PREFIX}${grid.id}`;
}

function saveOrder(grid) {
  try {
    const codes = Array.from(grid.querySelectorAll('.card:not(.skeleton)')).map(
      (c) => c.dataset.code
    );
    localStorage.setItem(orderKey(grid), JSON.stringify(codes));
    queueSync();
  } catch (_) { /* 忽略持久化失败 */ }
}

function applySavedOrder(grid) {
  let saved = [];
  try {
    saved = JSON.parse(localStorage.getItem(orderKey(grid)) || '[]');
  } catch (_) {
    saved = [];
  }
  if (!Array.isArray(saved)) return;
  for (const code of saved) {
    const card = cardMap.get(code);
    if (card && card.parentElement === grid) grid.appendChild(card);
  }
}

/* ---------- 跨设备排序同步 ---------- */

let syncTimer = null;

/** 收集当前所有板块的卡片顺序（以 DOM 为准，首次同步时也能拿到完整快照） */
function collectOrders() {
  const orders = {};
  for (const grid of Object.values(grids)) {
    const codes = Array.from(grid.querySelectorAll('.card:not(.skeleton)')).map(
      (c) => c.dataset.code
    );
    if (codes.length) orders[grid.id] = codes;
  }
  return orders;
}

/** 拖拽结束后防抖上传，避免一次拖动连续触发多个请求 */
function queueSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(pushOrders, 800);
}

async function pushOrders() {
  const orders = collectOrders();
  if (!Object.keys(orders).length) return;
  const updatedAt = Date.now();
  try {
    const res = await fetch(SYNC_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updatedAt, orders, pins: pinnedCodes }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    localStorage.setItem(SYNC_TIME_KEY, String(updatedAt));
  } catch (err) {
    // 离线或服务不可用时只保留本地顺序，下次拖拽会重试
    console.warn('[sync] 排序上传失败', err);
  }
}

/** 拉取远端顺序：远端更新则覆盖本地；远端为空则把本机顺序初始化上去 */
async function pullOrders() {
  try {
    const res = await fetch(SYNC_URL, { cache: 'no-store' });
    if (!res.ok) return;
    const remote = await res.json();
    const localAt = Number(localStorage.getItem(SYNC_TIME_KEY)) || 0;

    if (!remote || !remote.orders || typeof remote.updatedAt !== 'number') {
      if (Object.keys(collectOrders()).length) queueSync();
      return;
    }
    if (remote.updatedAt <= localAt) return;

    for (const [gridId, codes] of Object.entries(remote.orders)) {
      if (!Array.isArray(codes)) continue;
      localStorage.setItem(`${ORDER_PREFIX}${gridId}`, JSON.stringify(codes));
    }
    if (Array.isArray(remote.pins)) {
      pinnedCodes = remote.pins.filter((code) => typeof code === 'string');
      localStorage.setItem(PIN_KEY, JSON.stringify(pinnedCodes));
    }
    localStorage.setItem(SYNC_TIME_KEY, String(remote.updatedAt));
    for (const grid of Object.values(grids)) applySavedOrder(grid);
    applyPins();
    refitAllTitles();
    refitAllPills();
  } catch (_) { /* 离线时保持本地顺序 */ }
}

/**
 * 没有用户手动排序过的板块，按数据源顺序排列。
 * 这样指标调整分组或数据源顺序变化时，卡片会跟着走；用户拖拽过的板块保持原样。
 */
function applyDataOrder(items) {
  for (const [group, grid] of Object.entries(grids)) {
    if (localStorage.getItem(orderKey(grid))) continue;
    for (const item of items) {
      if (item.group !== group) continue;
      const card = cardMap.get(item.code);
      if (card && card.parentElement === grid) grid.appendChild(card);
    }
  }
}

/* ---------- 置顶 ---------- */

let pinnedCodes = loadPinned();

function loadPinned() {
  try {
    const saved = JSON.parse(localStorage.getItem(PIN_KEY) || '[]');
    return Array.isArray(saved) ? saved.filter((code) => typeof code === 'string') : [];
  } catch (_) {
    return [];
  }
}

function savePinned() {
  try {
    localStorage.setItem(PIN_KEY, JSON.stringify(pinnedCodes));
  } catch (_) { /* 存储失败不影响本次操作 */ }
  queueSync();
}

function pageOfHomeGrid(grid) {
  return GRID_PAGE[grid.id];
}

function updatePinButton(card) {
  const btn = card.querySelector('.pin');
  if (!btn) return;
  const pinned = pinnedCodes.includes(card.dataset.code);
  card.classList.toggle('pinned', pinned);
  btn.classList.toggle('active', pinned);
  btn.setAttribute('aria-pressed', String(pinned));
  btn.title = pinned ? '取消置顶' : '置顶';
}

function updatePinnedSections() {
  for (const [page, grid] of Object.entries(pinnedGrids)) {
    if (!grid || !pinnedSections[page]) continue;
    const count = grid.querySelectorAll('.card:not(.skeleton)').length;
    pinnedSections[page].hidden = count === 0;
    const badge = pinnedSections[page].querySelector('.pinned-count');
    if (badge) badge.textContent = count ? `${count} 项` : '';
  }
}

/** 把已置顶的卡片按保存顺序放进各页置顶区 */
function applyPins() {
  for (const code of pinnedCodes) {
    const card = cardMap.get(code);
    if (!card || !card._homeGrid) continue;
    const grid = pinnedGrids[pageOfHomeGrid(card._homeGrid)];
    if (grid) grid.appendChild(card);
  }
  for (const card of cardMap.values()) updatePinButton(card);
  updatePinnedSections();
}

/** 取消置顶后回到原板块：有手动排序按手动顺序，否则按数据源顺序 */
function restoreHomeOrder(grid) {
  if (localStorage.getItem(orderKey(grid))) {
    applySavedOrder(grid);
    return;
  }
  if (state.data) applyDataOrder(collectItems(state.data));
}

function togglePin(card) {
  const code = card.dataset.code;
  const home = card._homeGrid;
  if (!code || !home) return;
  const page = pageOfHomeGrid(home);
  const target = pinnedGrids[page];
  if (!target) return;

  if (pinnedCodes.includes(code)) {
    pinnedCodes = pinnedCodes.filter((c) => c !== code);
    home.appendChild(card);
    restoreHomeOrder(home);
  } else {
    pinnedCodes.push(code);
    target.appendChild(card);
  }

  updatePinButton(card);
  updatePinnedSections();
  savePinned();
  refitAllTitles();
  refitAllPills();
}

/* ---------- 拖拽排序 ---------- */

/**
 * 每个网格独立初始化 Sortable：只允许在同一板块内排序。
 * 鼠标直接拖拽；触摸设备长按 260ms 再拖，避免和页面滚动冲突。
 */
function sortableOptions(onEnd) {
  return {
    animation: 160,
    draggable: '.card:not(.skeleton)',
    delay: 260,
    delayOnTouchOnly: true,
    touchStartThreshold: 4,
    forceFallback: true,
    fallbackTolerance: 3,
    fallbackOnBody: true,
    ghostClass: 'sortable-ghost',
    chosenClass: 'sortable-chosen',
    dragClass: 'sortable-drag',
    scroll: true,
    bubbleScroll: true,
    onStart: () => {
      isDragging = true;
    },
    onEnd,
  };
}

function setupGridDnd(grid) {
  if (!window.Sortable) return;
  window.Sortable.create(
    grid,
    sortableOptions(() => {
      isDragging = false;
      reorderUsMacroGrid();
      saveOrder(grid);
    })
  );
}

/** 置顶区内部也可拖拽排序，顺序随置顶列表保存并同步 */
function setupPinnedDnd(grid) {
  if (!window.Sortable || !grid) return;
  window.Sortable.create(
    grid,
    sortableOptions(() => {
      isDragging = false;
      pinnedCodes = Array.from(grid.querySelectorAll('.card:not(.skeleton)')).map(
        (c) => c.dataset.code
      );
      savePinned();
      refitAllTitles();
      refitAllPills();
    })
  );
}

/* ---------- 卡片 ---------- */

function createCard(item) {
  const card = document.createElement('div');
  card.className = 'card loading';
  const valueFirst = item.group === 'usmacro';
  if (valueFirst) card.classList.add('card-value-first');
  card.dataset.code = item.code;

  const title = document.createElement('div');
  title.className = 'card-title';
  title.innerHTML =
    '<a class="name" target="_blank" rel="noopener noreferrer" draggable="false"></a>' +
    '<span class="pin" role="button" tabindex="0" title="置顶" aria-pressed="false">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 17v5"/>' +
    '<path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>' +
    '</svg></span>' +
    '<span class="grip" title="按住拖动卡片">⠿</span>';
  applyTitle(title, item.name);
  const pinBtn = title.querySelector('.pin');
  pinBtn.addEventListener('click', () => togglePin(card));
  pinBtn.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    togglePin(card);
  });
  const link = title.querySelector('.name');
  if (item.url) link.href = item.url;
  link.title = `在新窗口打开 ${item.name} 详情页`;

  const row = document.createElement('div');
  row.className = 'card-row';
  const pill = document.createElement('span');
  pill.className = 'pill flat';
  pill.textContent = '--';
  const amt = document.createElement('span');
  amt.className = 'change-amt flat';

  const price = document.createElement('div');
  price.className = 'card-price';
  price.textContent = '--';

  const time = document.createElement('div');
  time.className = 'card-time';

  card.appendChild(title);
  if (valueFirst) {
    row.appendChild(price);
    row.appendChild(pill);
    card.appendChild(row);
    card.appendChild(amt);
  } else {
    row.appendChild(pill);
    row.appendChild(amt);
    card.appendChild(row);
    card.appendChild(price);
  }
  card.appendChild(time);

  return card;
}

function updateCard(card, item) {
  card.classList.remove('loading', 'skeleton');
  const titleEl = card.querySelector('.card-title');
  const priceEl = card.querySelector('.card-price');
  const pillEl = card.querySelector('.pill');
  const amtEl = card.querySelector('.change-amt');
  const timeEl = card.querySelector('.card-time');

  if (item.error) {
    card.classList.add('no-data');
    priceEl.textContent = '--';
    priceEl.className = 'card-price';
    pillEl.className = 'pill flat';
    pillEl.textContent = '暂无数据';
    amtEl.textContent = '';
    amtEl.className = 'change-amt';
    timeEl.textContent = '';
    fitPill(card.querySelector('.card-row'));
    return;
  }
  card.classList.remove('no-data');

  applyTitle(titleEl, item.name);
  if (item.url) titleEl.querySelector('.name').href = item.url;

  // 美国宏观指标：主显示最新值（带单位），pill 为较上期变化，配角显示前值
  if (item.kind === 'macro') {
    const dir = directionOf(item.change);
    pillEl.className = `pill ${dir}`;
    pillEl.textContent = fmtSigned(item.change, item.unit, item.digits);
    amtEl.className = 'change-amt';
    amtEl.textContent =
      item.prev != null ? `前值 ${item.prev.toFixed(item.digits)}${item.unit}` : '';
    priceEl.textContent = `${item.value.toFixed(item.digits)}${item.unit}`;
    colorValue(priceEl, item, dir);
    timeEl.textContent = item.time || '';
    fitPill(card.querySelector('.card-row'));
    return;
  }

  const dir = directionOf(item.changePct);
  pillEl.className = `pill ${dir}`;
  pillEl.textContent = fmtSigned(item.changePct, '%');
  priceEl.textContent = `${fmtPrice(item.price)}${item.unit || ''}`;
  colorValue(priceEl, item, dir);
  if (item.group === 'usmacro') {
    amtEl.className = 'change-amt';
    amtEl.textContent = item.prev != null ? `前值 ${fmtPrice(item.prev)}${item.unit || ''}` : '';
  } else {
    amtEl.className = `change-amt ${dir}`;
    amtEl.textContent =
      item.change != null
        ? fmtSigned(item.change, '', Math.abs(item.change) >= 10 ? 2 : 3)
        : '';
  }
  timeEl.textContent = item.time || '';
  fitPill(card.querySelector('.card-row'));
}

function colorValue(priceEl, item, dir) {
  priceEl.className = item.group === 'usmacro' ? `card-price ${dir}` : 'card-price';
}

const cardMap = new Map();

function ensureCards(items) {
  for (const item of items) {
    if (!item || !item.code) continue;
    const target = grids[item.group];
    if (!target) continue;

    const existing = cardMap.get(item.code);
    if (existing) {
      existing._homeGrid = target;
      // 指标调整分组（如中国国债从国内指数移到大宗商品）时，把已有卡片迁到新网格；
      // 已置顶的卡片留在置顶区，由 applyPins 按新归属重新放置
      if (!pinnedCodes.includes(item.code) && existing.parentElement !== target) {
        target.appendChild(existing);
      }
      continue;
    }

    const card = createCard(item);
    card._homeGrid = target;
    cardMap.set(item.code, card);
    target.appendChild(card);
  }
  for (const grid of Object.values(grids)) applySavedOrder(grid);
  applyDataOrder(items);
  applyPins();
  refitAllTitles();
  refitAllPills();
}

function renderItems(items) {
  ensureCards(items);
  for (const item of items) {
    const card = cardMap.get(item.code);
    if (card) updateCard(card, item);
  }
  if (items.some((it) => it.group === 'usmacro')) reorderUsMacroGrid();
}

/**
 * 美国宏观经济板块：获取失败/无数据的卡片自动排到板块末尾。
 * 只做稳定分区，正常卡片之间保持原有相对顺序（含用户手动拖拽的结果）。
 */
function reorderUsMacroGrid() {
  const grid = grids.usmacro;
  const cards = Array.from(grid.querySelectorAll('.card:not(.skeleton)'));
  const noData = cards.filter((c) => c.classList.contains('no-data'));
  if (!noData.length) return;
  const desired = cards.filter((c) => !c.classList.contains('no-data')).concat(noData);
  if (cards.every((c, i) => c === desired[i])) return;
  for (const card of desired) grid.appendChild(card);
}

/* ---------- 骨架屏 ---------- */

function makeSkeleton() {
  const el = document.createElement('div');
  el.className = 'card skeleton';
  el.innerHTML =
    '<div class="skeleton-line w-60"></div>' +
    '<div class="skeleton-line w-40"></div>' +
    '<div class="skeleton-line w-80"></div>' +
    '<div class="skeleton-line w-30"></div>';
  return el;
}

function showSkeletons() {
  for (const grid of Object.values(grids)) {
    if (grid.querySelector('.card:not(.skeleton)')) continue;
    if (grid.querySelector('.skeleton')) continue;
    for (let i = 0; i < 5; i += 1) grid.appendChild(makeSkeleton());
  }
}

function clearSkeletons() {
  document.querySelectorAll('.card.skeleton').forEach((el) => el.remove());
}

/* ---------- 本地缓存：先显后刷 ---------- */

function loadCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (
      cached &&
      cached.data &&
      cached.data.schemaVersion === 1 &&
      typeof cached.data.generatedAt === 'string'
    ) {
      return cached.data;
    }
  } catch (_) { /* 缓存损坏时按无缓存处理 */ }
  return null;
}

function saveCache(data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), data }));
  } catch (_) { /* 存储失败不影响主流程 */ }
}

/* ---------- 资金流向 ---------- */

const FF_RANGE_LABELS = { today: '今日', '5d': '5日', '10d': '10日' };
let ffRange = 'today';

function fmtYi(v) {
  if (v == null || Number.isNaN(Number(v))) return '--';
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  return `${sign}${(Math.abs(v) / 1e8).toFixed(1)}亿`;
}

function renderFfChart(container, boards, dir) {
  container.innerHTML = '';
  if (!Array.isArray(boards) || !boards.length) {
    const empty = document.createElement('div');
    empty.className = 'ff-empty';
    empty.textContent = '暂无数据';
    container.appendChild(empty);
    return;
  }
  const maxAbs = Math.max(...boards.map((b) => Math.abs(b.amount)), 1);
  for (const b of boards) {
    const row = document.createElement('div');
    row.className = 'ff-row';

    const name = document.createElement('span');
    name.className = 'ff-name';
    name.textContent = b.name;
    name.title = b.name;

    const track = document.createElement('div');
    track.className = `ff-track ${dir}`;
    const bar = document.createElement('div');
    bar.className = 'ff-bar';
    bar.style.width = `${(Math.abs(b.amount) / maxAbs) * 100}%`;
    track.appendChild(bar);

    const value = document.createElement('span');
    value.className = `ff-value ${dir === 'in' ? 'up' : 'down'}`;
    value.textContent = fmtYi(b.amount);

    row.appendChild(name);
    row.appendChild(track);
    row.appendChild(value);
    container.appendChild(row);
  }
}

function renderFundFlow() {
  const data = state.data && state.data.fundflow ? state.data.fundflow[ffRange] : null;
  const label = FF_RANGE_LABELS[ffRange] || FF_RANGE_LABELS.today;
  const inflowEl = document.getElementById('ff-inflow');
  const outflowEl = document.getElementById('ff-outflow');
  const stampEl = document.getElementById('ff-stamp');

  if (!data) {
    inflowEl.innerHTML = '<div class="ff-empty">暂无数据，可稍后刷新重试</div>';
    outflowEl.innerHTML = '<div class="ff-empty">暂无数据，可稍后刷新重试</div>';
    document.getElementById('ff-inflow-total').textContent = `${label}主力净流入合计：--`;
    document.getElementById('ff-outflow-total').textContent = `${label}主力净流出合计：--`;
    stampEl.textContent = '';
    return;
  }

  renderFfChart(inflowEl, data.inflow, 'in');
  renderFfChart(outflowEl, data.outflow, 'out');
  document.getElementById('ff-inflow-total').textContent =
    `${label}主力净流入合计：${fmtYi(data.inflowTotal)}（TOP10 板块）`;
  document.getElementById('ff-outflow-total').textContent =
    `${label}主力净流出合计：${fmtYi(data.outflowTotal)}（TOP10 板块）`;
  stampEl.textContent = state.data.generatedAt
    ? `数据快照 ${fmtBeijing(state.data.generatedAt)}`
    : '';
}

document.querySelectorAll('input[name="ff-range"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    if (!radio.checked) return;
    ffRange = radio.value;
    renderFundFlow();
  });
});

/* ---------- 状态与提示 ---------- */

function isCompactView() {
  return window.matchMedia('(max-width: 767px)').matches;
}

function setStatus(kind, fullText, shortText) {
  statusDot.className = `status-dot${kind ? ` ${kind}` : ''}`;
  updateTimeEl.textContent =
    isCompactView() && shortText ? shortText : fullText;
}

function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 4200);
}

function flattenStatuses(sourceStatus) {
  const out = [];
  for (const value of Object.values(sourceStatus || {})) {
    if (!value || typeof value !== 'object') continue;
    if ('ok' in value || 'stale' in value) out.push(value);
    else out.push(...Object.values(value));
  }
  return out.filter((v) => v && typeof v === 'object');
}

function updateStatus({ fromCache = false } = {}) {
  const data = state.data;
  if (!data) return;
  const time = fmtBeijingClock(data.generatedAt);
  if (fromCache) {
    setStatus(
      '',
      `缓存 · ${fmtBeijing(data.generatedAt)}`,
      `缓存 ${time}`
    );
    return;
  }
  const statuses = flattenStatuses(data.sourceStatus);
  const hasStale = statuses.some((s) => s.stale);
  const hasFail = statuses.some((s) => s.ok === false);
  const age = Date.now() - new Date(data.generatedAt).getTime();

  if (hasFail) {
    setStatus('warn', `更新于 ${time} · 部分数据未更新`, `${time} · 部分未更新`);
  } else if (hasStale) {
    setStatus('warn', `更新于 ${time} · 部分沿用上次`, `${time} · 部分沿用`);
  } else if (Number.isFinite(age) && age > STALE_AFTER_MS) {
    setStatus('warn', `更新于 ${time} · 数据可能延迟`, `${time} · 可能延迟`);
  } else {
    setStatus('live', `更新于 ${time}`, time);
  }
}

function updateCounts() {
  const market = document.querySelectorAll('#page-market .card:not(.skeleton)').length;
  const industry = document.querySelectorAll('#page-industry .card:not(.skeleton)').length;
  marketCountEl.textContent = market ? `${market} 项` : '';
  industryCountEl.textContent = industry ? `${industry} 项` : '';
}

/* ---------- 数据渲染 ---------- */

/** 数据快照里的全部指标，按板块归组由 item.group 决定 */
function collectItems(payload) {
  return [
    ...(payload.indices || []),
    ...(payload.usbond || []),
    ...(payload.usmacro || []),
    ...(payload.pce || []),
    ...(payload.industries || []),
  ].filter((item) => item && item.code && item.group);
}

function applyPayload(payload, { fromCache = false } = {}) {
  if (!payload || !Array.isArray(payload.indices)) throw new Error('数据格式不正确');
  state.data = payload;
  state.fromCache = fromCache;

  const items = collectItems(payload);

  clearSkeletons();
  renderItems(items);
  renderFundFlow();
  updateStatus({ fromCache });
  updateCounts();
  if (!fromCache) {
    saveCache(payload);
    pullOrders();
  }
}

async function fetchLatest() {
  const res = await fetch(`data/latest.json?_=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadData({ manual = false, auto = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  if (manual) {
    refreshBtn.disabled = true;
    refreshBtn.classList.add('spinning');
  }

  try {
    const payload = await fetchLatest();
    const unchanged =
      auto && state.data && state.data.generatedAt === payload.generatedAt;

    // 用户正在拖拽时不要重排卡片，等下一次刷新
    if (unchanged || (auto && isDragging)) {
      updateStatus();
      return;
    }
    applyPayload(payload);
    if (manual) showToast(`已加载最新数据 · ${fmtBeijing(payload.generatedAt)}`);
  } catch (err) {
    if (!state.data) {
      clearSkeletons();
      setStatus('error', '加载失败');
      showToast(`数据加载失败：${err.message || err}，请稍后刷新重试`);
    } else if (manual || !auto) {
      showToast(`刷新失败：${err.message || err}，当前展示上次数据`);
      setStatus('warn', '刷新失败 · 展示上次数据', '刷新失败');
    }
  } finally {
    state.loading = false;
    refreshBtn.disabled = false;
    refreshBtn.classList.remove('spinning');
  }
}

/* ---------- 启动 ---------- */

showSkeletons();

const cached = loadCache();
if (cached) applyPayload(cached, { fromCache: true });

loadData();

refreshBtn.addEventListener('click', () => loadData({ manual: true }));

// 页面重新可见或每隔 5 分钟检查一次最新快照；数据未变化时不做任何重绘
setInterval(() => loadData({ auto: true }), AUTO_REFRESH_MS);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.data) loadData({ auto: true });
});

for (const grid of Object.values(grids)) setupGridDnd(grid);
for (const grid of Object.values(pinnedGrids)) setupPinnedDnd(grid);

// 跨设备排序同步：启动拉一次，之后每 30 秒检查一次远端
pullOrders();
setInterval(pullOrders, SYNC_PULL_MS);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) pullOrders();
});

// 注册 Service Worker：满足 Chrome「安装为应用」的条件，并提供离线兜底
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
