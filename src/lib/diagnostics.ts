/**
 * 网络与播放链路诊断
 *
 * 用途：在真机上跑一遍完整链路，把每一步的**实际结果**列出来。
 * 这是在没有真机调试环境时定位问题的唯一可靠手段。
 *
 * 检查项：
 *   1. 运行环境（是否原生平台 / 播放引擎）
 *   2. TMDB 元数据接口
 *   3. 各采集源列表接口
 *   4. 采集源搜索接口
 *   5. 详情接口 + 播放地址解析
 *   6. m3u8 清单可访问性 + 是否合法 HLS
 *   7. 原生播放器状态
 *
 * 每项都记录：耗时 / HTTP 状态 / 结果摘要 / 错误信息
 */

import { CMS_SOURCES, cmsDetail, cmsList, parsePlayLines, pickEpisode } from './cms';
import { allSources } from './customSources';
import { isNativePlatformOnly, NativePlayer } from '../player/nativePlayer';
import { getTmdbKey, tmdb } from './tmdb';
import { resetTmdbCircuit } from './catalogue';

export type DiagStatus = 'pass' | 'fail' | 'skip' | 'running';

export interface DiagItem {
  key: string;
  /** 分组标题 */
  group: string;
  label: string;
  status: DiagStatus;
  /** 耗时（毫秒） */
  ms?: number;
  /** 详情摘要 */
  detail?: string;
  /** 错误信息 */
  error?: string;
  /** 附带的可点击 URL（用于手动验证） */
  url?: string;
}

/** 计时执行一段逻辑 */
async function timed<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T; ms: number } | { ok: false; error: string; ms: number }> {
  const t0 = Date.now();
  try {
    const value = await fn();
    return { ok: true, value, ms: Date.now() - t0 };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      ms: Date.now() - t0,
    };
  }
}

/**
 * 识别「网络封锁 / DNS 污染」特征
 *
 * 实测样例：
 *   failed to connect to api.themoviedb.org/2a03:2880:f111:83:face:b00c:0:25de
 *   (port 443) from /2408:8440:... (port 43250) after 3500ms
 * 其中 2a03:2880 是 Facebook 的 IPv6 段 —— 典型的 DNS 污染。
 */
export function detectBlock(error?: string): string | null {
  if (!error) return null;
  const e = error.toLowerCase();
  if (e.includes('failed to connect') || e.includes('connectexception')) {
    return '网络不可达';
  }
  if (e.includes('timeout') || e.includes('timed out')) {
    return '连接超时';
  }
  if (e.includes('ssl') || e.includes('certificate') || e.includes('handshake')) {
    return 'TLS/证书错误';
  }
  if (e.includes('unknownhost') || e.includes('name or service not known')) {
    return 'DNS 解析失败';
  }
  return null;
}

/**
 * 跑完整诊断，逐项回调
 */
export async function runDiagnostics(
  onItem: (item: DiagItem) => void,
): Promise<DiagItem[]> {
  const items: DiagItem[] = [];

  const push = (item: DiagItem) => {
    items.push(item);
    onItem(item);
  };

  // ── 1. 运行环境 ──
  const isNative = isNativePlatformOnly();
  push({
    key: 'env.platform',
    group: '运行环境',
    label: '运行平台',
    status: 'pass',
    detail: isNative ? '原生（Capacitor Android）' : '浏览器预览',
  });

  if (isNative) {
    const r = await timed(() => NativePlayer.diagnose());
    if (r.ok) {
      const d = r.value;
      push({
        key: 'env.player',
        group: '运行环境',
        label: '原生播放器',
        status: 'pass',
        ms: r.ms,
        detail: [
          d.version ? `v${d.version}` : '',
          `dialog=${d.hasDialog ? '有' : '无'}`,
          `showing=${d.dialogShowing ? '是' : '否'}`,
          `player=${d.hasPlayer ? '有' : '无'}`,
          d.width ? `画面=${d.width}x${d.height}` : '',
          d.surfaceType ? `承载=${d.surfaceType}` : '',
          d.surfaceOnTop !== undefined ? `提层=${d.surfaceOnTop ? '是' : '否'}` : '',
          d.surfaceReady !== undefined ? `surface=${d.surfaceReady ? '就绪' : '未就绪'}` : '',
          `轨道 ${d.videoTrackCount ?? 0}V/${d.audioTrackCount ?? 0}A`,
          d.videoMime || '',
          d.firstFrameRendered !== undefined
            ? `首帧=${d.firstFrameRendered ? '已出画' : '未出画'}`
            : '',
        ]
          .filter(Boolean)
          .join(' · '),
      });
    } else {
      push({
        key: 'env.player',
        group: '运行环境',
        label: '原生播放器',
        status: 'fail',
        ms: r.ms,
        error: r.error,
        detail: '原生插件未响应 → 会回退 hls.js（WebView 内受 CORS 限制，可能黑屏）',
      });
    }
  } else {
    push({
      key: 'env.player',
      group: '运行环境',
      label: '原生播放器',
      status: 'skip',
      detail: '浏览器预览环境无原生插件',
    });
  }

  // ── 2. TMDB ──
  const key = getTmdbKey();
  push({
    key: 'tmdb.key',
    group: 'TMDB 元数据',
    label: 'API Key',
    status: key ? 'pass' : 'fail',
    detail: key ? `${key.slice(0, 8)}…（内置或用户自填）` : '未配置',
  });

  const tmdbRes = await timed(() => tmdb('/movie/popular'));
  const blocked = tmdbRes.ok ? null : detectBlock(tmdbRes.error);
  push({
    key: 'tmdb.list',
    group: 'TMDB 元数据',
    label: '热门列表接口',
    status: tmdbRes.ok ? 'pass' : 'fail',
    ms: tmdbRes.ms,
    detail: tmdbRes.ok
      ? `${tmdbRes.value?.results?.length ?? 0} 条（共 ${tmdbRes.value?.total_results ?? '?'}）`
      : blocked
        ? '疑似网络封锁 / DNS 污染 —— 已自动熔断，改用 CMS 片库'
        : '不可用 —— 已自动熔断，改用 CMS 片库',
    error: tmdbRes.ok ? undefined : tmdbRes.error,
    url: 'https://api.themoviedb.org/3/movie/popular',
  });

  // ── 3. 各采集源列表 ──
  const sources = allSources();
  for (const s of sources) {
    const r = await timed(() => cmsList(s, { limit: 1, timeoutMs: 8000 }));
    push({
      key: `src.list.${s.id}`,
      group: '采集源列表',
      label: s.name,
      status: r.ok ? 'pass' : 'fail',
      ms: r.ms,
      detail: r.ok ? `资源总量 ${(r.value.total ?? 0).toLocaleString()} 条` : undefined,
      error: r.ok ? undefined : r.error,
      url: `${s.base}?ac=list&limit=1`,
    });
  }

  // ── 4. 搜索 ──
  for (const s of CMS_SOURCES.slice(0, 3)) {
    const r = await timed(() =>
      cmsList(s, { keyword: '流浪地球', limit: 5, timeoutMs: 8000 }),
    );
    push({
      key: `src.search.${s.id}`,
      group: '采集源搜索',
      label: s.name,
      status: r.ok ? (r.value.list.length ? 'pass' : 'fail') : 'fail',
      ms: r.ms,
      detail: r.ok
        ? r.value.list.length
          ? `命中 ${r.value.list.length} 条：${r.value.list[0].vod_name}`
          : '接口通但无匹配'
        : undefined,
      error: r.ok ? (r.value.list.length ? undefined : '无匹配结果') : r.error,
      url: `${s.base}?ac=list&wd=流浪地球`,
    });
  }

  // ── 5. 详情 + 播放地址 ──
  const firstAlive = sources[0];
  const listRes = await timed(() =>
    cmsList(firstAlive, { keyword: '流浪地球', limit: 5, timeoutMs: 8000 }),
  );
  let playUrl: string | undefined;

  if (listRes.ok && listRes.value.list.length) {
    const item = listRes.value.list[0];
    const detRes = await timed(() => cmsDetail(firstAlive, item.vod_id));
    if (detRes.ok && detRes.value) {
      const lines = parsePlayLines(detRes.value);
      const picked = pickEpisode(lines, 1);
      push({
        key: 'detail.info',
        group: '详情与播放地址',
        label: '详情接口',
        status: lines.length ? 'pass' : 'fail',
        ms: detRes.ms,
        detail: `${detRes.value.vod_name} · ${lines.length} 条 m3u8 线路`,
        error: lines.length ? undefined : '未解析到 m3u8 线路',
      });
      if (picked) {
        playUrl = picked.url;
        push({
          key: 'detail.url',
          group: '详情与播放地址',
          label: '第 1 集地址',
          status: 'pass',
          detail: picked.url,
          url: picked.url,
        });
      }
    } else {
      push({
        key: 'detail.info',
        group: '详情与播放地址',
        label: '详情接口',
        status: 'fail',
        ms: detRes.ms,
        error: detRes.ok ? '详情为空' : detRes.error,
      });
    }
  } else {
    push({
      key: 'detail.info',
      group: '详情与播放地址',
      label: '搜索取样',
      status: 'fail',
      ms: listRes.ms,
      error: listRes.ok ? '搜索无结果，无法取样' : listRes.error,
    });
  }

  // ── 6. m3u8 清单 ──
  let m3u8Body = '';
  if (playUrl) {
    const r = await timed(async () => {
      const res = await fetch(playUrl!, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      const text = await res.text();
      return {
        status: res.status,
        valid: text.startsWith('#EXTM3U'),
        head: text.slice(0, 120),
        acao: res.headers.get('access-control-allow-origin'),
        body: text,
      };
    });
    if (r.ok) {
      m3u8Body = r.value.body;
      // 注意：这个 fetch 走的是 WebView 原生 fetch（CapacitorHttp.enabled=false
      // 时不劫持 XHR），因此能成功就说明 CDN 允许跨域 → hls.js 可用。
      push({
        key: 'm3u8.check',
        group: '播放清单',
        label: 'm3u8 可访问',
        status: r.value.valid && r.value.status < 400 ? 'pass' : 'fail',
        ms: r.ms,
        detail:
          `HTTP ${r.value.status} · ${r.value.valid ? '合法 HLS' : '非 HLS 格式'}` +
          ` · CORS ${r.value.acao || '无'}`,
        error: r.value.valid ? undefined : '返回内容不是 #EXTM3U 开头',
        url: playUrl,
      });
    } else {
      push({
        key: 'm3u8.check',
        group: '播放清单',
        label: 'm3u8 可访问',
        status: 'fail',
        ms: r.ms,
        error: r.error,
        url: playUrl,
      });
    }
  } else {
    push({
      key: 'm3u8.check',
      group: '播放清单',
      label: 'm3u8 可访问',
      status: 'skip',
      detail: '未取到播放地址，跳过',
    });
  }

  // ── 7. 分片 CORS（决定 hls.js 能否在 WebView 内播）─────
  //
  // 这是播放可行性的**决定性指标**：
  //   主清单带 CORS 不够 —— hls.js 还要拉分片（.ts）。
  //   分片若不带 ACAO，WebView 内 XHR 会被同源策略拦 → 必须走原生兜底。
  if (playUrl && m3u8Body) {
    const segRes = await timed(async () => {
      // 主清单里第一个非注释行 = 子清单（变体）地址
      const sub = m3u8Body
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('#'));

      if (!sub) {
        // 媒体清单（直接列分片）
        return { kind: 'media' as const, segUrl: playUrl!, acao: null as string | null };
      }

      const subUrl = new URL(sub, playUrl!).href;
      const r1 = await fetch(subUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const t1 = await r1.text();
      const seg = t1
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('#'));
      if (!seg) return { kind: 'none' as const, acao: null };

      const segUrl = new URL(seg, subUrl).href;
      const r2 = await fetch(segUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const buf = await r2.arrayBuffer();
      return {
        kind: 'seg' as const,
        segUrl,
        acao: r2.headers.get('access-control-allow-origin'),
        status: r2.status,
        bytes: buf.byteLength,
        isTs: buf.byteLength > 0 && new Uint8Array(buf)[0] === 0x47,
      };
    });

    if (!segRes.ok) {
      push({
        key: 'm3u8.seg',
        group: '播放清单',
        label: '分片可访问',
        status: 'fail',
        ms: segRes.ms,
        error: segRes.error,
      });
    } else if (segRes.value.kind === 'none') {
      push({
        key: 'm3u8.seg',
        group: '播放清单',
        label: '分片可访问',
        status: 'skip',
        detail: '清单内未找到分片地址',
      });
    } else {
      const v = segRes.value;
      const hasCors = !!v.acao;
      push({
        key: 'm3u8.seg',
        group: '播放清单',
        label: '分片可访问',
        status: v.kind === 'seg' && v.status < 400 && v.bytes! > 0 ? 'pass' : 'fail',
        ms: segRes.ms,
        detail:
          v.kind === 'seg'
            ? `HTTP ${v.status} · ${v.bytes} 字节${v.isTs ? ' · 有效 TS' : ''}` +
              ` · CORS ${hasCors ? '允许' : '无（需原生兜底）'}`
            : '媒体清单直链',
        error:
          v.kind === 'seg' && v.status >= 400 ? `HTTP ${v.status}` : undefined,
        url: v.kind === 'seg' ? v.segUrl : undefined,
      });
    }
  }

  return items;
}

/** 手动重试 TMDB（用户换网络后可用） */
export function retryTmdb(): void {
  resetTmdbCircuit();
}

/** 汇总统计 */
export function summarize(items: DiagItem[]): {
  pass: number;
  fail: number;
  skip: number;
  total: number;
} {
  return {
    pass: items.filter((i) => i.status === 'pass').length,
    fail: items.filter((i) => i.status === 'fail').length,
    skip: items.filter((i) => i.status === 'skip').length,
    total: items.length,
  };
}
