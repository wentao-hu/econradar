# EconRadar

国内外主要指数与宏观经济指标雷达。

## 网页版

**https://wentao-hu.github.io/econradar/**

- 桌面端：顶部导航 + 自适应卡片网格
- 移动端：底部 Tab 栏 + 双列卡片，适配安全区
- 数据由 GitHub Actions 每 15 分钟抓取一次，页面上的「刷新」读取最新快照

网页是纯静态站点，托管在 GitHub Pages 的 `gh-pages` 分支。行情接口校验 Referer
且不返回 CORS 头，浏览器无法直连，因此由 Actions 在服务端抓取后生成
`web/data/latest.json`，前端只读这份快照。

### 本地预览

```bash
node scripts/collect.js          # 抓取数据，输出 web/data/latest.json
cd web && python3 -m http.server 8899
```

打开 http://127.0.0.1:8899/ 。

### 数据采集

`scripts/collect.js` 复用 `lib/` 下的数据源（与 Electron 版同一套解析逻辑），
任一数据源抓取失败时沿用上次快照；`PREVIOUS_DATA` 环境变量可指定历史快照路径。

### 部署

`.github/workflows/deploy-pages.yml` 在定时任务、手动触发或网页代码变更时：

1. 从现有 `gh-pages` 分支恢复上次快照，作为失败回退；
2. 运行 `scripts/collect.js`；
3. 把 `web/` 目录以单个提交 force-push 到 `gh-pages`，由 Pages 发布。

### 跨设备排序同步

卡片排序除保存在本机 `localStorage` 外，还会同步到 Cloudflare Pages Functions + KV：

- API：`https://econradar-sync.pages.dev/api/order`（固定共享 key）
- 源码：`sync/`
- 部署：

```bash
cd sync
npx wrangler pages deploy public --project-name econradar-sync --branch main
```

拖拽结束后约 0.8 秒上传；页面每 30 秒拉取一次远端顺序，远端较新时自动覆盖本机顺序。

## Electron 版（保留）

```bash
npm install
npm start        # 运行（Mac / Windows 均可，无原生模块）
```

打包：

```bash
npm run dist       # Mac（dmg + zip，输出到 dist/）
npm run dist:win   # Windows（NSIS 安装包 + zip，x64 + arm64；Mac 上交叉打包亦可）
```
