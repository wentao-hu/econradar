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

const tabButtons = Array.from(document.querySelectorAll('.tab, .bottom-tab'));
const updateTimeEl = document.getElementById('update-time');
const statusDot = document.getElementById('status-dot');
const refreshBtn = document.getElementById('refresh-btn');
const toastEl = document.getElementById('toast');
const marketCountEl = document.getElementById('market-count');
const industryCountEl = document.getElementById('industry-count');

const CACHE_KEY = 'econradar-web-latest-v1';
const ORDER_PREFIX = 'econradar-web-card-order:';
const AUTO_REFRESH_MS = 5 * 60 * 1000;
const STALE_AFTER_MS = 45 * 60 * 1000;

// 移动端（触摸设备）不启用拖拽排序，避免长按误触；桌面端保留原有能力
const canDrag = window.matchMedia('(pointer: fine)').matches;

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

const initialPage = location.hash.replace('#', '');
switchPage(initialPage || 'market', { updateHash: false });

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

/* ---------- 拖拽排序（仅桌面端） ---------- */

let dragCtx = null; // { card, grid }

function clearDropHints() {
  document
    .querySelectorAll('.card.drop-before, .card.drop-after')
    .forEach((c) => c.classList.remove('drop-before', 'drop-after'));
}

function insertBeforeTarget(e, rect) {
  const withinRow = e.clientY >= rect.top && e.clientY <= rect.bottom;
  if (withinRow) return e.clientX < rect.left + rect.width / 2;
  return e.clientY < rect.top + rect.height / 2;
}

function orderKey(grid) {
  return `${ORDER_PREFIX}${grid.id}`;
}

function saveOrder(grid) {
  try {
    const codes = Array.from(grid.querySelectorAll('.card:not(.skeleton)')).map(
      (c) => c.dataset.code
    );
    localStorage.setItem(orderKey(grid), JSON.stringify(codes));
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

function setupCardDnd(card) {
  card.draggable = true;
  card.addEventListener('dragstart', (e) => {
    dragCtx = { card, grid: card.parentElement };
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.dataset.code);
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    clearDropHints();
    dragCtx = null;
  });
}

function setupGridDnd(grid) {
  grid.addEventListener('dragover', (e) => {
    if (!dragCtx || dragCtx.grid !== grid) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearDropHints();
    const target = e.target.closest('.card');
    if (target && target !== dragCtx.card && target.parentElement === grid) {
      const before = insertBeforeTarget(e, target.getBoundingClientRect());
      target.classList.add(before ? 'drop-before' : 'drop-after');
    }
  });
  grid.addEventListener('drop', (e) => {
    if (!dragCtx || dragCtx.grid !== grid) return;
    e.preventDefault();
    const target = e.target.closest('.card');
    if (target && target !== dragCtx.card && target.parentElement === grid) {
      const before = insertBeforeTarget(e, target.getBoundingClientRect());
      grid.insertBefore(dragCtx.card, before ? target : target.nextSibling);
    } else {
      grid.appendChild(dragCtx.card);
    }
    clearDropHints();
    reorderUsMacroGrid();
    saveOrder(grid);
  });
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
  title.title = `在新窗口打开 ${item.name} 详情页`;
  title.innerHTML = '<span class="name"></span><span class="grip" title="按住拖动卡片">⠿</span>';
  applyTitle(title, item.name);
  title.querySelector('.grip').addEventListener('click', (e) => e.stopPropagation());
  card.dataset.url = item.url || '';
  title.addEventListener('click', () => {
    if (card.dataset.url) window.open(card.dataset.url, '_blank', 'noopener,noreferrer');
  });

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

  if (canDrag) setupCardDnd(card);
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
  if (item.url) card.dataset.url = item.url;

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
    if (!item || !item.code || cardMap.has(item.code)) continue;
    if (!grids[item.group]) continue;
    const card = createCard(item);
    cardMap.set(item.code, card);
    grids[item.group].appendChild(card);
  }
  for (const grid of Object.values(grids)) applySavedOrder(grid);
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

document.getElementById('fundflow-title').addEventListener('click', () => {
  window.open('https://data.eastmoney.com/bkzj/hy.html', '_blank', 'noopener,noreferrer');
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

function applyPayload(payload, { fromCache = false } = {}) {
  if (!payload || !Array.isArray(payload.indices)) throw new Error('数据格式不正确');
  state.data = payload;
  state.fromCache = fromCache;

  const items = [
    ...(payload.indices || []),
    ...(payload.usbond || []),
    ...(payload.usmacro || []),
    ...(payload.pce || []),
    ...(payload.industries || []),
  ].filter((item) => item && item.code && item.group);

  clearSkeletons();
  renderItems(items);
  renderFundFlow();
  updateStatus({ fromCache });
  updateCounts();
  if (!fromCache) saveCache(payload);
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
    if (unchanged || (auto && dragCtx)) {
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

if (canDrag) {
  for (const grid of Object.values(grids)) setupGridDnd(grid);
}

// 注册 Service Worker：满足 Chrome「安装为应用」的条件，并提供离线兜底
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
