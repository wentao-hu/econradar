'use strict';

/**
 * 网页版数据采集脚本。
 *
 * GitHub Pages 是纯静态托管，浏览器直接请求新浪/东财行情接口会被
 * Referer 校验与 CORS 拦住，因此改由 GitHub Actions 定时在服务端抓取，
 * 产出一份静态 JSON 供前端读取。本脚本复用 Electron 主进程使用的 lib/ 数据源，
 * 保证网页与桌面版口径完全一致。
 *
 * 输出：web/data/latest.json
 * 环境变量：
 *   PREVIOUS_DATA  上一次成功产出的 JSON 路径；某个源抓取失败时用它回退，
 *                  避免偶发网络抖动导致整页空白（本地运行默认读输出文件自身）。
 */

// 必须在任何 Date 逻辑之前设置：lib/ 里生成的时间字符串按本地时区格式化，
// runner 默认是 UTC，统一成北京时间后界面标注才成立。
process.env.TZ = 'Asia/Shanghai';

const fs = require('fs');
const path = require('path');

const { fetchIndices } = require('../lib/indices');
const { fetchUsBond } = require('../lib/usbond');
const { fetchUsMacro } = require('../lib/usmacro');
const { fetchUsPce } = require('../lib/uspce');
const { fetchIndustries } = require('../lib/industries');
const { fetchFundFlow } = require('../lib/fundflow');

const OUT_FILE = path.join(__dirname, '..', 'web', 'data', 'latest.json');
const PREV_FILE = process.env.PREVIOUS_DATA || OUT_FILE;

const FF_RANGES = ['today', '5d', '10d'];

function readPrevious() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PREV_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

/** 一组数据里至少有一条有效项才算抓取成功 */
function hasUsableData(value) {
  if (Array.isArray(value)) return value.some((item) => item && !item.error);
  return !!(value && Array.isArray(value.inflow) && Array.isArray(value.outflow));
}

/** 抓一个数据源；失败或空数据时短暂重试一次，再失败则回退到上一次结果 */
async function collectSource(name, fetchFn, previous) {
  const startedAt = Date.now();
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const data = await fetchFn();
      if (hasUsableData(data)) {
        return { value: data, status: { ok: true, ms: Date.now() - startedAt } };
      }
      throw new Error('empty result');
    } catch (err) {
      lastError = err;
      // 接口偶发 502/超时很常见，等待片刻重试一次，避免整组数据缺席
      if (attempt === 0) {
        console.error(`[collect] ${name} 首次抓取失败，1 秒后重试：${(err && err.message) || err}`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  const prev = previous && previous[name];
  const message = String((lastError && lastError.message) || lastError);
  if (hasUsableData(prev)) {
    console.error(`[collect] ${name} 抓取失败，沿用上次数据：${message}`);
    return {
      value: prev,
      status: { ok: false, stale: true, ms: Date.now() - startedAt, error: message },
    };
  }
  console.error(`[collect] ${name} 抓取失败，且无可用历史数据：${message}`);
  return {
    value: Array.isArray(prev) ? prev : null,
    status: { ok: false, stale: false, ms: Date.now() - startedAt, error: message },
  };
}

async function collectFundFlow(previous) {
  const prev = previous && previous.fundflow;
  const pairs = await Promise.all(
    FF_RANGES.map(async (range) => {
      const res = await collectSource(
        `fundflow.${range}`,
        () => fetchFundFlow(range),
        { [`fundflow.${range}`]: prev && prev[range] }
      );
      return [range, res];
    })
  );
  const fundflow = {};
  const status = {};
  for (const [range, res] of pairs) {
    fundflow[range] = res.value;
    status[range] = res.status;
  }
  return { fundflow, status };
}

function beijingStamp(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

async function main() {
  const previous = readPrevious();

  const [indices, usbond, usmacro, pce, industries] = await Promise.all([
    collectSource('indices', fetchIndices, previous),
    collectSource('usbond', fetchUsBond, previous),
    collectSource('usmacro', fetchUsMacro, previous),
    collectSource('pce', fetchUsPce, previous),
    collectSource('industries', fetchIndustries, previous),
  ]);
  const ff = await collectFundFlow(previous);

  const generatedAt = new Date().toISOString();
  const payload = {
    schemaVersion: 1,
    generatedAt,
    generatedAtBeijing: beijingStamp(generatedAt),
    sourceStatus: {
      indices: indices.status,
      usbond: usbond.status,
      usmacro: usmacro.status,
      pce: pce.status,
      industries: industries.status,
      fundflow: ff.status,
    },
    indices: indices.value || [],
    usbond: usbond.value || [],
    usmacro: usmacro.value || [],
    pce: pce.value || [],
    industries: industries.value || [],
    fundflow: ff.fundflow,
  };

  const usable =
    ['indices', 'usbond', 'usmacro', 'pce', 'industries'].filter((key) =>
      hasUsableData(payload[key])
    ).length + (hasUsableData(ff.fundflow.today) ? 1 : 0);
  if (usable === 0) {
    throw new Error('所有数据源均抓取失败，放弃本次产出');
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload), 'utf8');

  const counts = {
    indices: payload.indices.length,
    usbond: payload.usbond.length,
    usmacro: payload.usmacro.length,
    pce: payload.pce.length,
    industries: payload.industries.length,
    fundflow: FF_RANGES.map(
      (r) => `${r}:${payload.fundflow[r] ? payload.fundflow[r].inflow.length : 0}`
    ).join('/'),
  };
  console.log(`[collect] 已写入 ${OUT_FILE}`);
  console.log(`[collect] generatedAt=${payload.generatedAtBeijing}（北京时间）`);
  console.log(`[collect] 条数 ${JSON.stringify(counts)}`);
}

main().catch((err) => {
  console.error(`[collect] 失败：${(err && err.stack) || err}`);
  process.exit(1);
});
