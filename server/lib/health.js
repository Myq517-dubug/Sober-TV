/**
 * 线路体检 —— 借鉴 AIStream 的 lineIsPlayable 思路，重新实现
 *
 * 目标：判断一个播放地址是否「大概率可播」，避免用户点了才发现是死链。
 *
 * 关键设计（照搬实战经验）：
 *  1. m3u8 / mp4 直链免探测 —— 冷链路探测会白等 0.3~0.5s
 *  2. 探测失败不阻断 —— 标记为 unknown 交给播放器尝试，避免误杀好源
 *  3. LRU 缓存 —— 同一地址 5 分钟内不重复探测
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export const HEALTH = {
  PLAYABLE: 'playable',
  DEAD: 'dead',
  UNKNOWN: 'unknown',
};

const PROBE_TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 400;

const cache = new Map();

/**
 * 判断一个 URL 是否「免探测直接放行」
 */
function isDirectPlayable(url) {
  const u = String(url || '');
  if (!u) return false;
  if (/\.m3u8(\?|$)/i.test(u)) return true;
  if (/\.(mp4|m4v|mov|webm)(\?|$)/i.test(u)) return true;
  // 部分采集站用 mime_type 标记
  if (/mime_type=video_mp4/i.test(u)) return true;
  return false;
}

/**
 * 判定 Content-Type 是否为可播放的媒体类型
 */
function contentTypeOk(status, ct) {
  if (status >= 400) return false;
  const t = String(ct || '').toLowerCase();
  if (!t) return true; // 无 Content-Type 不判死
  if (/^(video|audio)\//.test(t)) return true;
  if (/mpegurl/.test(t)) return true;
  if (/application\/octet-stream/.test(t)) return true;
  if (/\/mp4|\/webm|\/mpeg|\/x-flv/.test(t)) return true;
  // 明确的非媒体类型
  return false;
}

/**
 * 探测单个地址的健康状况
 * @returns {Promise<{status:string, latencyMs:number, contentType?:string, reason?:string}>}
 */
export async function probeLine(url, { headers = {}, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const u = String(url || '').trim();
  const base = { latencyMs: 0 };

  if (!u) {
    return { ...base, status: HEALTH.DEAD, reason: 'empty-url' };
  }

  // 直链免探测
  if (isDirectPlayable(u)) {
    return { ...base, status: HEALTH.PLAYABLE, reason: 'direct-ext' };
  }

  const key = u.slice(0, 220);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.result;
  }

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
        ...headers,
      },
    });
    clearTimeout(timer);

    // 尽早释放连接，避免占用 socket
    try {
      if (res.body && res.body.cancel) await res.body.cancel();
    } catch {
      /* ignore */
    }

    const ct = res.headers.get('content-type') || '';
    const ok = contentTypeOk(res.status, ct);
    const result = {
      status: ok ? HEALTH.PLAYABLE : HEALTH.DEAD,
      latencyMs: Date.now() - t0,
      contentType: ct,
      reason: ok ? undefined : `ct=${ct || 'no-ct'} status=${res.status}`,
    };

    if (cache.size >= CACHE_MAX) {
      // 简单 LRU：删最早插入的一条
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    cache.set(key, { at: Date.now(), result });
    return result;
  } catch (err) {
    clearTimeout(timer);
    // 探测本身失败不阻断 —— 交给播放器尝试
    const result = {
      status: HEALTH.UNKNOWN,
      latencyMs: Date.now() - t0,
      reason: err && err.name === 'AbortError' ? 'timeout' : String((err && err.message) || err),
    };
    cache.set(key, { at: Date.now(), result });
    return result;
  }
}

/**
 * 批量体检，并发受控
 */
export async function probeMany(urls, { concurrency = 6, headers = {} } = {}) {
  const list = Array.from(urls || []);
  const out = new Array(list.length);
  let idx = 0;

  async function worker() {
    while (idx < list.length) {
      const i = idx++;
      out[i] = await probeLine(list[i], { headers: headers[list[i]] || headers });
    }
  }

  const n = Math.min(concurrency, Math.max(1, list.length));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

/** 清空体检缓存（配置变更时调用） */
export function clearHealthCache() {
  cache.clear();
}
