'use strict';

// 启用 V8 编译缓存（Electron 30+ / Node 20.8+ 支持），
// 将编译产物缓存到磁盘，加快后续启动时的模块加载，不影响任何功能。
try {
  require('node:module').enableCompileCache?.();
} catch {
  // 不支持的版本直接忽略
}

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { fetchIndices, INDEX_META } = require('./lib/indices');
const { fetchUsMacro, MACRO_META } = require('./lib/usmacro');
const { fetchIndustries, INDUSTRY_META } = require('./lib/industries');

// 同一时刻只保留一个进行中的行情请求。
// 应用启动后立即预热，窗口加载与网络请求并行，
// 渲染进程首屏请求直接复用进行中的 Promise，避免串行等待。
let inflightFetch = null;
function fetchIndicesShared() {
  if (!inflightFetch) {
    inflightFetch = fetchIndices().finally(() => {
      inflightFetch = null;
    });
  }
  return inflightFetch;
}

// 美国宏观数据同样共享进行中请求，并随启动预热
let inflightMacroFetch = null;
function fetchUsMacroShared() {
  if (!inflightMacroFetch) {
    inflightMacroFetch = fetchUsMacro().finally(() => {
      inflightMacroFetch = null;
    });
  }
  return inflightMacroFetch;
}

// 行业指数数据共享进行中请求，并随启动预热
let inflightIndustryFetch = null;
function fetchIndustriesShared() {
  if (!inflightIndustryFetch) {
    inflightIndustryFetch = fetchIndustries().finally(() => {
      inflightIndustryFetch = null;
    });
  }
  return inflightIndustryFetch;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 720,
    minWidth: 980,
    minHeight: 620,
    title: 'EconRader',
    show: false, // 等首帧渲染完成后再显示，避免白屏闪烁、感知打开更快
    backgroundColor: '#f5f6f8',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 开发态窗口图标（须先确认文件存在）
  const pngIcon = path.join(__dirname, 'build', 'icon.png');
  if (fs.existsSync(pngIcon)) {
    win.setIcon(pngIcon);
  }

  win.once('ready-to-show', () => win.show());

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// 渲染进程请求最新指数数据
ipcMain.handle('indices:fetch', async () => {
  try {
    const data = await fetchIndicesShared();
    return { ok: true, data, fetchedAt: new Date().toISOString() };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// 渲染进程请求美国宏观数据
ipcMain.handle('usmacro:fetch', async () => {
  try {
    const data = await fetchUsMacroShared();
    return { ok: true, data, fetchedAt: new Date().toISOString() };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// 渲染进程请求行业指数数据
ipcMain.handle('industries:fetch', async () => {
  try {
    const data = await fetchIndustriesShared();
    return { ok: true, data, fetchedAt: new Date().toISOString() };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// 渲染进程请求指标静态元数据（分组/名称/链接），用于首屏立即渲染骨架卡片
ipcMain.handle('indices:meta', () => [...INDEX_META, ...MACRO_META, ...INDUSTRY_META]);

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

  // 启动即预热行情、宏观与行业数据，与窗口加载并行；失败不影响渲染进程后续自行重试
  fetchIndicesShared().catch(() => {});
  fetchUsMacroShared().catch(() => {});
  fetchIndustriesShared().catch(() => {});

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
