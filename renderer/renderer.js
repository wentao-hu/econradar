'use strict';

/* EconRadar 渲染进程：指数/大宗商品看板 */
/* 约定：上涨绿色、下跌红色，数字前始终带 + / - 号 */
/* 刷新策略：启动时自动拉取一次，之后仅在用户点击“刷新”时更新 */
/* 卡片顺序：同一栏目内可拖拽排序（左右/上下），顺序持久化到 localStorage；禁止跨栏目拖动 */

const grids = {
  cn: document.getElementById('grid-cn'),
  global: document.getElementById('grid-global'),
  usmacro: document.getElementById('grid-usmacro'),
  commodity: document.getElementById('grid-commodity'),
  cnIndustry: document.getElementById('grid-cn-industry'),
  usIndustry: document.getElementById('grid-us-industry'),
};

/* ---------- 顶部 Tab：市场概览 / 行业概览 ---------- */

const tabButtons = Array.from(document.querySelectorAll('.side-tab'));
const pages = {
  market: document.getElementById('page-market'),
  industry: document.getElementById('page-industry'),
};

function switchPage(page) {
  for (const btn of tabButtons) {
    const active = btn.dataset.page === page;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  }
  for (const [key, el] of Object.entries(pages)) {
    el.classList.toggle('page-hidden', key !== page);
  }
  // 刚切到可见的页面此前无法测量标题宽度，需要补一次字号适配
  refitAllTitles();
  refitAllPills();
  try {
    localStorage.setItem('econradar-active-page', page);
  } catch (_) { /* 忽略持久化失败 */ }
}

for (const btn of tabButtons) {
  btn.addEventListener('click', () => switchPage(btn.dataset.page));
}

// 恢复上次停留的页面（默认市场概览）
try {
  const savedPage = localStorage.getItem('econradar-active-page');
  if (savedPage && pages[savedPage]) switchPage(savedPage);
} catch (_) { /* 默认停留在市场概览 */ }
const updateTimeEl = document.getElementById('update-time');
const refreshBtn = document.getElementById('refresh-btn');
const errorBanner = document.getElementById('error-banner');

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

/** 标题统一使用基础字号；仅当实测渲染宽度超过卡片可用宽度时才逐级缩小 */
function applyTitle(titleEl, name) {
  titleEl.querySelector('.name').textContent = name;
  fitTitle(titleEl);
}

/** 实测标题是否溢出卡片宽度：不溢出保持统一字号，溢出才 19px -> 16px -> 14px 逐级降级 */
function fitTitle(titleEl) {
  titleEl.classList.remove('title-md', 'title-sm');
  // 未上屏或所在页面隐藏时无法测量，保持基础字号，待可见后由 refitAllTitles 适配
  if (!titleEl.isConnected || titleEl.clientWidth === 0) return;
  if (titleEl.scrollWidth <= titleEl.clientWidth + 1) return;
  titleEl.classList.add('title-md');
  if (titleEl.scrollWidth <= titleEl.clientWidth + 1) return;
  titleEl.classList.replace('title-md', 'title-sm');
}

function refitAllTitles() {
  document.querySelectorAll('.card-title').forEach(fitTitle);
}

/** 实测卡行内容（涨跌幅 pill + 配角）是否溢出卡行宽度：不换行，pill 18px -> 16px -> 14px -> 12px 逐级缩小 */
function fitPill(rowEl) {
  const pill = rowEl.querySelector('.pill');
  pill.classList.remove('pill-md', 'pill-sm', 'pill-xs');
  // 未上屏或所在页面隐藏时无法测量，保持基础字号，待可见后由 refitAllPills 适配
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

/* 窗口尺寸变化会改变卡片宽度，需要重新测量标题是否溢出（rAF 节流避免连发 reflow） */
let refitRaf = 0;
window.addEventListener('resize', () => {
  if (refitRaf) return;
  refitRaf = requestAnimationFrame(() => {
    refitRaf = 0;
    refitAllTitles();
    refitAllPills();
  });
});

/* ---------- 栏内拖拽排序 ---------- */

let dragCtx = null; // { card, grid }

function clearDropHints() {
  document
    .querySelectorAll('.card.drop-before, .card.drop-after')
    .forEach((c) => c.classList.remove('drop-before', 'drop-after'));
}

/** 根据指针在目标卡片中的位置决定插到其前面还是后面（兼容左右与上下移动） */
function insertBeforeTarget(e, rect) {
  const withinRow = e.clientY >= rect.top && e.clientY <= rect.bottom;
  if (withinRow) return e.clientX < rect.left + rect.width / 2;
  return e.clientY < rect.top + rect.height / 2;
}

function orderKey(grid) {
  return `econradar-card-order:${grid.id}`;
}

function saveOrder(grid) {
  try {
    const codes = Array.from(grid.querySelectorAll('.card')).map((c) => c.dataset.code);
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
    if (!dragCtx || dragCtx.grid !== grid) return; // 跨栏目拖动不允许落下
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
    saveOrder(grid);
  });
}

/* ---------- 卡片 ---------- */

function createCard(item) {
  const card = document.createElement('div');
  card.className = 'card loading';
  card.dataset.code = item.code;
  card.draggable = true;

  const title = document.createElement('div');
  title.className = 'card-title';
  title.title = `在浏览器中打开 ${item.name} 详情页`;
  title.innerHTML = '<span class="name"></span><span class="grip" title="按住拖动卡片">⠿</span>';
  applyTitle(title, item.name);
  title.querySelector('.grip').addEventListener('click', (e) => e.stopPropagation());
  title.addEventListener('click', () => window.econ.openExternal(item.url));

  // 第一行：涨跌幅（主角，大字）+ 涨跌点数（右侧配角，小字）
  const row = document.createElement('div');
  row.className = 'card-row';
  const pill = document.createElement('span');
  pill.className = 'pill flat';
  pill.textContent = '--';
  const amt = document.createElement('span');
  amt.className = 'change-amt flat';
  amt.textContent = '--';
  row.appendChild(pill);
  row.appendChild(amt);

  // 第二行：绝对数值（当前点位）
  const price = document.createElement('div');
  price.className = 'card-price';
  price.textContent = '--';

  const time = document.createElement('div');
  time.className = 'card-time';

  card.appendChild(title);
  card.appendChild(row);
  card.appendChild(price);
  card.appendChild(time);

  setupCardDnd(card);
  return card;
}

function updateCard(card, item) {
  card.classList.remove('loading');
  const titleEl = card.querySelector('.card-title');
  const priceEl = card.querySelector('.card-price');
  const pillEl = card.querySelector('.pill');
  const amtEl = card.querySelector('.change-amt');
  const timeEl = card.querySelector('.card-time');

  if (item.error) {
    priceEl.textContent = '--';
    pillEl.className = 'pill flat';
    pillEl.textContent = '暂无数据';
    amtEl.textContent = '';
    timeEl.textContent = '';
    fitPill(card.querySelector('.card-row'));
    return;
  }

  applyTitle(titleEl, item.name);

  // 美国宏观指标：主显示最新值（带单位），pill 为较上期变化，配角显示前值
  if (item.kind === 'macro') {
    const dir = directionOf(item.change);
    pillEl.className = `pill ${dir}`;
    pillEl.textContent = fmtSigned(item.change, item.unit, item.digits);
    amtEl.className = `change-amt ${dir}`;
    amtEl.textContent =
      item.prev != null ? `前值 ${item.prev.toFixed(item.digits)}${item.unit}` : '';
    priceEl.textContent = `${item.value.toFixed(item.digits)}${item.unit}`;
    timeEl.textContent = item.time || '';
    fitPill(card.querySelector('.card-row'));
    return;
  }

  const dir = directionOf(item.changePct);
  pillEl.className = `pill ${dir}`;
  pillEl.textContent = fmtSigned(item.changePct, '%');
  amtEl.className = `change-amt ${dir}`;
  // 配角涨跌点数：大数值 2 位小数，小数值（如原油/VIX）3 位小数
  amtEl.textContent =
    item.change != null ? fmtSigned(item.change, '', Math.abs(item.change) >= 10 ? 2 : 3) : '';
  priceEl.textContent = fmtPrice(item.price);
  timeEl.textContent = item.time || '';
  fitPill(card.querySelector('.card-row'));
}

const cardMap = new Map();

function ensureCards(items) {
  for (const item of items) {
    if (cardMap.has(item.code)) continue;
    const card = createCard(item);
    cardMap.set(item.code, card);
    (grids[item.group] || grids.global).appendChild(card);
  }
  for (const grid of Object.values(grids)) applySavedOrder(grid);
  // 新建卡片在上屏后补一次实测字号适配（创建时元素未上屏无法测量）
  refitAllTitles();
  refitAllPills();
}

/* ---------- 本地缓存：先显后刷（stale-while-revalidate） ---------- */

const CACHE_KEY = 'econradar-last-data';
let cacheShown = false; // 首屏是否已展示缓存数据（刷新失败时保留其时间戳）

function fmtClock(iso) {
  return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
}

/** 读取上次成功刷新的缓存；结构不合法时视为无缓存 */
function loadCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (
      cached &&
      Array.isArray(cached.data) &&
      cached.data.length > 0 &&
      typeof cached.fetchedAt === 'string' &&
      cached.data.every((it) => it && typeof it.code === 'string' && typeof it.group === 'string')
    ) {
      return cached;
    }
  } catch (_) { /* 缓存损坏时按无缓存处理 */ }
  return null;
}

function saveCache(data, fetchedAt) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ fetchedAt, data }));
  } catch (_) { /* 存储失败不影响主流程 */ }
}

/** 将一组数据填充到卡片（缓存与新鲜数据共用） */
function renderItems(items) {
  ensureCards(items);
  for (const item of items) {
    const card = cardMap.get(item.code);
    if (card) updateCard(card, item);
  }
}

let refreshing = false;

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  refreshBtn.disabled = true;
  try {
    // 行情、宏观与行业数据并行拉取；宏观/行业整体失败时降级为仅展示行情
    const [res, macroRes, industryRes] = await Promise.all([
      window.econ.getIndices(),
      window.econ.getUsMacro().catch(() => null),
      window.econ.getIndustries().catch(() => null),
    ]);
    if (!res.ok) throw new Error(res.error || '未知错误');
    let data = res.data;
    if (macroRes && macroRes.ok) data = [...data, ...macroRes.data];
    if (industryRes && industryRes.ok) data = [...data, ...industryRes.data];
    renderItems(data);
    saveCache(data, res.fetchedAt);
    cacheShown = false;
    updateTimeEl.textContent = `更新于 ${fmtClock(res.fetchedAt)}`;
    errorBanner.classList.add('hidden');
  } catch (err) {
    errorBanner.textContent = `数据获取失败：${err.message || err}（可点击“刷新”重试）`;
    errorBanner.classList.remove('hidden');
    // 已展示缓存时保留缓存时间戳，避免把“更新于”覆盖成无信息量的失败文案
    if (!cacheShown) updateTimeEl.textContent = '更新失败';
  } finally {
    refreshing = false;
    refreshBtn.disabled = false;
  }
}

/* ---------- 启动：骨架卡片 -> 缓存先显 -> 后台刷新 ---------- */

async function bootstrap() {
  // 1) 用静态元数据立即渲染全部骨架卡片（loading 态），首屏不再空白
  try {
    const meta = await window.econ.getIndexMeta();
    ensureCards(meta.map((m) => ({ ...m, name: m.fallbackName || m.name })));
  } catch (_) { /* 元数据不可用时静默降级为等数据到达再建卡 */ }

  // 2) 有缓存则立即展示上次数据（卡片自带行情时间，顶部标注缓存来源）
  const cached = loadCache();
  if (cached) {
    renderItems(cached.data);
    cacheShown = true;
    updateTimeEl.textContent = `缓存数据 · ${fmtClock(cached.fetchedAt)}`;
  }

  // 3) 后台拉取最新数据，到达后逐卡更新
  refresh();
}

/* ---------- 滚动条：滚动时显示，停止约 1.6s 后隐藏 ---------- */

const boardEl = document.querySelector('.board');
let scrollHideTimer = null;
boardEl.addEventListener(
  'scroll',
  () => {
    boardEl.classList.add('show-scrollbar');
    clearTimeout(scrollHideTimer);
    scrollHideTimer = setTimeout(() => boardEl.classList.remove('show-scrollbar'), 1600);
  },
  { passive: true }
);

for (const grid of Object.values(grids)) setupGridDnd(grid);
refreshBtn.addEventListener('click', refresh);
bootstrap();
