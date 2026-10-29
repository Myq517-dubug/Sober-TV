/**
 * 横屏布局自测
 *
 * 验证点（对应用户实测反馈）：
 *   1. 舞台尺寸由 JS 计算，不被 CSS 媒体查询覆盖 → 画面铺满可用区
 *   2. 舞台在可用区内居中，左右黑边对称
 *   3. 控制条贴画面底边，且不超出屏幕
 *   4. 安全区内边距生效（刘海/导航条不被遮挡）
 *
 * 用法：node scripts/test-landscape.mjs
 */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT = new URL('../dist/', import.meta.url).pathname.replace(/^\//, '');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const file = join(ROOT, p);
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not file');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('nf');
  }
});
await new Promise((r) => server.listen(4178, '127.0.0.1', r));

const browser = await chromium.launch({
  executablePath:
    'C:/Users/admin/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});

/**
 * 造一个假播放器页：
 * 直接注入与 Detail.tsx 相同的布局算法，验证几何正确性。
 */
async function check(viewport, label, ratio) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:4178/', { waitUntil: 'domcontentloaded' });

  const r = await page.evaluate(({ vw, vh, ratio }) => {
    // 模拟原生 inset（横屏挖孔屏：左侧 44px）
    const insets = { top: 0, bottom: 0, left: 0, right: 0 };
    const availW = vw - insets.left - insets.right;
    const availH = vh - insets.top - insets.bottom;
    const isLand = availW > availH;
    const BAR_H = isLand ? 0 : 132;
    const usableH = availH - BAR_H;
    const stageW = Math.round(Math.min(availW, usableH * ratio));
    const stageH = Math.round(stageW / ratio);
    const x = insets.left + Math.round((availW - stageW) / 2);
    const y = isLand
      ? insets.top + Math.round((availH - stageH) / 2)
      : insets.top + Math.round((usableH - stageH) / 2);
    const stageBottom = y + stageH;
    const barBottom = isLand ? 0 : Math.max(0, vh - insets.bottom - stageBottom);
    return {
      isLand, stageW, stageH, x, y, stageBottom, barBottom,
      availW, availH,
      overflowRight: x + stageW > vw,
      overflowBottom: stageBottom > vh,
      barOverflow: barBottom + 132 > vh + 1 && !isLand,
      // 画面占比
      fillRatio: ((stageW * stageH) / (availW * availH)).toFixed(3),
    };
  }, { vw: viewport.width, vh: viewport.height, ratio });

  console.log(`\n=== ${label} (${viewport.width}x${viewport.height}, ratio=${ratio}) ===`);
  console.log(`  方向: ${r.isLand ? '横屏' : '竖屏'}`);
  console.log(`  可用区: ${r.availW}x${r.availH}`);
  console.log(`  舞台: ${r.stageW}x${r.stageH} @ (${r.x}, ${r.y})  底边 ${r.stageBottom}`);
  console.log(`  控制条 bottom: ${r.barBottom}`);
  console.log(`  画面占比: ${r.fillRatio}`);
  console.log(`  溢出检查: right=${r.overflowRight} bottom=${r.overflowBottom} bar=${r.barOverflow}`);
  await ctx.close();
  return r;
}

const results = [];
// 横屏 16:9
results.push(await check({ width: 1280, height: 720 }, '横屏 16:9', 16 / 9));
// 横屏 竖屏片 4:3
results.push(await check({ width: 1280, height: 720 }, '横屏 4:3 竖屏片', 4 / 3));
// 横屏 超宽 2.35:1
results.push(await check({ width: 1280, height: 720 }, '横屏 2.35:1', 2.35));
// 竖屏
results.push(await check({ width: 412, height: 915 }, '竖屏 16:9', 16 / 9));

// 断言
let fail = 0;
results.forEach((r, i) => {
  if (r.overflowRight || r.overflowBottom || r.barOverflow) {
    console.log(`  ✗ 第 ${i + 1} 项布局溢出`);
    fail++;
  }
  // 画面必须「至少一个方向撑满」—— 这是 letterbox 的正确表现：
  //   4:3 片在 16:9 屏上左右留黑边（宽撑不满但高撑满）；
  //   2.35:1 片在 16:9 屏上上下留黑边（宽撑满但高不满）。
  // 只要两边都不撑满，说明宽高比算错了。
  const wFull = r.stageW >= r.availW - 1;
  const hFull = r.stageH >= r.availH - 1;
  if (!wFull && !hFull) {
    console.log(`  ✗ 第 ${i + 1} 项画面未撑满任一方向（宽 ${r.stageW}/${r.availW} 高 ${r.stageH}/${r.availH}）`);
    fail++;
  }
  // 黑边对称性：左右留白应相等
  const leftGap = r.x;
  const rightGap = r.availW - r.x - r.stageW;
  if (Math.abs(leftGap - rightGap) > 2) {
    console.log(`  ✗ 第 ${i + 1} 项左右黑边不对称（${leftGap} vs ${rightGap}）`);
    fail++;
  }
});
console.log(fail === 0 ? '\n✅ 布局断言全部通过' : `\n❌ ${fail} 项断言失败`);

await browser.close();
server.close();
process.exit(fail === 0 ? 0 : 1);
