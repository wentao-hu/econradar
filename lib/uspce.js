'use strict';

/**
 * 美国 PCE / 核心PCE 数据源：BEA（美国经济分析局）官方主题页。
 *
 * 页面对应产品：Personal Consumption Expenditures Price Index 及其
 * Excluding Food and Energy（核心 PCE）版本，均属月度 Personal Income and
 * Outlays 发布内容；卡片点击跳转的核对页就是这两个页面本身。
 *
 * 为什么改直连：BEA 页面是 Drupal 服务端渲染，近四期「Change From Month One
 * Year Ago」直接内嵌在主文档 HTML 的 table.bea-special 中，不需要 JS 渲染，
 * 也没有 Cloudflare 一类反爬拦截（实测 Node fetch 直连 HTTP 200）。
 * 原先走 cn.investing.com 需要隐藏 BrowserWindow + 反爬重试，最坏耗时近百秒；
 * 改直连后单次请求约 1.5s，且解析的是发布机构官方数据。
 *
 * 口径：卡片展示最新已发布月份的同比涨幅（%），前值/变化均取同口径相邻月份。
 */

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 单次请求超时（页面约 42KB，正常 1~2s 返回） */
const FETCH_TIMEOUT_MS = 15000;
/** PCE 每月只公布一次，30 分钟内复用结果，避免手动刷新反复抓取 */
const CACHE_TTL_MS = 30 * 60 * 1000;

/** 这两个 URL 既用于抓取解析，也是卡片标题点击跳转的官方核对页 */
const BEA_PCE_URL =
  'https://www.bea.gov/data/personal-consumption-expenditures-price-index';
const BEA_CORE_PCE_URL =
  'https://www.bea.gov/data/personal-consumption-expenditures-price-index-excluding-food-and-energy';

const PCE_META = [
  {
    code: 'usmacro_pce',
    group: 'usmacro',
    kind: 'macro',
    name: '美国PCE',
    unit: '%',
    digits: 1,
    url: BEA_PCE_URL,
    fetchUrl: BEA_PCE_URL,
  },
  {
    code: 'usmacro_core_pce',
    group: 'usmacro',
    kind: 'macro',
    name: '美国核心PCE',
    unit: '%',
    digits: 1,
    url: BEA_CORE_PCE_URL,
    fetchUrl: BEA_CORE_PCE_URL,
  },
];

const EN_MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function toFixedNumber(v, digits) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(digits));
}

/**
 * 解析页面内嵌的数据表，返回按时间倒序的 [{month, year, value}]。
 *
 * 页面结构（两页一致，服务端渲染）：
 *   <table class="bea-special table-invisible">
 *     <thead><tr><th colspan="2">Change From Month One Year Ago</th></tr></thead>
 *     <tbody>
 *       <tr class="item-fact-row"><td>August 2026</td><td>+3.4%</td></tr>
 *       ...
 * 年份写成四位数的行才是真实数据；发布前 BEA 会把月份占位成「Month 2026」，
 * 且把整段替换文案放在 HTML 注释里，因此这两种情况都会被这里过滤掉。
 */
function parseBeaTable(html) {
  const table = html.match(/<table[^>]*class="[^"]*bea-special[^"]*"[^>]*>([\s\S]*?)<\/table>/i);
  if (!table) return [];
  const out = [];
  const rowRe = /<td>\s*([A-Za-z]+)\s+(\d{4})\s*<\/td>\s*<td>\s*([+-]?\d+(?:\.\d+)?)\s*%\s*<\/td>/gi;
  let m;
  while ((m = rowRe.exec(table[1])) !== null) {
    const month = EN_MONTHS[m[1].toLowerCase()];
    const value = toFixedNumber(m[3], 1);
    if (!month || value == null) continue;
    out.push({ month, year: Number(m[2]), value });
  }
  return out;
}

async function fetchOne(meta) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let html;
  try {
    const res = await fetch(meta.fetchUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': CHROME_UA,
        // 固定英文页面，月份名才能按 EN_MONTHS 解析
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('PCE 页面请求超时');
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const rows = parseBeaTable(html);
  // 发布前页面会进入「Page being updated」占位状态，表格结构可能仍在但无真实数据
  if (!rows.length) return { ...meta, error: 'no-data' };

  const latest = rows[0];
  const prev = rows[1] ? rows[1].value : null;
  const value = toFixedNumber(latest.value, meta.digits);
  if (value == null) return { ...meta, error: 'parse-failed' };
  return {
    ...meta,
    value,
    prev,
    change: prev == null ? null : toFixedNumber(value - prev, meta.digits),
    time: `${latest.year}年${String(latest.month).padStart(2, '0')}月`,
  };
}

let cache = null; // { at, results }

/** 抓取美国 PCE / 核心PCE（两个页面并行）；全部成功才写缓存，部分失败时下次刷新重试 */
async function fetchUsPce() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.results;
  const results = await Promise.all(
    PCE_META.map((meta) =>
      fetchOne(meta).catch(() => ({ ...meta, error: 'fetch-failed' }))
    )
  );
  if (results.every((r) => !r.error)) cache = { at: Date.now(), results };
  return results;
}

module.exports = { fetchUsPce, PCE_META };
