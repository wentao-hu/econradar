'use strict';

/**
 * 行业指数数据源：新浪财经行情接口（hq.sinajs.cn）
 * 中国行业：国证/中证行业指数（sz399xxx、sz980xxx），A股行情格式；
 * 美国行业：费城半导体等行业指数（gb_ 前缀）+ 标普行业精选 ETF（gb_ 前缀），美股行情格式。
 * 展示名统一使用元数据中的短名（接口返回名过长或为空）。
 */

const { parseRecord } = require('./indices');

const SINA_HQ_URL = 'https://hq.sinajs.cn/list=';

/** 单次行情请求超时 */
const FETCH_TIMEOUT_MS = 8000;

/** 行业指数元数据：分组、展示名、跳转详情页 */
const INDUSTRY_META = [
  // ---- 中国行业 ----
  {
    code: 'sz980017',
    group: 'cnIndustry',
    name: '国证芯片',
    url: 'https://finance.sina.com.cn/realstock/company/sz980017/nc.shtml',
  },
  {
    code: 'sz399394',
    group: 'cnIndustry',
    name: '国证医药',
    url: 'https://finance.sina.com.cn/realstock/company/sz399394/nc.shtml',
  },
  {
    code: 'sz399997',
    group: 'cnIndustry',
    name: '中证白酒',
    url: 'https://finance.sina.com.cn/realstock/company/sz399997/nc.shtml',
  },
  {
    code: 'sz399976',
    group: 'cnIndustry',
    name: 'CS新能车',
    url: 'https://finance.sina.com.cn/realstock/company/sz399976/nc.shtml',
  },
  {
    code: 'sz399975',
    group: 'cnIndustry',
    name: '证券公司',
    url: 'https://finance.sina.com.cn/realstock/company/sz399975/nc.shtml',
  },
  {
    code: 'sz399986',
    group: 'cnIndustry',
    name: '中证银行',
    url: 'https://finance.sina.com.cn/realstock/company/sz399986/nc.shtml',
  },
  {
    code: 'sz399393',
    group: 'cnIndustry',
    name: '国证地产',
    url: 'https://finance.sina.com.cn/realstock/company/sz399393/nc.shtml',
  },
  {
    code: 'sz399395',
    group: 'cnIndustry',
    name: '国证有色',
    url: 'https://finance.sina.com.cn/realstock/company/sz399395/nc.shtml',
  },
  {
    code: 'sz399998',
    group: 'cnIndustry',
    name: '中证煤炭',
    url: 'https://finance.sina.com.cn/realstock/company/sz399998/nc.shtml',
  },
  {
    code: 'sz399971',
    group: 'cnIndustry',
    name: '中证传媒',
    url: 'https://finance.sina.com.cn/realstock/company/sz399971/nc.shtml',
  },
  // ---- 美国行业 ----
  {
    code: 'gb_sox',
    group: 'usIndustry',
    name: '费城半导体',
    url: 'https://stock.finance.sina.com.cn/usstock/quotes/.SOX.html',
  },
  {
    code: 'gb_nbi',
    group: 'usIndustry',
    name: '纳指生物科技',
    url: 'https://stock.finance.sina.com.cn/usstock/quotes/.NBI.html',
  },
  {
    code: 'gb_xlk',
    group: 'usIndustry',
    name: '信息科技',
    url: 'https://stock.finance.sina.com.cn/usstock/quotes/XLK.html',
  },
  {
    code: 'gb_xlf',
    group: 'usIndustry',
    name: '金融',
    url: 'https://stock.finance.sina.com.cn/usstock/quotes/XLF.html',
  },
  {
    code: 'gb_xle',
    group: 'usIndustry',
    name: '能源',
    url: 'https://stock.finance.sina.com.cn/usstock/quotes/XLE.html',
  },
  {
    code: 'gb_xlv',
    group: 'usIndustry',
    name: '医疗保健',
    url: 'https://stock.finance.sina.com.cn/usstock/quotes/XLV.html',
  },
  {
    code: 'gb_xly',
    group: 'usIndustry',
    name: '可选消费',
    url: 'https://stock.finance.sina.com.cn/usstock/quotes/XLY.html',
  },
  {
    code: 'gb_xlp',
    group: 'usIndustry',
    name: '必需消费',
    url: 'https://stock.finance.sina.com.cn/usstock/quotes/XLP.html',
  },
  {
    code: 'gb_xli',
    group: 'usIndustry',
    name: '工业',
    url: 'https://stock.finance.sina.com.cn/usstock/quotes/XLI.html',
  },
  {
    code: 'gb_xlc',
    group: 'usIndustry',
    name: '通信服务',
    url: 'https://stock.finance.sina.com.cn/usstock/quotes/XLC.html',
  },
];

/** 解析新浪接口完整返回文本；展示名统一用元数据短名 */
function parseIndustries(text) {
  const results = [];
  const re = /hq_str_(\w+)="([^"]*)"/g;
  const map = new Map();
  let m;
  while ((m = re.exec(text)) !== null) {
    map.set(m[1], m[2]);
  }
  for (const meta of INDUSTRY_META) {
    const raw = map.get(meta.code);
    if (!raw) {
      results.push({ ...meta, error: 'no-data' });
      continue;
    }
    const fields = raw.split(',');
    const parsed = parseRecord(meta.code, fields);
    if (!parsed) {
      results.push({ ...meta, error: 'parse-failed' });
      continue;
    }
    results.push({ ...meta, ...parsed });
  }
  return results;
}

/** 拉取全部行业指数数据 */
async function fetchIndustries() {
  const codes = INDUSTRY_META.map((i) => i.code).join(',');
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
    if (err && err.name === 'AbortError') throw new Error('行业行情接口请求超时，请稍后重试');
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`行业行情接口响应异常: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const text = new TextDecoder('gbk').decode(buf);
  return parseIndustries(text);
}

module.exports = { fetchIndustries, parseIndustries, INDUSTRY_META };
