/**
 * 公网 HTTP 客户端
 *
 * ── 为什么不能直接用 fetch ──────────────────────────────
 * 实测结论：公网影视聚合源（苹果 CMS 采集接口、其 CDN 直链）**几乎全部不返回
 * `Access-Control-Allow-Origin`**（仅 TVmaze 等少数带 `*`）。
 * 而 Capacitor Android WebView 的 origin 是 `https://localhost`，
 * 跨域 XHR 会被浏览器直接拦截 —— App 表现为「所有接口都超时」。
 *
 * ── 解决方案 ──────────────────────────────────────────
 * 1. 元数据 / 采集接口调用：走 CapacitorHttp 原生网络栈。
 *    `CapacitorHttp.request()` 在 Android 上由 HttpURLConnection 执行，
 *    完全不经过浏览器的同源策略，因此无 CORS 限制。
 * 2. 视频分片播放：走原生 ExoPlayer（见 NativePlayerPlugin），
 *    因为 CapacitorHttp 的 XHR 补丁会丢弃 responseType，
 *    hls.js 拿到的是 base64 文本而非二进制，播放必然损坏。
 *
 * 本模块对上层只暴露「按 URL 取文本 / 取 JSON」的语义，
 * Web 预览环境自动回退到标准 fetch。
 */

import { Capacitor, CapacitorHttp } from '@capacitor/core';

export interface HttpOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** 是否携带 Referer 头（防盗链场景） */
  referer?: string;
}

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const DEFAULT_TIMEOUT = 15000;

const isNative = (): boolean => {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
};

/** 合并请求头 */
function buildHeaders(opts: HttpOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
    Accept: '*/*',
    ...(opts.headers || {}),
  };
  if (opts.referer && !headers.Referer && !headers.referer) {
    headers.Referer = opts.referer;
  }
  return headers;
}

/**
 * 取文本响应。
 * @throws 网络错误或非 2xx 时抛出，调用方需自行处理降级
 */
export async function httpText(url: string, opts: HttpOptions = {}): Promise<HttpResult> {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;

  if (isNative()) {
    const res = await CapacitorHttp.request({
      url,
      method: 'GET',
      headers: buildHeaders(opts),
      // 采集接口一律按文本处理，避免原生层误判 content-type
      responseType: 'text',
      connectTimeout: timeout,
      readTimeout: timeout,
    });
    return {
      status: res.status,
      headers: (res.headers || {}) as Record<string, string>,
      body: typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? ''),
    };
  }

  // Web 预览环境：标准 fetch
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: buildHeaders(opts),
    });
    const body = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return { status: res.status, headers, body };
  } finally {
    clearTimeout(timer);
  }
}

/** 取 JSON */
export async function httpJson<T = any>(url: string, opts: HttpOptions = {}): Promise<T> {
  const res = await httpText(url, opts);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status} ${url}`);
  }
  try {
    return JSON.parse(res.body) as T;
  } catch (e) {
    throw new Error(`JSON 解析失败: ${res.body.slice(0, 120)}`);
  }
}

/**
 * 轻量探活 —— 只关心「通不通」，不关心内容。
 * 用于线路体检：明确的死链才跳过，unknown 保留（交给播放器尝试）。
 */
export async function probe(
  url: string,
  opts: HttpOptions = {},
): Promise<{ ok: boolean; status: number; latencyMs: number; contentType?: string }> {
  const t0 = Date.now();
  try {
    const res = await httpText(url, { ...opts, timeoutMs: opts.timeoutMs ?? 8000 });
    return {
      ok: res.status >= 200 && res.status < 400,
      status: res.status,
      latencyMs: Date.now() - t0,
      contentType: res.headers['content-type'] || res.headers['Content-Type'],
    };
  } catch {
    return { ok: false, status: 0, latencyMs: Date.now() - t0 };
  }
}
