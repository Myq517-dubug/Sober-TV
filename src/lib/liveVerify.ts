/**
 * 直播线路体检
 *
 * ── 要解决的问题 ──────────────────────────────────────
 * 公开直播源里死链占比很高（实测某个源整批央视地址全 404），
 * 频道墙如果照单全收，用户点十个台有五个转圈，体验极差。
 * 这里在展示前先把线路真的拉一遍，只留下确认能播的。
 *
 * ── 判定标准 ──────────────────────────────────────────
 *   · HLS（.m3u8 / .m3u）：拉清单前 2KB，必须含 #EXTM3U。
 *     只看 HTTP 200 不够 —— 大量失效源会返回 200 + 导航页 HTML。
 *   · 其他地址（无扩展名 / .ts 等）：用 HEAD 探活，
 *     连接失败或 4xx 判死；405 视为可播（不少服务器禁 HEAD）。
 *
 * ── 为什么要走原生网络栈 ──────────────────────────────
 * IPTV 服务器几乎都不带 CORS 头，WebView 里的 fetch 会被同源策略
 * 拦成网络错误，M3U 主机更拿不到响应体。CapacitorHttp 走原生
 * HttpURLConnection，没有 CORS 限制。
 *
 * ── 浏览器预览 ────────────────────────────────────────
 * 浏览器里没有原生栈，CORS 失败并不代表流是死的，
 * 所以探测异常一律按「可用」处理，避免预览环境把整墙频道误杀。
 */

import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { LiveChannel } from './live';

export interface ChannelProbe {
  ok: boolean;
  /** 第一条可用线路的下标 */
  line: number;
  at: number;
}

interface Entry extends ChannelProbe {
  /** 线路指纹：源更新后线路变了，旧结论立即作废 */
  sig: string;
}

const STORE_KEY = 'sober.live.probe';
const OK_TTL = 30 * 60 * 1000;
const DEAD_TTL = 10 * 60 * 1000;
const CACHE_MAX = 3000;
const TIMEOUT = 3000;

const cache = new Map<string, Entry>();
let loaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function isNative(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

/** 线路指纹（djb2），只用于判断线路有没有变 */
function channelSig(ch: LiveChannel): string {
  const s = ch.lines.map((l) => l.url).join('|');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${ch.lines.length}-${(h >>> 0).toString(36)}`;
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw) as Record<string, Entry>;
    const now = Date.now();
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (!v || typeof v.at !== 'number' || typeof v.ok !== 'boolean') continue;
      if (now - v.at >= (v.ok ? OK_TTL : DEAD_TTL)) continue;
      cache.set(k, v);
    }
  } catch {
    /* 存储损坏按无缓存处理 */
  }
}

function persist(): void {
  if (persistTimer != null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      if (typeof localStorage === 'undefined') return;
      const obj: Record<string, Entry> = {};
      let n = 0;
      cache.forEach((v, k) => {
        if (n++ < CACHE_MAX) obj[k] = v;
      });
      localStorage.setItem(STORE_KEY, JSON.stringify(obj));
    } catch {
      /* 配额不足时放弃持久化 */
    }
  }, 1500);
}

/** 取缓存的体检结论；线路变化或过期返回 null */
export function getProbe(ch: LiveChannel): ChannelProbe | null {
  load();
  const hit = cache.get(ch.id);
  if (!hit) return null;
  if (hit.sig !== channelSig(ch)) return null;
  if (Date.now() - hit.at >= (hit.ok ? OK_TTL : DEAD_TTL)) return null;
  return { ok: hit.ok, line: hit.line, at: hit.at };
}

function putProbe(ch: LiveChannel, probe: ChannelProbe): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(ch.id, { ...probe, sig: channelSig(ch) });
  persist();
}

const UA =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

/** HLS 清单探活 */
async function pingHls(url: string): Promise<boolean> {
  if (isNative()) {
    try {
      const res = await CapacitorHttp.request({
        url,
        method: 'GET',
        headers: { 'User-Agent': UA, Accept: '*/*', Range: 'bytes=0-2047' },
        responseType: 'text',
        connectTimeout: TIMEOUT,
        readTimeout: TIMEOUT,
      });
      if (res.status < 200 || res.status >= 400) return false;
      const body = typeof res.data === 'string' ? res.data : '';
      if (body.includes('#EXTM3U')) return true;
      const ct = String(res.headers?.['content-type'] || res.headers?.['Content-Type'] || '');
      return /mpegurl/i.test(ct);
    } catch {
      return false;
    }
  }

  // 浏览器预览：探测失败不代表源死了，放行
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, Range: 'bytes=0-2047' },
      });
      if (!res.ok) return false;
      const text = await res.text();
      return text.includes('#EXTM3U');
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return true;
  }
}

/** 非 HLS 地址探活：只看通不通，不下载内容 */
async function pingOther(url: string): Promise<boolean> {
  if (isNative()) {
    try {
      const res = await CapacitorHttp.request({
        url,
        method: 'HEAD',
        headers: { 'User-Agent': UA, Accept: '*/*' },
        connectTimeout: 3000,
        readTimeout: 3000,
      });
      return res.status < 400 || res.status === 405;
    } catch {
      return false;
    }
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    try {
      const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal });
      return res.status < 400 || res.status === 405;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return true;
  }
}

function isHls(url: string): boolean {
  return /\.m3u8?(\?|#|$)/i.test(url);
}

/** 单条线路是否可播 */
export async function pingLine(url: string): Promise<boolean> {
  if (!url) return false;
  return isHls(url) ? pingHls(url) : pingOther(url);
}

/**
 * 体检一个频道：按线路顺序最多试 MAX_LINE_PROBE 条，首条可用即停。
 * 结果带缓存，重复进入页面几乎零成本。
 */
const MAX_LINE_PROBE = 6;

export async function probeChannel(ch: LiveChannel): Promise<ChannelProbe> {
  const hit = getProbe(ch);
  if (hit) return hit;

  const urls = ch.lines.slice(0, MAX_LINE_PROBE).map((l) => l.url);
  if (!urls.length) {
    const probe = { ok: false, line: 0, at: Date.now() };
    putProbe(ch, probe);
    return probe;
  }

  // 首条能通就只发这一个请求，绝大多数频道走这条路
  if (await pingLine(urls[0])) {
    const probe = { ok: true, line: 0, at: Date.now() };
    putProbe(ch, probe);
    return probe;
  }

  // 首条不通时并行探剩下的：逐条顺延会让 6 条死链叠成 20 秒以上，
  // 用户等不起；一批并发出去的代价只是多几个 KB 的请求头。
  const rest = urls.slice(1);
  const results = await Promise.all(rest.map((u) => pingLine(u)));
  const idx = results.findIndex(Boolean);
  const probe: ChannelProbe =
    idx >= 0
      ? { ok: true, line: idx + 1, at: Date.now() }
      : { ok: false, line: 0, at: Date.now() };
  putProbe(ch, probe);
  return probe;
}

/**
 * 批量体检
 *
 * 并发上限压得比较低：多数用户是移动网络，同时开 8 条探测
 * 既能保证首屏秒出，也不会把带宽挤爆导致正常线路也超时。
 */
export function probeChannels(
  list: LiveChannel[],
  opts: {
    concurrency?: number;
    shouldStop?: () => boolean;
    onResult: (ch: LiveChannel, probe: ChannelProbe) => void;
  },
): Promise<void> {
  const concurrency = Math.max(1, opts.concurrency ?? 10);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < list.length) {
      if (opts.shouldStop?.()) return;
      const ch = list[cursor++];
      const probe = await probeChannel(ch);
      if (opts.shouldStop?.()) return;
      opts.onResult(ch, probe);
    }
  };

  return Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker)).then(
    () => undefined,
  );
}

export function clearProbes(): void {
  cache.clear();
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(STORE_KEY);
  } catch {
    /* ignore */
  }
}
