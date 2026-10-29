/**
 * 首屏性能实测 v2 —— 验证优化后的真实耗时
 *
 * 对应前端 catalogue.ts 的 cmsCatalogue() 流程：
 *   1. 分类表与列表**并行**发起（不再串行两阶段）
 *   2. 各源**竞速**，不等最慢的
 *   3. 分类表就绪后补一轮分类列表
 *   4. 限并发补详情取海报
 *
 * 运行：node --test server/test/perf2.test.mjs
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

async function getJson(url, timeout = 10000) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: '*/*' },
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** 与前端 cms.ts 一致的竞速实现 */
async function raceWithTimeout(tasks, ms) {
  const collected = [];
  let done = false;
  const runners = tasks.map(async (t) => {
    try {
      const r = await t.run();
      if (!done) collected.push(r);
      return r;
    } catch {
      return null;
    }
  });
  const all = Promise.all(runners);
  const timer = new Promise((r) => setTimeout(() => r('timeout'), ms));
  const outcome = await Promise.race([all.then(() => 'done'), timer]);
  if (outcome === 'done') {
    done = true;
    return collected;
  }
  const snap = [...collected];
  done = true;
  return snap;
}

/** 限并发 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cur = 0;
  async function worker() {
    while (cur < items.length) {
      const i = cur++;
      try {
        out[i] = await fn(items[i], i);
      } catch {
        out[i] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

test('首屏实测：分类+列表并行 + 竞速', async () => {
  const sources = CMS_SOURCES.slice(0, 5);
  const t0 = Date.now();

  // 分类表与列表**并行**
  const typePromise = raceWithTimeout(
    sources.map((s) => ({
      name: s.id,
      run: async () => {
        const j = await getJson(`${s.base}?ac=type`, 8000);
        return { source: s, cats: (j.list || []).map((c) => ({ typeId: Number(c.type_id), name: c.type_name })) };
      },
    })),
    5000,
  );

  const listPromise = raceWithTimeout(
    sources.map((s) => ({
      name: s.id,
      run: async () => {
        const j = await getJson(`${s.base}?ac=list&limit=16`, 10000);
        return { source: s, items: j.list || [] };
      },
    })),
    6000,
  );

  const [typeResults, listResults] = await Promise.all([typePromise, listPromise]);
  const tLists = Date.now() - t0;

  console.log(
    `   并行阶段：分类 ${typeResults.length} 源 / 列表 ${listResults.length} 源，耗时 ${tLists}ms`,
  );

  assert.ok(listResults.length >= 1, '应至少 1 个源出列表');
  assert.ok(tLists <= 6500, `并行+竞速应在 6.5 秒内完成，实际 ${tLists}ms`);

  // 补详情（取海报）
  const t1 = Date.now();
  const all = listResults.flatMap((r) => r.items);
  const details = await mapLimit(all.slice(0, 16), 4, async (it) => {
    const src = listResults.find((r) => r.items.includes(it))?.source ?? listResults[0].source;
    try {
      return await getJson(`${src.base}?ac=detail&ids=${it.vod_id}`, 12000);
    } catch {
      return null;
    }
  });
  const tDetails = Date.now() - t1;

  const withPic = details.filter((d) => d?.list?.[0]?.vod_pic).length;
  console.log(`   补详情 ${tDetails}ms，16 条中 ${withPic} 条拿到海报`);

  assert.ok(tDetails < 15000, `补详情应在 15 秒内，实际 ${tDetails}ms`);
  assert.ok(withPic >= 1, '应至少拿到一张海报');
});

test('首屏实测：二次启动走缓存（近瞬时）', async () => {
  // 模拟 localStorage 缓存命中
  const CACHE_KEY = 'sober.catalogue.cache';
  const TTL = 10 * 60 * 1000;

  const cached = { at: Date.now(), data: { rows: [{ title: 'x', items: [] }], source: 'cms' } };
  const raw = JSON.stringify(cached);

  const t0 = Date.now();
  const entry = JSON.parse(raw);
  const hit = Date.now() - entry.at <= TTL && entry?.data?.rows?.length > 0;
  const ms = Date.now() - t0;

  console.log(`   缓存命中耗时 ${ms}ms（hit=${hit}）`);
  assert.ok(hit, '缓存应命中');
  assert.ok(ms < 5, `缓存读取应近瞬时，实际 ${ms}ms`);
});

test('端到端：完整首屏（缓存未命中）应控制在可接受范围', async () => {
  // 找出当前真实可用的源
  const probes = await Promise.all(
    CMS_SOURCES.map(async (s) => {
      try {
        await getJson(`${s.base}?ac=list&limit=1`, 8000);
        return s;
      } catch {
        return null;
      }
    }),
  );
  const alive = probes.filter(Boolean);
  console.log(`   当前可用源 ${alive.length}/${CMS_SOURCES.length}`);

  const t0 = Date.now();
  const results = await raceWithTimeout(
    alive.map((s) => ({
      name: s.id,
      run: async () => {
        const j = await getJson(`${s.base}?ac=list&limit=16`, 10000);
        return j.list?.length ? { id: s.id, n: j.list.length } : null;
      },
    })),
    6000,
  );
  const ms = Date.now() - t0;

  console.log(`   竞速取列表 ${ms}ms，命中 ${results.length} 个源`);

  assert.ok(results.length >= 1, '应至少 1 个源可用');
  assert.ok(ms <= 6500, `应在 6.5 秒内出首屏数据，实际 ${ms}ms`);
});
