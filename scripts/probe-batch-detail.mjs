/**
 * 实测各采集源的「批量详情」支持情况与耗时
 *
 * 用途：验证首页海报补齐方案（?ac=detail&ids=a,b,c）
 *
 * 用法：node scripts/probe-batch-detail.mjs
 */
const SOURCES = [
  ['非凡资源', 'https://cj.ffzyapi.com/api.php/provide/vod/'],
  ['暴风资源', 'https://bfzyapi.com/api.php/provide/vod/'],
  ['电影天堂', 'https://caiji.dyttzyapi.com/api.php/provide/vod/'],
  ['豪华资源', 'https://hhzyapi.com/api.php/provide/vod/'],
  ['索尼资源', 'https://suoniapi.com/api.php/provide/vod/'],
  ['魔都资源', 'https://caiji.moduapi.cc/api.php/provide/vod/'],
  ['百度资源', 'https://api.apibdzy.com/api.php/provide/vod/'],
  ['360资源', 'https://360zy.com/api.php/provide/vod/'],
  ['卧龙资源', 'https://collect.wolongzyw.com/api.php/provide/vod/'],
];

const fetchJson = async (url, timeoutMs = 15000) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
};

console.log('源名\t\t列表ms\t批量ms\t批量条数\t有海报\t单条ms');
console.log('─'.repeat(64));

let totalPics = 0;
let totalItems = 0;

for (const [name, base] of SOURCES) {
  let listMs = '-';
  let ids = [];
  try {
    const t0 = Date.now();
    const j = await fetchJson(`${base}?ac=list&pg=1&limit=20`, 12000);
    listMs = Date.now() - t0;
    ids = (j.list || []).map((x) => x.vod_id);
  } catch (e) {
    console.log(`${name}\t列表失败: ${e.message}`);
    continue;
  }

  // 批量详情
  let batchMs = '-';
  let batchCount = 0;
  let pics = 0;
  try {
    const t0 = Date.now();
    const j = await fetchJson(`${base}?ac=detail&ids=${ids.join(',')}`, 15000);
    batchMs = Date.now() - t0;
    const list = j.list || [];
    batchCount = list.length;
    pics = list.filter((x) => x.vod_pic).length;
  } catch (e) {
    batchMs = '失败';
  }

  // 单条详情（对比耗时）
  let singleMs = '-';
  try {
    const t0 = Date.now();
    await fetchJson(`${base}?ac=detail&ids=${ids[0]}`, 15000);
    singleMs = Date.now() - t0;
  } catch {
    singleMs = '失败';
  }

  totalPics += pics;
  totalItems += batchCount;
  const batchOk = batchCount === ids.length;
  console.log(
    `${name}\t${listMs}\t${batchMs}\t${batchCount}/${ids.length}\t${pics}\t${singleMs}` +
      (batchOk ? '' : '  ⚠ 批量未全覆盖'),
  );
}

console.log('─'.repeat(64));
console.log(`批量总计: ${totalPics}/${totalItems} 条有海报`);
