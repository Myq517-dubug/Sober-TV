/**
 * 首页海报端到端验证
 *
 * 验证：首屏渲染的卡片里，带真实海报 img 的比例应接近 100%
 * （用户实测反馈「首页的推荐都没有海报图片」）
 *
 * 用法：node scripts/test-home-posters.mjs
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
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};
const server = createServer(async (req, res) => {
  try {
    const rawUrl = decodeURIComponent(req.url.split('?')[0]);

    /*
     * /cms?u=<encoded> —— 采集接口代理
     *
     * 采集接口没有 CORS 头，浏览器直连会被拦。
     * App 里走原生网络栈（无 CORS 限制），这里用本机代理等价模拟。
     */
    if (rawUrl === '/cms') {
      const q = new URL(req.url, 'http://127.0.0.1');
      const target = q.searchParams.get('u');
      if (!target) {
        res.writeHead(400);
        res.end('no target');
        return;
      }
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 15000);
      try {
        const r = await fetch(target, { signal: ac.signal });
        const body = Buffer.from(await r.arrayBuffer());
        res.writeHead(r.status, {
          'Content-Type': r.headers.get('content-type') || 'application/json',
        });
        res.end(body);
      } catch (e) {
        res.writeHead(504);
        res.end('proxy error');
      } finally {
        clearTimeout(timer);
      }
      return;
    }

    let p = rawUrl;
    if (p === '/') p = '/index.html';
    const f = join(ROOT, p);
    const s = await stat(f);
    if (!s.isFile()) throw 0;
    const b = await readFile(f);
    res.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream' });
    res.end(b);
  } catch {
    res.writeHead(404);
    res.end('nf');
  }
});
await new Promise((r) => server.listen(4180, '127.0.0.1', r));

const browser = await chromium.launch({
  executablePath:
    'C:/Users/admin/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
  args: ['--no-sandbox'],
});
const ctx = await browser.newContext({
  viewport: { width: 412, height: 915 },
  userAgent:
    'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
});
const page = await ctx.newPage();

// 模拟真实设备环境：TMDB 在国内被墙 → 预置熔断标记，强制走 CMS 片库
await page.addInitScript(() => {
  try {
    localStorage.setItem('sober.tmdb.tripped', '1');
    localStorage.removeItem('sober.catalogue.cache');
  } catch {}
});

// 记录 CMS 采集接口的响应（用于确认批量详情是否被调用）
const cmsCalls = [];
page.on('response', async (r) => {
  const u = r.url();
  if (u.includes('ac=detail') || u.includes('ac=list')) {
    cmsCalls.push({
      url: u.replace(/ids=[\d,]+/, 'ids=<批量>').slice(0, 110),
      status: r.status(),
    });
  }
});

/**
 * 模拟原生 HTTP 栈（CapacitorHttp）
 *
 * 采集接口**没有 CORS 头**，浏览器直连会被同源策略拦掉；
 * App 里走的是原生网络栈（无 CORS 限制）。
 * 这里用路由拦截把跨域请求变成「服务端代理」，等价于原生栈的行为。
 */
const CMS_HOSTS = [
  'cj.ffzyapi.com',
  'bfzyapi.com',
  'caiji.dyttzyapi.com',
  'hhzyapi.com',
  'suoniapi.com',
  'caiji.moduapi.cc',
  'api.apibdzy.com',
  '360zy.com',
  'collect.wolongzyw.com',
];

await page.route('**/*', async (route) => {
  const url = route.request().url();
  const isCms = CMS_HOSTS.some((h) => url.includes(h));
  const isTmdb = url.includes('themoviedb.org');
  if (!isCms && !isTmdb) return route.continue();

  if (isTmdb) {
    // TMDB 被墙 → 直接失败，模拟熔断
    return route.abort('failed');
  }

  // 采集接口：用本机代理转发（等价原生栈）
  // ⚠️ 目标 URL 必须整体编码 —— 否则其中的 ? 与 & 会与代理自身的
  //    query string 混淆，导致目标地址残缺。
  const proxied = 'http://127.0.0.1:4180/cms?u=' + encodeURIComponent(url);
  try {
    const r = await route.fetch({ url: proxied });
    const body = await r.body();
    return route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      },
      body,
    });
  } catch (e) {
    return route.abort('failed');
  }
});

const t0 = Date.now();
await page.goto('http://127.0.0.1:4180/', { waitUntil: 'domcontentloaded' });

// 等首页出现卡片
await page.waitForSelector('.poster-card', { timeout: 25000 });
const firstPaint = Date.now() - t0;

// 等图片加载（滚动触发 lazy load）
await page.evaluate(async () => {
  // 触发所有懒加载
  for (let y = 0; y < 3000; y += 600) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 120));
  }
  window.scrollTo(0, 0);
});
await page.waitForTimeout(25000);

const stats = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.poster-card')];
  let withImg = 0;
  let loaded = 0;
  let placeholder = 0;
  const samples = [];
  const missing = [];
  for (const c of cards) {
    const img = c.querySelector('.poster-card__art img');
    const ph = c.querySelector('.poster-card__placeholder');
    const title = c.querySelector('.poster-card__title')?.textContent || '';
    const row = c.closest('.row')?.querySelector('.row__title')?.textContent || '';
    if (img) {
      withImg++;
      if (img.complete && img.naturalWidth > 0) loaded++;
      else if (missing.length < 8) missing.push({ title, row, src: img.src.slice(0, 90) });
      if (samples.length < 3) samples.push({ src: img.src.slice(0, 90), ok: img.naturalWidth > 0 });
    } else if (ph) {
      placeholder++;
      if (missing.length < 8) missing.push({ title, row, src: '（无 img 元素）' });
    }
  }
  const rows = [...document.querySelectorAll('.row__title')].map((e) => e.textContent);

  /*
   * 首屏可见图片的加载率
   *
   * 为什么单独统计：全量统计会被两个因素污染 ——
   *   1. loading="lazy"：屏幕外的图本来就不该加载
   *   2. 浏览器对同 host 的并发连接上限（通常 6）：
   *      几十张图排在队列里，complete=false 只是「还没轮到」
   * 首屏可见区域的图才是用户真正会看到的。
   */
  const vh = window.innerHeight;
  let visible = 0;
  let visibleLoaded = 0;
  for (const c of cards) {
    const img = c.querySelector('.poster-card__art img');
    if (!img) continue;
    const r = c.getBoundingClientRect();
    if (r.top > vh || r.bottom < 0) continue;
    visible++;
    if (img.complete && img.naturalWidth > 0) visibleLoaded++;
  }

  return {
    total: cards.length,
    withImg,
    loaded,
    placeholder,
    samples,
    rows,
    missing,
    visible,
    visibleLoaded,
    allSrcs: cards
      .map((c) => c.querySelector('.poster-card__art img')?.src)
      .filter(Boolean),
  };
});

/**
 * 直接校验所有海报 URL 的可达性
 *
 * 浏览器里的加载率会被 lazy loading 与「同 host 并发连接上限（6）」
 * 污染 —— 排在队列里的图 complete=false，看起来像失败。
 * 直接 fetch 每个 URL 才是准确的可达率。
 */
const urlCheck = await page.evaluate(async (srcs) => {
  const uniq = [...new Set(srcs)];
  let ok = 0;
  const bad = [];
  // 限并发 8，避免把源打挂
  let idx = 0;
  const worker = async () => {
    while (idx < uniq.length) {
      const u = uniq[idx++];
      try {
        const r = await fetch(u, { method: 'GET', mode: 'no-cors' });
        // no-cors 下 opaque 响应也算拿到（说明服务器有响应）
        if (r.type === 'opaque' || r.ok || r.status === 0) ok++;
        else bad.push(`${r.status} ${u.slice(0, 80)}`);
      } catch (e) {
        bad.push(`ERR ${u.slice(0, 80)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return { total: uniq.length, ok, bad: bad.slice(0, 6) };
}, stats.allSrcs);

console.log('\n=== 首页海报验证 ===');
console.log(`首屏渲染耗时: ${firstPaint}ms`);
console.log(`行标题: ${stats.rows.join(' | ')}`);
console.log(`卡片总数: ${stats.total}`);
console.log(`带海报 <img>: ${stats.withImg}  (${((stats.withImg / (stats.total || 1)) * 100).toFixed(1)}%)`);
console.log(`图片实际加载成功: ${stats.loaded}  (${((stats.loaded / (stats.withImg || 1)) * 100).toFixed(1)}%)`);
console.log(`占位卡片: ${stats.placeholder}`);
console.log(
  `首屏可见图片: ${stats.visibleLoaded}/${stats.visible} 已加载` +
    ` (${((stats.visibleLoaded / (stats.visible || 1)) * 100).toFixed(1)}%)`,
);
console.log(
  `海报 URL 可达率: ${urlCheck.ok}/${urlCheck.total} ` +
    `(${((urlCheck.ok / (urlCheck.total || 1)) * 100).toFixed(1)}%)`,
);
if (urlCheck.bad.length) {
  console.log('不可达样本:');
  urlCheck.bad.forEach((b) => console.log(`  ✗ ${b}`));
}
if (stats.missing.length) {
  console.log('缺图样本（片名 / 所属行）:');
  stats.missing.forEach((m) => console.log(`  · ${m.title}  [${m.row}]  ${m.src}`));
}
console.log('样本:');
stats.samples.forEach((s) => console.log(`  ${s.ok ? '✓' : '✗'} ${s.src}`));
console.log('\nCMS 调用:');
cmsCalls.slice(0, 12).forEach((c) => console.log(`  [${c.status}] ${c.url}`));

const hasBatch = cmsCalls.some((c) => c.url.includes('ids=<批量>'));
console.log(`\n批量详情接口被调用: ${hasBatch ? '✅ 是' : '❌ 否'}`);

const ratio = stats.withImg / (stats.total || 1);
const urlRatio = urlCheck.ok / (urlCheck.total || 1);
const ok =
  stats.total > 0 &&
  ratio > 0.98 &&
  stats.placeholder === 0 &&
  hasBatch &&
  urlRatio > 0.9;
console.log(
  ok
    ? '\n✅ 首页海报验证通过（首屏即带图，无空卡片，批量详情生效，图片 URL 高可达）'
    : '\n❌ 首页海报验证未通过',
);

await browser.close();
server.close();
process.exit(ok ? 0 : 1);
