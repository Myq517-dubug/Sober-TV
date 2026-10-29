/**
 * 平台直播页冒烟验证（浏览器）
 *
 * 用桩数据模拟四家平台的列表 / 搜索 / 播放解析接口，验证：
 *   1. 卡片墙渲染：封面、主播、在线人数、平台角标
 *   2. 分类切换会带上对应的 B 站分区参数
 *   3. 关键词搜索只保留在播房间
 *   4. 平台接口失败时给出提示且不影响其他平台
 *   5. 下播的主播刷新后从墙上消失
 *   6. 点开卡片进入播放层并解析出播放地址
 *   7. 抖音走 SSR 载荷解析，播放地址直接复用列表里的签名地址
 *
 * 用法：node scripts/smoke-platform-live.mjs（需先构建 dist）
 */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT = new URL('../dist/', import.meta.url).pathname.replace(/^\//, '');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
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
await new Promise((r) => server.listen(4189, '127.0.0.1', r));

const ok = (data) => ({ code: 0, message: 'OK', data });

/** B 站分区列表桩数据：roomid / title / uname / face / cover / area_name / online */
function biliAreaRooms(parent, cate, count, tag) {
  return Array.from({ length: count }).map((_, i) => ({
    roomid: parent * 10000 + cate * 100 + i,
    title: `${tag}主播${i + 1}的直播`,
    uname: `${tag}主播${i + 1}`,
    face: 'https://i0.hdslb.com/bfs/face/demo.jpg',
    cover: 'https://i0.hdslb.com/bfs/live/demo-cover.jpg',
    area_name: tag,
    online: 9000 - i * 100,
  }));
}

let biliHotCount = 6;
/** 轮询时是否多返回一个「刚开播」房间，验证刷新后的插入位置 */
let pollExtra = 0;
/** 让虎牙接口整体失败，验证刷新失败不清空列表 */
let huyaFail = false;

/** 抖音分类页桩：房间数据写在 SSR 流式载荷里，流地址带签名 */
function douyinHtml(cat) {
  const base = Number(cat) * 1000;
  const rooms = Array.from({ length: 5 }).map((_, i) => ({
    room: {
      id_str: String(base + i),
      title: `抖音主播${i + 1}的直播`,
      owner: {
        nickname: `抖音主播${i + 1}`,
        avatar_thumb: { url_list: ['https://p.example/ava.jpg'] },
      },
      cover: { url_list: ['https://p.example/cover.jpg'] },
      game_tag: i % 2 ? '聊天' : '王者荣耀',
      stats: { total_user_str: String(9000 - i * 100) },
      stream_url: {
        flv_pull_url: {
          FULL_HD1: `https://pull.example/${base + i}_full.flv?sig=1`,
          HD1: `https://pull.example/${base + i}_hd.flv?sig=1`,
        },
        hls_pull_url_map: { FULL_HD1: `https://pull.example/${base + i}.m3u8?sig=1` },
      },
    },
    web_rid: String(700000 + base + i),
  }));
  // 电商房：应被过滤掉
  rooms.push({
    room: {
      id_str: String(base + 99),
      title: 'yy旗舰店秋冬上新',
      owner: { nickname: '某某官方号', avatar_thumb: { url_list: ['https://p.example/ava.jpg'] } },
      cover: { url_list: ['https://p.example/cover.jpg'] },
      stats: { total_user_str: '1' },
      stream_url: {
        flv_pull_url: { FULL_HD1: `https://pull.example/${base + 99}_full.flv?sig=1` },
        hls_pull_url_map: {},
      },
    },
    web_rid: String(700000 + base + 99),
  });
  const payload = `2:${JSON.stringify({ data: rooms })}\n3:I["$","div",null,{}]\n`;
  return `<html><body><script>self.__pace_f.push([1,${JSON.stringify(
    payload,
  )}])</script></body></html>`;
}

/** 虎牙列表桩：data.datas */
function huyaRooms(count) {
  return {
    data: {
      datas: Array.from({ length: count }).map((_, i) => ({
        profileRoom: `9${i}0001`,
        roomName: `虎牙星秀${i + 1}`,
        nick: `虎牙主播${i + 1}`,
        avatar180: 'https://example.com/ava.jpg',
        screenshot: 'https://example.com/cover.jpg',
        gameFullName: i % 2 ? '星秀' : '王者荣耀',
        totalCount: 5000 + i,
      })),
    },
  };
}

const browser = await chromium.launch({
  executablePath:
    'C:/Users/admin/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
  args: ['--no-sandbox'],
});
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 } });
const page = await ctx.newPage();
// 接管页面定时器，后面可以直接快进 60 秒触发自动轮询
await page.clock.install();

const areasSeen = [];
const searchSeen = [];
let aggCalls = 0;

await page.route('**/api.live.bilibili.com/**', async (route) => {
  const url = route.request().url();
  const json = (body) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      body: JSON.stringify(body),
    });

  if (url.includes('/room/v1/Area/getRoomList')) {
    const u = new URL(url);
    const parent = Number(u.searchParams.get('parent_area_id'));
    const cate = Number(u.searchParams.get('cate_id'));
    areasSeen.push(`${parent}_${cate}`);
    const tag = cate === 145 ? '颜值' : cate === 207 ? '舞蹈' : '游戏';
    return json(ok(biliAreaRooms(parent, cate, cate === 0 ? 4 : 5, tag)));
  }
  if (url.includes('webMain/getList')) {
    // 每次刷新少一个房间，模拟主播下播
    const n = Math.max(2, biliHotCount);
    biliHotCount -= 2;
    return json({
      code: 0,
      data: {
        recommend_room_list: [
          ...Array.from({ length: n }).map((_, i) => ({
            roomid: 800000 + i,
            title: `推荐直播${i + 1}`,
            uname: `推荐主播${i + 1}`,
            face: 'https://i0.hdslb.com/bfs/face/demo.jpg',
            cover: 'https://i0.hdslb.com/bfs/live/demo-cover.jpg',
            area_v2_name: '推荐',
            online: 3000 - i * 10,
          })),
          ...(pollExtra
            ? [
                {
                  roomid: 990001,
                  title: '刚开播的新主播',
                  uname: '新主播',
                  face: 'https://i0.hdslb.com/bfs/face/demo.jpg',
                  cover: 'https://i0.hdslb.com/bfs/live/demo-cover.jpg',
                  area_v2_name: '推荐',
                  online: 8888,
                },
              ]
            : []),
        ],
      },
    });
  }
  if (url.includes('getRoomPlayInfo')) {
    return json({
      code: 0,
      data: {
        live_status: 1,
        playurl_info: {
          playurl: {
            stream: [
              {
                protocol_name: 'http_hls',
                format: [
                  {
                    format_name: 'ts',
                    codec: [
                      {
                        codec_name: 'avc',
                        base_url: '/live/demo.m3u8?token=1',
                        url_info: [{ host: 'https://cdn.example', extra: '' }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
    });
  }
  return json({ code: 0, data: [] });
});

await page.route('**/api.bilibili.com/**', async (route) => {
  const u = new URL(route.request().url());
  const kw = u.searchParams.get('keyword') || '';
  searchSeen.push(kw);
  route.fulfill({
    status: 200,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
    body: JSON.stringify({
      code: 0,
      data: {
        result: [
          {
            type: 'live_room',
            roomid: 555001,
            title: `${kw} 在播`,
            uname: `${kw}主播`,
            face: 'https://i0.hdslb.com/bfs/face/demo.jpg',
            cover: '//i0.hdslb.com/bfs/live/demo-cover.jpg',
            cate_name: kw,
            live_status: 1,
            online: 1234,
          },
          {
            type: 'live_room',
            roomid: 555002,
            title: `${kw} 轮播录像`,
            uname: `${kw}主播2`,
            live_status: 0,
            online: 0,
          },
        ],
      },
    }),
  });
});

await page.route('**/*huya.com/**', async (route) => {
  if (huyaFail) return route.abort('connectionreset');
  const url = route.request().url();
  route.fulfill({
    status: 200,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
    body: JSON.stringify(url.includes('getLiveListByPage') ? huyaRooms(4) : { data: { datas: [] } }),
  });
});

// 斗鱼直接失败，验证单平台异常不影响整体
await page.route('**/*douyu.com/**', (route) => route.abort('connectionreset'));

// 抖音：分类页返回带 SSR 流式载荷的 HTML
await page.route('**/live.douyin.com/**', (route) => {
  const cat = new URL(route.request().url()).pathname.split('/').pop() || '1';
  route.fulfill({
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: douyinHtml(cat),
  });
});

// 聚合解析：返回 FLV 线路
await page.route('**/api.zxki.cn/**', (route) => {
  aggCalls++;
  route.fulfill({
    status: 200,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
    body: JSON.stringify({
      code: 200,
      status: 'ON',
      title: '虎牙星秀1',
      nick: '虎牙主播1',
      headers: { Referer: 'https://m.huya.com/' },
      urls: [
        { name: '蓝光(原画)', type: 'flv', ratio: '0', cdn: 'AL', url: 'https://cdn.example/1.flv' },
        { name: '高清', type: 'flv', ratio: '4000', cdn: 'TX', url: 'https://cdn.example/2.flv' },
      ],
    }),
  });
});

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

await page.goto('http://127.0.0.1:4189/live', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.lroom:not(.lroom--skeleton)', { timeout: 15000 });
// 四个平台并行拉取，B站先到先上墙，等其余平台落定
await page.waitForSelector('.lroom__plat.is-huya', { timeout: 15000 });
await page.waitForSelector('.lroom__plat.is-douyin', { timeout: 20000 });
await page.waitForTimeout(800);

const cards = await page.locator('.lroom:not(.lroom--skeleton)').count();
check('卡片墙渲染', cards >= 8, `${cards} 张卡片`);

const platTags = await page.locator('.lroom__plat').allTextContents();
check(
  '四个平台混排',
  new Set(platTags).size >= 3 &&
    platTags.includes('B站') &&
    platTags.includes('虎牙') &&
    platTags.includes('抖音'),
  platTags.slice(0, 8).join('/'),
);

const dyTitles = await page
  .locator('.lroom', { has: page.locator('.lroom__plat.is-douyin') })
  .locator('.lroom__title')
  .allTextContents();
check(
  '抖音过滤电商房',
  dyTitles.length >= 5 && !dyTitles.some((t) => /旗舰店|官方号|上新/.test(t)),
  `${dyTitles.length} 个抖音房`,
);

const failedChip = await page.locator('.live__pchip.is-failed').count();
check('斗鱼失败有提示', failedChip === 1, `${failedChip} 个失败标记`);

const onlineText = await page.locator('.lroom__online').first().textContent();
check('在线人数格式化', /万$|^\d+$/.test((onlineText || '').trim()), onlineText || '');

// 分类切换：颜值 → B 站 cate 145
await page.getByRole('button', { name: '颜值', exact: true }).click();
await page.waitForTimeout(1200);
check('颜值分类命中分区 145', areasSeen.includes('1_145'), areasSeen.join(','));

const beautyTitles = await page.locator('.lroom__title').allTextContents();
check(
  '颜值分类内容正确',
  beautyTitles.some((t) => t.includes('颜值')),
  beautyTitles.slice(0, 3).join(' | '),
);

// 搜索：只保留在播
await page.fill('.live__search input', 'ASMR');
await page.waitForTimeout(1500);
const searchTitles = await page.locator('.lroom__title').allTextContents();
check(
  '搜索只返回在播主播',
  searchTitles.length === 1 && searchTitles[0].includes('在播') && !searchTitles[0].includes('轮播'),
  `${searchTitles.length} 条：${searchTitles.join(' | ')}`,
);
check('搜索请求已发出', searchSeen.includes('ASMR'), searchSeen.join(','));

// 清空搜索回到推荐，验证下播主播消失
await page.fill('.live__search input', '');
await page.waitForTimeout(600);
await page.getByRole('button', { name: '推荐', exact: true }).click();
await page.waitForTimeout(1400);
const before = await page.locator('.lroom').count();
await page.locator('.live__iconbtn').click();
await page.waitForTimeout(1600);
const after = await page.locator('.lroom').count();
check('刷新后下播主播消失', after < before, `${before} → ${after}`);

await page.screenshot({ path: 'scripts/tmp-live-wall.png', fullPage: false });

// 点开虎牙卡片：走聚合解析 → 播放层
const huyaCard = page.locator('.lroom', { has: page.locator('.lroom__plat.is-huya') }).first();
await huyaCard.click();
await page.waitForSelector('.live-player', { timeout: 12000 });
const playerTitle = await page.locator('.live-player__title').textContent();
check('点开即播进入播放层', !!playerTitle && aggCalls > 0, `${playerTitle} / 解析 ${aggCalls} 次`);

const lineBtn = await page.locator('.live-player__btn').first().textContent();
check('播放层显示线路数', /线路\s*2/.test(lineBtn || ''), lineBtn || '');

await page.screenshot({ path: 'scripts/tmp-live-player.png', fullPage: false });

// 返回列表
await page.locator('.player__back').click();
await page.waitForTimeout(600);
check('返回列表', (await page.locator('.lgrid').count()) === 1, '');

// ── 自动轮询：已有卡片保持顺序，新主播插到最前 ─────────
const titlesBefore = (await page.locator('.lroom__title').allTextContents()).map((t) => t.trim());
pollExtra = 1;
await page.clock.fastForward(61_000);
let titlesAfter = titlesBefore;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 250));
  titlesAfter = (await page.locator('.lroom__title').allTextContents()).map((t) => t.trim());
  if (titlesAfter.includes('刚开播的新主播')) break;
}
pollExtra = 0;
const keptBefore = titlesBefore.filter((t) => titlesAfter.includes(t));
const keptAfter = titlesAfter.filter((t) => titlesBefore.includes(t));
check(
  '轮询后保持卡片顺序',
  keptBefore.length > 0 && keptBefore.join('|') === keptAfter.join('|'),
  `${keptAfter.length} 个保持原位`,
);
check(
  '轮询把新主播插到最前',
  !!titlesAfter[0] && !titlesBefore.includes(titlesAfter[0]),
  titlesAfter[0] || '无',
);

// ── 刷新失败：保留当前列表，不把墙清空 ────────────────
await page.getByRole('button', { name: '虎牙', exact: true }).click();
await page.waitForTimeout(900);
const huyaBefore = await page.locator('.lroom').count();
huyaFail = true;
await page.locator('.live__iconbtn').click();
await page.waitForTimeout(1500);
const huyaAfter = await page.locator('.lroom').count();
const failToast = ((await page.locator('.live-toast').textContent().catch(() => '')) || '').trim();
check(
  '刷新失败保留列表',
  huyaBefore > 0 && huyaAfter === huyaBefore && /保留当前列表/.test(failToast),
  `${huyaBefore} → ${huyaAfter} / ${failToast}`,
);
huyaFail = false;
await page.getByRole('button', { name: '全部', exact: true }).click();
await page.waitForTimeout(900);

// 虎牙卡片在「全部」里按人气降序
const huyaOnlines = (
  await page
    .locator('.lroom', { has: page.locator('.lroom__plat.is-huya') })
    .locator('.lroom__online')
    .allTextContents()
).map((t) => t.trim());
check(
  '虎牙按人气降序',
  huyaOnlines.length >= 2 && huyaOnlines[0] === '5003',
  huyaOnlines.join(','),
);

// 点开抖音卡片：播放地址直接复用列表解析出的签名线路，不再调聚合接口
const aggBefore = aggCalls;
const douyinCard = page.locator('.lroom', { has: page.locator('.lroom__plat.is-douyin') }).first();
await douyinCard.click();
await page.waitForSelector('.live-player', { timeout: 12000 });
const douyinTitle = await page.locator('.live-player__title').textContent();
const douyinLineBtn = await page.locator('.live-player__btn').first().textContent();
check(
  '抖音点开即播复用列表线路',
  !!douyinTitle && /线路\s*3/.test(douyinLineBtn || '') && aggCalls === aggBefore,
  `${douyinTitle} / ${douyinLineBtn} / 新增解析 ${aggCalls - aggBefore} 次`,
);

await mkdir('scripts', { recursive: true });
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
await browser.close();
server.close();
if (failed.length) process.exit(1);
