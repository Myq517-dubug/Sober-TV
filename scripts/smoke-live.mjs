/**
 * 直播页浏览器冒烟验证
 *
 * 覆盖：
 *   1. 首次进入自动铺满内置分类（9 个源 / 6 个分类 / 5 个默认启用）
 *   2. 内置源解析 → 频道按分组归类、跨源同名合并、脏数据过滤
 *   3. 分组 chip 按分类顺序排列
 *   4. 启用港澳台源后频道归到「港澳台」分类
 *   5. 自导入源与内置源分区展示
 *   6. 网络娱乐源：分组去 emoji 归一、频道墙分页（首屏 160 / 显示更多）
 *   7. 央视多线路源：只保留央视、高优先级线路排在最前
 *   8. 线路体检：假 200 的死链从频道墙摘掉，其余频道自动点亮
 *
 * 用法：node scripts/smoke-live.mjs（需先 npm run build）
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
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(await readFile(join(ROOT, 'index.html')));
  }
});
await new Promise((r) => server.listen(4188, '127.0.0.1', r));

/** 网络娱乐源：200 个频道验证分页；分组混入 emoji 装饰，验证归一化 */
function entPlaylist() {
  const rows = ['#EXTM3U'];
  for (let i = 0; i < 200; i++) {
    const group = i < 120 ? '一起看' : i < 170 ? '🎬手工绘画' : '原创IP';
    rows.push(
      `#EXTINF:-1 group-title="${group}",娱乐台${i + 1}`,
      `http://cdn.example/ent${i + 1}.m3u8`,
    );
  }
  rows.push(
    '#EXTINF:-1 group-title="列表更新时间",2026-10-28 15:45:53',
    'https://cdn.example/time.mp4',
  );
  return rows.join('\n');
}

/** 各内置源的模拟内容：覆盖中文分组、IPV4 后缀、点播文件与更新时间脏数据 */
const BODY = {
  'builtin-ent': entPlaylist(),
  'builtin-cn': `#EXTM3U
#EXTINF:-1 group-title="央视频道",CCTV-1
http://cdn.example/cctv1-a.m3u8
#EXTINF:-1 group-title="央视频道",CCTV-1
http://cdn.example/cctv1-b.m3u8
#EXTINF:-1 group-title="卫视频道",湖南卫视
http://cdn.example/hunan.m3u8
#EXTINF:-1 group-title="体育频道",CCTV-5
http://cdn.example/cctv5.m3u8
#EXTINF:-1 group-title="电影频道",电影1
http://cdn.example/movie1.m3u8
#EXTINF:-1 group-title="更新时间",2026-10-29 06:14:58
https://cdn.example/demo.mp4
#EXTINF:-1 group-title="卫视频道",坏台
rtmp://cdn.example/live
`,
  'builtin-4k': `#EXTM3U
#EXTINF:-1 group-title="央视IPV4",CCTV-1
http://cdn.example/cctv1-c.m3u8
#EXTINF:-1 group-title="4K8K频道",CCTV-4K
http://cdn.example/cctv4k.m3u8
`,
  'builtin-cctv': `#EXTM3U
#EXTINF:-1 group-title="央视频道",CCTV-1
http://cdn.example/cctv1-pri.m3u8
#EXTINF:-1 group-title="央视频道",CCTV-1
http://cdn.example/cctv1-pri2.m3u8
#EXTINF:-1 group-title="央视频道",CCTV-2
http://cdn.example/cctv2-pri.m3u8
#EXTINF:-1 group-title="卫视频道",湖南卫视
http://cdn.example/hunan-should-drop.m3u8
`,
  'builtin-vod': `#EXTM3U
#EXTINF:-1 group-title="影视「轮播」",轮播1
http://cdn.example/lunbo1.m3u8
#EXTINF:-1 group-title="影视「轮播」",坏频道
http://cdn.example/dead.m3u8
`,
  hk: `#EXTM3U
#EXTINF:-1 group-title="Entertainment",Asian Drama
http://cdn.example/hk1.m3u8
#EXTINF:-1 group-title="Movies",Celestial Movies
http://cdn.example/hk2.m3u8
`,
  tw: `#EXTM3U
#EXTINF:-1 group-title="Animation",Animax Asia Taiwan
http://cdn.example/tw1.m3u8
`,
  mo: `#EXTM3U
#EXTINF:-1 group-title="General",Canal Macau
http://cdn.example/mo1.m3u
`,
  'builtin-ipv6': `#EXTM3U
#EXTINF:-1 group-title="央视频道",CCTV-1
http://[2409:0000::1]/cctv1.m3u8
`,
};

const browser = await chromium.launch({
  executablePath: 'C:/Users/admin/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
  args: ['--no-sandbox'],
});

const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

await page.route('**/*.m3u8*', (route) => {
  // 体检探针：死的线路返回 200 + 导航页 HTML（大量失效源就是这样，只看状态码会误判）
  const dead = route.request().url().includes('/dead');
  route.fulfill({
    status: 200,
    headers: {
      'Content-Type': dead ? 'text/html; charset=utf-8' : 'application/vnd.apple.mpegurl',
      'Access-Control-Allow-Origin': '*',
    },
    body: dead ? '<html><body>404 Not Found</body></html>' : '#EXTM3U\n#EXT-X-VERSION:3\n',
  });
});

await page.route('**/*.m3u', (route) => {
  const u = route.request().url();
  const key = u.includes('live_platforms')
    ? 'builtin-ent'
    : u.includes('CCSH/IPTV')
    ? 'builtin-cctv'
    : u.includes('vbskycn')
    ? 'builtin-cn'
    : u.includes('aptv')
      ? 'builtin-4k'
      : u.includes('YanG')
        ? 'builtin-vod'
        : u.includes('countries/hk')
          ? 'hk'
          : u.includes('countries/tw')
            ? 'tw'
            : u.includes('countries/mo')
              ? 'mo'
              : 'builtin-ipv6';
  route.fulfill({
    status: 200,
    headers: { 'Content-Type': 'audio/x-mpegurl', 'Access-Control-Allow-Origin': '*' },
    body: BODY[key],
  });
});

const out = {};

await page.goto('http://127.0.0.1:4188/live', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

// ── 内置源铺满 + 默认启用 ───────────────────────────────
out.navCount = await page.locator('.nav__item').count();
out.activeNav = await page.locator('.nav__item.is-active span').allTextContents();
out.groupChips = (await page.locator('.live__chip').allTextContents()).map((t) =>
  t.replace(/\s+/g, ' ').trim(),
);
out.channels = (await page.locator('.lch__name').allTextContents()).map((t) => t.trim());

out.stored = await page.evaluate(() => {
  const list = JSON.parse(localStorage.getItem('sober.live.sources') || '[]');
  return {
    total: list.length,
    builtin: list.filter((s) => s.builtin).length,
    enabled: list.filter((s) => s.enabled).map((s) => s.id),
    categories: [...new Set(list.filter((s) => s.builtin).map((s) => s.category))],
    version: localStorage.getItem('sober.live.builtin.v'),
  };
});

out.parsed = await page.evaluate(() => {
  const cache = JSON.parse(localStorage.getItem('sober.live.cache') || 'null');
  const chs = cache?.channels || [];
  return {
    total: chs.length,
    groups: [...new Set(chs.map((c) => c.group))],
    cctv1Lines: chs.find((c) => c.name === 'CCTV-1')?.lines.length ?? 0,
    junk: chs.filter((c) => /^更新时间$|^\d{4}-\d{2}-\d{2}/.test(c.name)).map((c) => c.name),
    hasRtmp: chs.some((c) => c.name === '坏台'),
    has4k: chs.some((c) => c.name === 'CCTV-4K'),
    // 央视多线路源优先级最高：首条线路应来自它
    cctv1First: chs.find((c) => c.name === 'CCTV-1')?.lines[0]?.url ?? '',
    hunanLines: chs.find((c) => c.name === '湖南卫视')?.lines.length ?? 0,
    cctv2Lines: chs.find((c) => c.name === 'CCTV-2')?.lines.length ?? 0,
  };
});

// 央视多线路源只在面板里显示过滤后的央视频道数
out.cctvSource = await page.evaluate(() => {
  const list = JSON.parse(localStorage.getItem('sober.live.sources') || '[]');
  const s = list.find((x) => x.id === 'builtin-cctv');
  return { enabled: s?.enabled, count: s?.count, error: s?.lastError };
});

// ── 网络娱乐源：分组归一 + 频道墙分页 ───────────────────
out.ent = await page.evaluate(() => {
  const cache = JSON.parse(localStorage.getItem('sober.live.cache') || 'null');
  const chs = cache?.channels || [];
  const chips = [...document.querySelectorAll('.live__chip')].map((n) =>
    n.textContent.replace(/\s+/g, ' ').trim(),
  );
  const idxEnt = chips.findIndex((t) => t.startsWith('一起看'));
  const idx4k = chips.findIndex((t) => t.startsWith('4K8K'));
  return {
    groups: [...new Set(chs.filter((c) => /娱乐台/.test(c.name)).map((c) => c.group))],
    entCount: chs.filter((c) => /娱乐台/.test(c.name)).length,
    junkInCache: chs.filter((c) => /更新时间/.test(c.group)).length,
    chips,
    entAfter4k: idxEnt >= 0 && idx4k >= 0 && idxEnt > idx4k,
  };
});

// ── 线路体检：死链不上墙 ───────────────────────────────
await page
  .waitForFunction(() => document.querySelectorAll('.lch.is-checking').length === 0, null, {
    timeout: 30000,
  })
  .catch(() => {});
out.probe = {
  checking: await page.locator('.lch.is-checking').count(),
  deadVisible: (await page.locator('.lch__name').allTextContents()).map((t) => t.trim()).includes('坏频道'),
  statusText: ((await page.locator('.live__vtext').textContent()) || '').replace(/\s+/g, ' ').trim(),
  cacheHasDead: await page.evaluate(() => {
    const cache = JSON.parse(localStorage.getItem('sober.live.cache') || 'null');
    return (cache?.channels || []).some((c) => c.name === '坏频道');
  }),
};

out.page = {
  cards: await page.locator('.lch').count(),
  moreText: ((await page.locator('.live-more').textContent()) || '').replace(/\s+/g, ' ').trim(),
};
await page.locator('.live-more').click();
await page.waitForTimeout(300);
out.page.afterMore = await page.locator('.lch').count();

// ── 关键词搜索：结果同样只保留可播的 ───────────────────
await page.locator('.live__search input').fill('CCTV');
await page
  .waitForFunction(() => document.querySelectorAll('.lch.is-checking').length === 0, null, {
    timeout: 30000,
  })
  .catch(() => {});
out.search = {
  names: (await page.locator('.lch__name').allTextContents()).map((t) => t.trim()),
  status: ((await page.locator('.live__vtext').textContent()) || '').replace(/\s+/g, ' ').trim(),
};
await page.locator('.live__search input').fill('');
await page.waitForTimeout(600);

// ── 源面板：分类分组 ────────────────────────────────────
await page.locator('.live__iconbtn').last().click();
await page.waitForTimeout(400);
out.panel = {
  categories: (await page.locator('.bi-cat__title').allTextContents()).map((t) => t.trim()),
  builtinRows: await page.locator('.bi-cat .source-item').count(),
  customRows: await page.locator('.live-import__listhead').last().textContent(),
  panelVisible: await page.locator('.live-import__panel').isVisible(),
};
await page.screenshot({ path: 'release/live-sources.png' });

// ── 启用港澳台源 → 归到「港澳台」分类 ───────────────────
await page
  .locator('.bi-cat')
  .filter({ hasText: '港澳台' })
  .locator('button', { hasText: '启用' })
  .first()
  .click();
await page.waitForTimeout(900);
console.log('');
out.hmt = await page.evaluate(() => {
  const cache = JSON.parse(localStorage.getItem('sober.live.cache') || 'null');
  const chs = cache?.channels || [];
  return {
    groups: [...new Set(chs.map((c) => c.group))],
    hkCount: chs.filter((c) => c.group === '港澳台').length,
  };
});
await page.locator('.live-import__close').click();
await page.waitForTimeout(400);
await page.screenshot({ path: 'release/live-channels.png' });
out.chipsAfter = (await page.locator('.live__chip').allTextContents()).map((t) =>
  t.replace(/\s+/g, ' ').trim(),
);

out.errors = errors;
console.log(JSON.stringify(out, null, 2));

await browser.close();
server.close();
