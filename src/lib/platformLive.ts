/**
 * 平台直播数据层
 *
 * ── 数据源 ────────────────────────────────────────────
 *   · B 站：分区接口（room/v1/Area/getRoomList）+ 首页推荐 + 搜索
 *   · 虎牙：LiveList 分页目录（多个备用域名）
 *   · 斗鱼：目录接口（www / m 两套备用路径）
 *   · 抖音：直播站分类页的 React 服务端渲染数据（免签名）
 *
 * 四家的列表接口都只返回「正在直播」的房间，页面再按 60 秒轮询刷新，
 * 下播的主播会自动从墙上消失。
 *
 * ── 分类 ──────────────────────────────────────────────
 *   B 站有真实分区 ID（颜值 145 / 舞见 207 / 唱见 21 / 户外 368 …），
 *   虎牙斗鱼没有公开分区列表，用「分区名 + 标题」规则归类。
 *
 * ── 播放地址 ──────────────────────────────────────────
 *   B 站能直接拿到 HLS / FLV。
 *   虎牙、斗鱼与抖音的流地址都带防盗链签名，客户端无法本地计算。
 *   抖音的签名地址直接写在其服务端渲染的页面里，解析页面即可拿到；
 *   虎牙与斗鱼走公开解析接口（api.zxki.cn）换取临时地址。
 *   这三类线路都是 HTTP-FLV / 无 CORS 的 HLS，hls.js 播不了，
 *   标记 nativeOnly 交给原生 ExoPlayer。
 */

import { httpJson, httpText } from './net';

export type PlatformId = 'bili' | 'huya' | 'douyu' | 'douyin';
export type PlatformFilter = 'all' | PlatformId;
export type CategoryId = 'hot' | 'game' | 'beauty' | 'dance' | 'asmr' | 'music' | 'outdoor';

export interface LiveRoom {
  /** 全局唯一：platform:roomId */
  id: string;
  platform: PlatformId;
  roomId: string;
  /** 抖音的外部房间号，走解析接口时用它 */
  webRid?: string;
  title: string;
  anchor: string;
  avatar?: string;
  cover?: string;
  area: string;
  online: number;
}

export interface RoomLine {
  label: string;
  url: string;
  headers?: Record<string, string>;
  /** HTTP-FLV 等 Web 引擎播不了的线路，必须走原生 ExoPlayer */
  nativeOnly?: boolean;
}

export interface RoomStream {
  lines: RoomLine[];
  title?: string;
  anchor?: string;
  area?: string;
}

export interface LoadResult {
  rooms: LiveRoom[];
  errors: Partial<Record<PlatformId, string>>;
}

export const PLATFORM_ORDER: PlatformId[] = ['bili', 'huya', 'douyu', 'douyin'];

export const PLATFORM_META: Record<PlatformId, { name: string; short: string }> = {
  bili: { name: 'B站', short: 'B' },
  huya: { name: '虎牙', short: '虎' },
  douyu: { name: '斗鱼', short: '鱼' },
  douyin: { name: '抖音', short: '抖' },
};

export const CATEGORIES: { id: CategoryId; name: string }[] = [
  { id: 'hot', name: '推荐' },
  { id: 'game', name: '游戏' },
  { id: 'beauty', name: '颜值' },
  { id: 'dance', name: '舞蹈' },
  { id: 'asmr', name: 'ASMR' },
  { id: 'music', name: '音乐' },
  { id: 'outdoor', name: '户外' },
];

/** B 站真实分区（parent 大类 / cate 子分区，0 表示整个大类） */
const BILI_AREAS: Record<Exclude<CategoryId, 'hot' | 'asmr'>, { parent: number; cate: number }[]> = {
  game: [
    { parent: 2, cate: 0 },
    { parent: 3, cate: 0 },
    { parent: 6, cate: 0 },
  ],
  beauty: [{ parent: 1, cate: 145 }],
  dance: [{ parent: 1, cate: 207 }],
  music: [
    { parent: 1, cate: 21 },
    { parent: 5, cate: 190 },
  ],
  outdoor: [{ parent: 10, cate: 368 }],
};

/** B 站已撤掉 ASMR 分区，只能靠搜索捞在播的助眠主播 */
const ASMR_KEYWORDS = ['ASMR', '助眠', '耳语'];

/** 虎牙 / 斗鱼的花名没有统一字段，按分区名 + 标题归类 */
const CATEGORY_RULES: Array<[Exclude<CategoryId, 'hot'>, RegExp]> = [
  ['asmr', /asmr|助眠|耳语|哄睡|电台|语音|采耳/i],
  ['dance', /舞蹈|宅舞|韩舞|街舞|爵士|中国舞|古典舞|跳舞|舞见/i],
  ['beauty', /颜值|星秀|美女|女神|小姐姐|交友|模特|团播|脱口秀/i],
  ['music', /音乐|唱见|唱歌|歌手|弹琴|吉他|乐器|古风|二次元|虚拟/i],
  ['outdoor', /户外|一起看|聊天|杂谈|生活|美食|旅行|萌宠|运动|汽车|桌游/i],
  [
    'game',
    /游戏|英雄联盟|王者|和平精英|绝地求生|cs|dota|无畏契约|三角洲|永劫|我的世界|穿越火线|魔兽|炉石|星际|守望|刀塔|原神|崩坏|主机|单机|手游|网游|赛事|lol|pubg|apex|valorant|fps|moba/i,
  ],
];

const BILI_REFERER = 'https://live.bilibili.com/';
const UA =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

/** 单个平台铺到墙上的上限，避免低热度房间把首屏撑爆 */
const PLATFORM_LIMIT = 120;

// ── 通用工具 ────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

function num(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(String(v ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** 搜索结果的标题带 <em> 高亮标签与 HTML 实体 */
function cleanText(v: unknown): string {
  return str(v)
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function fixUrl(v: unknown): string | undefined {
  let s = str(v).trim();
  if (!s) return undefined;
  if (s.startsWith('//')) s = `https:${s}`;
  if (!/^https?:\/\//i.test(s)) return undefined;
  return s;
}

/** B 站图床支持按尺寸裁切，卡片墙只取小图，省流量也快 */
function biliImg(url: string | undefined, w: number, h: number): string | undefined {
  if (!url || !/hdslb\.com/.test(url)) return url;
  return `${url.split('@')[0]}@${w}w_${h}h_1c.webp`;
}

function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/abort|timeout|timed out/i.test(m)) return '网络超时';
  if (/reset|ECONN|ENOTFOUND|failed|fetch|network/i.test(m)) return '网络不可达';
  return m.slice(0, 60) || '拉取失败';
}

function topByHeat(list: LiveRoom[], n = PLATFORM_LIMIT): LiveRoom[] {
  return [...list].sort((a, b) => b.online - a.online).slice(0, n);
}

/**
 * 垫底的 0 人房间要么是脏数据，要么确实没人看。
 * 热门平台列表里这种房间不少，过滤后观感更好；但如果过滤后所剩无几，
 * 说明这个平台的人数口径不可信（比如人气字段缺失），那就别过滤。
 */
function dropDead(list: LiveRoom[]): LiveRoom[] {
  const alive = list.filter((r) => r.online > 0);
  return alive.length >= 20 ? alive : list;
}

/** 多个平台交替合并：避免「全部」被单一平台霸屏 */
function interleave(parts: LiveRoom[][]): LiveRoom[] {
  const queues = parts.filter((p) => p.length).map((p) => [...p]);
  const out: LiveRoom[] = [];
  const seen = new Set<string>();
  let added = true;
  while (added) {
    added = false;
    for (const q of queues) {
      const room = q.shift();
      if (!room) continue;
      added = true;
      if (seen.has(room.id)) continue;
      seen.add(room.id);
      out.push(room);
    }
  }
  return out;
}

function dedupe(list: LiveRoom[]): LiveRoom[] {
  const map = new Map<string, LiveRoom>();
  for (const r of list) if (!map.has(r.id)) map.set(r.id, r);
  return [...map.values()];
}

// ── B 站 ────────────────────────────────────────────────

function biliRoom(r: any): LiveRoom | null {
  const roomId = str(r?.roomid ?? r?.room_id ?? r?.id);
  if (!roomId) return null;
  return {
    id: `bili:${roomId}`,
    platform: 'bili',
    roomId,
    title: cleanText(r?.title) || '正在直播',
    anchor: cleanText(r?.uname ?? r?.nick ?? ''),
    avatar: biliImg(fixUrl(r?.face ?? r?.uface ?? r?.anchor_info?.base_info?.face), 80, 80),
    cover: biliImg(
      fixUrl(r?.cover ?? r?.user_cover ?? r?.system_cover ?? r?.pic ?? r?.keyframe),
      480,
      270,
    ),
    area: cleanText(r?.area_name ?? r?.area_v2_name ?? r?.cate_name ?? ''),
    online: num(r?.online ?? r?.watched_show?.num),
  };
}

/** 首页推荐：约 24 个当前在播房间 */
async function biliHot(): Promise<LiveRoom[]> {
  const urls = [
    'https://api.live.bilibili.com/xlive/web-interface/v1/webMain/getList?platform=web',
    'https://api.live.bilibili.com/xlive/web-interface/v1/webMain/getMoreRecList?platform=web',
  ];
  const results = await Promise.allSettled(
    urls.map((u) =>
      httpJson<any>(u, { referer: BILI_REFERER, timeoutMs: 9000, headers: { Accept: 'application/json' } }),
    ),
  );
  const rooms: LiveRoom[] = [];
  let ok = false;
  for (const res of results) {
    if (res.status !== 'fulfilled') continue;
    const list = res.value?.data?.recommend_room_list;
    if (!Array.isArray(list)) continue;
    ok = true;
    for (const item of list) {
      const room = biliRoom(item);
      if (room) rooms.push(room);
    }
  }
  if (!ok) throw new Error('推荐列表拉取失败');
  return topByHeat(dedupe(rooms));
}

/** 按真实分区拉在播房间（这个接口不需要 WBI 签名） */
async function biliArea(parent: number, cate: number): Promise<LiveRoom[]> {
  const url =
    'https://api.live.bilibili.com/room/v1/Area/getRoomList?platform=web' +
    `&parent_area_id=${parent}&cate_id=${cate}&sort_type=online&page=1&page_size=30`;
  const j = await httpJson<any>(url, {
    referer: BILI_REFERER,
    timeoutMs: 9000,
    headers: { Accept: 'application/json' },
  });
  if (j?.code !== 0) throw new Error(j?.message || '分区列表异常');
  const list: any[] = Array.isArray(j?.data) ? j.data : [];
  const rooms: LiveRoom[] = [];
  for (const item of list) {
    const room = biliRoom(item);
    if (room) rooms.push(room);
  }
  return rooms;
}

/** 关键词搜索直播间（page 从 1 开始） */
async function biliSearch(keyword: string, page = 1): Promise<LiveRoom[]> {
  const url =
    'https://api.bilibili.com/x/web-interface/search/type?search_type=live_room' +
    `&keyword=${encodeURIComponent(keyword)}&page=${page}`;
  const j = await httpJson<any>(url, {
    referer: BILI_REFERER,
    timeoutMs: 10000,
    headers: { Accept: 'application/json' },
  });
  if (j?.code !== 0) throw new Error(j?.message || 'B站搜索接口异常');
  const result = j?.data?.result;
  if (!Array.isArray(result)) return [];
  const rooms: LiveRoom[] = [];
  for (const item of result) {
    if (item?.type && item.type !== 'live_room') continue;
    // 搜索结果会混入未开播 / 轮播录像，必须只留在播
    if (item?.live_status != null && Number(item.live_status) !== 1) continue;
    const room = biliRoom(item);
    if (room) rooms.push(room);
  }
  return rooms;
}

async function biliByCategory(category: CategoryId): Promise<LiveRoom[]> {
  if (category === 'hot') return biliHot();

  if (category === 'asmr') {
    const results = await Promise.allSettled(ASMR_KEYWORDS.map((kw) => biliSearch(kw, 1)));
    const rooms: LiveRoom[] = [];
    let ok = false;
    for (const res of results) {
      if (res.status !== 'fulfilled') continue;
      ok = true;
      rooms.push(...res.value);
    }
    if (!ok) throw new Error('B站 ASMR 搜索失败');
    return topByHeat(dedupe(rooms));
  }

  const areas = BILI_AREAS[category];
  const results = await Promise.allSettled(areas.map((a) => biliArea(a.parent, a.cate)));
  const rooms: LiveRoom[] = [];
  let ok = false;
  for (const res of results) {
    if (res.status !== 'fulfilled') continue;
    ok = true;
    rooms.push(...res.value);
  }
  if (!ok) throw new Error('B站分区列表拉取失败');
  return topByHeat(dedupe(rooms));
}

// ── 虎牙 ────────────────────────────────────────────────

/** 主站被墙时依次换备用域名，同一个接口三份都试 */
const HUYA_HOSTS = [
  'https://www.huya.com/cache.php',
  'https://mp.huya.com/cache.php',
  'https://m.huya.com/cache.php',
];

async function huyaPage(page: number): Promise<LiveRoom[]> {
  // 备用域名并发竞速：被墙的域名会立刻 RST，串行重试只会白等
  try {
    const j = await Promise.any(
      HUYA_HOSTS.map((host) =>
        httpJson<any>(`${host}?m=LiveList&do=getLiveListByPage&tagAll=0&page=${page}`, {
          referer: 'https://www.huya.com/',
          timeoutMs: 9000,
          headers: { Accept: 'application/json, text/plain, */*' },
        }).then((data) => {
          if (!Array.isArray(data?.data?.datas)) throw new Error('虎牙列表格式异常');
          return data;
        }),
      ),
    );

    const datas: any[] = j.data.datas;
    const rooms: LiveRoom[] = [];
    for (const d of datas) {
      const roomId = str(d?.profileRoom ?? d?.rid ?? d?.roomId);
      if (!roomId) continue;
      if (d?.liveStatus != null && String(d.liveStatus) !== '1') continue;
      rooms.push({
        id: `huya:${roomId}`,
        platform: 'huya',
        roomId,
        title: cleanText(d?.roomName ?? d?.introduction) || '正在直播',
        anchor: cleanText(d?.nick ?? ''),
        avatar: fixUrl(d?.avatar180 ?? d?.avatar ?? d?.anchorAvatar),
        cover: fixUrl(d?.screenshot ?? d?.cover),
        area: cleanText(d?.gameFullName ?? d?.gameHostName ?? ''),
        online: num(d?.totalCount ?? d?.activityCount),
      });
    }
    return rooms;
  } catch (e) {
    if (e instanceof AggregateError) {
      throw new Error(errText(e.errors?.[0]));
    }
    throw e;
  }
}

async function huyaAll(): Promise<LiveRoom[]> {
  const results = await Promise.allSettled([huyaPage(1), huyaPage(2), huyaPage(3)]);
  const rooms: LiveRoom[] = [];
  let ok = false;
  let firstErr: unknown = null;
  for (const res of results) {
    if (res.status === 'fulfilled') {
      ok = true;
      rooms.push(...res.value);
    } else if (!firstErr) {
      firstErr = res.reason;
    }
  }
  if (!ok) throw new Error(errText(firstErr));
  return topByHeat(dropDead(dedupe(rooms)));
}

// ── 斗鱼 ────────────────────────────────────────────────

function douyuAvatar(v: unknown): string | undefined {
  const s = str(v).trim();
  if (!s) return undefined;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('//')) return `https:${s}`;
  return `https://apic.douyucdn.cn/upload/${s.replace(/^\/+/, '')}`;
}

function douyuCover(v: unknown): string | undefined {
  const s = str(v).trim();
  if (!s) return undefined;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('//')) return `https:${s}`;
  return undefined;
}

async function douyuPage(page: number): Promise<LiveRoom[]> {
  const attempts: Array<() => Promise<any[]>> = [
    async () => {
      const j = await httpJson<any>(`https://www.douyu.com/gapi/rkc/directory/0_0/${page}`, {
        referer: 'https://www.douyu.com/directory/all',
        timeoutMs: 9000,
        headers: { Accept: 'application/json, text/plain, */*' },
      });
      return Array.isArray(j?.data?.rl) ? j.data.rl : [];
    },
    async () => {
      const j = await httpJson<any>(`https://m.douyu.com/api/room/list?page=${page}&type=`, {
        referer: 'https://m.douyu.com/',
        timeoutMs: 9000,
        headers: { Accept: 'application/json, text/plain, */*' },
      });
      return Array.isArray(j?.data?.list) ? j.data.list : [];
    },
  ];

  let lastErr: unknown = null;
  for (const run of attempts) {
    try {
      const list = await run();
      if (!list.length) throw new Error('斗鱼列表为空');
      const rooms: LiveRoom[] = [];
      for (const d of list) {
        const roomId = str(d?.rid);
        if (!roomId) continue;
        rooms.push({
          id: `douyu:${roomId}`,
          platform: 'douyu',
          roomId,
          title: cleanText(d?.rn) || '正在直播',
          anchor: cleanText(d?.nn ?? ''),
          avatar: douyuAvatar(d?.av),
          cover: douyuCover(d?.rs16 ?? d?.rs1 ?? d?.room_pic),
          area: cleanText(d?.c2name ?? d?.c2name2 ?? ''),
          online: num(d?.ol),
        });
      }
      return rooms;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error('斗鱼列表拉取失败');
}

async function douyuAll(): Promise<LiveRoom[]> {
  const results = await Promise.allSettled([douyuPage(1), douyuPage(2), douyuPage(3)]);
  const rooms: LiveRoom[] = [];
  let ok = false;
  let firstErr: unknown = null;
  for (const res of results) {
    if (res.status === 'fulfilled') {
      ok = true;
      rooms.push(...res.value);
    } else if (!firstErr) {
      firstErr = res.reason;
    }
  }
  if (!ok) throw new Error(errText(firstErr));
  return topByHeat(dropDead(dedupe(rooms)));
}

// ── 抖音 ────────────────────────────────────────────────

/**
 * 抖音直播站的分区页是 React 服务端渲染，房间数据连同带签名的
 * FLV/HLS 地址一起写在 `self.__pace_f.push([1,"..."])` 的流式载荷里。
 * 这条路径不需要 a_bogus 签名，也不需要登录 Cookie。
 *
 * 代价是：免签名的推荐流只给低热度房间（实测在线 0~50），
 * 高热度榜必须带 a_bogus 调 partition/detail/room 接口，那条路不接。
 */
const DOUYIN_CATS = ['1', '101', '102', '103', '104', '105', '106', '107', '108'];
let douyinCursor = 0;

/** 推荐流里混着大量店铺 / 电商直播，标题和主播名里几乎都有这些词 */
const DOUYIN_SHOP =
  /官方号|旗舰店|专营店|专卖店|工厂店|实体店|体验店|门店|开业|招商|加盟|批发|源头工厂|清仓|甩卖|抢购|秒杀|上新|名品|轻奢|服饰|女装|男装|童装|内衣|箱包|潮鞋|珠宝|玉器|翡翠|玛瑙|文玩|核桃|茶叶|白酒|保健品|减肥|瘦身|祛斑|祛痘|医美|美容|美甲|假发|眼镜|家电|家具|建材|五金|汽配|轮胎|执照|代办|贷款|保险|房产|楼盘|装修|驾校|招生|招聘|民宿/;

/** 列表里拿到的原生流地址缓存，点开时直接用，避免再解析一次 */
const douyinStreams = new Map<string, { at: number; lines: RoomLine[] }>();

/** 从 start 位置的 { 开始取平衡括号内的 JSON 文本 */
function balancedObject(s: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/** 把页面里的流式载荷拼成一段连续文本 */
function pacePayload(html: string): string {
  const parts: string[] = [];
  const re = /self\.__pace_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      parts.push(JSON.parse(m[1]));
    } catch {
      // 单个坏块不影响其他块
    }
  }
  return parts.join('');
}

/** 抖音的人数都是「1.2万在线观众」这类中文单位字符串 */
function cnCount(v: unknown): number {
  const s = str(v).trim();
  if (!s) return 0;
  const m = s.match(/([\d.]+)\s*(亿|万|w|k)?/i);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  const unit = (m[2] || '').toLowerCase();
  if (unit === '亿') return Math.round(n * 1e8);
  if (unit === '万' || unit === 'w') return Math.round(n * 1e4);
  if (unit === 'k') return Math.round(n * 1e3);
  return Math.round(n);
}

function douyinLines(room: any): RoomLine[] {
  const su = room?.stream_url;
  const flv: Record<string, unknown> = su?.flv_pull_url ?? {};
  const hls: Record<string, unknown> = su?.hls_pull_url_map ?? {};

  const out: RoomLine[] = [];
  const seen = new Set<string>();
  const push = (label: string, url: unknown) => {
    const u = str(url);
    if (!u || seen.has(u)) return;
    seen.add(u);
    out.push({ label, url: u, nativeOnly: true });
  };

  // FLV 起播更快，放在前面；再补 HLS 作为备用
  push('FLV 原画', flv.FULL_HD1 ?? flv.ORIGIN);
  push('FLV 高清', flv.HD1);
  push('FLV 标清', flv.SD1 ?? flv.LD1);
  push('HLS 原画', hls.FULL_HD1 ?? hls.ORIGIN);
  push('HLS 标清', hls.SD1 ?? hls.LD1);
  return out.slice(0, 5);
}

function douyinRooms(html: string): LiveRoom[] {
  const p = pacePayload(html);
  if (!p) return [];

  const rooms: LiveRoom[] = [];
  const re = /"room":\{"id_str":"(\d+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(p))) {
    const objStart = p.indexOf('{', m.index + 7);
    const json = balancedObject(p, objStart);
    if (!json) continue;
    let room: any;
    try {
      room = JSON.parse(json);
    } catch {
      continue;
    }
    const roomId = str(room?.id_str) || m[1];
    // web_rid 是 room 之后的同级字段，用于解析接口兜底
    const tail = p.slice(objStart + json.length, objStart + json.length + 3000);
    const webRid = tail.match(/"web_rid":"(\d+)"/)?.[1];
    const owner = room?.owner ?? {};
    const lines = douyinLines(room);
    if (lines.length) douyinStreams.set(roomId, { at: Date.now(), lines });

    rooms.push({
      id: `douyin:${roomId}`,
      platform: 'douyin',
      roomId,
      webRid,
      title: cleanText(room?.title) || '正在直播',
      anchor: cleanText(owner?.nickname),
      avatar: fixUrl(owner?.avatar_thumb?.url_list?.[0]),
      cover: fixUrl(room?.cover?.url_list?.[0]),
      area: cleanText(room?.game_tag ?? room?.others?.game_tag ?? ''),
      online:
        cnCount(room?.stats?.total_user_str) ||
        cnCount(room?.room_view_stats?.display_short) ||
        num(room?.stats?.total_user),
    });
  }
  const all = dedupe(rooms);
  const content = all.filter((r) => !DOUYIN_SHOP.test(`${r.title} ${r.anchor}`));
  // 深夜时段整页都可能是店铺直播，全过滤掉会开天窗，留个兜底
  return content.length >= 3 ? content : all;
}

/** 每个分区翻页游标：分类页每页只有 15 个房间，翻几页才会换一批主播 */
const douyinOffset = new Map<string, number>();

async function douyinPage(cat: string): Promise<LiveRoom[]> {
  const off = douyinOffset.get(cat) ?? 0;
  const url = `https://live.douyin.com/category/${cat}${off ? `?offset=${off}` : ''}`;
  const res = await httpText(url, {
    referer: 'https://live.douyin.com/',
    timeoutMs: 20000,
    headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
  const rooms = douyinRooms(res.body);
  if (!rooms.length) throw new Error('抖音列表为空');
  // 首页返回的基本是低热度新房间，翻到第五页就回到开头，避免深翻触发风控
  douyinOffset.set(cat, off >= 60 ? 0 : off + 15);
  return rooms;
}

/**
 * 分类页返回的都是通用的在播推荐流，每次轮换三个分类并翻页，
 * 既保证主播多样性，也不会一次拉太多页面（单页约 1MB）。
 */
async function douyinAll(count = 3): Promise<LiveRoom[]> {
  const picks: string[] = [];
  for (let i = 0; i < count; i++) {
    picks.push(DOUYIN_CATS[douyinCursor % DOUYIN_CATS.length]);
    douyinCursor++;
  }
  const results = await Promise.allSettled(picks.map((c) => douyinPage(c)));
  const rooms: LiveRoom[] = [];
  let ok = false;
  let firstErr: unknown = null;
  for (const res of results) {
    if (res.status === 'fulfilled') {
      ok = true;
      rooms.push(...res.value);
    } else if (!firstErr) {
      firstErr = res.reason;
    }
  }
  if (!ok) throw new Error(errText(firstErr));
  // 抖音的人数统计不准（大量房间都是 0），按热度排序反而把顺序打乱，保持接口推荐序
  return dedupe(rooms);
}

// ── 分类筛选与缓存 ──────────────────────────────────────

function matchCategory(room: LiveRoom, category: CategoryId): boolean {
  if (category === 'hot') return true;
  const rule = CATEGORY_RULES.find(([id]) => id === category);
  // 主播昵称里也常带分区信息（如「王者荣耀-xx」），一并参与匹配
  return rule ? rule[1].test(`${room.area} ${room.title} ${room.anchor}`) : true;
}

interface CacheEntry {
  at: number;
  rooms: LiveRoom[];
}

/** 列表缓存 90 秒：切分类/回页面不用重复拉，轮询时强制刷新 */
const CACHE_TTL = 90_000;
/** 抖音单次刷新要拉三个 1MB 页面，单独放慢到 5 分钟，也顺便让房间池保持稳定 */
const DOUYIN_LIST_TTL = 5 * 60_000;
const platformCache = new Map<PlatformId, CacheEntry>();
const biliCategoryCache = new Map<CategoryId, CacheEntry>();

async function loadPlatform(
  p: PlatformId,
  category: CategoryId,
  force: boolean,
): Promise<LiveRoom[]> {
  if (p === 'bili') {
    const hit = biliCategoryCache.get(category);
    if (!force && hit && Date.now() - hit.at < CACHE_TTL && hit.rooms.length) return hit.rooms;
    const rooms = await biliByCategory(category);
    biliCategoryCache.set(category, { at: Date.now(), rooms });
    return rooms;
  }

  const hit = platformCache.get(p);
  const cached = hit && hit.rooms.length ? hit : null;
  // 抖音无视 force：轮询每分钟都重拉三个大页面既费流量，也会让卡片墙整体洗牌
  const fresh =
    p === 'douyin'
      ? !!cached && Date.now() - cached.at < DOUYIN_LIST_TTL
      : !force && !!cached && Date.now() - cached.at < CACHE_TTL;

  let all: LiveRoom[];
  if (fresh && cached) {
    all = cached.rooms;
  } else {
    all = p === 'huya' ? await huyaAll() : p === 'douyu' ? await douyuAll() : await douyinAll();
    platformCache.set(p, { at: Date.now(), rooms: all });
  }
  const filtered = all.filter((r) => matchCategory(r, category));
  return p === 'douyin' ? filtered.slice(0, 90) : topByHeat(filtered, 90);
}

/**
 * 拉取当前分类下的在播主播
 *
 * @param onPartial 「全部」模式下每个平台陆续返回就回调，先到先上墙
 */
export async function listRooms(
  platform: PlatformFilter,
  category: CategoryId,
  onPartial?: (rooms: LiveRoom[]) => void,
  force = false,
): Promise<LoadResult> {
  const errors: Partial<Record<PlatformId, string>> = {};

  if (platform !== 'all') {
    try {
      const rooms = await loadPlatform(platform, category, force);
      return { rooms, errors };
    } catch (e) {
      errors[platform] = errText(e);
      return { rooms: [], errors };
    }
  }

  const parts: LiveRoom[][] = [];
  await Promise.all(
    PLATFORM_ORDER.map(async (p, i) => {
      try {
        parts[i] = await loadPlatform(p, category, force);
      } catch (e) {
        parts[i] = [];
        errors[p] = errText(e);
      }
      onPartial?.(interleave(parts));
    }),
  );

  return { rooms: interleave(parts), errors };
}

// ── 关键词搜索 ──────────────────────────────────────────

export async function searchRooms(
  keyword: string,
  platforms: PlatformId[],
): Promise<LoadResult> {
  const kw = keyword.trim();
  const errors: Partial<Record<PlatformId, string>> = {};
  if (!kw) return { rooms: [], errors };

  const lower = kw.toLowerCase();
  const jobs = platforms.map(async (p) => {
    try {
      if (p === 'bili') {
        const [a, b] = await Promise.allSettled([biliSearch(kw, 1), biliSearch(kw, 2)]);
        if (a.status === 'rejected' && b.status === 'rejected') {
          throw new Error(errText(a.reason));
        }
        const rooms: LiveRoom[] = [];
        if (a.status === 'fulfilled') rooms.push(...a.value);
        if (b.status === 'fulfilled') rooms.push(...b.value);
        return rooms;
      }
      const hit = platformCache.get(p);
      const all = hit?.rooms?.length ? hit.rooms : await loadPlatform(p, 'hot', false);
      return all.filter((r) =>
        `${r.title} ${r.anchor} ${r.area}`.toLowerCase().includes(lower),
      );
    } catch (e) {
      errors[p] = errText(e);
      return [];
    }
  });

  const rooms = await Promise.all(jobs);
  return { rooms: dedupe(rooms.flat()), errors };
}

// ── 播放地址解析 ────────────────────────────────────────

const AGG_API = 'https://api.zxki.cn/api/hy';

function normalizeLines(
  raw: Array<{ label: string; url: string }>,
  headers?: Record<string, string>,
): RoomLine[] {
  const seen = new Set<string>();
  const lines: RoomLine[] = [];
  for (const item of raw) {
    const url = str(item.url).trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    lines.push({
      label: item.label || '直播线路',
      url,
      headers,
      nativeOnly: !/\.m3u8(\?|#|$)/i.test(url),
    });
  }
  return lines;
}

/** 虎牙 / 斗鱼 / 抖音：流地址带签名，交给解析接口换取临时地址 */
async function resolveSigned(
  platform: 'huya' | 'douyu' | 'douyin',
  roomId: string,
): Promise<RoomStream> {
  const j = await httpJson<any>(`${AGG_API}?site=${platform}&id=${encodeURIComponent(roomId)}`, {
    timeoutMs: 10000,
    headers: { Accept: 'application/json' },
  });

  if (!j || Number(j.code) !== 200) throw new Error(str(j?.message) || '直播源解析失败');
  const status = str(j.status).toUpperCase();
  if (status && status !== 'ON') throw new Error('主播已下播');

  const list: Array<{ name?: string; type?: string; url?: string; ratio?: string; cdn?: string }> =
    Array.isArray(j.urls) ? j.urls : [];
  const refHost =
    platform === 'huya'
      ? 'https://m.huya.com/'
      : platform === 'douyu'
        ? 'https://www.douyu.com/'
        : 'https://live.douyin.com/';
  const headers =
    j.headers && typeof j.headers === 'object'
      ? (j.headers as Record<string, string>)
      : { 'User-Agent': UA, Referer: refHost };

  // 原画优先、同清晰度优先 AL 节点
  const score = (x: { ratio?: string; cdn?: string }) => {
    const ratio = str(x.ratio);
    const byRatio =
      ratio === '0' || ratio === '' ? 0 : ratio === '6000' ? 1 : ratio === '4000' ? 2 : 3;
    const byCdn = str(x.cdn).toUpperCase().startsWith('AL') ? 0 : 1;
    return byRatio * 10 + byCdn;
  };
  const sorted = [...list].filter((x) => str(x.url)).sort((a, b) => score(a) - score(b));

  const lines = normalizeLines(
    sorted.map((x) => ({
      label: [str(x.name) || '直播线路', str(x.cdn)].filter(Boolean).join(' · '),
      url: str(x.url),
    })),
    headers,
  ).slice(0, 8);

  if (!lines.length) throw new Error('没有可用的直播线路');

  return {
    lines,
    title: cleanText(j.title) || undefined,
    anchor: cleanText(j.nick) || undefined,
    area: cleanText(j.game) || undefined,
  };
}

/** 虎牙兜底：直接解析房间页里的播放器配置 */
async function resolveHuyaPage(roomId: string): Promise<RoomStream | null> {
  try {
    const res = await httpText(`https://www.huya.com/${roomId}`, {
      referer: 'https://www.huya.com/',
      timeoutMs: 9000,
    });
    if (res.status < 200 || res.status >= 300) return null;
    const body = res.body;
    const one = (key: string) => {
      const m = body.match(new RegExp(`"${key}":"([^"]+)"`));
      return m ? m[1].replace(/&amp;/g, '&') : '';
    };
    const base = one('sFlvUrl');
    const stream = one('sStreamName');
    const suffix = one('sFlvUrlSuffix');
    const anti = one('sFlvAntiCode');
    if (!base || !stream || !anti) return null;
    return {
      lines: [
        {
          label: '虎牙直播',
          url: `${base}/${stream}.${suffix || 'flv'}?${anti}`,
          headers: { 'User-Agent': UA, Referer: 'https://m.huya.com/' },
          nativeOnly: true,
        },
      ],
    };
  } catch {
    return null;
  }
}

/** B 站：优先 HLS，拿不到再退回 FLV */
async function resolveBili(roomId: string): Promise<RoomStream> {
  const headers = { Referer: BILI_REFERER, 'User-Agent': UA };

  try {
    const playInfoUrl =
      'https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo' +
      `?room_id=${encodeURIComponent(roomId)}&protocol=0,1&format=0,1,2&codec=0,1` +
      '&qn=10000&platform=web&ptype=8&dolby=5&panorama=1';
    const j = await httpJson<any>(playInfoUrl, {
      referer: BILI_REFERER,
      timeoutMs: 9000,
      headers: { Accept: 'application/json' },
    });
    const data = j?.data;
    if (data && Number(data.live_status) === 0) throw new Error('主播已下播');

    const raw = data?.playurl_info?.playurl;
    const streams: any[] = Array.isArray(raw) ? (raw[0]?.stream ?? []) : (raw?.stream ?? []);
    const picked: RoomLine[] = [];

    const build = (stream: any, label: string): RoomLine | null => {
      const formats: any[] = Array.isArray(stream?.format) ? stream.format : [];
      const fmt =
        formats.find((f) => f?.format_name === 'ts' || f?.format_name === 'flv') || formats[0];
      const codecs: any[] = Array.isArray(fmt?.codec) ? fmt.codec : [];
      const codec = codecs.find((c) => c?.codec_name === 'avc') || codecs[0];
      const info: any = Array.isArray(codec?.url_info) ? codec.url_info[0] : null;
      if (!codec?.base_url || !info?.host) return null;
      return {
        label,
        url: `${info.host}${codec.base_url}${info.extra || ''}`,
        headers,
        nativeOnly: label === 'FLV',
      };
    };

    const hls = build(
      streams.find((s) => s?.protocol_name === 'http_hls'),
      'HLS',
    );
    const flv = build(
      streams.find((s) => s?.protocol_name === 'http_stream'),
      'FLV',
    );
    if (hls) picked.push(hls);
    if (flv) picked.push(flv);
    if (picked.length) return { lines: picked };
  } catch (e) {
    if (e instanceof Error && /下播/.test(e.message)) throw e;
  }

  const fallback = await httpJson<any>(
    `https://api.live.bilibili.com/room/v1/Room/playUrl?cid=${encodeURIComponent(roomId)}&platform=web&qn=10000`,
    { referer: BILI_REFERER, timeoutMs: 9000, headers: { Accept: 'application/json' } },
  );
  const durl: any[] = Array.isArray(fallback?.data?.durl) ? fallback.data.durl : [];
  const lines = normalizeLines(
    durl.map((d, i) => ({ label: i === 0 ? 'FLV' : `线路${i + 1}`, url: str(d?.url) })),
    headers,
  );
  if (!lines.length) throw new Error('这个直播间暂时没有可用的播放地址');
  return { lines };
}

/** 抖音列表里拿到的签名地址有效期只有几分钟，超过就重新解析 */
const DOUYIN_STREAM_TTL = 5 * 60_000;

/**
 * 抖音：签名地址在列表页里已经拿过一次，直接复用；
 * 缓存过期或被拒时走聚合接口（用 web_rid），再不行就重抓分类页。
 */
async function resolveDouyin(room: LiveRoom): Promise<RoomStream> {
  const meta = { title: room.title, anchor: room.anchor, area: room.area };
  const cached = douyinStreams.get(room.roomId);
  if (cached && Date.now() - cached.at < DOUYIN_STREAM_TTL) {
    return { lines: cached.lines, ...meta };
  }

  try {
    return { ...(await resolveSigned('douyin', room.webRid || room.roomId)), ...meta };
  } catch (e) {
    if (e instanceof Error && /下播/.test(e.message)) throw e;
  }

  // 最后兜底：重抓几页分类数据，主播还在播就能拿到新的签名地址
  const results = await Promise.allSettled(DOUYIN_CATS.slice(0, 3).map((c) => douyinPage(c)));
  for (const res of results) {
    if (res.status !== 'fulfilled') continue;
    if (!res.value.some((r) => r.roomId === room.roomId)) continue;
    const fresh = douyinStreams.get(room.roomId);
    if (fresh) return { lines: fresh.lines, ...meta };
  }
  throw new Error('抖音直播源解析失败');
}

/** 解析一个主播的播放地址（点开即播的唯一入口） */
export async function resolveRoom(room: LiveRoom): Promise<RoomStream> {
  if (room.platform === 'bili') return resolveBili(room.roomId);
  if (room.platform === 'douyin') return resolveDouyin(room);

  try {
    return await resolveSigned(room.platform, room.roomId);
  } catch (e) {
    if (e instanceof Error && /下播/.test(e.message)) throw e;
    if (room.platform === 'huya') {
      const fallback = await resolveHuyaPage(room.roomId);
      if (fallback) return fallback;
    }
    throw e;
  }
}

// ── 输入直连 ────────────────────────────────────────────

/**
 * 识别「粘贴房间地址 / 输入房间号」的直连请求
 *
 * 平台选择为「全部」时无法判断纯数字房间号属于哪个平台，返回 null，
 * 由用户先选平台；粘贴完整链接时不受此限制。
 */
export function parseRoomInput(
  input: string,
  platform: PlatformFilter,
): { platform: PlatformId; roomId: string } | null {
  const s = input.trim();
  if (!s) return null;

  const m = s.match(/(live\.bilibili\.com|huya\.com|douyu\.com|live\.douyin\.com)\/(?:room\/)?(\d{3,})/i);
  if (m) {
    const host = m[1].toLowerCase();
    const id = m[2];
    if (host.includes('bilibili')) return { platform: 'bili', roomId: id };
    if (host.includes('huya')) return { platform: 'huya', roomId: id };
    if (host.includes('douyin')) return { platform: 'douyin', roomId: id };
    return { platform: 'douyu', roomId: id };
  }

  if (/^\d{3,}$/.test(s) && platform !== 'all') {
    return { platform, roomId: s };
  }
  return null;
}

/** 在线人数：12345 → 1.2万 */
export function formatOnline(n: number): string {
  if (!n || n <= 0) return '';
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}亿`;
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)}万`;
  return String(n);
}

/** 平台 + 房间号构造 LiveRoom（直连房间号时用） */
export function roomFromId(platform: PlatformId, roomId: string): LiveRoom {
  return {
    id: `${platform}:${roomId}`,
    platform,
    roomId,
    // 抖音直连输入的是 web_rid，内部 id_str 只有在列表里才拿得到
    webRid: platform === 'douyin' ? roomId : undefined,
    title: `房间 ${roomId}`,
    anchor: '',
    area: '',
    online: 0,
  };
}
