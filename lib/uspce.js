'use strict';

/**
 * 美国 PCE 数据源：cn.investing.com 经济日历事件页。
 *
 * 为什么用隐藏 BrowserWindow 而不是 fetch：
 * investing.com 有 Cloudflare 防护，Node fetch / curl 直连一律 403（TLS 指纹），
 * 东财/金十等国内源均无 PCE 指标，FRED/TradingView 国内网络不可达。
 * Electron 内嵌 Chromium 指纹与 Chrome 一致，配合 Chrome UA 可以通过。
 * Cloudflare 按请求概率拦截（实测约 1/3 通过），故每次加载带重试；
 * 一旦通过，cf_clearance cookie 写入持久 partition，后续请求直接放行。
 *
 * 数据提取：页面为 Next.js SSR，历史数据内嵌在 __NEXT_DATA__ 的
 * economicCalendarEventStore.occurrences 中，因此拦截全部子资源（广告/脚本/图片），
 * 只下载主文档 HTML，单次加载约 1.5s。
 */

const { BrowserWindow } = require('electron');

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const MAX_TRIES = 6;
const RETRY_DELAY_MS = 1200;
const LOAD_TIMEOUT_MS = 15000;
/** PCE 每月只公布一次，30 分钟内复用结果，避免手动刷新反复抓取 */
const CACHE_TTL_MS = 30 * 60 * 1000;

const PCE_META = [
  {
    code: 'usmacro_pce',
    group: 'usmacro',
    kind: 'macro',
    name: '美国PCE',
    unit: '%',
    digits: 1,
    url: 'https://cn.investing.com/economic-calendar/pce-price-index-906',
  },
  {
    code: 'usmacro_core_pce',
    group: 'usmacro',
    kind: 'macro',
    name: '美国核心PCE',
    unit: '%',
    digits: 1,
    url: 'https://cn.investing.com/economic-calendar/core-pce-price-index-905',
  },
];

/** 在页面内提取最近几期数据（JSON 字符串，避免结构化克隆边界问题） */
const EXTRACT_JS = `(()=>{
  const el=document.getElementById("__NEXT_DATA__");
  if(!el) return null;
  const d=JSON.parse(el.textContent);
  const s=d.props&&d.props.pageProps&&d.props.pageProps.state
    &&d.props.pageProps.state.economicCalendarEventStore;
  if(!s||!Array.isArray(s.occurrences)) return null;
  return JSON.stringify(s.occurrences.slice(0,8).map(o=>({
    t:o.occurrence_time, p:o.reference_period, a:o.actual, prev:o.previous,
  })));
})()`;

const CN_MONTHS = {
  一月: 1, 二月: 2, 三月: 3, 四月: 4, 五月: 5, 六月: 6,
  七月: 7, 八月: 8, 九月: 9, 十月: 10, 十一月: 11, 十二月: 12,
};

/** 由发布时间 + 中文期次名（如"六月"）推导出"2026年06月"格式的报告期 */
function periodLabel(hit) {
  const m = CN_MONTHS[hit.p];
  const d = new Date(hit.t);
  if (!m || Number.isNaN(d.getTime())) return '';
  let y = d.getUTCFullYear();
  // 期次月份大于发布月份，说明期次属于上一年（如 1 月发布去年 12 月数据）
  if (m > d.getUTCMonth() + 1) y -= 1;
  return `${y}年${String(m).padStart(2, '0')}月`;
}

function toFixedNumber(v, digits) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(digits));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchOne(win, meta) {
  for (let i = 0; i < MAX_TRIES; i++) {
    try {
      await Promise.race([
        win.loadURL(meta.url),
        delay(LOAD_TIMEOUT_MS).then(() => {
          throw new Error('load-timeout');
        }),
      ]);
      const raw = await win.webContents.executeJavaScript(EXTRACT_JS);
      const occ = raw ? JSON.parse(raw) : null;
      // 最新一期往往尚未公布（actual 缺失），取第一条已公布的记录
      const hit = occ && occ.find((o) => o.a != null);
      if (hit) {
        const value = toFixedNumber(hit.a, meta.digits);
        const prev = toFixedNumber(hit.prev, meta.digits);
        if (value != null) {
          return {
            ...meta,
            value,
            prev,
            change: prev == null ? null : toFixedNumber(value - prev, meta.digits),
            time: periodLabel(hit),
          };
        }
      }
    } catch {
      // 被 Cloudflare 拦截或加载超时，等待后重试
    }
    await delay(RETRY_DELAY_MS);
  }
  return { ...meta, error: 'fetch-failed' };
}

let cache = null; // { at, results }

/** 抓取美国 PCE / 核心PCE；全部成功才写缓存，部分失败时下次刷新重试 */
async function fetchUsPce() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.results;
  let win = null;
  try {
    win = new BrowserWindow({
      show: false,
      width: 1100,
      height: 700,
      webPreferences: { sandbox: true, partition: 'persist:uspce', spellcheck: false },
    });
    win.webContents.setUserAgent(CHROME_UA);
    // __NEXT_DATA__ 内嵌在主文档中，拦截全部子资源
    win.webContents.session.webRequest.onBeforeRequest((details, cb) => {
      cb({ cancel: details.resourceType !== 'mainFrame' });
    });
    // 串行加载：第一页通过后 cf_clearance 生效，第二页不再被拦
    const results = [];
    for (const meta of PCE_META) results.push(await fetchOne(win, meta));
    if (results.every((r) => !r.error)) cache = { at: Date.now(), results };
    return results;
  } catch {
    return PCE_META.map((meta) => ({ ...meta, error: 'fetch-failed' }));
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
  }
}

module.exports = { fetchUsPce, PCE_META };
