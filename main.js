'use strict';

// 启用 V8 编译缓存（Electron 30+ / Node 20.8+ 支持），
// 将编译产物缓存到磁盘，加快后续启动时的模块加载，不影响任何功能。
try {
  require('node:module').enableCompileCache?.();
} catch {
  // 不支持的版本直接忽略
}

const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { fetchIndices, INDEX_META } = require('./lib/indices');
const { fetchUsBond, USBOND_META } = require('./lib/usbond');
const { fetchUsMacro, MACRO_META } = require('./lib/usmacro');
const { fetchUsPce, PCE_META } = require('./lib/uspce');
const { fetchIndustries, INDUSTRY_META } = require('./lib/industries');
const { fetchFundFlow, RANGE_FIELDS } = require('./lib/fundflow');

// 预热结果复用窗口：启动预热与渲染进程首刷通常只隔几百毫秒，
// 若预热完成后渲染进程才来请求，inflight 已结束会重复抓取同一批数据；
// TTL 内的请求直接复用最近一次结果，消除这轮重复请求。
// 手动刷新（fresh=true）绕过 TTL 始终重新抓取，刷新语义不变。
const RESULT_TTL_MS = 10 * 1000;

// 同一数据口径（key）同一时刻只保留一个进行中的请求，渲染进程直接复用进行中的
// Promise；成功结果按 TTL 短缓存，失败不缓存（下次请求重新抓取）。
// fetchFn 接收 key 作为参数（无参源固定传 ''，被忽略；资金流向 key 为排行周期）。
function makeSharedFetch(fetchFn) {
  const inflight = new Map();
  const last = new Map(); // key -> { at, data }
  return function sharedFetch({ key = '', fresh = false } = {}) {
    if (!fresh) {
      const hit = last.get(key);
      if (hit && Date.now() - hit.at < RESULT_TTL_MS) return Promise.resolve(hit.data);
    }
    if (!inflight.has(key)) {
      const p = Promise.resolve()
        .then(() => fetchFn(key))
        .then((data) => {
          last.set(key, { at: Date.now(), data });
          return data;
        })
        .finally(() => {
          inflight.delete(key);
        });
      inflight.set(key, p);
    }
    return inflight.get(key);
  };
}

// 各数据源均随启动预热，与窗口加载并行。
// PCE 与东财宏观分开成两个通道：
// 改 BEA 直连后单次约 2s，但仍不复用东财宏观那条会一起返回的 Promise，
// PCE 自身 30 分钟缓存也不至于拖住美债、非农等更新更频繁的指标。
const fetchIndicesShared = makeSharedFetch(fetchIndices);
const fetchUsBondShared = makeSharedFetch(fetchUsBond);
const fetchUsMacroShared = makeSharedFetch(fetchUsMacro);
const fetchUsPceShared = makeSharedFetch(fetchUsPce);
const fetchIndustriesShared = makeSharedFetch(fetchIndustries);
const fetchFundFlowShared = makeSharedFetch(fetchFundFlow);

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 720,
    minWidth: 980,
    minHeight: 620,
    title: 'EconRadar',
    show: false, // 等首帧渲染完成后再显示，避免白屏闪烁、感知打开更快
    backgroundColor: '#f5f6f8',
    // 隐藏式标题栏是 macOS 专属体验（配红绿灯位置）；Windows 上没有红绿灯，
    // 用同样式会丢掉最小化/关闭按钮，因此 Windows 走原生标题栏。
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 } }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false, // 纯数据展示界面没有输入场景，关掉省去拼写检查词典的内存开销
    },
  });

  // 开发态窗口图标（须先确认文件存在）
  const pngIcon = path.join(__dirname, 'build', 'icon.png');
  if (fs.existsSync(pngIcon)) {
    win.setIcon(pngIcon);
  }

  win.once('ready-to-show', () => win.show());

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 拦截 Cmd/Ctrl+R：触发数据刷新而非页面 reload
  // （reload 会重置窗口状态、丢失进行中的拖拽，且语义是"重新加载"而非"刷新数据"）
  win.webContents.on('before-input-event', (event, input) => {
    if (
      input.type === 'keyDown' &&
      input.key.toLowerCase() === 'r' &&
      (input.meta || input.control)
    ) {
      event.preventDefault();
      win.webContents.send('app:refresh');
    }
  });
}

// 统一注册数据拉取通道：fresh=true（手动刷新）绕过预热结果缓存，强制重新抓取
function handleFetch(channel, sharedFetch) {
  ipcMain.handle(channel, async (_event, fresh) => {
    try {
      const data = await sharedFetch({ fresh: !!fresh });
      return { ok: true, data, fetchedAt: new Date().toISOString() };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
}

// 渲染进程请求最新指数数据
handleFetch('indices:fetch', fetchIndicesShared);
// 渲染进程请求美债收益率（东财行情，2/10/30 年三个期限）
handleFetch('usbond:fetch', fetchUsBondShared);
// 渲染进程请求美国宏观数据（东财口径，不含 PCE）
handleFetch('usmacro:fetch', fetchUsMacroShared);
// 渲染进程请求美国 PCE 数据（BEA 官方页直连）
handleFetch('uspce:fetch', fetchUsPceShared);
// 渲染进程请求行业指数数据
handleFetch('industries:fetch', fetchIndustriesShared);

// 渲染进程请求板块资金流向数据（行业板块主力净流入/净流出 TOP10，range: today/5d/10d）
ipcMain.handle('fundflow:fetch', async (_event, range, fresh) => {
  try {
    const key = RANGE_FIELDS[range] ? range : 'today';
    const data = await fetchFundFlowShared({ key, fresh: !!fresh });
    return { ok: true, data, fetchedAt: new Date().toISOString() };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// 渲染进程请求指标静态元数据（分组/名称/链接），用于首屏立即渲染骨架卡片
ipcMain.handle('indices:meta', () => [
  ...INDEX_META,
  ...USBOND_META,
  ...MACRO_META,
  ...PCE_META,
  ...INDUSTRY_META,
]);

// 渲染进程保存关键设置（如拖拽排序）后，立刻把 localStorage 挂起写入落盘。
// Chromium 的 DOM Storage 按秒级批量提交，异常退出（崩溃/强杀/断电）会丢掉未提交的写入。
ipcMain.on('storage:flush', () => {
  session.defaultSession.flushStorageData();
});

// 点击指数标题 -> 默认浏览器打开详情页
ipcMain.handle('open-external', (event, url) => {
  if (typeof url === 'string' && /^https:\/\//.test(url)) {
    return shell.openExternal(url);
  }
  return Promise.resolve();
});

app.whenReady().then(() => {
  // 仅开发态设置 Dock 图标；打包后由 .app 内 icon.icns 负责
  const pngIcon = path.join(__dirname, 'build', 'icon.png');
  if (!app.isPackaged && app.dock && fs.existsSync(pngIcon)) {
    app.dock.setIcon(pngIcon);
  }

  createWindow();

  // 启动即预热行情、美债、宏观、PCE、行业与资金流向数据，与窗口加载并行；失败不影响渲染进程后续自行重试
  fetchIndicesShared().catch(() => {});
  fetchUsBondShared().catch(() => {});
  fetchUsMacroShared().catch(() => {});
  fetchUsPceShared().catch(() => {});
  fetchIndustriesShared().catch(() => {});
  fetchFundFlowShared({ key: 'today' }).catch(() => {});

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

// 退出前强制把 localStorage 挂起的写入落盘。
// Chromium 的 DOM Storage 按秒级批量提交，拖拽排序后立刻退出会丢掉未提交的写入
// （"拖完顺序、重开后顺序复原"正是该场景），flushStorageData 是官方对应的落盘手段。
let storageFlushed = false;
app.on('before-quit', (event) => {
  if (storageFlushed) return;
  event.preventDefault();
  storageFlushed = true;
  Promise.race([
    session.defaultSession.flushStorageData(),
    // 兜底：flush 异常卡住时也要保证能正常退出
    new Promise((resolve) => setTimeout(resolve, 800)),
  ]).finally(() => app.quit());
});
