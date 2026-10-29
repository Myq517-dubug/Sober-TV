/**
 * 直播数据层
 *
 * ── 设计要点 ──────────────────────────────────────────
 * 1. **内置公开源 + 自导入**：内置几类公开维护的第三方播放列表
 *    （综合、超清、影视轮播、港澳台、IPv6 备用），开箱即用；
 *    同时保留自定义 M3U / TXT 导入。内置源只是地址清单，
 *    不托管任何流媒体内容，可用性由上游决定，且可随时停用。
 * 2. **同名同分组合并成多线路**：公开直播源稳定性差，
 *    同一个台往往在列表里出现多次，合并后可以自动顺延。
 * 3. **协议白名单**：只保留 HTTP(S) 的 m3u8 / ts / mpd。
 *    rtmp / rtsp / udp 组播 ExoPlayer 默认不支持，直接过滤，
 *    免得用户点了半天一直转圈。
 * 4. **缓存**：直播源动辄几千个台，每次进页面都重新下载太慢，
 *    解析结果按来源缓存到 localStorage，失败时继续用旧数据。
 */

import { httpText } from './net';

const SOURCE_KEY = 'sober.live.sources';
const CACHE_KEY = 'sober.live.cache';
const RECENT_KEY = 'sober.live.recent';
const FAV_KEY = 'sober.live.fav';
const BUILTIN_KEY = 'sober.live.builtin.v';

/** 内置源目录版本：加新分类时 +1，老用户升级后自动补齐缺失的条目 */
const BUILTIN_VERSION = 3;

/** 单个频道的一条线路 */
export interface ChannelLine {
  label: string;
  url: string;
}

/** 一个频道（同名同分组的多条线路已被合并） */
export interface LiveChannel {
  id: string;
  name: string;
  group: string;
  logo?: string;
  lines: ChannelLine[];
}

/** 用户导入的直播源 */
export interface LiveSource {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  addedAt: number;
  /** 上次拉取到的频道数 */
  count?: number;
  lastError?: string;
  /** 是否来自内置目录（内置源不可删除，只能停用） */
  builtin?: boolean;
  /** 分类标签：内置源在面板里按它分组展示 */
  category?: string;
  /** 一句话说明，展示在面板里 */
  note?: string;
  /** 该源的分组信息不适合展示（如英文分组）时，统一归到 category */
  flattenGroup?: boolean;
  /**
   * 只保留央视频道
   *
   * 央视多线路源整份列表里还混着卫视、地方台，这里按频道名过滤，
   * 只把央视的线路补进已有的央视频道，避免整份列表重复导入。
   */
  onlyCctv?: boolean;
  /**
   * 合并优先级：数值越大，它的线路越靠前
   *
   * 线路顺序 = 播放失败时的顺延顺序。央视综合源里不少单播地址
   * 已失效（整片 404），必须让稳定源排在前面，否则用户点开央视
   * 会先连撞几条死链，甚至撞满顺延上限后直接报错。
   */
  priority?: number;
}

/** 内置源目录项 */
interface BuiltinSourceDef {
  id: string;
  name: string;
  category: string;
  note: string;
  url: string;
  /** 首次启动是否默认启用 */
  enabled: boolean;
  flattenGroup?: boolean;
  onlyCctv?: boolean;
  priority?: number;
}

/**
 * 内置直播源目录
 *
 * 全部是公开仓库里长期维护的播放列表地址，本项目不转存任何流。
 * 中文源优先（分组即分类），英文分组源用 flattenGroup 归并到分类下。
 */
export const BUILTIN_SOURCES: BuiltinSourceDef[] = [
  {
    id: 'builtin-cn',
    name: '综合直播源',
    category: '综合',
    note: '央视、卫视、地方、体育、影视、少儿、纪录、音乐等主流频道',
    url: 'https://cdn.jsdelivr.net/gh/vbskycn/iptv@master/tv/iptv4.m3u',
    enabled: true,
    priority: 10,
  },
  {
    id: 'builtin-cctv',
    name: '央视多线路源',
    category: '综合',
    note: '央视 1-17 套与 4K/8K，每个台约 20 条线路，主源失效时自动顺延',
    url: 'https://cdn.jsdelivr.net/gh/CCSH/IPTV@main/live.m3u',
    enabled: true,
    onlyCctv: true,
    priority: 50,
  },
  {
    id: 'builtin-4k',
    name: '4K / 8K 超清源',
    category: '超清',
    note: '4K 8K 与历年春晚专场，画质优先、带宽占用较高',
    url: 'https://cdn.jsdelivr.net/gh/Kimentanm/aptv@master/m3u/iptv.m3u',
    enabled: true,
  },
  {
    id: 'builtin-vod',
    name: '影视轮播 · 咪咕',
    category: '影视',
    note: '影视轮播、游戏赛事与咪咕系频道，补充综合源缺失的类型',
    url: 'https://cdn.jsdelivr.net/gh/YanG-1989/m3u@main/Gather.m3u',
    enabled: true,
  },
  {
    id: 'builtin-ent',
    name: '网络娱乐直播',
    category: '网络娱乐',
    note: '虎牙 / 斗鱼 / B 站 / YY 的一起看与轮播：杂谈、户外、萌宠、助眠等',
    url: 'https://cdn.jsdelivr.net/gh/CCSH/IPTV@main/live_platforms.m3u',
    enabled: true,
  },
  {
    id: 'builtin-hk',
    name: '香港频道',
    category: '港澳台',
    note: '香港地区公开频道，频道名为英文',
    url: 'https://iptv-org.github.io/iptv/countries/hk.m3u',
    enabled: false,
    flattenGroup: true,
  },
  {
    id: 'builtin-tw',
    name: '台湾频道',
    category: '港澳台',
    note: '台湾地区公开频道，频道名为英文',
    url: 'https://iptv-org.github.io/iptv/countries/tw.m3u',
    enabled: false,
    flattenGroup: true,
  },
  {
    id: 'builtin-mo',
    name: '澳门频道',
    category: '港澳台',
    note: '澳门地区公开频道，频道名为英文',
    url: 'https://iptv-org.github.io/iptv/countries/mo.m3u',
    enabled: false,
    flattenGroup: true,
  },
  {
    id: 'builtin-ipv6',
    name: 'IPv6 备用源',
    category: '备用',
    note: '仅在 IPv6 网络下可用，作为主源失效时的兜底',
    url: 'https://cdn.jsdelivr.net/gh/fanmingming/live@main/tv/m3u/ipv6.m3u',
    enabled: false,
  },
];

const BUILTIN_MAP = new Map(BUILTIN_SOURCES.map((d) => [d.id, d]));

function toLiveSource(def: BuiltinSourceDef, at = Date.now()): LiveSource {
  return {
    id: def.id,
    name: def.name,
    url: def.url,
    enabled: def.enabled,
    addedAt: at,
    builtin: true,
    category: def.category,
    note: def.note,
    flattenGroup: def.flattenGroup,
    onlyCctv: def.onlyCctv,
    priority: def.priority,
  };
}

export interface LiveCache {
  at: number;
  channels: LiveChannel[];
}

/** 最近观看（存完整信息，缓存刷新后依然能播） */
export interface RecentChannel {
  id: string;
  name: string;
  group: string;
  logo?: string;
  url: string;
  at: number;
}

// ── 源管理 ──────────────────────────────────────────────

export function loadLiveSources(): LiveSource[] {
  try {
    const raw = localStorage.getItem(SOURCE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x && typeof x.url === 'string' && x.url)
      .map((x) => {
        const id = String(x.id || `live-${x.url.length}-${x.url.slice(-12)}`);
        // 内置源的地址 / 分类以目录为准：上游换地址后用户无需手动改
        const def = BUILTIN_MAP.get(id);
        return {
          id,
          name: String(x.name || def?.name || '直播源'),
          url: def ? def.url : String(x.url),
          enabled: x.enabled !== false,
          addedAt: Number(x.addedAt) || Date.now(),
          count: typeof x.count === 'number' ? x.count : undefined,
          lastError: typeof x.lastError === 'string' ? x.lastError : undefined,
          builtin: def ? true : undefined,
          category: def?.category,
          note: def?.note,
          flattenGroup: def?.flattenGroup,
          onlyCctv: def?.onlyCctv,
          priority: def?.priority,
        };
      });
  } catch {
    return [];
  }
}

export function saveLiveSources(list: LiveSource[]): void {
  try {
    localStorage.setItem(SOURCE_KEY, JSON.stringify(list));
  } catch {
    /* 存储不可用时忽略 */
  }
}

/**
 * 补齐内置源
 *
 * 首次启动直接铺满目录；老用户升级时按 BUILTIN_VERSION 增量补齐，
 * 用户自己停用的内置源不会被重新打开。
 */
export function seedBuiltinSources(): LiveSource[] {
  let list = loadLiveSources();
  let version = 0;
  try {
    version = Number(localStorage.getItem(BUILTIN_KEY)) || 0;
  } catch {
    version = 0;
  }
  if (version >= BUILTIN_VERSION) return list;

  const have = new Set(list.map((s) => s.id));
  const add = BUILTIN_SOURCES.filter((d) => !have.has(d.id)).map((d) => toLiveSource(d));
  list = [...list, ...add];
  saveLiveSources(list);
  try {
    localStorage.setItem(BUILTIN_KEY, String(BUILTIN_VERSION));
  } catch {
    /* ignore */
  }
  return list;
}

/** 内置源被手动删掉后，从面板一键恢复（保持当前启用状态优先） */
export function restoreBuiltinSources(list: LiveSource[]): LiveSource[] {
  const have = new Set(list.map((s) => s.id));
  const add = BUILTIN_SOURCES.filter((d) => !have.has(d.id)).map((d) => toLiveSource(d));
  if (!add.length) return list;
  const next = [...list, ...add];
  saveLiveSources(next);
  return next;
}

/** 规范化用户输入的地址（补协议、去空白） */
export function normalizePlaylistUrl(input: string): string | null {
  let s = (input || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    // 只做合法性校验，路径保持原样（播放列表参数经常是必需的）
    new URL(s);
    return s;
  } catch {
    return null;
  }
}

// ── 播放列表解析 ────────────────────────────────────────

/** 支持的协议/容器：HLS、MPEG-TS、DASH */
function isSupportedUrl(url: string): boolean {
  const u = url.trim().toLowerCase();
  if (!/^https?:\/\//.test(u) && !/^\//.test(u)) return false;
  // 点播文件不是直播流：某些源会混入 mp4 演示片，直接丢弃
  if (/\.(mp4|mkv|flv|avi|mov|webm|mp3|m4a)(\?|#|$)/.test(u)) return false;
  if (/\.m3u8(\?|#|$)/.test(u)) return true;
  if (/\.m3u?(\?|#|$)/.test(u)) return true;
  if (/\.mpd(\?|#|$)/.test(u)) return true;
  if (/\.ts(\?|#|$)/.test(u)) return true;
  // 少量源把地址包在跳转接口里，没有扩展名也放行
  return !/^rtmp|^rtsp|^udp|^rtp|^p2p/.test(u) && u.includes('://');
}

/**
 * 分组名归一化
 *
 * 公开源里同一个分组常有 IPV4/IPV6、央视/央视频道 等写法，
 * 归一后同频道能合并成多线路，分类 chip 也不会碎片化。
 */
function normalizeGroup(raw: string): string {
  let s = (raw || '').trim();
  // 去装饰：前置 emoji / 图标符号，以及「港·澳·台」这类间隔点
  s = s.replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s•]+/u, '').replace(/[·•・]/g, '');
  s = s.replace(/\s*ipv[46]\s*$/i, '').trim();
  if (!s) return '未分组';
  if (/^央视/.test(s)) return '央视频道';
  if (/^卫视/.test(s)) return '卫视频道';
  if (/^地方/.test(s)) return '地方频道';
  if (/^(动画|少儿)/.test(s)) return '儿童频道';
  return s;
}

/** 分类排序：央视 → 卫视 → 地方 → 港澳台 → 体育 → 影视 → 少儿 → 纪录 → 音乐 → 超清 → 网络娱乐 */
const GROUP_RANK: Array<[RegExp, number]> = [
  [/^央视频道/, 10],
  [/^卫视频道/, 20],
  [/^地方频道/, 30],
  [/^港澳台/, 40],
  [/^(体育|赛事)/, 50],
  [/^(影视|电影|经典剧场)/, 60],
  [/^(儿童|少儿|动画)/, 70],
  [/^(纪录|纪实)/, 80],
  [/^(新闻)/, 85],
  [/^(音乐|戏曲)/, 90],
  [/^4k|^8k|超清/i, 100],
  // 网络娱乐：平台轮播在前，其余场景分类按拼音排在其后
  [/^(一起看|原创ip|zonghe|原创|网络)/i, 300],
  [/^(手工绘画|萌宠|户外|美食|时尚|情感杂谈|生活杂谈|沉浸体验|电子榨菜|car|运动体育)/i, 310],
];

/** 分组排序比较器，未知分组按中文拼音排在最后 */
export function compareGroups(a: string, b: string): number {
  const ra = GROUP_RANK.find(([re]) => re.test(a))?.[1] ?? 500;
  const rb = GROUP_RANK.find(([re]) => re.test(b))?.[1] ?? 500;
  if (ra !== rb) return ra - rb;
  return a.localeCompare(b, 'zh');
}

/** 源里混入的「更新时间」「2026-10-29 06:14」之类占位行 */
function isJunkChannel(name: string, group: string): boolean {
  if (/更新时间$/.test(group)) return true;
  // 上游列表常用「4K60PSDR 测试」这类验证片占位
  if (/测试/.test(name)) return true;
  if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(name)) return true;
  return false;
}

/** 从 #EXTINF 行里取属性 */
function attr(line: string, key: string): string | undefined {
  const re = new RegExp(`${key}="([^"]*)"`, 'i');
  const m = line.match(re);
  return m ? m[1] : undefined;
}

/** 频道 id：名称 + 分组，保证跨刷新稳定 */
function channelId(name: string, group: string): string {
  let h = 5381;
  const s = `${group}|${name}`;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `ch${(h >>> 0).toString(36)}`;
}

/** 合并同名同分组的频道 */
function mergeChannel(
  map: Map<string, LiveChannel>,
  name: string,
  group: string,
  url: string,
  logo?: string,
): void {
  const n = name.trim();
  if (!n) return;
  const g = normalizeGroup(group);
  if (isJunkChannel(n, g)) return;
  const id = channelId(n, g);
  const exist = map.get(id);
  if (exist) {
    if (!exist.lines.some((l) => l.url === url)) {
      exist.lines.push({ label: `线路${exist.lines.length + 1}`, url });
    }
    if (!exist.logo && logo) exist.logo = logo;
    return;
  }
  map.set(id, {
    id,
    name: n,
    group: g,
    logo: logo || undefined,
    lines: [{ label: '线路1', url }],
  });
}

/**
 * 解析 M3U / M3U8 播放列表
 *
 * 兼容常见变体：
 *   · 标准 #EXTM3U + #EXTINF:-1 tvg-logo="..." group-title="...",频道名
 *   · 单行 `频道名,http://...`
 */
function parseM3u(text: string, out: Map<string, LiveChannel>): void {
  const lines = text.split(/\r?\n/);
  let pendingName = '';
  let pendingGroup = '';
  let pendingLogo: string | undefined;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      // 名称在最后一个逗号之后
      const comma = line.lastIndexOf(',');
      pendingName =
        comma >= 0 ? line.slice(comma + 1).trim() : (attr(line, 'tvg-name') || '').trim();
      pendingGroup = (attr(line, 'group-title') || attr(line, 'group') || '未分组').trim();
      pendingLogo = attr(line, 'tvg-logo') || attr(line, 'logo');
      continue;
    }

    if (line.startsWith('#')) continue;

    if (pendingName) {
      if (isSupportedUrl(line)) {
        mergeChannel(out, pendingName, pendingGroup, line, pendingLogo);
      }
      pendingName = '';
      pendingGroup = '';
      pendingLogo = undefined;
      continue;
    }

    // 无 #EXTINF 的简写：频道名,地址
    const comma = line.indexOf(',');
    if (comma > 0) {
      const name = line.slice(0, comma).trim();
      const rest = line.slice(comma + 1).trim();
      // 一行多线路用 # 分隔
      for (const u of rest.split('#')) {
        if (isSupportedUrl(u)) mergeChannel(out, name, '未分组', u.trim());
      }
    }
  }
}

/**
 * 解析 TXT 播放列表（DIYP / 电视家风格）
 *
 *   央视频道,#genre#
 *   CCTV-1,http://xxx.m3u8
 */
function parseTxt(text: string, out: Map<string, LiveChannel>): void {
  let group = '未分组';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    if (/,+#genre#$/i.test(line)) {
      group = line.split(',')[0].trim() || '未分组';
      continue;
    }

    const comma = line.indexOf(',');
    if (comma <= 0) continue;
    const name = line.slice(0, comma).trim();
    // 同一台的多条线路可能用 # 或 , 分隔
    const rest = line.slice(comma + 1).trim();
    const urls = rest.split(/[#,]/).filter(Boolean);
    for (const u of urls) {
      if (isSupportedUrl(u)) mergeChannel(out, name, group, u.trim());
    }
  }
}

/** 解析任意播放列表文本 */
export function parsePlaylist(text: string): LiveChannel[] {
  const out = new Map<string, LiveChannel>();
  if (!text) return [];
  if (/^\s*#EXTM3U/i.test(text) || /#EXTINF/i.test(text)) {
    parseM3u(text, out);
  } else {
    parseTxt(text, out);
  }
  return [...out.values()].sort(
    (a, b) => compareGroups(a.group, b.group) || a.name.localeCompare(b.name, 'zh'),
  );
}

// ── 缓存 ────────────────────────────────────────────────

/** 频道缓存上限：再大的列表也没必要全存进 localStorage */
const MAX_CACHE_CHANNELS = 4000;

export function readChannelCache(): LiveCache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as LiveCache;
    if (!data || !Array.isArray(data.channels) || !data.channels.length) return null;
    return data;
  } catch {
    return null;
  }
}

function writeChannelCache(channels: LiveChannel[]): void {
  try {
    const trimmed = channels.slice(0, MAX_CACHE_CHANNELS);
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), channels: trimmed }));
  } catch {
    /* 配额不足时放弃缓存，不影响当次使用 */
  }
}

/**
 * 拉取全部启用源并合并
 *
 * 单个源失败不影响其他源；全部失败时返回空数组，由调用方决定是否沿用旧缓存。
 */
export async function fetchChannels(
  sources: LiveSource[],
  onProgress?: (done: number, total: number) => void,
): Promise<LiveChannel[]> {
  const enabled = sources.filter((s) => s.enabled !== false);
  if (!enabled.length) return [];

  // 高优先级源先合并 —— 合并顺序决定「线路1/2/3」的顺序，
  // 也就是播放失败时的顺延顺序。并发抓取、按序合并，既有速度又稳定。
  const ordered = [...enabled].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  const merged = new Map<string, LiveChannel>();
  let done = 0;

  const lists = await Promise.all(
    ordered.map(async (src) => {
      try {
        const res = await httpText(src.url, { timeoutMs: 20000 });
        if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
        const list = parsePlaylist(res.body).filter(
          (ch) => !src.onlyCctv || /^(CCTV|央视)/i.test(ch.name),
        );
        src.count = list.length;
        src.lastError = undefined;
        return list;
      } catch (e) {
        src.lastError = e instanceof Error ? e.message : String(e);
        return null;
      } finally {
        done++;
        onProgress?.(done, ordered.length);
      }
    }),
  );

  for (let i = 0; i < ordered.length; i++) {
    const src = ordered[i];
    const list = lists[i];
    if (!list) continue;
    for (const ch of list) {
      // 英文分组的源统一归到它自己的分类下，避免出现一堆英文 chip
      const g = src.flattenGroup && src.category ? src.category : ch.group;
      for (const line of ch.lines) {
        mergeChannel(merged, ch.name, g, line.url, ch.logo);
      }
    }
  }

  const channels = [...merged.values()].sort(
    (a, b) => compareGroups(a.group, b.group) || a.name.localeCompare(b.name, 'zh'),
  );
  if (channels.length) writeChannelCache(channels);
  return channels;
}

// ── 最近观看 ────────────────────────────────────────────

export function loadRecent(): RecentChannel[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => x && x.url).slice(0, 12) : [];
  } catch {
    return [];
  }
}

export function pushRecent(ch: LiveChannel, url: string): RecentChannel[] {
  const item: RecentChannel = {
    id: ch.id,
    name: ch.name,
    group: ch.group,
    logo: ch.logo,
    url,
    at: Date.now(),
  };
  const list = [item, ...loadRecent().filter((x) => x.id !== ch.id)].slice(0, 12);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
  return list;
}

// ── 收藏频道 ────────────────────────────────────────────

export function loadFavChannels(): string[] {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function toggleFavChannel(id: string): string[] {
  const list = loadFavChannels();
  const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}
