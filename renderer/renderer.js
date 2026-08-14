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
  fundflow: document.getElementById('page-fundflow'),
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
}

for (const btn of tabButtons) {
  btn.addEventListener('click', () => switchPage(btn.dataset.page));
}

// 启动时始终停留在默认的市场概览页，不恢复上次停留的页面
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
    // 顺序是关键用户设置：立刻落盘，避免异常退出时丢失本次拖拽结果
    window.econ.flushStorage?.();
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

/* ---------- 资金流向缓存：与行情一样先显后刷，按排行周期分别缓存 ---------- */

function ffCacheKey(range) {
  return `econradar-last-fundflow:${range}`;
}

/** 读取指定周期的上次成功数据；结构不合法时视为无缓存 */
function loadFundFlowCache(range) {
  try {
    const cached = JSON.parse(localStorage.getItem(ffCacheKey(range)) || 'null');
    if (
      cached &&
      cached.data &&
      Array.isArray(cached.data.inflow) &&
      Array.isArray(cached.data.outflow) &&
      typeof cached.fetchedAt === 'string'
    ) {
      return cached;
    }
  } catch (_) { /* 缓存损坏时按无缓存处理 */ }
  return null;
}

function saveFundFlowCache(range, data, fetchedAt) {
  try {
    localStorage.setItem(ffCacheKey(range), JSON.stringify({ fetchedAt, data }));
  } catch (_) { /* 存储失败不影响主流程 */ }
}

/* ---------- 资金流向页：行业板块主力净流入/净流出柱状图 ---------- */

/** 排行周期 -> 合计文案前缀（今日/5日/10日） */
const FF_RANGE_LABELS = { today: '今日', '5d': '5日', '10d': '10日' };

/** 当前选中的排行周期，默认今日 */
let ffRange = 'today';

/** 元 -> 带正负号的亿元文本：+267.0亿 / -66.9亿 */
function fmtYi(v) {
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  return `${sign}${(Math.abs(v) / 1e8).toFixed(1)}亿`;
}

/** 渲染一个资金流向榜单；dir='in' 红柱（净流入），dir='out' 绿柱（净流出），均从左向右生长 */
function renderFfChart(container, boards, dir) {
  container.innerHTML = '';
  if (!boards.length) {
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

function renderFundFlow(data, range) {
  const label = FF_RANGE_LABELS[range] || FF_RANGE_LABELS.today;
  renderFfChart(document.getElementById('ff-inflow'), data.inflow, 'in');
  renderFfChart(document.getElementById('ff-outflow'), data.outflow, 'out');
  document.getElementById('ff-inflow-total').textContent =
    `${label}主力净流入合计：${fmtYi(data.inflowTotal)}（TOP10 板块）`;
  document.getElementById('ff-outflow-total').textContent =
    `${label}主力净流出合计：${fmtYi(data.outflowTotal)}（TOP10 板块）`;
}

/** 切换排行周期：先置加载态，拉取对应口径数据后渲染；期间再次切换则丢弃过期结果 */
async function loadFundFlowRange(range) {
  for (const id of ['ff-inflow', 'ff-outflow']) {
    document.getElementById(id).innerHTML = '<div class="ff-empty">加载中…</div>';
  }
  const res = await window.econ.getFundFlow(range).catch(() => null);
  if (range !== ffRange) return; // 用户已切到其他周期，丢弃本次结果
  if (res && res.ok) {
    renderFundFlow(res.data, range);
    saveFundFlowCache(range, res.data, res.fetchedAt);
  } else {
    showFundFlowError();
  }
}

// 排行周期单选：切换后立即按新口径拉取渲染
document.querySelectorAll('input[name="ff-range"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    if (!radio.checked) return;
    ffRange = radio.value;
    loadFundFlowRange(ffRange);
  });
});

function showFundFlowError() {
  for (const id of ['ff-inflow', 'ff-outflow']) {
    const container = document.getElementById(id);
    container.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'ff-empty';
    empty.textContent = '数据获取失败，可点击右上角“刷新”重试';
    container.appendChild(empty);
  }
}

// 页面标题 -> 默认浏览器打开东方财富板块资金流向页核对数据
document
  .getElementById('fundflow-title')
  .addEventListener('click', () =>
    window.econ.openExternal('https://data.eastmoney.com/bkzj/hy.html')
  );

let refreshing = false;

/**
 * 拉取全部数据并逐源渲染：哪个源先到就先更新哪组卡片。
 *
 * 按钮锁只跟随核心数据（indices）：行情到达（成功或失败）即恢复刷新按钮，
 * 不再等待最慢的源。PCE 走隐藏窗口 + 反爬重试，最坏可能耗时近百秒，
 * 若按钮锁等它，用户在 PCE 完成前完全无法再次刷新——表现为“按钮按不动”。
 * 慢源继续后台渲染，到达即更新对应卡片，不阻塞用户。主进程 makeSharedFetch
 * 的 inflight 复用保证并发请求不会重复抓取同一数据源。
 *
 * isManual=true（点击“刷新”或 Cmd/Ctrl+R）时绕过主进程预热结果缓存，强制重新抓取。
 */
function refresh(isManual = false) {
  if (refreshing) return;
  refreshing = true;
  refreshBtn.disabled = true;

  // 本轮已到达的数据逐源累积，任一源到达即落缓存，下次启动才能完整先显
  const freshData = [];
  let indicesFetchedAt = null; // 行情时间戳：缓存与顶部“更新于”共用
  const ffRangeAtFetch = ffRange; // 记录发起时的排行周期，渲染时若已切换则丢弃资金流向结果

  const persistCache = () => {
    if (indicesFetchedAt && freshData.length) saveCache(freshData, indicesFetchedAt);
  };

  // 宏观/PCE/行业共用：到达即渲染对应卡片并落缓存；整体失败时保持现状（缓存或骨架）
  const renderChunk = (res) => {
    if (!res || !res.ok) return;
    freshData.push(...res.data);
    renderItems(res.data);
    persistCache();
  };

  // 行情是主数据：成功时更新顶部时间并清错误条，失败时出错误条；
  // 无论成败，行情处理完即恢复刷新按钮——慢源不再阻塞用户再次刷新
  window.econ.getIndices(isManual)
    .then((res) => {
      if (!res || !res.ok) throw new Error((res && res.error) || '未知错误');
      indicesFetchedAt = res.fetchedAt;
      freshData.push(...res.data);
      renderItems(res.data);
      cacheShown = false;
      updateTimeEl.textContent = `更新于 ${fmtClock(res.fetchedAt)}`;
      errorBanner.classList.add('hidden');
      persistCache();
    })
    .catch((err) => {
      errorBanner.textContent = `数据获取失败：${err.message || err}（可点击“刷新”重试）`;
      errorBanner.classList.remove('hidden');
      // 已展示缓存时保留缓存时间戳，避免把“更新于”覆盖成无信息量的失败文案
      if (!cacheShown) updateTimeEl.textContent = '更新失败';
    })
    .finally(() => {
      refreshing = false;
      refreshBtn.disabled = false;
    });

  // 慢源：后台渲染，不阻塞刷新按钮；主进程 inflight 复用保证不重复抓取
  window.econ.getUsMacro(isManual).then(renderChunk).catch(() => {});
  window.econ.getUsPce(isManual).then(renderChunk).catch(() => {});
  window.econ.getIndustries(isManual).then(renderChunk).catch(() => {});
  window.econ.getFundFlow(ffRangeAtFetch, isManual)
    .then((res) => {
      if (ffRangeAtFetch !== ffRange) return;
      if (res && res.ok) {
        renderFundFlow(res.data, ffRangeAtFetch);
        saveFundFlowCache(ffRangeAtFetch, res.data, res.fetchedAt);
      } else {
        showFundFlowError();
      }
    })
    .catch(() => {
      if (ffRangeAtFetch === ffRange) showFundFlowError();
    });
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
  // 资金流向同样先展示上次缓存（启动时固定为今日口径），新数据到达后自动替换
  const ffCached = loadFundFlowCache(ffRange);
  if (ffCached) renderFundFlow(ffCached.data, ffRange);

  // 3) 后台拉取最新数据，各源到达即更新对应卡片
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
// 手动刷新传 isManual=true：绕过主进程预热结果缓存，始终拉最新数据
refreshBtn.addEventListener('click', () => refresh(true));
// Cmd/Ctrl+R 快捷刷新（主进程 before-input-event 拦截后转发，避免触发页面 reload）
window.econ.onRefresh(() => refresh(true));
bootstrap();
