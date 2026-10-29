/**
 * 广告识别与线路体检的单元自测
 * 运行：node server/test/algorithms.test.mjs
 */

import assert from 'node:assert';
import { analyzeMedia, stripAds, regDomain } from '../lib/adDetect.js';
import { probeLine, HEALTH } from '../lib/health.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}

console.log('\n── 注册域提取 ──');

test('标准二级域名', () => {
  assert.strictEqual(regDomain('www.example.com'), 'example.com');
});

test('含二级后缀', () => {
  assert.strictEqual(regDomain('a.b.example.com.cn'), 'example.com.cn');
});

test('IP 不处理', () => {
  assert.strictEqual(regDomain('192.168.1.1'), '192.168.1.1');
});

console.log('\n── 广告识别 ──');

/** 构造一个含插播广告的 m3u8 */
function buildManifest({ mainDomain, adDomain, segDur = 6, mainCount = 60, adCount = 3, adDur = 2 }) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:10', '#EXT-X-MEDIA-SEQUENCE:0'];
  for (let i = 0; i < mainCount; i++) {
    lines.push(`#EXTINF:${segDur.toFixed(3)},`);
    lines.push(`https://${mainDomain}/seg${i}.ts`);
  }
  // 广告块：断点起头 + 极短
  lines.push('#EXT-X-DISCONTINUITY');
  for (let i = 0; i < adCount; i++) {
    lines.push(`#EXTINF:${adDur.toFixed(3)},`);
    lines.push(`https://${adDomain}/ad${i}.ts`);
  }
  for (let i = 0; i < mainCount; i++) {
    lines.push(`#EXTINF:${segDur.toFixed(3)},`);
    lines.push(`https://${mainDomain}/seg2_${i}.ts`);
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n');
}

test('断点插播被识别', () => {
  const text = buildManifest({
    mainDomain: 'cdn.example.com',
    adDomain: 'ads.other.net',
  });
  const r = analyzeMedia(text, 'https://cdn.example.com/list.m3u8');
  assert.strictEqual(r.verdict, 'ad', `应判定为 ad，实际 ${r.verdict}`);
  assert.ok(r.reasons.discAd > 0, '应命中断点插播规则');
  assert.ok(r.blocked > 0, '应拦截到片段');
});

test('纯正片不被误杀', () => {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  for (let i = 0; i < 60; i++) {
    lines.push('#EXTINF:6.000,');
    lines.push(`https://cdn.example.com/seg${i}.ts`);
  }
  lines.push('#EXT-X-ENDLIST');
  const r = analyzeMedia(lines.join('\n'), 'https://cdn.example.com/list.m3u8');
  assert.strictEqual(r.verdict, 'clean', `不应误判，实际 ${r.verdict}`);
  assert.strictEqual(r.blocked, 0);
});

test('同质 2s 源不被短时规则误杀', () => {
  // 全部片段都是 2s —— 时长极差为 0，短时判定不启用
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  for (let i = 0; i < 40; i++) {
    lines.push('#EXTINF:2.000,');
    lines.push(`https://cdn.example.com/seg${i}.ts`);
  }
  lines.push('#EXT-X-ENDLIST');
  const r = analyzeMedia(lines.join('\n'), 'https://cdn.example.com/list.m3u8');
  assert.strictEqual(r.reasons.durShort, 0, '短时规则不应触发');
  assert.strictEqual(r.verdict, 'clean');
});

test('CUE-OUT 标记被识别', () => {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  for (let i = 0; i < 30; i++) {
    lines.push('#EXTINF:6.000,');
    lines.push(`https://cdn.example.com/seg${i}.ts`);
  }
  lines.push('#EXT-X-CUE-OUT:DURATION=30');
  lines.push('#EXTINF:6.000,');
  lines.push('https://cdn.example.com/ad.ts');
  lines.push('#EXT-X-CUE-IN');
  for (let i = 30; i < 60; i++) {
    lines.push('#EXTINF:6.000,');
    lines.push(`https://cdn.example.com/seg${i}.ts`);
  }
  lines.push('#EXT-X-ENDLIST');
  const r = analyzeMedia(lines.join('\n'), 'https://cdn.example.com/list.m3u8');
  assert.ok(r.reasons.cue > 0, '应命中 CUE 规则');
  assert.strictEqual(r.verdict, 'ad');
});

test('主域取切片域众数而非清单域', () => {
  // 清单在 list.example.org，切片全在 cdn.example.com
  const lines = ['#EXTM3U'];
  for (let i = 0; i < 40; i++) {
    lines.push('#EXTINF:6.000,');
    lines.push(`https://cdn.example.com/seg${i}.ts`);
  }
  lines.push('#EXT-X-ENDLIST');
  const r = analyzeMedia(lines.join('\n'), 'https://list.example.org/list.m3u8');
  assert.strictEqual(r.mainDomain, 'example.com', `主域应为 example.com，实际 ${r.mainDomain}`);
  assert.strictEqual(r.verdict, 'clean', '切片与主域一致，不应判跨域');
});

test('片段过少时不做判断', () => {
  const lines = ['#EXTM3U', '#EXTINF:6.000,', 'https://cdn.example.com/a.ts', '#EXT-X-ENDLIST'];
  const r = analyzeMedia(lines.join('\n'), 'https://cdn.example.com/list.m3u8');
  assert.strictEqual(r.verdict, 'unknown');
  assert.strictEqual(r.unchanged, true);
});

test('黑名单域名被拦截', () => {
  const lines = ['#EXTM3U'];
  for (let i = 0; i < 40; i++) {
    lines.push('#EXTINF:6.000,');
    lines.push(`https://cdn.example.com/seg${i}.ts`);
  }
  lines.push('#EXTINF:2.000,');
  lines.push('https://bad-advert.net/x.ts');
  lines.push('#EXT-X-ENDLIST');
  const r = analyzeMedia(lines.join('\n'), 'https://cdn.example.com/list.m3u8', {
    blacklist: ['bad-advert.net'],
  });
  assert.ok(r.reasons.blacklist > 0, '应命中黑名单');
});

test('stripAds 后广告片段被移除', () => {
  const text = buildManifest({
    mainDomain: 'cdn.example.com',
    adDomain: 'ads.other.net',
  });
  const out = stripAds(text, 'https://cdn.example.com/list.m3u8');
  assert.ok(out.blocked > 0);
  assert.ok(!out.text.includes('ads.other.net'), '广告域名应被移除');
  assert.ok(out.text.includes('cdn.example.com'), '正片应保留');
});

console.log('\n── 线路体检 ──');

test('空 URL 判定为死链', async () => {
  const r = await probeLine('');
  assert.strictEqual(r.status, HEALTH.DEAD);
});

test('m3u8 直链免探测', async () => {
  const r = await probeLine('https://example.com/a.m3u8?token=1');
  assert.strictEqual(r.status, HEALTH.PLAYABLE);
  assert.strictEqual(r.reason, 'direct-ext');
});

test('探测超时返回 unknown 而非 dead', async () => {
  // 指向一个不会响应的地址，强制超时
  const r = await probeLine('http://10.255.255.1:9/never', {}, 800);
  assert.strictEqual(r.status, HEALTH.UNKNOWN, '探测失败不应判死，避免误杀好源');
});

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed > 0 ? 1 : 0);
