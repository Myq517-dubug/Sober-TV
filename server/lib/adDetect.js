/**
 * m3u8 插播广告识别 —— 借鉴 AIStream analyzeMedia 的五路判定思路，重新实现
 *
 * 五路信号：
 *   1. CUE      —— #EXT-X-CUE-OUT / CUE-IN，上游显式标注，零误判
 *   2. 断点插播 —— #EXT-X-DISCONTINUITY 起头 + 极短组（ts 级广告，HLS 通用信号）
 *   3. 长异常   —— 整段长广告
 *   4. 短异常   —— 2s 填充广告
 *   5. 跨域     —— 切片域名与主域不符且属可疑 TLD
 *
 * 三个必须遵守的实现约束（否则误判率极高）：
 *   A. 主域取「切片注册域众数」，不是清单域名 —— 有些源清单在 A 域而切片全在 B 域
 *   B. 正片基准取「最长组」，不是中位数 —— 广告组会把中位数拉低导致漏判
 *   C. 短时判定需时长极差 > 1.8 倍才启用 —— 否则同质 2s 源被大面积误杀
 */

/** 可疑顶级域（广告联盟常用） */
const SUSPECT_TLDS = new Set([
  'com',
  'net',
  'org',
  'info',
  'biz',
  'xyz',
  'top',
  'click',
  'link',
  'ads',
  'pw',
  'cc',
  'ws',
  'live',
  'vip',
]);

/** 取注册域（近似 eTLD+1） */
export function regDomain(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h || /^\d+\.\d+\.\d+\.\d+$/.test(h)) return h;
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  // 处理常见二级后缀
  const secondLevel = new Set(['com', 'net', 'org', 'co', 'gov', 'edu', 'ac']);
  if (secondLevel.has(parts[parts.length - 2]) && parts.length >= 3) {
    return parts.slice(parts.length - 3).join('.');
  }
  return parts.slice(-2).join('.');
}

/** 解析 m3u8 文本为片段列表 */
function parseSegments(lines, base) {
  const segs = [];
  let currentDur = 0;
  let currentUrl = null;
  let disc = false;
  let discLine = -1;
  let inCue = false;
  const cueAd = new Set();

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const ln = raw.trim();

    if (ln.startsWith('#EXT-X-DISCONTINUITY')) {
      disc = true;
      discLine = i;
    } else if (/^#EXT-X-CUE-OUT/i.test(ln)) {
      inCue = true;
    } else if (/^#EXT-X-CUE-IN/i.test(ln)) {
      inCue = false;
    } else if (ln.startsWith('#EXTINF:')) {
      const m = /#EXTINF:([\d.]+)/i.exec(ln);
      currentDur = m ? parseFloat(m[1]) || 0 : 0;
    } else if (ln && !ln.startsWith('#')) {
      let abs = ln;
      try {
        abs = new URL(ln, base).toString();
      } catch {
        /* 保留原值 */
      }
      if (inCue) cueAd.add(i);
      segs.push({
        li: i,
        url: abs,
        dur: currentDur,
        disc,
        discLine,
        isCueAd: cueAd.has(i),
      });
      currentDur = 0;
      currentUrl = null;
      disc = false;
      discLine = -1;
    }
  }
  return segs;
}

/**
 * 分析 m3u8 清单，识别插播广告
 * @param {string} text m3u8 清单文本
 * @param {string} base 清单自身的 URL（用于解析相对路径）
 * @param {object} opts { blacklist: string[] }
 */
export function analyzeMedia(text, base, opts = {}) {
  const blacklist = (opts.blacklist || [])
    .map((x) => String(x).trim().toLowerCase())
    .filter(Boolean);

  const lines = String(text || '').split('\n').map((l) => l.replace(/\r$/, ''));
  const segs = parseSegments(lines, base);

  const reasons = { crossDomain: 0, durLong: 0, durShort: 0, cue: 0, blacklist: 0, discAd: 0 };

  // 片段太少不足以判断
  if (segs.length < 8) {
    return {
      unchanged: true,
      verdict: 'unknown',
      total: segs.length,
      blocked: 0,
      adSegments: [],
      adBlocks: [],
      reasons,
      discMarkers: 0,
    };
  }

  // ── A. 主域取切片注册域众数 ──────────────────────
  const rdCount = new Map();
  for (const s of segs) {
    let host = '';
    try {
      host = new URL(s.url).host;
    } catch {
      continue;
    }
    const rd = regDomain(host);
    if (!rd) continue;
    rdCount.set(rd, (rdCount.get(rd) || 0) + 1);
  }
  let mainRD = '';
  try {
    mainRD = regDomain(new URL(base).host);
  } catch {
    /* ignore */
  }
  let topN = 0;
  for (const [rd, n] of rdCount) {
    if (n > topN) {
      topN = n;
      mainRD = rd;
    }
  }
  // 众数不够显著（多 CDN 分散）→ 回落到清单域名
  if (topN < segs.length * 0.3) {
    try {
      mainRD = regDomain(new URL(base).host);
    } catch {
      /* ignore */
    }
  }

  // ── 时长统计 ────────────────────────────────────
  const durs = segs.map((s) => s.dur).filter((d) => d > 0).sort((a, b) => a - b);
  const med = durs.length ? durs[Math.floor(durs.length / 2)] : 0;
  const minDur = durs.length ? durs[0] : 0;
  const maxDur = durs.length ? durs[durs.length - 1] : 0;

  // ── C. 时长极差足够大才启用短时判定 ───────────────
  const variety = med > 0 && maxDur > minDur * 1.8;

  // ── 累计起始秒（须在构造 adBlocks 之前完成）─────────
  let acc = 0;
  for (const s of segs) {
    s.startSec = acc;
    acc += s.dur;
  }

  // ── 分组（按 DISCONTINUITY 边界）─────────────────
  // 注意：断点只在广告「之前」出现是常态，广告组常常与后续正片连成一组。
  // 因此不能整组判定，必须取组内「以断点开头的广告前缀段」。
  const groups = [];
  let g = [];
  for (const s of segs) {
    if (s.disc && g.length) {
      groups.push(g);
      g = [];
    }
    g.push(s);
  }
  if (g.length) groups.push(g);

  // ── B. 正片基准取最长组 ──────────────────────────
  const groupDurs = groups.map((gp) => gp.reduce((a, b) => a + b.dur, 0));
  const maxGroupDur = groupDurs.length ? Math.max(...groupDurs) : 0;

  const adLine = new Set();
  const adBlocks = [];
  let blocked = 0;

  for (const grp of groups) {
    // ── 断点插播：取组内以断点开头的「广告前缀段」─────
    // 前缀段的边界 = 遇到第一个「像正片」的片段即停止
    // （时长接近正片中位 且 域名同主域 → 认为是正片恢复）
    let adRun = null;
    if (grp.length > 0 && grp[0].disc) {
      adRun = [];
      for (const s of grp) {
        const srd = (() => {
          try {
            return regDomain(new URL(s.url).host);
          } catch {
            return '';
          }
        })();
        const sameDomain = srd && srd === mainRD;
        const longLikeMain = med > 0 && s.dur >= med * 0.6;
        // 出现「同主域 + 时长接近正片」的片段 → 广告前缀段结束
        if (adRun.length > 0 && sameDomain && longLikeMain) break;
        adRun.push(s);
        // 安全上限：广告段不会太长
        if (adRun.length > 60) break;
      }
    }

    const run = adRun && adRun.length ? adRun : grp;
    const runDur = run.reduce((a, b) => a + b.dur, 0);

    const rds = [...new Set(run.map((s) => {
      try {
        return regDomain(new URL(s.url).host);
      } catch {
        return '';
      }
    }).filter(Boolean))];

    const suspectCross = rds.some(
      (rd) => rd && rd !== mainRD && SUSPECT_TLDS.has(rd.split('.').pop()),
    );
    const gt = runDur;
    const gavg = run.length ? gt / run.length : 0;

    // 长异常：整段长广告
    const durLong = med > 0 && gavg > med * 3 && gt >= 8 && gt <= 180 && run.length < 10;
    // 短异常：2s 填充广告（需 variety 前提）
    const durShort = variety && gavg < med * 0.6 && run.length >= 2 && run.length <= 14;
    // 断点插播：ts 级广告，最通用的信号
    // 判定 = 以断点起头 + 时长远小于正片 + 绝对时长小 + 片数少
    const discAd =
      adRun !== null &&
      adRun.length > 0 &&
      gt > 0 &&
      gt < maxGroupDur * 0.15 &&
      gt < 90 &&
      adRun.length <= 30;
    // CUE：上游显式标记
    const hasCue = run.some((s) => s.isCueAd);
    // 黑名单域名
    const blHit = run.some((s) => {
      try {
        const h = new URL(s.url).host.toLowerCase();
        return blacklist.some(
          (b) => h === b || h.endsWith('.' + b) || regDomain(h) === b,
        );
      } catch {
        return false;
      }
    });

    const isAd = discAd || durLong || durShort || hasCue || blHit;
    if (!isAd) continue;

    if (hasCue) reasons.cue++;
    if (discAd) reasons.discAd++;
    if (durLong) reasons.durLong++;
    if (durShort) reasons.durShort++;
    if (suspectCross) reasons.crossDomain++;
    if (blHit) reasons.blacklist++;

    const startSec = run[0]?.startSec ?? 0;
    adBlocks.push({
      startSec: Math.round(startSec),
      durationSec: Math.round(gt),
      segments: run.length,
      signals: [
        hasCue && 'cue',
        discAd && 'discontinuity',
        durLong && 'long',
        durShort && 'short',
        blHit && 'blacklist',
      ].filter(Boolean),
    });

    for (const s of run) {
      if (!adLine.has(s.li)) {
        adLine.add(s.li);
        blocked++;
      }
      if (s.discLine >= 0) adLine.add(s.discLine);
    }
  }

  const verdict = blocked > 0 ? 'ad' : 'clean';
  const discMarkers = lines.filter((l) => l.trim().startsWith('#EXT-X-DISCONTINUITY')).length;

  return {
    unchanged: false,
    verdict,
    total: segs.length,
    blocked,
    adSegments: [...adLine].sort((a, b) => a - b),
    adBlocks,
    reasons,
    discMarkers,
    mainDomain: mainRD,
    mainDomainShare: segs.length ? Math.round((topN / segs.length) * 100) : 0,
  };
}

/**
 * 从 m3u8 文本中删除广告片段，返回改写后的清单
 */
export function stripAds(text, base, opts = {}) {
  const analysis = analyzeMedia(text, base, opts);
  if (analysis.unchanged || analysis.verdict !== 'ad' || !analysis.adSegments.length) {
    return { text, blocked: 0, analysis };
  }

  const lines = String(text).split('\n').map((l) => l.replace(/\r$/, ''));
  const drop = new Set(analysis.adSegments);

  // 需要连带删除对应行的 URI（EXTINF 后的 URL 行）以及被标记的 DISCONTINUITY 行
  const dropLines = new Set();
  for (const li of analysis.adSegments) {
    dropLines.add(li);
    // 往前找 EXTINF
    for (let i = li - 1; i >= 0; i--) {
      if (lines[i].trim().startsWith('#EXTINF:')) {
        dropLines.add(i);
        break;
      }
    }
  }
  // 删除被标记的 DISCONTINUITY 行（需重新索引）
  const discDrop = new Set();
  for (const li of analysis.adSegments) {
    for (let i = li - 1; i >= 0; i--) {
      if (lines[i].trim().startsWith('#EXT-X-DISCONTINUITY')) {
        discDrop.add(i);
        break;
      }
    }
  }
  for (const i of discDrop) dropLines.add(i);

  const out = lines.filter((_, i) => !dropLines.has(i));
  return { text: out.join('\n'), blocked: analysis.blocked, analysis };
}
