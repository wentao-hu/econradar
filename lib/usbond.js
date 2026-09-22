'use strict';

/**
 * 美债收益率数据源：东方财富行情接口（push2delay.eastmoney.com）
 * 对应 quote.eastmoney.com/stock/171.US2Y|US10Y|US30Y.html 三个期限页面。
 *
 * 为什么用东财而不是新浪 globalbd：
 * 新浪该接口的「昨收」是填充值（实测开盘/昨收/最高三字段恒为同一值），
 * 与真实前一交易日收盘不符，涨跌幅系统性偏大 0.3~0.4 个百分点
 * （2026-09-21 实测：10 年期新浪 -0.97% / 东财 -0.65%，东财昨收 4.9940
 * 与日K 前一交易日 2026-09-18 收盘完全吻合）。东财页也正是卡片点击跳转的
 * 核对页，卡片数字可与页面逐项对上。
 *
 * 为什么用 push2delay：2026-08 起 push2.eastmoney.com 对非浏览器客户端直接掐断
 * 连接（Empty reply / other side closed），push2delay 是东财官方延迟行情镜像，
 * 接口契约与 push2 完全一致。批量接口 ulist.np 对美债三期限恒返回 0 值，
 * 故逐只请求 stock/get（三个并发）。
 */

const API_BASE = 'https://push2delay.eastmoney.com/api/qt/stock/get';

/** 单次请求超时 */
const FETCH_TIMEOUT_MS = 8000;

/**
 * 三个期限的元数据。
 * code 沿用新浪时期的 globalbd_* 命名：卡片排序与首屏缓存都以 code 为键，
 * 改名会让旧缓存条目对不上新卡片（renderer 的 ensureCards 对未知 code 一律新建，
 * 会造成同指标出现两张卡片），故保持稳定。
 */
const USBOND_META = [
  {
    code: 'globalbd_us2yt',
    group: 'usmacro',
    name: '美债2年收益率',
    // 收益率本质是百分数，东财页面只是省略了符号；展示层按 unit 后处理补上
    unit: '%',
    secid: '171.US2Y',
    url: 'https://quote.eastmoney.com/stock/171.US2Y.html',
  },
  {
    code: 'globalbd_us10yt',
    group: 'usmacro',
    name: '美债10年收益率',
    unit: '%',
    secid: '171.US10Y',
    url: 'https://quote.eastmoney.com/stock/171.US10Y.html',
  },
  {
    code: 'globalbd_us30yt',
    group: 'usmacro',
    name: '美债30年收益率',
    unit: '%',
    secid: '171.US30Y',
    url: 'https://quote.eastmoney.com/stock/171.US30Y.html',
  },
];

function toFixedNumber(v, digits) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(digits));
}

/** unix 秒时间戳 -> "YYYY-MM-DD HH:MM:SS"（本地时区；界面标注「时间均为北京时间」） */
function fmtTimestamp(sec) {
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 解析单只行情。接口价格为整数，按 f59 给出的小数位数还原
 * （美债 f59=4，即 49613 -> 4.9613）；涨跌额与涨跌幅直接取接口字段，
 * 与东财页面显示口径完全一致；prev 取昨收（f60），与日K 前一交易日收盘吻合。
 */
function parseQuote(d, meta) {
  if (!d) return null;
  const digits = Number(d.f59);
  const scale = 10 ** (Number.isFinite(digits) ? digits : 4);
  const price = toFixedNumber(Number(d.f43) / scale, 3);
  if (price == null) return null;
  const prev = toFixedNumber(Number(d.f60) / scale, 3);
  const ts = Number(d.f86);
  return {
    ...meta,
    price,
    prev,
    change: toFixedNumber(Number(d.f169) / scale, 3),
    changePct: toFixedNumber(Number(d.f170) / 100, 2),
    time: Number.isFinite(ts) ? fmtTimestamp(ts) : '',
  };
}

/** 拉取单个期限 */
async function fetchOne(meta) {
  const url = `${API_BASE}?secid=${meta.secid}&fields=f43,f59,f60,f169,f170,f86`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Referer: 'https://quote.eastmoney.com/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('美债数据接口请求超时');
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`美债数据接口响应异常: HTTP ${res.status}`);
  const json = await res.json();
  return parseQuote(json && json.data, meta) || { ...meta, error: 'parse-failed' };
}

/** 拉取三个期限的美债收益率（并发请求；单个失败不拖垮整体） */
async function fetchUsBond() {
  return Promise.all(
    USBOND_META.map((meta) =>
      fetchOne(meta).catch(() => ({ ...meta, error: 'fetch-failed' }))
    )
  );
}

module.exports = { fetchUsBond, USBOND_META, parseQuote };
