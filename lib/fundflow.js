'use strict';

/**
 * 板块资金流向数据源：东方财富「数据中心 - 板块资金流向 - 行业板块」页
 *   https://data.eastmoney.com/bkzj/hy.html
 * 页面本身不内嵌数据，由 push2 行情接口驱动，此处直接调用同一接口、同一参数。
 * 板块范围参数取自页面 JS（/newstatic/js/bkzj/list.js）：
 *   hy 行业板块 -> fs=m:90+s:4（gn 概念 -> m:90+t:3，dy 地域 -> m:90+t:1）
 * 注意不能用 m:90+t:2（旧版行业分类），它会混入「电子」等汇总板块，与页面榜单对不上。
 *   fields=f62   今日主力净流入（元）；5 日 -> f164，10 日 -> f174（页面「5日/10日排行」同源字段）
 *   fid=f62&po=1 按主力净流入降序 = 净流入榜（页面默认排序）
 *   fid=f62&po=0 升序 = 净流出榜（最负在前）
 */

// 用 push2delay（东财官方延迟行情镜像，接口契约与 push2 完全一致）：
// 2026-08 起 push2.eastmoney.com 对非浏览器客户端直接掐断连接（Empty reply / other side closed），
// 板块资金流向为日级汇总数据，延迟无实际影响。
const API_BASE = 'https://push2delay.eastmoney.com/api/qt/clist/get';

/** 排行周期 -> 接口字段：today 今日 / 5d 五日 / 10d 十日 */
const RANGE_FIELDS = { today: 'f62', '5d': 'f164', '10d': 'f174' };

/** 页面地址：渲染层标题点击跳转，供用户手动核对数据 */
const PAGE_URL = 'https://data.eastmoney.com/bkzj/hy.html';

/** 单次请求超时 */
const FETCH_TIMEOUT_MS = 8000;

/** 净流入/净流出各取前 10 个板块 */
const TOP_N = 10;

/** 按主力净流入排序拉取一页板块（po=1 降序净流入榜，po=0 升序净流出榜；field 决定今日/5日/10日口径） */
async function fetchBoards(po, field) {
  const url =
    `${API_BASE}?pn=1&pz=${TOP_N}&po=${po}&np=1&fltt=2&invt=2` +
    `&fid=${field}&fs=m:90+s:4&fields=f12,f14,${field}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Referer: 'https://data.eastmoney.com/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('板块资金流向接口请求超时，请稍后重试');
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`板块资金流向接口响应异常: HTTP ${res.status}`);
  const json = await res.json();
  const diff = json && json.data && Array.isArray(json.data.diff) ? json.data.diff : [];
  return diff
    .filter((d) => typeof d[field] === 'number') // 非交易日字段为 "-"，直接剔除
    .map((d) => ({ code: d.f12, name: d.f14, amount: d[field] }));
}

/**
 * 拉取行业板块主力净流入/净流出 TOP10 及各自合计（合计为上榜 10 个板块之和）
 * @param {string} [range='today'] 排行周期：'today' 今日 / '5d' 五日 / '10d' 十日
 */
async function fetchFundFlow(range = 'today') {
  const field = RANGE_FIELDS[range] || RANGE_FIELDS.today;
  const [inflow, outflowRaw] = await Promise.all([fetchBoards(1, field), fetchBoards(0, field)]);
  // 强势上涨日净流出榜尾部可能出现正值，只保留真实净流出的板块
  const outflow = outflowRaw.filter((b) => b.amount < 0);
  const sum = (list) => list.reduce((acc, b) => acc + b.amount, 0);
  return {
    pageUrl: PAGE_URL,
    inflow,
    outflow,
    inflowTotal: sum(inflow),
    outflowTotal: sum(outflow),
  };
}

module.exports = { fetchFundFlow, PAGE_URL, RANGE_FIELDS };
