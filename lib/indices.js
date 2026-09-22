'use strict';

/**
 * 指数数据源：新浪财经行情接口（hq.sinajs.cn）
 * 该接口必须携带 Referer: https://finance.sina.com.cn，且返回 GBK 编码文本。
 */

const SINA_HQ_URL = 'https://hq.sinajs.cn/list=';

/** 单次行情请求超时：防止弱网/接口挂起时请求永久悬挂，导致界面一直处于加载态 */
const FETCH_TIMEOUT_MS = 8000;

/** 指数元数据：分组、展示名、跳转详情页 */
const INDEX_META = [
  // ---- 国内指数 ----
  {
    code: 'sh000001',
    group: 'cn',
    fallbackName: '上证指数',
    url: 'https://finance.sina.com.cn/realstock/company/sh000001/nc.shtml',
  },
  {
    code: 'sh000300',
    group: 'cn',
    fallbackName: '沪深300',
    url: 'https://finance.sina.com.cn/realstock/company/sh000300/nc.shtml',
  },
  {
    code: 'sz399006',
    group: 'cn',
    fallbackName: '创业板指',
    url: 'https://finance.sina.com.cn/realstock/company/sz399006/nc.shtml',
  },
  {
    code: 'sh000688',
    group: 'cn',
    fallbackName: '科创50',
    url: 'https://finance.sina.com.cn/realstock/company/sh000688/nc.shtml',
  },
  {
    // 中国10年期国债收益率（中债收益率曲线），与美债同走新浪 globalbd 接口
    code: 'globalbd_cn10yt',
    group: 'cn',
    fallbackName: '10年期国债收益率',
    url: 'https://stock.finance.sina.com.cn/forex/globalbd/cn10yt.html',
  },
  // ---- 全球指数 ----
  {
    code: 'gb_inx',
    group: 'global',
    fallbackName: '标普500',
    url: 'https://stock.finance.sina.com.cn/usstock/quotes/.inx.html',
  },
  {
    code: 'gb_ixic',
    group: 'global',
    fallbackName: '纳斯达克',
    url: 'https://stock.finance.sina.com.cn/usstock/quotes/.IXIC.html',
  },
  {
    code: 'gb_dji',
    group: 'global',
    fallbackName: '道琼斯',
    url: 'https://stock.finance.sina.com.cn/usstock/quotes/.DJI.html',
  },
  {
    code: 'int_nikkei',
    group: 'global',
    fallbackName: '日经225',
    url: 'https://finance.sina.com.cn/stock/globalindex/quotes/NKY',
  },
  {
    code: 'rt_hkHSI',
    group: 'global',
    fallbackName: '恒生指数',
    url: 'https://stock.finance.sina.com.cn/hkstock/quotes/HSI.html',
  },
  // ---- 美国宏观经济（实时行情类：美元指数 / 汇率；美债收益率见 lib/usbond.js） ----
  {
    code: 'DINIW',
    group: 'usmacro',
    fallbackName: '美元指数',
    url: 'https://finance.sina.com.cn/money/forex/hq/DINIW.shtml',
  },
  {
    code: 'USDCNY',
    group: 'usmacro',
    fallbackName: '美元兑人民币',
    url: 'https://finance.sina.com.cn/money/forex/hq/USDCNY.shtml',
  },
  // ---- 大宗商品 ----
  {
    code: 'hf_OIL',
    group: 'commodity',
    fallbackName: '布伦特原油',
    url: 'https://finance.sina.com.cn/futures/quotes/OIL.shtml',
  },
  {
    code: 'hf_XAU',
    group: 'commodity',
    fallbackName: '伦敦金',
    url: 'https://finance.sina.com.cn/futures/quotes/XAU.shtml',
  },
  {
    code: 'hf_XAG',
    group: 'commodity',
    fallbackName: '伦敦银',
    url: 'https://finance.sina.com.cn/futures/quotes/XAG.shtml',
  },
  {
    code: 'hf_VX',
    group: 'commodity',
    fallbackName: 'VIX恐慌指数',
    url: 'https://finance.sina.com.cn/futures/quotes/VX.shtml',
  },
];

function toFixedNumber(v, digits) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(digits));
}

/** unix 秒时间戳 -> "YYYY-MM-DD HH:MM:SS"（本地时区），与其他卡片的行情时间格式一致 */
function fmtTimestamp(sec) {
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 解析单条 hq_str 记录，返回 { price, change, changePct, time } */
function parseRecord(code, fields) {
  if (code.startsWith('sh') || code.startsWith('sz')) {
    // A股指数: 0名称 1今开 2昨收 3最新 ... 30日期 31时间
    const price = toFixedNumber(fields[3], 2);
    const prevClose = Number(fields[2]);
    if (price == null || !Number.isFinite(prevClose) || prevClose === 0) return null;
    const change = price - prevClose;
    const changePct = (change / prevClose) * 100;
    const time = `${fields[30] || ''} ${fields[31] || ''}`.trim();
    return { price, change: toFixedNumber(change, 2), changePct: toFixedNumber(changePct, 2), time };
  }
  if (code.startsWith('gb_')) {
    // 美股指数: 0名称 1最新 2涨跌幅(%) 3时间 4涨跌额
    const price = toFixedNumber(fields[1], 2);
    const changePct = toFixedNumber(fields[2], 2);
    const change = toFixedNumber(fields[4], 2);
    if (price == null || changePct == null) return null;
    return { price, change, changePct, time: (fields[3] || '').trim() };
  }
  if (code === 'int_nikkei') {
    // 日经: 0名称 1最新 2涨跌额 3涨跌幅(%)
    const price = toFixedNumber(fields[1], 2);
    const change = toFixedNumber(fields[2], 2);
    const changePct = toFixedNumber(fields[3], 2);
    if (price == null || changePct == null) return null;
    return { price, change, changePct, time: '' };
  }
  if (code === 'globalbd_cn10yt') {
    // 中国10年期国债收益率: 0名称 1开盘 2昨收 3最新 4最高 5最低 ... 11unix秒时间戳 12日期 13时间
    // 12/13 字段是美东时间（已实测与时间戳核对），界面标注「时间均为北京时间」，
    // 显示美东时间会误导，故用时间戳转本地时间
    const price = toFixedNumber(fields[3], 3);
    const prevClose = Number(fields[2]);
    if (price == null || !Number.isFinite(prevClose) || prevClose === 0) return null;
    const change = price - prevClose;
    const changePct = (change / prevClose) * 100;
    const ts = Number(fields[11]);
    const time = Number.isFinite(ts)
      ? fmtTimestamp(ts)
      : `${fields[12] || ''} ${fields[13] || ''}`.trim();
    return { price, change: toFixedNumber(change, 3), changePct: toFixedNumber(changePct, 2), time };
  }
  if (code === 'DINIW' || code === 'USDCNY') {
    // 外汇: 0时间 3昨收 5开盘 6最高 7最低 8最新 9名称 10日期
    const price = toFixedNumber(fields[8], 4);
    const prevClose = Number(fields[3]);
    if (price == null || !Number.isFinite(prevClose) || prevClose === 0) return null;
    const change = price - prevClose;
    const changePct = (change / prevClose) * 100;
    const time = `${fields[10] || ''} ${fields[0] || ''}`.trim();
    return {
      price,
      prev: toFixedNumber(prevClose, 4),
      change: toFixedNumber(change, 4),
      changePct: toFixedNumber(changePct, 2),
      time,
    };
  }
  if (code.startsWith('hf_')) {
    // 外盘期货/贵金属: 0最新价 6时间 7昨结 12日期 13名称
    const price = Number(fields[0]);
    const prevSettle = Number(fields[7]);
    if (!Number.isFinite(price) || !Number.isFinite(prevSettle) || prevSettle === 0) return null;
    const change = price - prevSettle;
    const changePct = (change / prevSettle) * 100;
    const time = `${fields[12] || ''} ${fields[6] || ''}`.trim();
    return {
      price: toFixedNumber(price, 3),
      change: toFixedNumber(change, 3),
      changePct: toFixedNumber(changePct, 2),
      time,
    };
  }
  if (code.startsWith('rt_hk')) {
    // 港股指数: 1名称 2最新 7涨跌额 8涨跌幅(%) 17日期 18时间
    const price = toFixedNumber(fields[2], 2);
    const change = toFixedNumber(fields[7], 2);
    const changePct = toFixedNumber(fields[8], 2);
    if (price == null || changePct == null) return null;
    const time = `${fields[17] || ''} ${fields[18] || ''}`.trim();
    return { price, change, changePct, time };
  }
  return null;
}

/** 解析新浪接口完整返回文本 */
function parseIndices(text) {
  const results = [];
  const re = /hq_str_(\w+)="([^"]*)"/g;
  const map = new Map();
  let m;
  while ((m = re.exec(text)) !== null) {
    map.set(m[1], m[2]);
  }
  for (const meta of INDEX_META) {
    const raw = map.get(meta.code);
    if (!raw) {
      results.push({ ...meta, name: meta.fallbackName, error: 'no-data' });
      continue;
    }
    const fields = raw.split(',');
    const parsed = parseRecord(meta.code, fields);
    if (!parsed) {
      results.push({ ...meta, name: fields[0] || meta.fallbackName, error: 'parse-failed' });
      continue;
    }
    // 大宗商品/国债/外汇接口返回的名称较长或字段位置不同，统一用短名
    const useFallback =
      meta.code.startsWith('hf_') ||
      meta.code.startsWith('globalbd_') ||
      meta.code === 'DINIW' ||
      meta.code === 'USDCNY';
    const name = useFallback
      ? meta.fallbackName
      : meta.code.startsWith('rt_hk')
        ? (fields[1] || meta.fallbackName)
        : (fields[0] || meta.fallbackName);
    results.push({ ...meta, name, ...parsed });
  }
  return results;
}

/** 拉取全部指数数据（Node 18+ 全局 fetch，Electron 主进程同样可用） */
async function fetchIndices() {
  const codes = INDEX_META.map((i) => i.code).join(',');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(SINA_HQ_URL + codes, {
      signal: controller.signal,
      headers: {
        Referer: 'https://finance.sina.com.cn',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('行情接口请求超时，请稍后重试');
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`行情接口响应异常: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const text = new TextDecoder('gbk').decode(buf);
  return parseIndices(text);
}

module.exports = { fetchIndices, parseIndices, parseRecord, INDEX_META };
