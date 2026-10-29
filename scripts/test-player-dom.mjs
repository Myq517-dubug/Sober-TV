/**
 * 真实 DOM 渲染验证：CSS 不得覆盖 JS 计算出的舞台尺寸
 *
 * 这是用户实测 bug 的根因：
 *   旧 CSS 的横屏媒体查询 `width: min(100%, calc(100vh * var(--ar-num, 1.7778)))`
 *   把 JS 算好的 --stage-w 覆盖掉了 → 画面缩成中间一小块。
 *
 * 用法：node scripts/test-player-dom.mjs
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
  '.svg': 'image/svg+xml',
};
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const file = join(ROOT, p);
    const s = await stat(file);
    if (!s.isFile()) throw new Error('nf');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('nf');
  }
});
await new Promise((r) => server.listen(4179, '127.0.0.1', r));

const browser = await chromium.launch({
  executablePath:
    'C:/Users/admin/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
  args: ['--no-sandbox'],
});

/** 复刻 Detail.css 的关键样式，注入测试页 */
const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html,body { background:#000; height:100%; }
  .player-shell {
    position: fixed; inset: 0; width: 100%; height: 100%;
    background:#000; overflow:hidden; z-index:40;
  }
  .player__stage {
    position:absolute;
    left: var(--stage-x,0px); top: var(--stage-y,0px);
    width: var(--stage-w,100%); height: var(--stage-h,auto);
    background:#123;
  }
  .player__video { width:100%; height:100%; object-fit:contain; background:#000; }
  .pbar {
    position:absolute; left:0; right:0; bottom: var(--pbar-bottom,0px);
    padding:12px 14px calc(14px + var(--safe-b,0px));
    background:linear-gradient(to top, rgba(6,8,7,.94), rgba(6,8,7,0));
    height:110px;
    /* 禁用入场动画：动画从 translateY(12px) 归位，
       测量时若处于动画中间态会读到偏移 12px 的假位置 */
    animation:none !important;
  }
  @media screen and (orientation: landscape) {
    .pbar { padding-left:20px; padding-right:20px; }
  }
`;

async function run(vw, vh, ratio, label) {
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh } });
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:4179/', { waitUntil: 'domcontentloaded' });
  await page.addStyleTag({ content: CSS });
  // 等控制条入场动画结束（pbar-in 从 translateY(12px) 归位），
  // 否则测到的位置会偏 12px —— 那是动画中间态，不是布局问题。
  await page.waitForTimeout(400);

  const computed = await page.evaluate(
    ({ vw, vh, ratio }) => {
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

      const shell = document.createElement('div');
      shell.className = 'player-shell';
      shell.style.setProperty('--stage-w', stageW + 'px');
      shell.style.setProperty('--stage-h', stageH + 'px');
      shell.style.setProperty('--stage-x', x + 'px');
      shell.style.setProperty('--stage-y', y + 'px');
      shell.style.setProperty('--pbar-bottom', barBottom + 'px');
      shell.style.setProperty('--safe-b', insets.bottom + 'px');
      shell.innerHTML =
        '<div class="player__stage"><div class="player__video"></div></div><div class="pbar"></div>';
      document.body.appendChild(shell);

      const stage = shell.querySelector('.player__stage');
      const bar = shell.querySelector('.pbar');
      const sr = stage.getBoundingClientRect();
      const br = bar.getBoundingClientRect();
      return {
        isLand,
        expect: { w: stageW, h: stageH, x, y, barBottom },
        actual: {
          w: Math.round(sr.width),
          h: Math.round(sr.height),
          x: Math.round(sr.left),
          y: Math.round(sr.top),
          // 底边用 bottom 边量（动画已结束）
          barBottom: Math.round(vh - br.bottom),
        },
        barTop: Math.round(br.top),
        barBottomEdge: Math.round(br.bottom),
        vh,
      };
    },
    { vw, vh, ratio },
  );

  const e = computed.expect;
  const a = computed.actual;
  const ok =
    e.w === a.w &&
    e.h === a.h &&
    e.x === a.x &&
    e.y === a.y &&
    e.barBottom === a.barBottom;

  console.log(`\n=== ${label} (${vw}x${vh}, ratio=${ratio.toFixed(2)}) ===`);
  console.log(`  期望舞台: ${e.w}x${e.h} @ (${e.x},${e.y})  barBottom=${e.barBottom}`);
  console.log(`  实际舞台: ${a.w}x${a.h} @ (${a.x},${a.y})  barBottom=${a.barBottom}`);
  console.log(`  控制条: top=${computed.barTop} bottom=${computed.barBottomEdge} (屏幕高 ${vh})`);
  console.log(`  ${ok ? '✅ CSS 未覆盖 JS 尺寸' : '❌ CSS 覆盖了 JS 尺寸（就是原 bug）'}`);

  await ctx.close();
  return ok;
}

const results = [];
results.push(await run(1280, 720, 16 / 9, '横屏 16:9'));
results.push(await run(1280, 720, 4 / 3, '横屏 4:3'));
results.push(await run(1280, 720, 2.35, '横屏 2.35:1'));
results.push(await run(412, 915, 16 / 9, '竖屏 16:9'));

await browser.close();
server.close();
const bad = results.filter((x) => !x).length;
console.log(bad === 0 ? '\n✅ 全部通过' : `\n❌ ${bad} 项失败`);
process.exit(bad === 0 ? 0 : 1);
