# EconRadar

国内外主要指数与宏观经济指标雷达（Electron）。

## 开发

```bash
git clone https://github.com/wentao-hu/econradar.git
cd econradar
npm install
npm start        # 运行（Mac / Windows 均可，无原生模块）
```

## 打包

```bash
npm run dist       # Mac（dmg + zip，输出到 dist/）
npm run dist:win   # Windows（NSIS 安装包 + zip，x64 + arm64；Mac 上交叉打包亦可）
```
