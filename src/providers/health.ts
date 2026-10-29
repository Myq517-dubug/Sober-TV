/**
 * 线路体检（客户端侧）
 *
 * 服务端已有同名能力，这里是客户端兜底：
 *  - 服务端不可达时（离线/自部署未启动）仍能判断死链
 *  - 直连型源不经服务端解析，需要客户端自己体检
 */

import type { HealthResult, HealthStatus } from './types';

const UA =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

const PROBE_TIMEOUT_MS = 6000;
/** 体检结果缓存 10 分钟：死链没必要每次进页面都重新探测一遍 */
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 300;
const STORAGE_KEY = 'sober.healthCache';

interface CacheEntry {
  at: number;
  result: HealthResult;
}

const cache = new Map<string, CacheEntry>();

/**
 * 从 localStorage 恢复未过期的体检结果
 *
 * 只保留 playable / dead 两类确定结论：
 * unknown 多是网络抖动或超时，存下来会把「一时的网络问题」
 * 变成十分钟内都判定为不可用，得不偿失。
 */
function loadPersisted(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw) as Record<string, CacheEntry>;
    const now = Date.now();
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      if (!v || typeof v.at !== 'number' || !v.result) continue;
      if (now - v.at >= CACHE_TTL_MS) continue;
      cache.set(key, v);
    }
  } catch {
    /* 存储损坏时按无缓存处理 */
  }
}

loadPersisted();

/** 合并写入（1.2s 内的多次探测只落盘一次） */
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(): void {
  if (persistTimer != null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      if (typeof localStorage === 'undefined') return;
      const obj: Record<string, CacheEntry> = {};
      cache.forEach((v, k) => {
        if (v.result.status === 'unknown') return;
        obj[k] = v;
      });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
    } catch {
      /* 配额满/隐私模式写不进去时忽略 */
    }
  }, 1200);
}

function isDirectPlayable(url: string): boolean {
  const u = String(url || '');
  if (!u) return false;
  if (/\.m3u8(\?|$)/i.test(u)) return true;
  if (/\.(mp4|m4v|mov|webm)(\?|$)/i.test(u)) return true;
  if (/mime_type=video_mp4/i.test(u)) return true;
  return false;
}

function contentTypeOk(status: number, ct: string): boolean {
  if (status >= 400) return false;
  const t = String(ct || '').toLowerCase();
  if (!t) return true;
  if (/^(video|audio)\//.test(t)) return true;
  if (/mpegurl/.test(t)) return true;
  if (/application\/octet-stream/.test(t)) return true;
  if (/\/mp4|\/webm|\/mpeg|\/x-flv/.test(t)) return true;
  return false;
}

export async function checkLineHealth(
  url: string,
  headers?: Record<string, string>,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<HealthResult> {
  const u = String(url || '').trim();
  if (!u) return { status: 'dead', latencyMs: 0, reason: 'empty-url' };
  if (isDirectPlayable(u)) {
    return { status: 'playable', latencyMs: 0, reason: 'direct-ext' };
  }

  const key = u.slice(0, 220);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;

  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(u, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        Range: 'bytes=0-1',
        'User-Agent': UA,
        Accept: '*/*',
        ...(headers || {}),
      },
    });
    clearTimeout(timer);

    try {
      if (res.body && res.body.cancel) await res.body.cancel();
    } catch {
      /* ignore */
    }

    const ct = res.headers.get('content-type') || '';
    const ok = contentTypeOk(res.status, ct);
    const result: HealthResult = {
      status: ok ? 'playable' : 'dead',
      latencyMs: Date.now() - t0,
      contentType: ct,
      reason: ok ? undefined : `ct=${ct || 'no-ct'} status=${res.status}`,
    };
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    cache.set(key, { at: Date.now(), result });
    schedulePersist();
    return result;
  } catch (err) {
    clearTimeout(timer);
    // 探测失败不阻断，交播放器尝试
    const result: HealthResult = {
      status: 'unknown',
      latencyMs: Date.now() - t0,
      reason: err instanceof Error && err.name === 'AbortError' ? 'timeout' : String(err),
    };
    cache.set(key, { at: Date.now(), result });
    return result;
  }
}

export function clearHealthCache(): void {
  cache.clear();
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export type { HealthStatus };
