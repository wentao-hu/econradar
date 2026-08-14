'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('econ', {
  /** 拉取全部指数数据（fresh=true 手动刷新，绕过预热结果缓存） */
  getIndices: (fresh) => ipcRenderer.invoke('indices:fetch', fresh),
  /** 拉取美国宏观经济数据（东财口径，不含 PCE） */
  getUsMacro: (fresh) => ipcRenderer.invoke('usmacro:fetch', fresh),
  /** 拉取美国 PCE 数据（investing，独立通道，耗时可能较长） */
  getUsPce: (fresh) => ipcRenderer.invoke('uspce:fetch', fresh),
  /** 拉取行业指数数据（中国行业 + 美国行业） */
  getIndustries: (fresh) => ipcRenderer.invoke('industries:fetch', fresh),
  /** 拉取板块资金流向数据（行业板块主力净流入/净流出 TOP10；range: 'today'/'5d'/'10d'） */
  getFundFlow: (range, fresh) => ipcRenderer.invoke('fundflow:fetch', range, fresh),
  /** 获取指标静态元数据（分组/名称/链接），用于首屏骨架卡片 */
  getIndexMeta: () => ipcRenderer.invoke('indices:meta'),
  /** 用默认浏览器打开指数详情页 */
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  /** 通知主进程把 localStorage 挂起写入立刻落盘（用于拖拽排序等关键设置） */
  flushStorage: () => ipcRenderer.send('storage:flush'),
  /** 主进程拦截 Cmd/Ctrl+R 后通知渲染进程触发数据刷新（不 reload 页面） */
  onRefresh: (cb) => ipcRenderer.on('app:refresh', () => cb()),
});
