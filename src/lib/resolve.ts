/**
 * 公网播放解析 —— 把「一部影片」映射到「可播放的线路列表」
 *
 * ── 链路 ──────────────────────────────────────────────
 *   TMDB 影片(中文名) → CMS 搜索(中文名) → 选中 vod_id → CMS 详情
 *   → 解析 vod_play_url → 挑出目标集数 → m3u8 直链
 *
 * ── 为什么按「名称」而非 ID 关联 ────────────────────────
 * TMDB 与 CMS 是两套独立的数据体系，没有共同 ID。
 * TMDB 的中文译名（language=zh-CN）与 CMS 的片名高度重合，
 * 实测「流浪地球」在 CMS 精确命中 4 条，是可靠的关联键。
 *
 * ── 多源冗余 ──────────────────────────────────────────
 * 同一影片会在多个采集源中查找，全部命中的线路汇成候选列表，
 * 由 PlayerController 按 keep / 权重 / 顺延策略挑一条起播。
 */

import type { LoadContext } from '../providers/types';
import type { SelectableSource } from '../player/sourceSelector';
import {
  cmsDetail,
  cmsList,
  healthySources,
  parsePlayLines,
  pickEpisode,
  raceFirst,
  raceWithTimeout,
  type CmsListItem,
  type CmsSource,
  type PlayLine,
} from './cms';
import { allSources } from './customSources';

/** 一条已解析的线路（含来源溯源） */
export interface ResolvedLine extends SelectableSource {
  /** CMS 线路名，如 dyttm3u8 */
  lineName: string;
  /** 采集源 id */
  sourceId: string;
  /** 该片在 CMS 中的 id */
  vodId: number;
  /** 目标集在列表中的下标（0 基） */
  episodeIndex: number;
  /**
   * 该条线路的整季地址表
   *
   * 一个 CMS 详情接口就把整季地址都返回了，没必要换集时再搜一遍。
   * 下发原生播放窗口后，选集/播完自动续集会直接在本进程内换集，
   * 不依赖「原生 → JS → 重新解析 → 再起播」这条易断的往返链路。
   */
  episodes?: { n: number; url: string }[];
}

/** 从集名里取集号（「第03集」「03」「EP3」都能认） */
function episodeNoOf(name: string, fallback: number): number {
  const m = name.match(/第?\s*(\d+)\s*[集话期]/) || name.match(/^(\d+)$/);
  return m ? Number(m[1]) : fallback;
}

/**
 * 整季地址表
 *
 * 只保留 m3u8 直链（同一线路里可能混着网页播放页）；
 * 若该线路一条 m3u8 都没有，则原样保留，避免把线路过滤成空。
 */
function episodeListOf(line: PlayLine): { n: number; url: string }[] {
  const all = line.episodes.map((e, i) => ({
    n: episodeNoOf(e.name, i + 1),
    url: e.url,
  }));
  const hls = all.filter((e) => e.url.includes('.m3u8'));
  return hls.length ? hls : all;
}

/** 解析选项 */
export interface ResolveOptions {
  /** 影片中文名（用于在 CMS 中搜索） */
  title: string;
  /** 类型 */
  mediaType: 'movie' | 'tv' | 'anime' | 'live';
  /** 目标集号（电影恒为 1） */
  episode?: number;
  /** 优先线路名（keep 语义） */
  keep?: string;
  /** 要使用的采集源（默认全部） */
  sources?: CmsSource[];
  /** 单次最多解析几个源，控制首屏延迟 */
  maxSources?: number;
}

/** 单个源的解析结果 */
interface SourceAttempt {
  source: CmsSource;
  vodId: number;
  vodName: string;
  lines: PlayLine[];
}

/**
 * 名称归一化 —— 用于剔除「衍生片」误匹配
 * 例：搜「流浪地球」时，「流浪地球2」应排在后面
 */
function titleScore(query: string, candidate: string): number {
  const q = query.trim();
  const c = candidate.trim();
  if (!q || !c) return 0;
  if (c === q) return 100;
  if (c.startsWith(q)) return 80 - (c.length - q.length);
  if (c.includes(q)) return 60 - (c.length - q.length);
  return 0;
}

/**
 * 在所有源中解析出可播放线路
 */
export async function resolveLines(opts: ResolveOptions): Promise<ResolvedLine[]> {
  // 源池 = 内置源 + 用户自定义源（自定义源权重更高，优先尝试）
  const sources = healthySources(opts.sources ?? allSources());
  const maxSources = opts.maxSources ?? 4;
  const episode = opts.episode ?? 1;

  // 1. 跨源搜索（快模式：第一个源返回就用，不等慢源）
  const hitGroups = await raceFirst<
    { source: CmsSource; item: CmsListItem }[]
  >(
    sources.map((source) => ({
      name: source.id,
      run: async () => {
        const r = await cmsList(source, { keyword: opts.title, limit: 10 });
        return r.list.map((item) => ({ source, item }));
      },
    })),
    1,
    5000,
  );
  const hits = hitGroups.flat();

  // 2. 按名称匹配度筛选，保留每个源的最佳命中
  const perSource = new Map<string, { vodId: number; vodName: string; score: number }>();
  for (const h of hits) {
    const score = titleScore(opts.title, h.item.vod_name);
    if (score <= 0) continue;
    const cur = perSource.get(h.source.id);
    if (!cur || score > cur.score) {
      perSource.set(h.source.id, {
        vodId: h.item.vod_id,
        vodName: h.item.vod_name,
        score,
      });
    }
  }

  if (!perSource.size) return [];

  // 3. 取分数最高的若干源，拉详情（竞速：第一个能播的先返回）
  const ordered = [...perSource.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, maxSources);

  const attempts = await raceWithTimeout(
    ordered.map(([sourceId, info]) => ({
      name: sourceId,
      run: async (): Promise<SourceAttempt | null> => {
        const source = sources.find((s) => s.id === sourceId)!;
        try {
          const detail = await cmsDetail(source, info.vodId);
          if (!detail) return null;
          const lines = parsePlayLines(detail);
          if (!lines.length) return null;
          return { source, vodId: info.vodId, vodName: info.vodName, lines };
        } catch {
          return null;
        }
      },
    })),
    8000,
  ).then((list) => list.filter((x): x is SourceAttempt => !!x));

  // 4. 抽成候选线路
  const out: ResolvedLine[] = [];
  for (const a of attempts) {
    for (const line of a.lines) {
      const picked = pickEpisode([line], episode);
      if (!picked) continue;
      out.push({
        id: `${a.source.id}-${a.vodId}-${picked.index}-${picked.url.slice(-20)}`,
        url: picked.url,
        label: `${a.source.name.trim()} · ${line.from}`,
        lineName: line.from,
        sourceId: a.source.id,
        vodId: a.vodId,
        episodeIndex: picked.index,
        quality: 'AUTO',
        official: false,
        weight: a.source.weight,
        episodes: episodeListOf(line),
      });
    }
  }

  // 5. keep 置顶 + 权重降序
  if (opts.keep) {
    const i = out.findIndex((s) => s.label === opts.keep);
    if (i > 0) {
      const [item] = out.splice(i, 1);
      out.unshift(item);
    }
  }
  out.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));

  return out;
}

/**
 * 直连解析 —— 已经知道「哪个源的哪条片子」时直接取播放地址
 *
 * 用途：从片库点进详情页时，条目本身就带 sourceId + vodId，
 * 无需再按片名跨源搜索一遍（搜索是详情页最慢的一步）。
 *
 * @param sourceId 采集源 id
 * @param vodId    该源内的影片 id
 * @param episode  目标集号
 */
export async function resolveDirect(
  sourceId: string,
  vodId: number,
  episode = 1,
): Promise<ResolvedLine[]> {
  const source = allSources().find((s) => s.id === sourceId);
  if (!source) return [];

  try {
    const detail = await cmsDetail(source, vodId);
    if (!detail) return [];
    const lines = parsePlayLines(detail);
    const out: ResolvedLine[] = [];

    for (const line of lines) {
      const picked = pickEpisode([line], episode);
      if (!picked) continue;
      out.push({
        id: `${source.id}-${vodId}-${picked.index}-${picked.url.slice(-20)}`,
        url: picked.url,
        label: `${source.name.trim()} · ${line.from}`,
        lineName: line.from,
        sourceId: source.id,
        vodId,
        episodeIndex: picked.index,
        quality: 'AUTO',
        official: false,
        weight: source.weight,
        episodes: episodeListOf(line),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 便捷入口 —— 按 LoadContext 解析
 */
export async function resolveByContext(
  ctx: LoadContext,
  title: string,
  keep?: string,
): Promise<ResolvedLine[]> {
  return resolveLines({
    title,
    mediaType: ctx.mediaType,
    episode: ctx.mediaType === 'movie' ? 1 : ctx.episode ?? 1,
    keep,
  });
}
