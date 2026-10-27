'use strict';

/**
 * 行业指数数据源
 *
 * - 中证行业：东方财富批量行情接口（push2delay）。
 *   新浪、腾讯、东财普通 secid 均不支持 932xxx / H30xxx 新代码；
 *   东财把中证指数归在市场 2（secid=2.932077），ulist.np 批量接口一次可取全部。
 *   中证指数官网的 /perf/* 接口有 WAF 风控（实测批量请求后整段路径被封禁），不作为数据源。
 *
 * - 国证行业：指数清单以国证指数官网 channelCode=201（国证指数-行业指数）为准。
 *   399xxx / 980xxx / 1000 系列走新浪实时行情；CN50xx 系列新浪和东财都没有行情，
 *   走国证官网列表接口，该接口为上一交易日数据，卡片时间标注数据日期。
 *
 * - 美国行业：新浪财经美股行情（gb_ 前缀），逻辑不变。
 */

const { parseRecord } = require('./indices');

const SINA_HQ_URL = 'https://hq.sinajs.cn/list=';
const EM_BATCH_URL = 'https://push2delay.eastmoney.com/api/qt/ulist.np/get';
const CNINDEX_LIST_URL =
  'https://www.cnindex.com.cn/index/indexList?channelCode=201&rows=500&pageNum=1';
const CNINDEX_DAY_URL = 'https://www.cnindex.com.cn/index/queryDay';

/** 单次行情请求超时 */
const FETCH_TIMEOUT_MS = 10000;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  Accept: 'application/json, text/plain, */*',
};

function csindexUrl(code) {
  // 中证官网为 hash 路由；路径式地址（/zh-CN/indices/index-detail/xxx）会落到首页
  return `https://www.csindex.com.cn/#/indices/family/detail?indexCode=${code}`;
}

function cnindexUrl(code) {
  return `https://www.cnindex.com.cn/module/index-detail.html?act_menu=1&indexCode=${code}`;
}

function emIndexUrl(code) {
  // 新浪 realstock 页在移动端会强制唤起新浪财经 App（fallback 为空时 Chrome 报黑屏），
  // 统一改用东财行情页；东财对 399xxx / 980xxx 全部收录
  return `https://quote.eastmoney.com/zs${code.replace(/^(sh|sz)/, '')}.html`;
}

/**
 * 行业指数元数据：分组、展示名、跳转详情页
 * cnIndex = 中证行业，cnCni = 国证行业，usIndustry = 美国行业
 *
 * 中证只纳入东财批量接口能稳定提供行情的指数：中证全指一级行业 11 个、
 * 二级行业 8 个，以及代表性中证行业主题指数 6 个。
 * 其余中证二级行业代码（H30164 等）东财未收录，官网接口又被风控，暂不纳入。
 */
const INDUSTRY_META = [
  // ---- 中证行业：代表性行业主题指数（新浪实时，优先展示） ----
  { code: '399986', group: 'cnIndex', name: '中证银行', url: emIndexUrl('sz399986'), sinaCode: 'sz399986' },
  { code: '399997', group: 'cnIndex', name: '中证白酒', url: emIndexUrl('sz399997'), sinaCode: 'sz399997' },
  { code: '399975', group: 'cnIndex', name: '证券公司', url: emIndexUrl('sz399975'), sinaCode: 'sz399975' },
  { code: '399998', group: 'cnIndex', name: '中证煤炭', url: emIndexUrl('sz399998'), sinaCode: 'sz399998' },
  { code: '399976', group: 'cnIndex', name: 'CS新能车', url: emIndexUrl('sz399976'), sinaCode: 'sz399976' },
  { code: '399971', group: 'cnIndex', name: '中证传媒', url: emIndexUrl('sz399971'), sinaCode: 'sz399971' },
  { code: '399987', group: 'cnIndex', name: '中证酒', url: emIndexUrl('sz399987'), sinaCode: 'sz399987' },
  { code: '399989', group: 'cnIndex', name: '中证医疗', url: emIndexUrl('sz399989'), sinaCode: 'sz399989' },
  { code: '399967', group: 'cnIndex', name: '中证军工', url: emIndexUrl('sz399967'), sinaCode: 'sz399967' },

  // ---- 中证行业：一级行业（东财实时，新浪不支持 932xxx） ----
  { code: '932077', group: 'cnIndex', name: '能源', url: csindexUrl('932077') },
  { code: '932078', group: 'cnIndex', name: '原材料', url: csindexUrl('932078') },
  { code: '932079', group: 'cnIndex', name: '工业', url: csindexUrl('932079') },
  { code: '932080', group: 'cnIndex', name: '可选消费', url: csindexUrl('932080') },
  { code: '932081', group: 'cnIndex', name: '主要消费', url: csindexUrl('932081') },
  { code: '932082', group: 'cnIndex', name: '医药卫生', url: csindexUrl('932082') },
  { code: '932083', group: 'cnIndex', name: '金融', url: csindexUrl('932083') },
  { code: '932084', group: 'cnIndex', name: '信息技术', url: csindexUrl('932084') },
  { code: '932085', group: 'cnIndex', name: '通信服务', url: csindexUrl('932085') },
  { code: '932086', group: 'cnIndex', name: '公用事业', url: csindexUrl('932086') },
  { code: '931775', group: 'cnIndex', name: '房地产', url: csindexUrl('931775') },

  // ---- 中证行业：二级行业（东财收录的 8 个） ----
  { code: 'H30171', group: 'cnIndex', name: '运输指数', url: csindexUrl('H30171') },
  { code: 'H30182', group: 'cnIndex', name: '计算机', url: csindexUrl('H30182') },
  { code: 'H30184', group: 'cnIndex', name: '半导体', url: csindexUrl('H30184') },
  { code: 'H30192', group: 'cnIndex', name: '食品', url: csindexUrl('H30192') },
  { code: 'H30198', group: 'cnIndex', name: '油气产业', url: csindexUrl('H30198') },
  { code: 'H30199', group: 'cnIndex', name: '电力指数', url: csindexUrl('H30199') },
  { code: 'H30205', group: 'cnIndex', name: '饮料指数', url: csindexUrl('H30205') },
  { code: 'H30217', group: 'cnIndex', name: '医疗器械', url: csindexUrl('H30217') },

  // ---- 国证行业：一级行业（1000 系列，11 个，新浪实时，优先展示） ----
  { code: 'sz399381', group: 'cnCni', name: '1000能源', url: emIndexUrl('sz399381') },
  { code: 'sz399382', group: 'cnCni', name: '1000材料', url: emIndexUrl('sz399382') },
  { code: 'sz399383', group: 'cnCni', name: '1000工业', url: emIndexUrl('sz399383') },
  { code: 'sz399384', group: 'cnCni', name: '1000可选', url: emIndexUrl('sz399384') },
  { code: 'sz399385', group: 'cnCni', name: '1000消费', url: emIndexUrl('sz399385') },
  { code: 'sz399386', group: 'cnCni', name: '1000医药', url: emIndexUrl('sz399386') },
  { code: 'sz399387', group: 'cnCni', name: '1000金融', url: emIndexUrl('sz399387') },
  { code: 'sz399388', group: 'cnCni', name: '1000信息', url: emIndexUrl('sz399388') },
  { code: 'sz399389', group: 'cnCni', name: '国证通信', url: emIndexUrl('sz399389') },
  { code: 'sz399390', group: 'cnCni', name: '1000公用', url: emIndexUrl('sz399390') },
  { code: 'sz399367', group: 'cnCni', name: '1000地产', url: emIndexUrl('sz399367') },

  // ---- 国证行业：二级行业（新浪实时，8 个） ----
  { code: 'sz399393', group: 'cnCni', name: '国证地产', url: emIndexUrl('sz399393') },
  { code: 'sz399394', group: 'cnCni', name: '国证医药', url: emIndexUrl('sz399394') },
  { code: 'sz399395', group: 'cnCni', name: '国证有色', url: emIndexUrl('sz399395') },
  { code: 'sz399396', group: 'cnCni', name: '国证食品', url: emIndexUrl('sz399396') },
  { code: 'sz399431', group: 'cnCni', name: '国证银行', url: emIndexUrl('sz399431') },
  { code: 'sz399433', group: 'cnCni', name: '国证交运', url: emIndexUrl('sz399433') },
  { code: 'sz399435', group: 'cnCni', name: '国证农牧', url: emIndexUrl('sz399435') },
  { code: 'sz399440', group: 'cnCni', name: '国证钢铁', url: emIndexUrl('sz399440') },

  // ---- 国证行业：行业主题（新浪实时，6 个） ----
  { code: 'sz399432', group: 'cnCni', name: '智能汽车', url: emIndexUrl('sz399432') },
  { code: 'sz399434', group: 'cnCni', name: '数字传媒', url: emIndexUrl('sz399434') },
  { code: 'sz399436', group: 'cnCni', name: '绿色煤炭', url: emIndexUrl('sz399436') },
  { code: 'sz399438', group: 'cnCni', name: '绿色电力', url: emIndexUrl('sz399438') },
  { code: 'sz399439', group: 'cnCni', name: '国证油气', url: emIndexUrl('sz399439') },
  { code: 'sz980017', group: 'cnCni', name: '国证芯片', url: emIndexUrl('sz980017') },
  { code: 'sz399365', group: 'cnCni', name: '国证粮食', url: emIndexUrl('sz399365') },
  { code: 'sz399363', group: 'cnCni', name: '国证算力', url: emIndexUrl('sz399363') },
  { code: 'sz980027', group: 'cnCni', name: '国证储能电池', url: emIndexUrl('sz980027') },
  { code: 'sz399437', group: 'cnCni', name: '证券龙头', url: emIndexUrl('sz399437') },
  { code: 'sz399366', group: 'cnCni', name: '能源金属', url: emIndexUrl('sz399366') },

  // ---- 国证行业：CN 系列（新浪无行情，走国证官网，上一交易日） ----
  { code: 'CN5082', group: 'cnCni', name: '国证航天', url: cnindexUrl('CN5082'), cniOnly: true },
  { code: 'CN5084', group: 'cnCni', name: '电信服务', url: cnindexUrl('CN5084'), cniOnly: true },
  { code: 'CN5085', group: 'cnCni', name: '服装纺织', url: cnindexUrl('CN5085'), cniOnly: true },
  { code: 'CN5086', group: 'cnCni', name: '工业服务', url: cnindexUrl('CN5086'), cniOnly: true },
  { code: 'CN5090', group: 'cnCni', name: '国证化工', url: cnindexUrl('CN5090'), cniOnly: true },
  { code: 'CN5093', group: 'cnCni', name: '国证零售', url: cnindexUrl('CN5093'), cniOnly: true },
  { code: 'CN5094', group: 'cnCni', name: '耐用消费', url: cnindexUrl('CN5094'), cniOnly: true },
  { code: 'CN5097', group: 'cnCni', name: '消费服务', url: cnindexUrl('CN5097'), cniOnly: true },
  { code: 'CN5100', group: 'cnCni', name: '白色家电', url: cnindexUrl('CN5100'), cniOnly: true },
  { code: 'CN5101', group: 'cnCni', name: '国证百货', url: cnindexUrl('CN5101'), cniOnly: true },
  { code: 'CN5105', group: 'cnCni', name: '路桥港口', url: cnindexUrl('CN5105'), cniOnly: true },
  { code: 'CN5106', group: 'cnCni', name: '酒店餐饮', url: cnindexUrl('CN5106'), cniOnly: true },

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
    url: 'https://stock.finance.sina.com.cn/usstock/quotes/.XLK.html',
  },
  {
    code: 'gb_xlf',
    group: 'usIndustry',
    name: '金融',
    url: 'https://stock.finance.sina.com.cn/usstock/quotes/.XLF.html',
  },
  {
    code: 'gb_xle',
    group: 'usIndustry',
    name: '能源',
    url: 'https://stock.finance.sina.com.cn/usstock/quotes/.XLE.html',
  },
  {
    code: 'gb_xlv',
    group: 'usIndustry',
    name: '医疗保健',
    url: 'https://stock.finance.sina.com.cn/usstock/quotes/.XLV.html',
  },
  {
    code: 'gb_xly',
    group: 'usIndustry',
    name: '可选消费',
    url: 'https://stock.finance.sina.com.cn/usstock/quotes/.XLY.html',
  },
  {
    code: 'gb_xlp',
    group: 'usIndustry',
    name: '必需消费',
    url: 'https://stock.finance.sina.com.cn/usstock/quotes/.XLP.html',
  },
  {
    code: 'gb_xli',
    group: 'usIndustry',
    name: '工业',
    url: 'https://stock.finance.sina.com.cn/usstock/quotes/.XLI.html',
  },
  {
    code: 'gb_xlc',
    group: 'usIndustry',
    name: '通信服务',
    url: 'https://stock.finance.sina.com.cn/usstock/quotes/.XLC.html',
  },
];

const CNI_STOCK_META = INDUSTRY_META.filter((m) => m.group === 'cnCni' && !m.cniOnly);
const CNI_OFFICIAL_META = INDUSTRY_META.filter((m) => m.cniOnly);

/** 带超时的 fetch；返回 Response */
async function fetchWithTimeout(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal, headers });
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('行业行情接口请求超时，请稍后重试');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** unix 秒时间戳 -> "YYYY-MM-DD HH:MM:SS"（本地时区） */
function fmtTimestamp(sec) {
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 中证代码 -> 东财 secid：399xxx 属深市 0，其余中证指数（931xxx / 932xxx / H30xxx）属市场 2 */
function emSecid(code) {
  return `${code.startsWith('399') ? 0 : 2}.${code}`;
}

/** 解析新浪批量返回文本，按元数据顺序匹配 */
function parseSinaRecords(metas, text, keyOf = (m) => m.code) {
  const map = new Map();
  const re = /hq_str_(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(text)) !== null) map.set(m[1], m[2]);
  return metas.map((meta) => {
    const key = keyOf(meta);
    const raw = map.get(key);
    if (!raw) return { ...meta, error: 'no-data' };
    const parsed = parseRecord(key, raw.split(','));
    if (!parsed) return { ...meta, error: 'parse-failed' };
    return { ...meta, ...parsed };
  });
}

/** 新浪批量行情：按 sinaCode 请求与解析，返回项保留原始 code */
async function fetchSinaQuotes(metas) {
  if (!metas.length) return [];
  const codes = metas.map((m) => m.sinaCode).join(',');
  const res = await fetchWithTimeout(SINA_HQ_URL + codes, {
    Referer: 'https://finance.sina.com.cn',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  });
  if (!res.ok) throw new Error(`新浪行业行情接口响应异常: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  return parseSinaRecords(metas, new TextDecoder('gbk').decode(buf), (m) => m.sinaCode);
}

/**
 * 东财批量行情（中证一级/二级以及新浪无数据的代码）。
 * 返回字段 f2 最新价 / f3 涨跌幅 / f4 涨跌额 / f124 行情时间戳。
 */
async function fetchEastmoneyQuotes(metas) {
  const secids = metas.map((m) => emSecid(m.code)).join(',');
  const url =
    `${EM_BATCH_URL}?fltt=2&invt=2&fields=f2,f3,f4,f12,f13,f14,f124&secids=${secids}`;
  const res = await fetchWithTimeout(url, {
    ...BROWSER_HEADERS,
    Referer: 'https://quote.eastmoney.com/',
  });
  if (!res.ok) throw new Error(`中证行业行情接口响应异常: HTTP ${res.status}`);
  const json = await res.json();
  const rows = json && json.data && Array.isArray(json.data.diff) ? json.data.diff : [];
  const map = new Map(rows.map((r) => [r.f12, r]));

  return metas.map((meta) => {
    const row = map.get(meta.code);
    if (!row || !Number.isFinite(row.f2)) return { ...meta, error: 'no-data' };
    return {
      ...meta,
      price: Number(row.f2.toFixed(2)),
      change: Number(Number(row.f4).toFixed(2)),
      changePct: Number(Number(row.f3).toFixed(2)),
      time: Number.isFinite(row.f124) ? fmtTimestamp(row.f124) : '',
    };
  });
}

/** 中证行业：新浪有代码的先用新浪实时，缺失的用东财实时兜底 */
async function fetchCnIndex() {
  const metas = INDUSTRY_META.filter((m) => m.group === 'cnIndex');
  const sinaMetas = metas.filter((m) => m.sinaCode);
  const [sinaItems, emItems] = await Promise.all([
    fetchSinaQuotes(sinaMetas).catch(() => []),
    fetchEastmoneyQuotes(metas).catch(() => []),
  ]);
  const sinaMap = new Map(sinaItems.filter((i) => !i.error).map((i) => [i.code, i]));
  const emMap = new Map(emItems.filter((i) => !i.error).map((i) => [i.code, i]));

  return metas.map(
    (meta) => sinaMap.get(meta.code) || emMap.get(meta.code) || { ...meta, error: 'no-data' }
  );
}

/** 国证行业：新浪实时行情（399xxx / 980xxx / 1000 系列） */
async function fetchCniRealtime() {
  const codes = CNI_STOCK_META.map((m) => m.code).join(',');
  const res = await fetchWithTimeout(SINA_HQ_URL + codes, {
    Referer: 'https://finance.sina.com.cn',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  });
  if (!res.ok) throw new Error(`行业行情接口响应异常: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  return parseSinaRecords(CNI_STOCK_META, new TextDecoder('gbk').decode(buf));
}

/**
 * 国证行业：CN50xx 系列走国证官网行业指数列表。
 * 该接口返回上一交易日收盘点位与涨跌幅（percent 为小数），日期由 queryDay 提供。
 */
async function fetchCniOfficial() {
  const res = await fetchWithTimeout(CNINDEX_LIST_URL, {
    ...BROWSER_HEADERS,
    Referer: 'https://www.cnindex.com.cn/',
  });
  if (!res.ok) throw new Error(`国证行业接口响应异常: HTTP ${res.status}`);
  const json = await res.json();
  const rows = json && json.data && Array.isArray(json.data.rows) ? json.data.rows : [];
  const map = new Map(rows.map((r) => [r.indexcode, r]));

  let dataDate = '';
  try {
    const dayRes = await fetchWithTimeout(CNINDEX_DAY_URL, {
      ...BROWSER_HEADERS,
      Referer: 'https://www.cnindex.com.cn/',
    });
    const dayJson = await dayRes.json();
    if (dayJson && Number.isFinite(dayJson.data)) dataDate = fmtDate(dayJson.data);
  } catch (_) { /* 日期拿不到时仅标注收盘 */ }

  return CNI_OFFICIAL_META.map((meta) => {
    const row = map.get(meta.code);
    if (!row || !Number.isFinite(Number(row.closeingPoint))) {
      return { ...meta, error: 'no-data' };
    }
    const price = Number(row.closeingPoint);
    const changePct = Number(row.percent) * 100;
    if (!Number.isFinite(changePct)) return { ...meta, error: 'parse-failed' };
    // 接口只给涨跌幅，反推涨跌点数；percent 精度 0.01%，误差可忽略
    const prev = price / (1 + changePct / 100);
    const change = price - prev;
    return {
      ...meta,
      price: Number(price.toFixed(2)),
      change: Number(change.toFixed(2)),
      changePct: Number(changePct.toFixed(2)),
      time: `${dataDate} 收盘`.trim(),
    };
  });
}

/** 美国行业：新浪美股行情（gb_ 前缀） */
async function fetchUsIndustries() {
  const metas = INDUSTRY_META.filter((m) => m.group === 'usIndustry');
  const codes = metas.map((m) => m.code).join(',');
  const res = await fetchWithTimeout(SINA_HQ_URL + codes, {
    Referer: 'https://finance.sina.com.cn',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  });
  if (!res.ok) throw new Error(`行业行情接口响应异常: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  return parseSinaRecords(metas, new TextDecoder('gbk').decode(buf));
}

/** 拉取全部行业指数数据；单个分组失败不影响其他分组 */
async function fetchIndustries() {
  const [cnIndex, cniStock, cniOfficial, usIndustry] = await Promise.all([
    fetchCnIndex().catch(() =>
      INDUSTRY_META.filter((m) => m.group === 'cnIndex').map((m) => ({ ...m, error: 'no-data' }))
    ),
    fetchCniRealtime().catch(() =>
      CNI_STOCK_META.map((m) => ({ ...m, error: 'no-data' }))
    ),
    fetchCniOfficial().catch(() =>
      CNI_OFFICIAL_META.map((m) => ({ ...m, error: 'no-data' }))
    ),
    fetchUsIndustries().catch(() =>
      INDUSTRY_META.filter((m) => m.group === 'usIndustry').map((m) => ({ ...m, error: 'no-data' }))
    ),
  ]);

  // 按元数据原始顺序拼接，保证首屏骨架与数据卡片顺序一致
  const byCode = new Map(
    [...cnIndex, ...cniStock, ...cniOfficial, ...usIndustry].map((item) => [item.code, item])
  );
  return INDUSTRY_META.map((meta) => byCode.get(meta.code) || { ...meta, error: 'no-data' });
}

module.exports = { fetchIndustries, INDUSTRY_META };
