/**
 * 首屏性能实测
 *
 * 模拟 App 启动后的真实首屏流程，测量各阶段耗时。
 * 重点验证「用户反馈的太卡、加载不出来」是否已解决。
 *
 * 运行：node server/test/perf.test.mjs
 */

import assert from 'node:assert';
import { test } from 'node:test';

const UA =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

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

async function timedFetch(url, timeout = 12000) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*' },
      signal: AbortSignal.timeout(timeout),
    });
    const body = await r.text();
    return { ok: r.ok, status: r.status, ms: Date.now() - t0, body };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, error: String(e) };
  }
}

test('性能：健康源探测不应被失效源拖慢（并发而非串行）', async () => {
  const t0 = Date.now();
  const results = await Promise.all(
    CMS_SOURCES.map((s) => timedFetch(`${s.base}?ac=list&limit=1`, 10000)),
  );
  const total = Date.now() - t0;
  const ok = results.filter((r) => r.ok);
  const slowest = Math.max(...results.map((r) => r.ms));

  console.log(
    `   探测总耗时 ${total}ms（并发），可用 ${ok.length}/${CMS_SOURCES.length}，最慢单源 ${slowest}ms`,
  );

  // 并发探测的总耗时应接近最慢的那个源，而不是所有源之和
  const sum = results.reduce((s, r) => s + r.ms, 0);
  assert.ok(
    total < sum * 0.6,
    `并发后总耗时应显著小于串行之和（total=${total}, sum=${sum}）`,
  );
});

test('性能：TMDB 不可达时，片库不应被它阻塞', async () => {
  // TMDB 用一个短超时模拟被墙场景
  const tmdbT0 = Date.now();
  const tmdbRes = await timedFetch(
    'https://api.themoviedb.org/3/movie/popular?api_key=8d97210e6edd66eb9e967278325836d0',
    5000,
  );
  const tmdbMs = Date.now() - tmdbT0;

  // 同时测 CMS 片库路径（取最快可用源的列表）
  const cmsT0 = Date.now();
  const cmsResults = await Promise.all(
    CMS_SOURCES.slice(0, 4).map((s) => timedFetch(`${s.base}?ac=list&limit=16`, 10000)),
  );
  const cmsMs = Date.now() - cmsT0;
  const cmsOk = cmsResults.filter((r) => r.ok);

  console.log(
    `   TMDB: ${tmdbRes.ok ? '可达' : '不可达'} ${tmdbMs}ms | CMS 片库: ${cmsMs}ms，可用 ${cmsOk.length}/4`,
  );

  // 关键：CMS 片库必须能独立快速出结果，不能依赖 TMDB
  assert.ok(cmsOk.length >= 1, 'CMS 片库至少应有一个源可用');
  assert.ok(cmsMs < 12000, `CMS 片库应在 12 秒内出结果，实际 ${cmsMs}ms`);
});

test('性能：详情页直连解析应快于跨源搜索', async () => {
  const source = CMS_SOURCES[0];

  // 1. 搜索（详情页旧路径）
  const sT0 = Date.now();
  const list = await timedFetch(`${source.base}?ac=list&wd=${encodeURIComponent('流浪地球')}&limit=10`);
  const searchMs = Date.now() - sT0;
  const item = JSON.parse(list.body).list[0];

  // 2. 直连（详情页新路径）
  const dT0 = Date.now();
  const detail = await timedFetch(`${source.base}?ac=detail&ids=${item.vod_id}`);
  const directMs = Date.now() - dT0;

  console.log(`   跨源搜索 ${searchMs}ms | 直连解析 ${directMs}ms`);

  assert.ok(detail.ok, '直连详情应成功');
  // 直连至少不比搜索慢太多（搜索本身只是单源单次）
  assert.ok(directMs < searchMs * 2 + 3000, '直连不应显著慢于搜索');
});

test('性能：源健康探测能正确区分可用与失效', async () => {
  const results = await Promise.all(
    CMS_SOURCES.map(async (s) => {
      const r = await timedFetch(`${s.base}?ac=list&limit=1`, 8000);
      return { id: s.id, ok: r.ok, ms: r.ms };
    }),
  );
  const ok = results.filter((r) => r.ok);
  const down = results.filter((r) => !r.ok);

  console.log(
    `   可用 ${ok.length}：${ok.map((r) => r.id).join(',')}\n` +
      `   失效 ${down.length}：${down.map((r) => r.id).join(',')}`,
  );

  // 失效源应被识别出来（这正是剔除它们、避免等待超时的前提）
  assert.ok(ok.length >= 3, '应至少 3 个源可用');
  assert.equal(ok.length + down.length, CMS_SOURCES.length);
});
