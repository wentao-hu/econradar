'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('econ', {
  /** 拉取全部指数数据 */
  getIndices: () => ipcRenderer.invoke('indices:fetch'),
  /** 拉取美国宏观经济数据 */
  getUsMacro: () => ipcRenderer.invoke('usmacro:fetch'),
  /** 拉取行业指数数据（中国行业 + 美国行业） */
  getIndustries: () => ipcRenderer.invoke('industries:fetch'),
  /** 获取指标静态元数据（分组/名称/链接），用于首屏骨架卡片 */
  getIndexMeta: () => ipcRenderer.invoke('indices:meta'),
  /** 用默认浏览器打开指数详情页 */
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
});
