/**
 * 苹果 CMS（AppleCMS / MacCMS V10）公网采集接口客户端
 *
 * ── 接口形态 ──────────────────────────────────────────
 * 列表/搜索：`?ac=list&wd=<关键词>&pg=<页码>&t=<分类id>`
 * 详情：     `?ac=detail&ids=<vod_id>`
 * 分类：     `?ac=type` → 各源的分类 id 与名称
 * 优化：     `?ac=list` 配合路径 `from/<播放源名>/` 只返回该源的数据
 *
 * 返回结构：
 *   { code, msg, page, pagecount, total, list: [{ vod_id, vod_name, vod_pic, ... }] }
 *
 * 播放地址在 `vod_play_url` 里，格式为：
 *   "第1集$<url1>#第2集$<url2>#..."   多线路用 `$$$` 分隔
 * 播放来源名在 `vod_play_from`，同样用 `$$$` 分隔，与 url 列表一一对应。
 *
 * ── 实测要点（2026-10-27 逐站实测）──────────────────
 * 1. **列表接口只返回精简字段**（8 个字段，无 vod_pic / vod_year），
 *    完整字段（海报、演员、集数）只有详情接口才有。
 *    → 海报要么逐条查详情（慢），要么用 TMDB（但 TMDB 域名在部分网络被墙）。
 * 2. **各源的 type_id 完全不通用**（实测 ff 是 1-26、360zy 是 27-38、
 *    hhzy 是 45-53），所以不能硬编码分类 id，必须按分类**名称**匹配。
 * 3. `vod_play_from` 中带 `m3u8` 字样的线路才是真正的 HLS 直链，
 *    另一条通常是网页播放页（/share/xxx），不能直接喂给播放器。
 * 4. 这些源全部无 CORS 头，必须走 net.ts 的原生 HTTP。
 * 5. `from/<源名>/` 优化接口对 list 体积仅省约 3%（list 本就不含 play_url），
 *    对 detail 约省 3~4%。收益有限，但可减少无用线路的解析开销。
 */

import { httpJson } from './net';

/** 一个采集源 */
export interface CmsSource {
  id: string;
  name: string;
  /** 接口根地址，形如 https://host/api.php/provide/vod/ */
  base: string;
  /** 线路权重，越大越优先 */
  weight: number;
  /** 是否为用户自建源（自建源不参与内置源的默认排序策略） */
  custom?: boolean;
  /** 启用状态 */
  enabled?: boolean;
}

/**
 * 内置公网采集源清单
 *
 * 全部为 MacCMS V10 标准协议，均已实测返回 200 与真实数据。
 * 片库量差异很大（4.9 万 ~ 16.7 万），故全部保留、按权重与健康度择优。
 *
 * 采集站域名迁移/关闭很常见，故配合 probeSources() 做运行时健康探测，
 * 失效源自动从解析池剔除（否则每次解析都要等它超时，是卡顿的主要来源）。
 */
export const CMS_SOURCES: CmsSource[] = [
  { id: 'ffm3u8', name: '非凡资源', base: 'https://cj.ffzyapi.com/api.php/provide/vod/', weight: 100 },
  { id: 'bfzym3u8', name: '暴风资源', base: 'https://bfzyapi.com/api.php/provide/vod/', weight: 95 },
  { id: 'dyttm3u8', name: '电影天堂', base: 'https://caiji.dyttzyapi.com/api.php/provide/vod/', weight: 94 },
  { id: 'hhm3u8', name: '豪华资源', base: 'https://hhzyapi.com/api.php/provide/vod/', weight: 92 },
  { id: 'snm3u8', name: '索尼资源', base: 'https://suoniapi.com/api.php/provide/vod/', weight: 90 },
  { id: 'modum3u8', name: '魔都资源', base: 'https://caiji.moduapi.cc/api.php/provide/vod/', weight: 88 },
  { id: 'dbm3u8', name: '百度资源', base: 'https://api.apibdzy.com/api.php/provide/vod/', weight: 86 },
  { id: '360zy', name: '360资源', base: 'https://360zy.com/api.php/provide/vod/', weight: 84 },
  { id: 'wolong', name: '卧龙资源', base: 'https://collect.wolongzyw.com/api.php/provide/vod/', weight: 80 },
];

/** 分类定义 */
export interface CmsCategory {
  typeId: number;
  name: string;
}

/** 跨源通用的分类关键词 —— 按名称在各源的分类表里匹配 */
export const CATEGORY_KEYWORDS: { key: string; name: string; keywords: string[] }[] = [
  { key: 'movie', name: '电影', keywords: ['电影', '片', 'movie'] },
  { key: 'tv', name: '剧集', keywords: ['剧', '连续剧', '电视剧', 'tv'] },
  { key: 'variety', name: '综艺', keywords: ['综艺', '真人秀', '脱口秀'] },
  { key: 'anime', name: '动漫', keywords: ['动漫', '动画', '漫画', '二次元'] },
  { key: 'doc', name: '纪录片', keywords: ['纪录片', '记录片', '科教', '教育'] },
];

/**
 * 把源自己的分类名（如「日本剧」「港台综艺」）归到通用大类
 *
 * 先精确匹配，再包含匹配；都不中返回 null（该条目不参与归类行）。
 *
 * ⚠️ 关键词要覆盖各站实际写法：实测有的源写「记录片」而非「纪录片」。
 */
export function classifyTypeName(typeName: string | undefined): string | null {
  const name = (typeName || '').trim();
  if (!name) return null;

  for (const g of CATEGORY_KEYWORDS) {
    for (const k of g.keywords) {
      if (name === k) return g.key;
    }
  }
  for (const g of CATEGORY_KEYWORDS) {
    for (const k of g.keywords) {
      if (name.includes(k)) return g.key;
    }
  }
  return null;
}

/** 源健康状态 */
export interface SourceHealth {
  id: string;
  ok: boolean;
  latencyMs: number;
  total?: number;
  /** 最近一次探测时间 */
  checkedAt: number;
  /** 连续失败次数 */
  failures: number;
}

/** 健康状态缓存 —— TTL 5 分钟 */
const HEALTH_TTL = 5 * 60 * 1000;
const healthMap = new Map<string, SourceHealth>();

/**
 * 探测所有源的可用性
 *
 * 用途：
 *   - 设置页展示各源状态
 *   - 解析前剔除失效源，避免每次解析都去等超时
 */
export async function probeSources(
  sources: CmsSource[] = CMS_SOURCES,
  onProgress?: (h: SourceHealth) => void,
): Promise<SourceHealth[]> {
  // ⚠️ 不能用 Promise.all —— 它要等最慢的源（不可达的源要等满超时），
  // 用户看到的就是「加载内置源非常慢」。
  // 这里并发发起 + 逐个回调，谁先回先显示。
  const results = await Promise.all(
    sources.map(async (s) => {
      const t0 = Date.now();
      try {
        const r = await cmsList(s, { limit: 1, timeoutMs: 6000 });
        const h: SourceHealth = {
          id: s.id,
          ok: true,
          latencyMs: Date.now() - t0,
          total: r.total,
          checkedAt: Date.now(),
          failures: 0,
        };
        healthMap.set(s.id, h);
        onProgress?.(h);
        return h;
      } catch {
        const prev = healthMap.get(s.id);
        const h: SourceHealth = {
          id: s.id,
          ok: false,
          latencyMs: Date.now() - t0,
          checkedAt: Date.now(),
          failures: (prev?.failures ?? 0) + 1,
        };
        healthMap.set(s.id, h);
        onProgress?.(h);
        return h;
      }
    }),
  );
  return results;
}

/**
 * 取当前健康的源
 *
 * 未探测过（缓存缺失）的源默认认为可用，避免首次使用被误杀。
 * 探测过且失败的源直接剔除 —— 这是首屏/解析不再卡顿的关键。
 */
export function healthySources(sources: CmsSource[] = CMS_SOURCES): CmsSource[] {
  const now = Date.now();
  const alive: CmsSource[] = [];
  for (const s of sources) {
    if (s.enabled === false) continue;
    const h = healthMap.get(s.id);
    if (!h || now - h.checkedAt > HEALTH_TTL) {
      // 缓存缺失或过期，暂按可用处理（下次探测会刷新）
      alive.push(s);
      continue;
    }
    if (h.ok) alive.push(s);
  }
  return alive.length ? alive : sources.filter((s) => s.enabled !== false);
}

/** 读取缓存的健康状态 */
export function getSourceHealth(): SourceHealth[] {
  return [...healthMap.values()];
}

/** 列表项（精简字段） */
export interface CmsListItem {
  vod_id: number;
  vod_name: string;
  vod_en?: string;
  type_id?: number;
  type_name?: string;
  vod_remarks?: string;
  vod_time?: string;
  vod_play_from?: string;
}

/** 详情项（完整字段） */
export interface CmsDetail extends CmsListItem {
  vod_pic?: string;
  vod_year?: string;
  vod_actor?: string;
  vod_director?: string;
  vod_area?: string;
  vod_class?: string;
  vod_content?: string;
  vod_score?: string;
  vod_play_from?: string;
  vod_play_url?: string;
}

/** 一条可播放线路 */
export interface PlayLine {
  /** 线路名（来源名） */
  from: string;
  /** 集数列表 */
  episodes: { name: string; url: string }[];
}

export interface CmsListResult {
  page: number;
  pagecount: number;
  total: number;
  list: CmsListItem[];
}

/** 构造查询串 */
function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    sp.set(k, String(v));
  }
  return sp.toString();
}

/** 拉取列表 / 搜索 */
export async function cmsList(
  source: CmsSource,
  params: {
    keyword?: string;
    typeId?: number;
    page?: number;
    limit?: number;
    timeoutMs?: number;
  } = {},
): Promise<CmsListResult> {
  const url =
    source.base +
    '?' +
    qs({
      ac: 'list',
      wd: params.keyword,
      t: params.typeId,
      pg: params.page ?? 1,
      limit: params.limit ?? 30,
    });

  const j = await httpJson<any>(url, { timeoutMs: params.timeoutMs ?? 9000 });
  return {
    page: Number(j.page) || 1,
    pagecount: Number(j.pagecount) || 1,
    total: Number(j.total) || 0,
    list: (j.list || []) as CmsListItem[],
  };
}

/**
 * 拉取详情
 *
 * @param ids 单个 id（保持兼容）
 */
export async function cmsDetail(source: CmsSource, vodId: number): Promise<CmsDetail | null> {
  const list = await cmsDetails(source, [vodId]);
  return list[0] ?? null;
}

/**
 * 批量拉取详情 —— 一次请求取多条（关键性能优化）
 *
 * ── 为什么需要 ──────────────────────────────────────
 * CMS 采集接口的**列表接口不返回海报**（实测仅 8 个精简字段），
 * 海报（vod_pic）只在详情接口里。
 * 旧实现逐条查详情补海报：60 条 = 60 次请求，限并发 6 也要 25 秒，
 *   用户全程看到「没有海报的灰卡片」。
 *
 * 实测 `?ac=detail&ids=a,b,c` 支持**逗号分隔批量**（2026-10-28 逐源实测）：
 *   非凡 617ms/20 条、电影天堂 529ms、360资源 274ms、暴风 4821ms、魔都 5242ms
 *   → 逐条要 4~10 秒，批量只要 0.3~5 秒。
 *
 * ⚠️ 兼容性：部分源不接受多 id（实测 suoni 返回空、bfzy 偶发超时），
 *   此时自动回退为逐条查询（限量），保证不丢数据。
 *
 * @param timeoutMs 单次请求超时（批量请求用）
 */
export async function cmsDetails(
  source: CmsSource,
  vodIds: number[],
  timeoutMs = 12000,
): Promise<CmsDetail[]> {
  if (!vodIds.length) return [];

  const deadline = Date.now() + timeoutMs;

  const url = source.base + '?' + qs({ ac: 'detail', ids: vodIds.join(',') });
  try {
    const j = await httpJson<any>(url, { timeoutMs });
    const list = (j.list || []) as CmsDetail[];
    if (list.length) {
      // 按请求顺序对齐（源不保证返回顺序）
      const map = new Map<number, CmsDetail>();
      for (const d of list) map.set(Number(d.vod_id), d);
      return vodIds.map((id) => map.get(id)).filter(Boolean) as CmsDetail[];
    }
  } catch {
    /* 落空则回退逐条 */
  }

  // 回退：逐条查（慢但可靠）。
  //
  // ⚠️ 必须受**总时间预算**约束：慢源逐条要 10 秒/条，
  // 20 条就是 200 秒 → 首屏会被拖死。
  // 超预算就放弃剩余条目（它们会以无海报状态被延后，不进首屏）。
  const out: CmsDetail[] = [];
  for (const id of vodIds.slice(0, 8)) {
    const remain = deadline - Date.now();
    if (remain <= 500) break; // 预算耗尽
    try {
      const d = await cmsDetailSingle(source, id, Math.min(remain, 5000));
      if (d) out.push(d);
    } catch {
      /* 忽略单条失败 */
    }
  }
  return out;
}

/** 单条详情（内部用，避免与 cmsDetails 互相递归） */
async function cmsDetailSingle(
  source: CmsSource,
  vodId: number,
  timeoutMs = 15000,
): Promise<CmsDetail | null> {
  const url = source.base + '?' + qs({ ac: 'detail', ids: vodId });
  const j = await httpJson<any>(url, { timeoutMs });
  const list = (j.list || []) as CmsDetail[];
  return list[0] ?? null;
}

/**
 * 竞速取数 —— 第一个成功的就返回，其余在后台继续
 *
 * ── 为什么必须有这个 ──────────────────────────────────
 * 实测：9 个源并发探测时，总耗时 = 最慢那个源的耗时（10 秒超时），
 * 因为 Promise.all 要等所有人。**并发并不能解决「慢源拖累整体」**。
 *
 * 用户反馈的「太卡、加载不出来」根因就在这里：
 * 只要有一个源不可达（要等满超时），整屏就卡住。
 *
 * 对策：竞速 + 超时上限。片库只用最先回来的源，
 * 其余源的结果在后台补进缓存，下次刷新就能用上。
 *
 * @param tasks  各源的任务
 * @param ms     超时上限，超时后用已成功的结果（无则抛错）
 */
export async function raceWithTimeout<T>(
  tasks: Array<{ name: string; run: () => Promise<T> }>,
  ms = 8000,
): Promise<T[]> {
  const collected: T[] = [];
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

  // 超时定时器 —— 到点后不再等新结果
  const timer = new Promise<'timeout'>((resolve) => {
    setTimeout(() => resolve('timeout'), ms);
  });

  const outcome = await Promise.race([all.then(() => 'done' as const), timer]);

  if (outcome === 'done') {
    done = true;
    return collected;
  }

  // 超时：先返回已收到的结果
  const snapshot = [...collected];
  done = true;
  return snapshot;
}

/**
 * 竞速取数（快模式）—— 第一个成功就立刻返回
 *
 * 与 raceWithTimeout 的区别：不等所有源，也不等超时上限。
 * 适合「只要有一份数据就能先渲染」的场景（如片库首屏）。
 *
 * @param minCount 至少要几个结果才返回（0 = 第一个就返回）
 * @param ms       最长等待
 */
export async function raceFirst<T>(
  tasks: Array<{ name: string; run: () => Promise<T> }>,
  minCount = 0,
  ms = 8000,
  /**
   * 结果过滤器 —— 只有通过判定的结果才被收集、才计入 minCount
   *
   * ⚠️ 搜索场景必须用它：某些源对关键词无匹配时会返回**空列表**，
   * 空列表同样是「成功返回」，若不过滤就会让竞速提前结束并返回空结果，
   * 表现为「搜不到影片」。
   */
  accept?: (r: T) => boolean,
): Promise<T[]> {
  const collected: T[] = [];
  let done = false;

  const runners = tasks.map(async (t) => {
    try {
      const r = await t.run();
      if (!done && (accept ? accept(r) : true)) collected.push(r);
      return r;
    } catch {
      return null;
    }
  });

  // 全部跑完（作为兜底：若一个都没成功，等它们）
  const all = Promise.all(runners);

  const timer = new Promise<'timeout'>((resolve) => {
    setTimeout(() => resolve('timeout'), ms);
  });

  // 达到 minCount 就返回
  const enough = new Promise<'enough'>((resolve) => {
    const check = () => {
      if (collected.length >= minCount && minCount > 0) {
        done = true;
        resolve('enough');
      }
    };
    const iv = setInterval(check, 30);
    // 定时器到点后由 race 的 timer 分支处理
    setTimeout(() => clearInterval(iv), ms);
  });

  const outcome = await Promise.race([
    all.then(() => 'done' as const),
    enough,
    timer,
  ]);

  if (outcome === 'done') {
    done = true;
    return collected;
  }

  const snapshot = [...collected];
  done = true;
  return snapshot;
}

/**
 * 取分类表
 * 各源 type_id 不通用，靠这个接口动态获取。
 */
export async function cmsTypes(source: CmsSource): Promise<CmsCategory[]> {
  const url = source.base + '?ac=type';
  const j = await httpJson<any>(url, { timeoutMs: 10000 });
  const list = (j.list || []) as any[];
  // 去重（实测部分源会返回重复项）
  const seen = new Set<number>();
  const out: CmsCategory[] = [];
  for (const c of list) {
    const id = Number(c.type_id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ typeId: id, name: c.type_name || '' });
  }
  return out;
}

/**
 * 按关键词在源的分类表里找匹配的类型 id
 * 这是跨源通用的做法 —— 各源 type_id 完全不同，只能按名称匹配。
 */
export function matchTypeId(
  categories: CmsCategory[],
  keywords: string[],
): number | undefined {
  // 先精确匹配名称
  for (const kw of keywords) {
    const hit = categories.find((c) => c.name === kw);
    if (hit) return hit.typeId;
  }
  // 再包含匹配
  for (const kw of keywords) {
    const hit = categories.find((c) => c.name.includes(kw));
    if (hit) return hit.typeId;
  }
  return undefined;
}

/**
 * 解析播放地址
 *
 * 只保留 m3u8 直链线路 —— 另一类线路是网页播放页（/share/xxx），
 * 喂给播放器只会白屏。
 */
export function parsePlayLines(detail: CmsDetail): PlayLine[] {
  const fromRaw = detail.vod_play_from || '';
  const urlRaw = detail.vod_play_url || '';
  if (!urlRaw) return [];

  const froms = fromRaw.split('$$$');
  const urlGroups = urlRaw.split('$$$');
  const lines: PlayLine[] = [];

  for (let i = 0; i < urlGroups.length; i++) {
    const group = urlGroups[i];
    if (!group) continue;

    const episodes = group
      .split('#')
      .map((seg) => {
        const idx = seg.indexOf('$');
        if (idx < 0) return null;
        const name = seg.slice(0, idx).trim();
        const url = seg.slice(idx + 1).trim();
        if (!url) return null;
        return { name, url };
      })
      .filter((x): x is { name: string; url: string } => !!x);

    if (!episodes.length) continue;

    const from = (froms[i] || `线路${i + 1}`).trim();
    const hasM3u8 = episodes.some((e) => e.url.includes('.m3u8'));
    if (!hasM3u8) continue;

    lines.push({ from, episodes });
  }

  return lines;
}

/**
 * 从详情中挑出指定集数的地址
 *
 * 匹配策略（按优先级）：
 *   1. 集名精确等于「第 N 集」/「N」
 *   2. 集名中包含 N
 *   3. 按下标取第 N-1 个（兜底）
 */
export function pickEpisode(
  lines: PlayLine[],
  episode: number,
): { url: string; line: string; index: number } | null {
  for (const line of lines) {
    const norm = (s: string) => s.replace(/[\s]/g, '');

    // 1. 精确
    for (let i = 0; i < line.episodes.length; i++) {
      const n = norm(line.episodes[i].name);
      if (n === `第${episode}集` || n === `${episode}` || n === `EP${episode}`) {
        return { url: line.episodes[i].url, line: line.from, index: i };
      }
    }
    // 2. 包含
    for (let i = 0; i < line.episodes.length; i++) {
      const n = norm(line.episodes[i].name);
      if (n.includes(`第${episode}集`) || new RegExp(`(第)?${episode}(集|话|期)`).test(n)) {
        return { url: line.episodes[i].url, line: line.from, index: i };
      }
    }
  }

  // 3. 下标兜底 —— 只在唯一线路有足够集数时使用
  const first = lines[0];
  if (first && first.episodes.length >= episode) {
    return { url: first.episodes[episode - 1].url, line: first.from, index: episode - 1 };
  }

  return null;
}

/**
 * 在多个源中搜索某片，返回候选（按源权重排序）
 *
 * 只在健康源上搜索 —— 失效源会拖慢整条链路（每个不可达源都要等超时）。
 */
export async function searchAcrossSources(
  keyword: string,
  sources: CmsSource[] = CMS_SOURCES,
): Promise<{ source: CmsSource; item: CmsListItem }[]> {
  const pool = healthySources(sources);
  const results = await Promise.all(
    pool.map(async (source) => {
      try {
        const r = await cmsList(source, { keyword, limit: 10 });
        return r.list.map((item) => ({ source, item }));
      } catch {
        return [];
      }
    }),
  );

  const flat = results.flat();
  // 源权重优先，其次按名称长度贴近关键词优先（更精确的匹配排前面）
  return flat.sort((a, b) => {
    if (a.source.weight !== b.source.weight) return b.source.weight - a.source.weight;
    const la = a.item.vod_name.length;
    const lb = b.item.vod_name.length;
    return la - lb;
  });
}
