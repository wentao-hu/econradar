'use strict';

/**
 * 从 build/icon-source.png 生成 macOS 图标：
 * - 1024x1024 RGBA PNG（squircle，四角透明，圆角内白底）
 * - 主体最长边约占画布 64%，居中，LANCZOS 缩放
 * - 同步生成 build/icon.icns（iconutil）
 *
 * 用法: node scripts/generate-icon.js
 * 依赖: 系统 Python3 + Pillow；macOS iconutil / sips
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const buildDir = path.join(root, 'build');
const sourcePng = path.join(buildDir, 'icon-source.png');
const outPng = path.join(buildDir, 'icon.png');
const outIcns = path.join(buildDir, 'icon.icns');

if (!fs.existsSync(sourcePng)) {
  console.error('缺少 build/icon-source.png，请先放入用户原图');
  process.exit(1);
}

const py = `
from PIL import Image
import sys

SRC, OUT, SIZE = sys.argv[1], sys.argv[2], 1024
SUBJECT_RATIO = 0.64
SQUIRCLE_N = 5.0

src = Image.open(SRC).convert("RGBA")
px = src.load()
w, h = src.size

for y in range(h):
    for x in range(w):
        r, g, b, a = px[x, y]
        if r < 28 and g < 28 and b < 28:
            px[x, y] = (0, 0, 0, 0)

min_x, min_y, max_x, max_y = w, h, 0, 0
found = False
for y in range(h):
    for x in range(w):
        if px[x, y][3] > 20:
            found = True
            min_x = min(min_x, x); min_y = min(min_y, y)
            max_x = max(max_x, x); max_y = max(max_y, y)
if not found:
    raise SystemExit("icon-source 无可识别主体（可能全透明）")

pad = 2
min_x = max(0, min_x - pad); min_y = max(0, min_y - pad)
max_x = min(w - 1, max_x + pad); max_y = min(h - 1, max_y + pad)
glyph = src.crop((min_x, min_y, max_x + 1, max_y + 1))
gw, gh = glyph.size

target = int(SIZE * SUBJECT_RATIO)
scale = target / max(gw, gh)
nw = max(1, int(round(gw * scale)))
nh = max(1, int(round(gh * scale)))
glyph = glyph.resize((nw, nh), Image.Resampling.LANCZOS)

canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
mask = Image.new("L", (SIZE, SIZE), 0)
mp = mask.load()
cx = cy = (SIZE - 1) / 2.0
a = SIZE / 2.0
for y in range(SIZE):
    for x in range(SIZE):
        dx = abs(x - cx) / a
        dy = abs(y - cy) / a
        d = (dx ** SQUIRCLE_N + dy ** SQUIRCLE_N) ** (1.0 / SQUIRCLE_N)
        edge = 0.5 - (d - 1.0) * a / 1.2
        if edge <= 0:
            v = 0
        elif edge >= 1:
            v = 255
        else:
            v = int(round(edge * 255))
        mp[x, y] = v

white = Image.new("RGBA", (SIZE, SIZE), (255, 255, 255, 255))
canvas.paste(white, (0, 0), mask)
ox = (SIZE - nw) // 2
oy = (SIZE - nh) // 2
canvas.alpha_composite(glyph, (ox, oy))
canvas.putalpha(mask)
canvas.save(OUT, "PNG")
print(f"icon.png {SIZE}x{SIZE}, subject {nw}x{nh} ({100 * max(nw, nh) / SIZE:.1f}%)")
`;

const compose = spawnSync('python3', ['-c', py, sourcePng, outPng], {
  encoding: 'utf8',
});
if (compose.status !== 0) {
  console.error(compose.stderr || compose.stdout || 'compose failed');
  process.exit(compose.status || 1);
}
process.stdout.write(compose.stdout);

const iconset = path.join(buildDir, 'icon.iconset');
fs.rmSync(iconset, { recursive: true, force: true });
fs.mkdirSync(iconset, { recursive: true });

const sizes = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

for (const [name, px] of sizes) {
  const dest = path.join(iconset, name);
  const r = spawnSync('sips', ['-z', String(px), String(px), outPng, '--out', dest], {
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout || `sips failed for ${name}`);
    process.exit(r.status || 1);
  }
}

const icns = spawnSync('iconutil', ['-c', 'icns', iconset, '-o', outIcns], {
  encoding: 'utf8',
});
fs.rmSync(iconset, { recursive: true, force: true });
if (icns.status !== 0) {
  console.error(icns.stderr || icns.stdout || 'iconutil failed');
  process.exit(icns.status || 1);
}

console.log('icon.icns written:', outIcns);
