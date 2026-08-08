'use strict';

/**
 * 美国宏观经济数据源：东方财富数据中心接口（datacenter-web.eastmoney.com）
 * 对应 data.eastmoney.com/cjsj/foreign_0_X.html 各指标页，
 * reportName 固定为 RPT_ECONOMICVALUE_USANEW，按 INDICATOR_ID 过滤。
 */

const EM_API_URL = 'https://datacenter-web.eastmoney.com/api/data/v1/get';

/** 单次请求超时 */
const FETCH_TIMEOUT_MS = 8000;

/**
 * 指标元数据。
 * valueDivisor：接口原始值换算为展示值的除数
 * （非农接口单位是“千人”，页面展示口径为“万人”，故除以 10）。
 */
const MACRO_META = [
  {
    code: 'usmacro_fed_rate',
    group: 'usmacro',
    kind: 'macro',
    indicatorId: 'EMG00342250',
    name: '美联储利率',
    unit: '%',
    digits: 2,
    valueDivisor: 1,
    url: 'https://data.eastmoney.com/cjsj/foreign_0_22.html',
  },
  {
    code: 'usmacro_cpi_headline',
    group: 'usmacro',
    kind: 'macro',
    indicatorId: 'EMG00000733',
    name: '美国CPI',
    unit: '%',
    digits: 2,
    valueDivisor: 1,
    url: 'https://data.eastmoney.com/cjsj/foreign_0_12.html',
  },
  {
    // 口径：核心CPI:季调:当月同比（code 沿用 usmacro_cpi 以保留已保存的卡片排序）
    code: 'usmacro_cpi',
    group: 'usmacro',
    kind: 'macro',
    indicatorId: 'EMG00000746',
    name: '美国核心CPI',
    unit: '%',
    digits: 2,
    valueDivisor: 1,
    url: 'https://data.eastmoney.com/cjsj/foreign_0_14.html',
  },
  {
    code: 'usmacro_nonfarm',
    group: 'usmacro',
    kind: 'macro',
    indicatorId: 'EMG00152118',
    name: '非农就业人数变化',
    unit: '万',
    digits: 2,
    valueDivisor: 10,
    url: 'https://data.eastmoney.com/cjsj/foreign_0_2.html',
  },
  {
    code: 'usmacro_unemployment',
    group: 'usmacro',
    kind: 'macro',
    indicatorId: 'EMG00001039',
    name: '失业率',
    unit: '%',
    digits: 2,
    valueDivisor: 1,
    url: 'https://data.eastmoney.com/cjsj/foreign_0_4.html',
  },
];

function toFixedNumber(v, digits) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(digits));
}

/** 拉取单个指标的最近若干期数据 */
async function fetchOne(meta) {
  const filter = encodeURIComponent(`(INDICATOR_ID="${meta.indicatorId}")`);
  const url =
    `${EM_API_URL}?reportName=RPT_ECONOMICVALUE_USANEW&columns=ALL` +
    `&filter=${filter}&pageNumber=1&pageSize=8` +
    `&sortColumns=REPORT_DATE&sortTypes=-1&source=WEB&client=WEB`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('宏观数据接口请求超时');
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`宏观数据接口响应异常: HTTP ${res.status}`);
  const json = await res.json();
  const rows = (json && json.result && json.result.data) || [];
  // 最新一期往往尚未公布（VALUE 为 null），取第一条已公布的记录
  const row = rows.find((r) => r.VALUE != null);
  if (!row) return { ...meta, error: 'no-data' };
  const value = toFixedNumber(row.VALUE / meta.valueDivisor, meta.digits);
  const prev = toFixedNumber(row.PRE_VALUE / meta.valueDivisor, meta.digits);
  if (value == null) return { ...meta, error: 'parse-failed' };
  return {
    ...meta,
    value,
    prev,
    change: prev == null ? null : toFixedNumber(value - prev, meta.digits),
    time: row.REPORT_DATE_CH || (row.REPORT_DATE || '').slice(0, 10),
  };
}

/** 拉取全部美国宏观指标（各指标并行请求；单个失败不拖垮整体） */
async function fetchUsMacro() {
  return Promise.all(
    MACRO_META.map((meta) =>
      fetchOne(meta).catch(() => ({ ...meta, error: 'fetch-failed' }))
    )
  );
}

module.exports = { fetchUsMacro, MACRO_META };
