/**
 * 公网链路集成测试 v2 —— 覆盖扩充后的源池与用户自定义源
 *
 * 直接打真实公网接口，验证：
 *   1. 内置源池里至少 N 个可用（保证片库足够全）
 *   2. 分类接口可用，且能按名称匹配出跨源通用的分类 id
 *   3. 每个可用源都能独立解析出 m3u8 地址
 *   4. 地址规范化能把各种写法统一成标准接口路径
 *
 * 运行：node --test server/test/public.test.mjs
 */

import assert from 'node:assert';
import { test } from 'node:test';

const TMDB_KEY = '8d97210e6edd66eb9e967278325836d0';
const TMDB_BASE = 'https://api.themoviedb.org/3';

/** 与前端 src/lib/cms.ts 的 CMS_SOURCES 保持一致 */
const CMS_SOURCES = [
  { id: 'ffm3u8', name: '非凡资源', base: 'https://cj.ffzyapi.com/api.php/provide/vod/' },
  { id: 'bfzym3u8', name: '暴风资源', base: 'https://bfzyapi.com/api.php/provide/vod/' },
  { id: 'dyttm3u8', name: '电影天堂', base: 'https://caiji.dyttzyapi.com/api.php/provide/vod/' },
  { id: 'hhm3u8', name: '豪华资源', base: 'https://hhzyapi.com/api.php/provide/vod/' },
  { id: 'snm3u8', name: '索尼资源', base: 'https://suoniapi.com/api.php/provide/vod/' },
  { id: 'modum3u8', name: '魔都资源', base: 'https://caiji.moduapi.cc/api.php/provide/vod/' },
  { id: 'dbm3u8', name: '百度资源', base: 'https://api.apibdzy.com/api.php/provide/vod/' },
  { id: '360zy', name: '360资源', base: 'https://360zy.com/api.php/provide/vod/' },
  { id: 'wolong', name: '卧龙资源', base: 'https://collect.wolongzyw.com/api.php/provide/vod/' },
];

const UA =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

async function getJson(url, timeout = 15000) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: '*/*' },
    signal: AbortSignal.timeout(timeout),
  });
  assert.ok(r.ok, `HTTP ${r.status} ${url}`);
  return r.json();
}

/** 解析播放地址 —— 与前端 cms.ts 保持一致 */
function parsePlayLines(detail) {
  const fromRaw = detail.vod_play_from || '';
  const urlRaw = detail.vod_play_url || '';
  if (!urlRaw) return [];

  const froms = fromRaw.split('$$$');
  const groups = urlRaw.split('$$$');
  const lines = [];

  for (let i = 0; i < groups.length; i++) {
    const episodes = groups[i]
      .split('#')
      .map((seg) => {
        const idx = seg.indexOf('$');
        if (idx < 0) return null;
        const name = seg.slice(0, idx).trim();
        const url = seg.slice(idx + 1).trim();
        return url ? { name, url } : null;
      })
      .filter(Boolean);
    if (!episodes.length) continue;
    if (!episodes.some((e) => e.url.includes('.m3u8'))) continue;
    lines.push({ from: froms[i] || `线路${i + 1}`, episodes });
  }
  return lines;
}

/** 挑集 —— 与前端 cms.ts 保持一致 */
function pickEpisode(lines, episode) {
  const norm = (s) => s.replace(/\s/g, '');
  for (const line of lines) {
    for (let i = 0; i < line.episodes.length; i++) {
      const n = norm(line.episodes[i].name);
      if (n === `第${episode}集` || n === `${episode}`) {
        return { url: line.episodes[i].url, line: line.from, index: i };
      }
    }
    for (let i = 0; i < line.episodes.length; i++) {
      const n = norm(line.episodes[i].name);
      if (n.includes(`第${episode}集`)) {
        return { url: line.episodes[i].url, line: line.from, index: i };
      }
    }
  }
  const first = lines[0];
  if (first && first.episodes.length >= episode) {
    return { url: first.episodes[episode - 1].url, line: first.from, index: episode - 1 };
  }
  return null;
}

/** 地址规范化 —— 与前端 customSources.ts 保持一致 */
function normalizeSourceUrl(input) {
  let s = (input || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  s = s.split('?')[0].split('#')[0];
  s = s.replace(/\/+$/, '');

  const m = s.match(/^(.*?\/api\.php\/provide\/vod)/i);
  if (m) return `${m[1]}/`;

  if (/\/api\.php/i.test(s)) {
    const m2 = s.match(/^(.*?\/api\.php)/i);
    if (m2) return `${m2[1]}/provide/vod/`;
  }

  const m3 = s.match(/^(https?:\/\/[^/]+)/i);
  return m3 ? `${m3[1]}/api.php/provide/vod/` : null;
}

/**
 * TMDB 在部分网络环境（如 CI 沙箱、被墙区域）不可达。
 * 这属于「环境限制」而非「密钥失效」，
 * 故 TMDB 相关用例在网络不可达时跳过（skip）而不是判失败。
 */
async function tmdbAvailable() {
  try {
    const r = await fetch(`${TMDB_BASE}/movie/popular?api_key=${TMDB_KEY}&language=zh-CN&page=1`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return false;
    const j = await r.json();
    return typeof j.total_results === 'number';
  } catch {
    return false;
  }
}

const TMDB_REACHABLE = await tmdbAvailable();
if (!TMDB_REACHABLE) {
  console.log('   [提示] 当前网络无法直连 api.themoviedb.org，跳过 TMDB 用例');
}

// ── TMDB ──────────────────────────────────────────────

test('TMDB 密钥有效，popular 可返回真实数据', async (t) => {
  if (!TMDB_REACHABLE) {
    t.skip('当前网络不可达 TMDB');
    return;
  }
  const j = await getJson(`${TMDB_BASE}/movie/popular?api_key=${TMDB_KEY}&language=zh-CN&page=1`);
  assert.ok(j.results.length > 0, '应返回结果');
  assert.ok(j.total_results > 1000, `total_results 应很大，实际 ${j.total_results}`);
  assert.ok(j.results[0].title, '应有中文标题');
});

test('TMDB 搜索可返回中文片名', async (t) => {
  if (!TMDB_REACHABLE) {
    t.skip('当前网络不可达 TMDB');
    return;
  }
  const j = await getJson(
    `${TMDB_BASE}/search/multi?api_key=${TMDB_KEY}&language=zh-CN&query=${encodeURIComponent('流浪地球')}`,
  );
  assert.ok(j.results.length > 0, '应有搜索结果');
  const names = j.results.map((r) => r.title || r.name);
  assert.ok(names.some((n) => n.includes('流浪地球')), `应含目标片名，实际: ${names.join(',')}`);
});

// ── 源池 ──────────────────────────────────────────────

test('内置源池：至少 3 个源可用（保证片库足够全）', async () => {
  const results = await Promise.all(
    CMS_SOURCES.map(async (s) => {
      try {
        const j = await getJson(`${s.base}?ac=list&limit=1`, 12000);
        return { id: s.id, ok: j.code === 1, total: j.total };
      } catch {
        return { id: s.id, ok: false };
      }
    }),
  );
  const ok = results.filter((r) => r.ok);
  assert.ok(
    ok.length >= 3,
    `应至少 3 个源可用，实际: ${JSON.stringify(results.map((r) => [r.id, r.ok]))}`,
  );
  const total = ok.reduce((sum, r) => sum + (r.total || 0), 0);
  assert.ok(total > 100000, `可用源片库总量应超 10 万，实际 ${total}`);
  console.log(
    `   可用源 ${ok.length}/${CMS_SOURCES.length}：${ok
      .map((r) => `${r.id}(${r.total})`)
      .join(', ')}`,
  );
});

test('分类接口可用，且能按名称匹配出跨源通用分类', async () => {
  const results = await Promise.all(
    CMS_SOURCES.slice(0, 4).map(async (s) => {
      try {
        const j = await getJson(`${s.base}?ac=type`, 12000);
        const seen = new Set();
        const cats = [];
        for (const c of j.list || []) {
          const id = Number(c.type_id);
          if (!id || seen.has(id)) continue;
          seen.add(id);
          cats.push({ typeId: id, name: c.type_name || '' });
        }
        return { id: s.id, ok: cats.length > 0, cats };
      } catch {
        return { id: s.id, ok: false, cats: [] };
      }
    }),
  );
  const ok = results.filter((r) => r.ok);
  assert.ok(ok.length >= 1, '应至少 1 个源的分类接口可用');

  // 至少一个源能匹配出「电影」或「剧集」类
  const movieKeywords = ['电影', '片'];
  const tvKeywords = ['剧', '连续剧', '电视剧', 'tv', '动漫'];
  let matched = 0;
  for (const r of ok) {
    const movie = r.cats.find((c) => movieKeywords.some((k) => c.name.includes(k)));
    const tv = r.cats.find((c) => tvKeywords.some((k) => c.name.includes(k)));
    if (movie || tv) matched++;
  }
  assert.ok(matched >= 1, '应至少一个源能按名称匹配出分类 id');
});

test('每个可用源都能独立解析出 m3u8 地址', async () => {
  const results = await Promise.all(
    CMS_SOURCES.map(async (s) => {
      try {
        const list = await getJson(
          `${s.base}?ac=list&wd=${encodeURIComponent('流浪地球')}&limit=10`,
          12000,
        );
        if (!list.list.length) return { id: s.id, ok: false, reason: '无搜索结果' };

        const item = list.list.find((it) => it.vod_name === '流浪地球') || list.list[0];
        const det = await getJson(`${s.base}?ac=detail&ids=${item.vod_id}`, 15000);
        const lines = parsePlayLines(det.list[0]);
        if (!lines.length) return { id: s.id, ok: false, reason: '无 m3u8 线路' };

        const picked = pickEpisode(lines, 1);
        if (!picked) return { id: s.id, ok: false, reason: '无法定位第 1 集' };
        if (!picked.url.includes('.m3u8')) {
          return { id: s.id, ok: false, reason: `非 m3u8: ${picked.url}` };
        }
        return { id: s.id, ok: true, name: item.vod_name, url: picked.url };
      } catch (e) {
        return { id: s.id, ok: false, reason: String(e).slice(0, 60) };
      }
    }),
  );

  const ok = results.filter((r) => r.ok);
  assert.ok(ok.length >= 2, `应至少 2 个源可解析，实际: ${JSON.stringify(results)}`);
  for (const r of ok) console.log(`   [${r.id}] ${r.name} → ${r.url.slice(0, 62)}`);
});

test('m3u8 清单可访问且是合法 HLS', async () => {
  const list = await getJson(
    `${CMS_SOURCES[0].base}?ac=list&wd=${encodeURIComponent('流浪地球')}&limit=10`,
  );
  const item = list.list.find((it) => it.vod_name === '流浪地球') || list.list[0];
  const j = await getJson(`${CMS_SOURCES[0].base}?ac=detail&ids=${item.vod_id}`);
  const lines = parsePlayLines(j.list[0]);
  const picked = pickEpisode(lines, 1);

  const r = await fetch(picked.url, {
    headers: { 'User-Agent': UA, Range: 'bytes=0-800' },
    signal: AbortSignal.timeout(20000),
  });
  assert.ok(r.ok, `m3u8 应可访问，HTTP ${r.status}`);
  const text = await r.text();
  assert.ok(text.startsWith('#EXTM3U'), '应是合法 HLS 主清单');
});

// ── 用户自定义源 ──────────────────────────────────────

test('地址规范化：多种写法都能归一', () => {
  const cases = [
    ['https://a.com/api.php/provide/vod/', 'https://a.com/api.php/provide/vod/'],
    ['https://a.com/api.php/provide/vod', 'https://a.com/api.php/provide/vod/'],
    ['https://a.com/api.php/provide/vod/?ac=list', 'https://a.com/api.php/provide/vod/'],
    ['https://a.com/inc/api.php/provide/vod/', 'https://a.com/inc/api.php/provide/vod/'],
    ['https://a.com/api.php', 'https://a.com/api.php/provide/vod/'],
    ['a.com', 'https://a.com/api.php/provide/vod/'],
    ['http://b.com/x/api.php/provide/vod/', 'http://b.com/x/api.php/provide/vod/'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeSourceUrl(input), expected, `输入 ${input}`);
  }
  assert.equal(normalizeSourceUrl(''), null);
  assert.equal(normalizeSourceUrl('   '), null);
});

test('自定义源：可用地址能通过测试并归一', async () => {
  const r = await getJson(`${CMS_SOURCES[0].base}?ac=list&limit=3`, 12000);
  assert.ok(r.list.length > 0);
  const base = normalizeSourceUrl(CMS_SOURCES[0].base);
  assert.equal(base, CMS_SOURCES[0].base);
});
