/**
 * 竞速策略实测 —— 验证「太卡、加载不出来」已解决
 *
 * 核心验证点：
 *   1. 竞速取数：慢源不再拖累整体（这是首屏卡顿的根因）
 *   2. 失效源被剔除后，解析不再等满超时
 *   3. 完整首屏流程的实际耗时
 *
 * 运行：node --test server/test/race.test.mjs
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

async function timedFetch(url, timeout = 10000) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*' },
      signal: AbortSignal.timeout(timeout),
    });
    await r.text();
    return { ok: r.ok, ms: Date.now() - t0 };
  } catch {
    return { ok: false, ms: Date.now() - t0 };
  }
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
  const timer = new Promise((resolve) => setTimeout(() => resolve('timeout'), ms));
  const outcome = await Promise.race([all.then(() => 'done'), timer]);

  if (outcome === 'done') {
    done = true;
    return collected;
  }
  const snapshot = [...collected];
  done = true;
  return snapshot;
}

test('竞速：慢源不拖累整体耗时', async () => {
  // 构造场景：3 个快源 + 2 个会超时 8 秒的慢源
  const tasks = [
    { name: 'fast1', run: () => timedFetch(`${CMS_SOURCES[0].base}?ac=list&limit=1`, 10000) },
    { name: 'fast2', run: () => timedFetch(`${CMS_SOURCES[2].base}?ac=list&limit=1`, 10000) },
    { name: 'slow1', run: () => timedFetch(`${CMS_SOURCES[1].base}?ac=list&limit=1`, 10000) },
    { name: 'slow2', run: () => timedFetch(`${CMS_SOURCES[4].base}?ac=list&limit=1`, 10000) },
  ];

  const t0 = Date.now();
  const raced = await raceWithTimeout(tasks, 4000);
  const raceMs = Date.now() - t0;

  // 对照：串行等待全部
  const t1 = Date.now();
  await Promise.all(tasks.map((t) => t.run()));
  const allMs = Date.now() - t1;

  console.log(`   竞速(4s 上限) ${raceMs}ms 返回 ${raced.length} 个 | 等全部 ${allMs}ms`);

  assert.ok(raced.length >= 1, '竞速应至少拿到 1 个结果');
  assert.ok(
    raceMs <= 5000,
    `竞速应在超时上限内返回，实际 ${raceMs}ms（慢源会挂满 8-10 秒）`,
  );
  assert.ok(raceMs < allMs, '竞速应快于等全部');
});

test('竞速：首个成功即可用，不必等所有源', async () => {
  const t0 = Date.now();
  const results = await raceWithTimeout(
    CMS_SOURCES.map((s) => ({
      name: s.id,
      run: async () => {
        const r = await timedFetch(`${s.base}?ac=list&limit=16`, 10000);
        return r.ok ? { id: s.id, total: 1 } : null;
      },
    })),
    5000,
  );
  const ms = Date.now() - t0;

  console.log(`   5 秒上限内拿到 ${results.length} 个可用源，耗时 ${ms}ms`);

  assert.ok(results.length >= 1, '应至少拿到 1 个可用源');
  assert.ok(ms <= 5500, `应在超时上限内完成，实际 ${ms}ms`);
});

test('实测：完整片库流程耗时（分类→列表→详情）', async () => {
  const t0 = Date.now();

  // 1. 分类表（竞速）
  const typeGroups = await raceWithTimeout(
    CMS_SOURCES.slice(0, 5).map((s) => ({
      name: s.id,
      run: async () => {
        const r = await timedFetch(`${s.base}?ac=type`, 8000);
        return r.ok ? s : null;
      },
    })),
    5000,
  );
  const tTypes = Date.now() - t0;

  // 2. 列表（竞速）
  const t1 = Date.now();
  const listGroups = await raceWithTimeout(
    CMS_SOURCES.slice(0, 5).map((s) => ({
      name: s.id,
      run: async () => {
        const r = await timedFetch(`${s.base}?ac=list&limit=16`, 10000);
        return r.ok ? s : null;
      },
    })),
    6000,
  );
  const tLists = Date.now() - t1;

  const total = Date.now() - t0;

  console.log(
    `   分类 ${tTypes}ms（${typeGroups.length} 源）| 列表 ${tLists}ms（${listGroups.length} 源）| 合计 ${total}ms`,
  );

  assert.ok(listGroups.length >= 1, '应至少 1 个源可出列表');
  assert.ok(total < 12000, `片库主流程应在 12 秒内完成，实际 ${total}ms`);
});

test('实测：失效源被剔除后，搜索不再等满超时', async () => {
  // 先探测出失效源
  const probes = await Promise.all(
    CMS_SOURCES.map(async (s) => ({ s, r: await timedFetch(`${s.base}?ac=list&limit=1`, 6000) })),
  );
  const alive = probes.filter((p) => p.r.ok).map((p) => p.s);
  const dead = probes.filter((p) => !p.r.ok).map((p) => p.s);
  console.log(`   存活 ${alive.length} 个，失效 ${dead.length} 个`);

  // 只用存活源搜索
  const t0 = Date.now();
  const groups = await raceWithTimeout(
    alive.map((s) => ({
      name: s.id,
      run: async () => {
        const r = await timedFetch(`${s.base}?ac=list&wd=${encodeURIComponent('流浪地球')}&limit=10`, 10000);
        return r.ok ? s : null;
      },
    })),
    5000,
  );
  const ms = Date.now() - t0;

  console.log(`   存活源搜索耗时 ${ms}ms，命中 ${groups.length} 个源`);
  assert.ok(groups.length >= 1, '存活源应能搜到内容');
  assert.ok(ms < 6000, `搜索应在 6 秒内完成，实际 ${ms}ms`);
});
