/**
 * 片库数据层 —— 公网直连
 *
 * ── 性能关键（用户实测反馈「太卡、加载不出来」的根因）──────────
 * 实测发现：TMDB 域名 `api.themoviedb.org` 在部分网络下**被墙**，
 * 直连会一直挂到 20 秒超时。而旧实现里首页要等 TMDB 三个接口
 * 全部失败才回落 CMS → 首屏必然卡住十几秒。
 *
 * 对策：
 *   1. **熔断**：TMDB 连续失败 2 次后，本会话内直接跳过（不再发起请求），
 *      下次启动再重试。用户不会被卡住。
 *   2. **CMS 优先**：片库主源改为 CMS 多源并行（各源并发，互不阻塞）。
 *   3. **海报并发补齐**：CMS 列表接口无海报（实测仅 8 个精简字段），
 *      用限并发批量查详情补齐，避免串行导致的长尾。
 *
 * ── 数据来源分工 ──────────────────────────────────────
 *   CMS 采集接口 —— 主源：片名、海报、分类、播放地址都在这里
 *   TMDB         —— 增强：评分、简介、热门榜（可用时叠加，失败无感）
 */

import { posterUrl, tmdb } from './tmdb';
import {
  CATEGORY_KEYWORDS,
  cmsDetail,
  cmsDetails,
  cmsList,
  classifyTypeName,
  cmsTypes,
  matchTypeId,
  parsePlayLines,
  raceFirst,
  raceWithTimeout,
  type CmsListItem,
} from './cms';
import { allSources } from './customSources';

export interface MediaItem {
  id: string | number;
  title: string;
  poster?: string;
  backdrop?: string;
  year?: string;
  rating?: number;
  overview?: string;
  mediaType: 'movie' | 'tv' | 'anime';
  typeLabel?: string;
  /** 该条目在采集源中的 id（若命中），用于直接取播放地址 */
  cmsId?: number;
  /** 命中的采集源 id */
  cmsSourceId?: string;
  /** 是否有可播地址 */
  playable?: boolean;
  /** 集数（剧集） */
  episodeCount?: number;
}

export interface CatalogueRow {
  title: string;
  subtitle?: string;
  items: MediaItem[];
}

export interface Catalogue {
  hero?: MediaItem;
  rows: CatalogueRow[];
  source: 'tmdb' | 'cms' | 'demo';
}

// ── TMDB 熔断 ────────────────────────────────────────────

/**
 * TMDB 熔断状态
 *
 * ── 为什么必须持久化 ──────────────────────────────────
 * 实测：TMDB 在部分网络下是 **IP 段级封锁**（不只是 DNS 污染）：
 *   - 域名被解析到无关地址（2a03:2880 是 Facebook 的段）
 *   - 用 DoH 拿到的真实 IP 直连同样超时
 *   - 换域名无效（同一 IP 段）
 * 也就是说在这类网络里 TMDB **完全不可用**。
 *
 * 若熔断只在内存里，每次启动 App 都要先白等一次超时，
 * 用户感知就是「加载很慢」。持久化后只需失败一次，之后直接跳过。
 */
const TMDB_TRIP_KEY = 'sober.tmdb.tripped';

/** TMDB 连续失败次数 */
let tmdbFailures = 0;
/** 是否已熔断（跨会话生效） */
let tmdbTripped = readTripFlag();

function readTripFlag(): boolean {
  try {
    return localStorage.getItem(TMDB_TRIP_KEY) === '1';
  } catch {
    return false;
  }
}

function writeTripFlag(v: boolean): void {
  try {
    if (v) localStorage.setItem(TMDB_TRIP_KEY, '1');
    else localStorage.removeItem(TMDB_TRIP_KEY);
  } catch {
    /* 存储不可用时忽略 */
  }
}
/** 熔断前的成功缓存，供离线时复用 */
let tmdbCache: { trending?: any; popular?: any; topRated?: any } = {};

const TMDB_MAX_FAILURES = 1;

// ── 片库缓存（秒开）────────────────────────────────────

const CATALOGUE_CACHE_KEY = 'sober.catalogue.cache';
/** 缓存有效期：10 分钟 */
const CATALOGUE_CACHE_TTL = 10 * 60 * 1000;

interface CatalogueCacheEntry {
  at: number;
  data: Catalogue;
}

/** 读缓存 */
export function readCatalogueCache(): Catalogue | null {
  try {
    const raw = localStorage.getItem(CATALOGUE_CACHE_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CatalogueCacheEntry;
    if (!entry?.data?.rows?.length) return null;
    if (Date.now() - entry.at > CATALOGUE_CACHE_TTL) return null;
    return entry.data;
  } catch {
    return null;
  }
}

/** 写缓存 */
function writeCatalogueCache(data: Catalogue): void {
  try {
    const entry: CatalogueCacheEntry = { at: Date.now(), data };
    localStorage.setItem(CATALOGUE_CACHE_KEY, JSON.stringify(entry));
  } catch {
    /* 存储不可用时忽略 */
  }
}

/** 清除片库缓存（用户手动刷新时用） */
export function clearCatalogueCache(): void {
  try {
    localStorage.removeItem(CATALOGUE_CACHE_KEY);
  } catch {
    /* ignore */
  }
}

/** TMDB 当前是否可用（不发起请求） */
export function isTmdbAvailable(): boolean {
  return !tmdbTripped;
}

/** 重置 TMDB 熔断状态（用户手动重试时调用） */
export function resetTmdbCircuit(): void {
  tmdbFailures = 0;
  tmdbTripped = false;
  writeTripFlag(false);
}

/** 调 TMDB，失败自动计入熔断 */
async function tmdbSafe<T>(path: string, params?: Record<string, string | number>): Promise<T | null> {
  if (tmdbTripped) return null;
  try {
    const r = await tmdb<T>(path, params);
    tmdbFailures = 0;
    return r;
  } catch {
    tmdbFailures++;
    if (tmdbFailures >= TMDB_MAX_FAILURES) {
      tmdbTripped = true;
      writeTripFlag(true);
      console.warn('[SoberTV] TMDB 不可用，已熔断（跨会话生效），改用 CMS 片库');
    }
    return null;
  }
}

// ── 工具 ────────────────────────────────────────────────

function mapItem(raw: any, mediaType: 'movie' | 'tv' | 'anime'): MediaItem {
  const title = raw.title || raw.name || '未命名';
  const date = raw.release_date || raw.first_air_date || '';
  return {
    id: raw.id,
    title,
    poster: posterUrl(raw.poster_path),
    backdrop: posterUrl(raw.backdrop_path, 'w780'),
    year: date ? date.slice(0, 4) : undefined,
    rating: raw.vote_average ? Math.round(raw.vote_average * 10) / 10 : undefined,
    overview: raw.overview,
    mediaType,
    typeLabel: mediaType === 'movie' ? '电影' : '剧集',
    episodeCount: raw.number_of_episodes ?? raw.number_of_seasons,
  };
}

/** 演示片库 —— 所有网络源均不可达时的兜底 */
const DEMO_ITEMS: MediaItem[] = [
  {
    id: 'demo-1',
    title: '星海旅人',
    poster: 'https://picsum.photos/seed/sober1/342/513',
    backdrop: 'https://picsum.photos/seed/sober1b/1280/720',
    year: '2025',
    rating: 8.4,
    overview: '一名星际领航员在最后一次跃迁中迷失方向，独自面对一颗荒芜行星的漫长黑夜。',
    mediaType: 'movie',
    typeLabel: '电影',
  },
  {
    id: 'demo-2',
    title: '雾中回声',
    poster: 'https://picsum.photos/seed/sober2/342/513',
    backdrop: 'https://picsum.photos/seed/sober2b/1280/720',
    year: '2024',
    rating: 7.9,
    overview: '海边小镇的广播员每夜收到来自十年前的听众来信。',
    mediaType: 'movie',
    typeLabel: '电影',
  },
  {
    id: 'demo-3',
    title: '零度边界',
    poster: 'https://picsum.photos/seed/sober3/342/513',
    year: '2023',
    rating: 8.1,
    overview: '气候研究员在极地科考站发现了不该存在的第四种云层。',
    mediaType: 'tv',
    typeLabel: '剧集',
  },
  {
    id: 'demo-4',
    title: '午后三点',
    poster: 'https://picsum.photos/seed/sober4/342/513',
    year: '2025',
    rating: 7.6,
    overview: '一家老书店，三位常客，以及十二个没有结局的下午。',
    mediaType: 'movie',
    typeLabel: '电影',
  },
  {
    id: 'demo-5',
    title: '静默频率',
    poster: 'https://picsum.photos/seed/sober5/342/513',
    year: '2024',
    rating: 8.8,
    overview: '声音工程师发现城市底噪里藏着一段循环播放的密语。',
    mediaType: 'tv',
    typeLabel: '剧集',
  },
  {
    id: 'demo-6',
    title: '长夜将尽',
    poster: 'https://picsum.photos/seed/sober6/342/513',
    year: '2022',
    rating: 8.2,
    overview: '守塔人的最后一个冬天，以及一封寄向 lighthouse 的信。',
    mediaType: 'movie',
    typeLabel: '电影',
  },
];

function demoCatalogue(): Catalogue {
  const trending = DEMO_ITEMS.slice(0, 8);
  const top = [...DEMO_ITEMS].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0)).slice(0, 8);
  const recent = DEMO_ITEMS.slice(2, 10);
  return {
    hero: DEMO_ITEMS[0],
    rows: [
      {
        title: '热门剧集',
        subtitle: '正在热播',
        items: trending
          .filter((i) => i.mediaType === 'tv')
          .concat(trending.filter((i) => i.mediaType === 'movie')),
      },
      { title: '高分精选', subtitle: '口碑佳作', items: top },
      { title: '最近上新', items: recent },
    ],
    source: 'demo',
  };
}

// ── CMS 片库 ────────────────────────────────────────────

/**
 * 合并 TMDB 与 CMS 的片库结果
 */
function mergeCatalogue(tmdbRows: any[] | null, cms: Catalogue | null): Catalogue {
  const [trending, popular, topRated] = tmdbRows ?? [];
  if (trending) tmdbCache.trending = trending;
  if (popular) tmdbCache.popular = popular;
  if (topRated) tmdbCache.topRated = topRated;

  const rows: CatalogueRow[] = [];
  if (trending) {
    rows.push({
      title: '本周热门',
      subtitle: '全站趋势',
      items: (trending.results || [])
        .slice(0, 16)
        .map((r: any) => mapItem(r, r.media_type === 'movie' ? 'movie' : 'tv')),
    });
  }
  if (popular) {
    rows.push({
      title: '热门电影',
      items: (popular.results || []).slice(0, 16).map((r: any) => mapItem(r, 'movie')),
    });
  }
  if (topRated) {
    rows.push({
      title: '高分剧集',
      items: (topRated.results || []).slice(0, 16).map((r: any) => mapItem(r, 'tv')),
    });
  }
  rows.push(...(cms?.rows ?? []));
  if (!rows.length) return demoCatalogue();

  const result: Catalogue = {
    hero:
      (trending?.results?.[0]
        ? mapItem(trending.results[0], trending.results[0].media_type === 'movie' ? 'movie' : 'tv')
        : undefined) ?? cms?.hero,
    rows,
    source: trending ? 'tmdb' : 'cms',
  };
  writeCatalogueCache(result);
  return result;
}

/**
 * 加载片库
 *
 * 策略：**缓存秒开 + CMS 多源竞速 + TMDB 增强**
 *   - 有缓存时**立即返回缓存**（近乎瞬时），后台静默刷新
 *   - CMS 是主源，竞速取数，谁先回先用谁，不等最慢的
 *   - TMDB 可用时并入热门榜；不可用（被墙）时熔断跳过，绝不阻塞首屏
 */
export async function loadCatalogue(
  options: { forceRefresh?: boolean; onMoreRows?: (rows: CatalogueRow[]) => void } = {},
): Promise<Catalogue> {
  const onMoreRows = options.onMoreRows;
  // 1. 缓存优先 —— 二次启动近乎瞬时
  if (!options.forceRefresh) {
    const cached = readCatalogueCache();
    if (cached) {
      // 后台静默刷新，不阻塞本次渲染
      void loadCatalogue({ forceRefresh: true }).then((fresh) => {
        if (fresh.rows.length) writeCatalogueCache(fresh);
      });
      return cached;
    }
  }

  // TMDB 与 CMS **竞速**：谁先回先用谁
  //
  // ⚠️ 不能用 Promise.all —— TMDB 在部分网络不可达（实测直连挂 20 秒），
  // 等它就等于把整个首屏拖到 20 秒，用户看到的就是「一直加载不出来」。
  const tmdbPromise = Promise.all([
    tmdbSafe<any>('/trending/all/week'),
    tmdbSafe<any>('/movie/popular'),
    tmdbSafe<any>('/tv/top_rated'),
  ]);

  const cmsPromise = cmsCatalogue(onMoreRows);

  // 给 TMDB 4 秒窗口：到点就只用 CMS 的结果渲染
  const [tmdbRows, cms] = (await Promise.race([
    tmdbPromise.then((r) => [r, null] as [any, Catalogue | null]),
    cmsPromise.then((c) => [null, c] as [any, Catalogue | null]),
    new Promise<[null, null]>((resolve) => setTimeout(() => resolve([null, null]), 4000)),
  ])) as [any[], Catalogue | null];

  // CMS 还没回来但 TMDB 回来了 —— 等 CMS 补上
  if (!cms) {
    const c = await cmsPromise;
    return mergeCatalogue(tmdbRows, c);
  }

  return mergeCatalogue(tmdbRows, cms);
}

/**
 * CMS 片库
 *
 * 各源 type_id 不通用，故先取分类表再按名称匹配；
 * 列表接口无海报，用限并发批量查详情补齐。
 *
 * ── 三重提速（针对「太卡、加载不出来」）──────────────
 * 1. **竞速**：第一个成功的源立刻用于渲染，不等慢源。
 *    实测：竞速 4.06s vs 等全部 10.01s。
 * 2. **两阶段并行**：分类表与列表**同时**发起（旧实现是串行两阶段，
 *    各等满超时上限，累计 11 秒）。分类表回来后若已拿到列表则不重取。
 * 3. **缓存秒开**：片库结果写 localStorage（TTL 10 分钟），
 *    二次启动直接渲染缓存，后台再刷新 —— 体感接近瞬时。
 */
async function cmsCatalogue(onMore?: (rows: CatalogueRow[]) => void): Promise<Catalogue> {
  const sources = allSources().slice(0, 5);

  // ════════════════════════════════════════════════════
  // 首批：通用列表（不带 t）→ 按 type_name 跨源合并成大类行
  // ════════════════════════════════════════════════════
  //
  // 为什么不用「先取分类表再取分类列表」：
  //   实测各源 ?ac=type 耗时 0.7~12 秒（hhzy / dbm3u8 直接超时），
  //   串行两阶段必然拖慢首屏。
  //   而通用列表 ?ac=list 只需 1~1.3 秒，条目自带 type_name，
  //   按它归类即可得到「电影/剧集/综艺/动漫/纪录片」等大类行。
  //
  // 实测：2.6 秒拿到 4 源 × 20 条 → 5 个大类行、60 条。
  const genericRunners = sources.map((source) => ({
    name: source.id,
    promise: cmsList(source, { limit: 20, timeoutMs: 9000 }).then(
      (r) => ({ source, items: r.list }),
      () => null,
    ),
  }));

  const genericGroups = (
    (await raceWithTimeout(
      genericRunners.map((r) => ({ name: r.name, run: () => r.promise })),
      2500,
    )) as Array<{ source: (typeof sources)[number]; items: CmsListItem[] } | null>
  ).filter((x): x is { source: (typeof sources)[number]; items: CmsListItem[] } => !!x);

  if (!genericGroups.length) {
    const cached = buildFromCache();
    if (cached) return cached;
    return { hero: undefined, rows: [], source: 'demo' };
  }

  // ════════════════════════════════════════════════════
  // 补海报：批量查详情（每个源 1 次请求）
  // ════════════════════════════════════════════════════
  //
  // 为什么必须在这里做（用户实测反馈「首页推荐都没有海报图片」）：
  //   CMS 的**列表接口不返回 vod_pic**（实测只有 8 个精简字段），
  //   海报只在详情接口里。旧实现把补详情放到后台异步做，
  //   首屏渲染出来的是一堆没海报的灰卡片 —— 用户第一印象就是「图全没了」。
  //
  // 关键优化：`?ac=detail&ids=a,b,c` 支持逗号批量，
  //   60 条从 60 次请求降到 5 次（每源一次）→ 从 25 秒降到 1~2 秒。
  //   既然这么快，就可以放进首屏链路，首屏即带海报。
  //
  // 但慢源实测要 4.8~5.2 秒（暴风/魔都），不能拖住首屏。
  //   → **限时竞速**：给 3.2 秒窗口，先用已到的源出海报卡片；
  //     慢源稍后到达时，整行替换补上。
  //
  // 兜底：某些源不接受多 id（实测 suoni 返回空），
  //   cmsDetails 内部会自动回退为逐条查询，不会丢数据。
  const detailMap = new Map<string, any>();
  /** 已完成批量补图的源 id */
  const doneSources = new Set<string>();

  const detailJobs = genericGroups.map(async (g) => {
    try {
      const dets = await cmsDetails(
        g.source,
        g.items.map((it) => it.vod_id),
        // 6 秒上限：慢源（暴风/魔都实测 5 秒）刚好赶得上，
        // 再慢就放弃这一源 —— 它会在下一轮缓存刷新时补上。
        6000,
      );
      for (const d of dets) {
        detailMap.set(`${g.source.id}~${d.vod_id}`, d);
      }
    } catch {
      /* 该源补图失败 → 保留无海报卡片，不影响其他源 */
    } finally {
      doneSources.add(g.source.id);
    }
  });

  // 限时等待：3.2 秒后不管结果，先出首屏
  await Promise.race([
    Promise.all(detailJobs),
    new Promise<void>((resolve) => setTimeout(resolve, 3200)),
  ]);

  // ════════════════════════════════════════════════════
  // 后台：分类表 → 各分类列表 → 细分行
  // ════════════════════════════════════════════════════
  const typeRunners = sources.map((source) => ({
    name: source.id,
    promise: cmsTypes(source).then(
      (cats) => ({ source, cats }),
      () => null,
    ),
  }));
  const typeAllPromise = Promise.all(typeRunners.map((r) => r.promise));

  // 分类表就绪后，拉各分类的细分列表
  const detailPromise = typeAllPromise.then(async (typeResults) => {
    const typeMap = new Map(
      typeResults.filter(Boolean).map((t) => [t!.source.id, t!.cats]),
    );
    const targets: {
      source: (typeof sources)[number];
      typeId: number;
      label: string;
      mediaType: 'movie' | 'tv' | 'anime';
    }[] = [];

    for (const source of sources) {
      const cats = typeMap.get(source.id);
      if (!cats) continue;
      for (const cat of CATEGORY_KEYWORDS) {
        const typeId = matchTypeId(cats, cat.keywords);
        if (!typeId) continue;
        targets.push({
          source,
          typeId,
          label: cat.name,
          mediaType: cat.key === 'anime' ? 'anime' : cat.key === 'tv' ? 'tv' : 'movie',
        });
      }
    }
    if (!targets.length) return [];

    const groups = (
      await Promise.all(
        targets.map(async (t) => {
          try {
            const r = await cmsList(t.source, {
              typeId: t.typeId,
              limit: 20,
              timeoutMs: 9000,
            });
            return { target: t, items: r.list };
          } catch {
            return null;
          }
        }),
      )
    ).filter((x): x is { target: (typeof targets)[number]; items: CmsListItem[] } => !!x);

    return groups;
  });

  // ── 首批行：按通用大类跨源合并 ─────────────────────
  //
  // ⚠️ 关键：**首批不等详情**。
  // 实测补 100 条详情若串行分组要 85 秒（用户全程看到骨架屏）。
  // 正确做法：先用列表数据（片名/类型都有）立即出卡片，
  // 海报/年份/集数由后台详情补齐后整行替换。
  const rows: CatalogueRow[] = [];
  let hero: MediaItem | undefined;

  const buckets = new Map<
    string,
    { source: (typeof sources)[number]; item: CmsListItem }[]
  >();

  for (const g of genericGroups) {
    for (const item of g.items) {
      const cat = classifyTypeName(item.type_name);
      if (!cat) continue;
      if (!buckets.has(cat)) buckets.set(cat, []);
      buckets.get(cat)!.push({ source: g.source, item });
    }
  }

  const CAT_LABEL: Record<string, string> = {
    movie: '电影',
    tv: '剧集',
    variety: '综艺',
    anime: '动漫',
    doc: '纪录片',
  };

  const mediaTypeOf = (cat: string): 'movie' | 'tv' | 'anime' =>
    cat === 'anime' ? 'anime' : cat === 'tv' ? 'tv' : 'movie';

  // 首批行：按通用大类跨源合并
  //
  // ⚠️ 关键：**只渲染已拿到海报的条目**。
  //   竞速窗口（3.2s）内没回来的源，其条目会变成「没有海报的灰卡片」，
  //   正是用户反馈的「首页推荐都没有海报图片」。
  //   → 缺图的条目留到后台补齐时插入，首屏一张空卡都不出现。
  const pendingItems: {
    cat: string;
    e: { source: (typeof sources)[number]; item: CmsListItem };
  }[] = [];

  for (const [cat, list] of buckets) {
    const items: MediaItem[] = [];
    for (const e of list) {
      const d = detailMap.get(`${e.source.id}~${e.item.vod_id}`);
      if (!d?.vod_pic) {
        // 没海报 → 延后插入
        pendingItems.push({ cat, e });
        continue;
      }
      const lines = parsePlayLines(d);
      items.push({
        id: `cms~${e.source.id}~${e.item.vod_id}`,
        title: d.vod_name || e.item.vod_name,
        poster: d.vod_pic,
        year: d.vod_year,
        overview: d.vod_content || e.item.vod_remarks,
        mediaType: mediaTypeOf(cat),
        typeLabel: CAT_LABEL[cat] ?? cat,
        cmsId: e.item.vod_id,
        cmsSourceId: e.source.id,
        playable: lines.length > 0,
        episodeCount: lines[0]?.episodes.length,
      });
    }
    if (items.length) {
      rows.push({ title: CAT_LABEL[cat] ?? cat, items });
      if (!hero) hero = items[0];
    }
  }

  // ── 后台：慢源迟到 → 补上缺图的条目 ─────────────────
  //
  // 竞速窗口（3.2 秒）内没回来的源，等它回来后把「之前因缺海报
  // 而被延后的条目」补进行里 —— 用户看到的是卡片陆续出现，
  // 而不是一堆永远空白的灰格子。
  void (async () => {
    // 等所有批量补图任务结束
    await Promise.all(detailJobs);

    if (!pendingItems.length) return;

    // 按大类归组待补条目
    const byCat = new Map<string, typeof pendingItems>();
    for (const p of pendingItems) {
      if (!byCat.has(p.cat)) byCat.set(p.cat, []);
      byCat.get(p.cat)!.push(p);
    }

    const extra: CatalogueRow[] = [];
    for (const [cat, list] of byCat) {
      const items: MediaItem[] = [];
      for (const { e } of list) {
        const d = detailMap.get(`${e.source.id}~${e.item.vod_id}`);
        if (!d?.vod_pic) continue; // 仍无海报 → 继续不显示
        const lines = parsePlayLines(d);
        items.push({
          id: `cms~${e.source.id}~${e.item.vod_id}`,
          title: d.vod_name || e.item.vod_name,
          poster: d.vod_pic,
          year: d.vod_year,
          overview: d.vod_content || e.item.vod_remarks,
          mediaType: mediaTypeOf(cat),
          typeLabel: CAT_LABEL[cat] ?? cat,
          cmsId: e.item.vod_id,
          cmsSourceId: e.source.id,
          playable: lines.length > 0,
          episodeCount: lines[0]?.episodes.length,
        });
      }
      if (items.length) extra.push({ title: CAT_LABEL[cat] ?? cat, items });
    }
    if (extra.length && onMore) onMore(extra);
  })();

  // ── 后台补齐：分类细分行随后到达时追加 ──────────────
  if (onMore) {
    void detailPromise.then(async (groups) => {
      if (!groups.length) return;
      const extra: CatalogueRow[] = [];

      for (const g of groups) {
        if (!g.items.length) continue;
        const source = g.target.source;
        // 批量查详情（一次请求拿整组海报）
        const dets = await cmsDetails(
          source,
          g.items.map((it) => it.vod_id),
        );
        const byId = new Map(dets.map((d) => [Number(d.vod_id), d]));
        const items: MediaItem[] = [];
        g.items.forEach((it) => {
          const det = byId.get(it.vod_id);
          const lines = det ? parsePlayLines(det) : [];
          items.push({
            id: `cms~${source.id}~${it.vod_id}`,
            title: det?.vod_name || it.vod_name,
            poster: det?.vod_pic,
            year: det?.vod_year,
            overview: det?.vod_content || it.vod_remarks,
            mediaType: g.target.mediaType,
            typeLabel: g.target.label,
            cmsId: it.vod_id,
            cmsSourceId: source.id,
            playable: lines.length > 0,
            episodeCount: lines[0]?.episodes.length,
          });
        });
        if (items.length) {
          extra.push({ title: `${source.name} · ${g.target.label}`, items });
        }
      }
      if (extra.length) onMore(extra);
    });
  }

  return { hero, rows, source: 'cms' };
}

/** 用缓存的 TMDB 数据构建片库（TMDB 不可达时的兜底） */
function buildFromCache(): Catalogue | null {
  const { trending, popular, topRated } = tmdbCache;
  if (!trending && !popular && !topRated) return null;

  const rows: CatalogueRow[] = [];
  if (trending) {
    rows.push({
      title: '本周热门',
      items: (trending.results || [])
        .slice(0, 16)
        .map((r: any) => mapItem(r, r.media_type === 'movie' ? 'movie' : 'tv')),
    });
  }
  if (popular) {
    rows.push({
      title: '热门电影',
      items: (popular.results || []).slice(0, 16).map((r: any) => mapItem(r, 'movie')),
    });
  }
  if (topRated) {
    rows.push({
      title: '高分剧集',
      items: (topRated.results || []).slice(0, 16).map((r: any) => mapItem(r, 'tv')),
    });
  }
  return {
    hero: trending?.results?.[0]
      ? mapItem(trending.results[0], trending.results[0].media_type === 'movie' ? 'movie' : 'tv')
      : undefined,
    rows,
    source: 'tmdb',
  };
}

// ── 搜索 ────────────────────────────────────────────────

/**
 * 搜索 —— CMS 多源 + TMDB 并行
 * 任何一个源先返回即可用，全失败才回落演示数据。
 */
export async function searchMedia(query: string): Promise<MediaItem[]> {
  const q = query.trim();
  if (!q) return [];

  const tasks: Promise<MediaItem[]>[] = [];

  // CMS 多源搜索（竞速：先返回的先用，不等慢源）
  tasks.push(
    (async () => {
      const sources = allSources();
      const hits = await raceFirst<
        { source: (typeof sources)[number]; it: CmsListItem }[]
      >(
        sources.map((source) => ({
          name: source.id,
          run: async () => {
            const r = await cmsList(source, { keyword: q, limit: 12 });
            return r.list.map((it) => ({ source, it }));
          },
        })),
        1,
        6000,
        // ⚠️ 关键：空结果不算数。
        // 某些源对关键词无匹配时返回空列表，空列表也是「成功」，
        // 不过滤会让竞速立刻结束并返回空 → 表现为「搜不到影片」。
        (r) => r.length > 0,
      );

      const flat = hits.flat();
      if (!flat.length) return [];

      // 按源分组批量查详情取海报（每源 1 次请求，而非每条 1 次）
      const bySource = new Map<string, { source: (typeof sources)[number]; items: CmsListItem[] }>();
      for (const { source, it } of flat) {
        const key = source.id;
        if (!bySource.has(key)) bySource.set(key, { source, items: [] });
        bySource.get(key)!.items.push(it);
      }

      const detailMap = new Map<string, any>();
      await Promise.all(
        [...bySource.values()].map(async ({ source, items }) => {
          try {
            const dets = await cmsDetails(
              source,
              items.map((it) => it.vod_id),
            );
            for (const d of dets) detailMap.set(`${source.id}~${d.vod_id}`, d);
          } catch {
            /* 忽略 */
          }
        }),
      );

      return flat.map(({ source, it }) => {
        const det = detailMap.get(`${source.id}~${it.vod_id}`);
        return {
          id: `cms~${source.id}~${it.vod_id}`,
          title: det?.vod_name || it.vod_name,
          poster: det?.vod_pic,
          year: det?.vod_year,
          overview: det?.vod_content || it.vod_remarks,
          mediaType: (det?.type_id === 2 ? 'tv' : 'movie') as 'movie' | 'tv',
          typeLabel: det?.type_name,
          cmsId: it.vod_id,
          cmsSourceId: source.id,
        } satisfies MediaItem;
      });
    })(),
  );

  // TMDB 搜索（被墙时静默失败）
  if (!tmdbTripped) {
    tasks.push(
      (async () => {
        const j = await tmdbSafe<any>('/search/multi', { query: q });
        if (!j) return [];
        return (j.results || [])
          .filter((r: any) => r.media_type === 'movie' || r.media_type === 'tv')
          .map((r: any) => mapItem(r, r.media_type === 'movie' ? 'movie' : 'tv'));
      })(),
    );
  }

  // ⚠️ 不能用 Promise.allSettled —— 它会等最慢的任务。
  // TMDB 在部分网络不可达（15 秒超时），用它就等于每次搜索都先卡满。
  // 改成「等第一个有结果的」：CMS 通常几百毫秒就有结果。
  const settled = await Promise.race([
    Promise.allSettled(tasks),
    // 兜底：4 秒后用当时已有的结果
    new Promise<PromiseSettledResult<MediaItem[]>[]>((resolve) =>
      setTimeout(() => {
        void Promise.allSettled(tasks).then(resolve);
      }, 4000),
    ),
  ]);

  const merged: MediaItem[] = [];
  const seen = new Set<string>();
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue;
    for (const item of s.value) {
      const key = item.title.replace(/\s/g, '');
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }

  if (merged.length) return merged;

  // 全部失败 → 演示数据
  const lower = q.toLowerCase();
  return DEMO_ITEMS.filter(
    (i) =>
      i.title.toLowerCase().includes(lower) ||
      (i.overview || '').toLowerCase().includes(lower),
  );
}

// ── 详情 ────────────────────────────────────────────────

/**
 * 详情
 * CMS 条目（id 形如 cms-<source>-<vodId>）直接查源；
 * TMDB 条目走 TMDB。
 */
export async function fetchDetail(
  id: string | number,
  mediaType: string,
): Promise<MediaItem | null> {
  // CMS 直连条目
  const m = String(id).match(/^cms~(.+)~(\d+)$/);
  if (m) {
    const sourceId = m[1];
    const vodId = Number(m[2]);
    const source = allSources().find((s) => s.id === sourceId);
    if (source) {
      try {
        const d = await cmsDetail(source, vodId);
        if (!d) return null;
        const lines = parsePlayLines(d);
        return {
          id,
          title: d.vod_name,
          poster: d.vod_pic,
          year: d.vod_year,
          overview: d.vod_content || d.vod_remarks,
          mediaType: d.type_id === 2 ? 'tv' : 'movie',
          typeLabel: d.type_name,
          cmsId: vodId,
          cmsSourceId: source.id,
          playable: lines.length > 0,
          episodeCount: lines[0]?.episodes.length,
        };
      } catch {
        return null;
      }
    }
  }

  if (String(id).startsWith('demo-')) {
    return DEMO_ITEMS.find((i) => i.id === id) ?? null;
  }

  const raw = await tmdbSafe<any>(
    mediaType === 'tv' ? `/tv/${id}` : `/movie/${id}`,
  );
  if (raw) return mapItem(raw, mediaType === 'tv' ? 'tv' : 'movie');

  return null;
}

/**
 * 剧集列表
 * CMS 条目按播放线路拆集（这是真正能播的集）。
 */
export async function fetchSeasons(
  id: string | number,
  mediaType: string,
): Promise<{
  season: number;
  name: string;
  episodes: { ep: number; name: string; overview: string; still?: string }[];
}[]> {
  if (mediaType !== 'tv') return [];

  const m = String(id).match(/^cms~(.+)~(\d+)$/);
  if (m) {
    const source = allSources().find((s) => s.id === m[1]);
    if (source) {
      try {
        const d = await cmsDetail(source, Number(m[2]));
        const lines = d ? parsePlayLines(d) : [];
        const eps = lines[0]?.episodes ?? [];
        return [
          {
            season: 1,
            name: '剧集',
            episodes: eps.map((e, i) => ({ ep: i + 1, name: e.name, overview: '' })),
          },
        ];
      } catch {
        return [];
      }
    }
  }

  if (tmdbTripped) return [];

  try {
    const list = await tmdb<any>(`/tv/${id}`);
    const seasons = list.seasons || [];
    const out = [];
    for (const s of seasons) {
      if (s.season_number === 0) continue;
      const detail = await tmdb<any>(`/tv/${id}/season/${s.season_number}`);
      out.push({
        season: s.season_number,
        name: s.name || `第 ${s.season_number} 季`,
        episodes: (detail.episodes || []).map((e: any) => ({
          ep: e.episode_number,
          name: e.name || `第 ${e.episode_number} 集`,
          overview: e.overview || '',
          still: posterUrl(e.still_path, 'w300'),
        })),
      });
    }
    return out;
  } catch {
    return [];
  }
}

export { DEMO_ITEMS };
