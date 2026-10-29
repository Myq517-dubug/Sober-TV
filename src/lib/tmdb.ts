/**
 * TMDB 官方 API 客户端
 *
 * ── 密钥说明 ──────────────────────────────────────────
 * 内置的是一份经实测有效的公开 API Key（可正常读取 popular / trending 等接口）。
 * 它同时被打进 APK，因此任何拿到 APK 的人都能看到 —— 这是公开客户端的固有代价。
 * 生产环境建议通过设置页让用户自填，并在此处留空作为占位。
 *
 * ── 网络说明 ──────────────────────────────────────────
 * TMDB 官方 API 自带 CORS 头（`Access-Control-Allow-Origin: *`），
 * 浏览器直连即可；这里统一走 net.ts，保持与 CMS 源同一条链路，
 * 顺便复用超时与 UA 策略。
 */

import { httpJson } from './net';

/** 内置默认 Key（实测有效） */
export const DEFAULT_TMDB_KEY = '8d97210e6edd66eb9e967278325836d0';

const TMDB_BASE = 'https://api.themoviedb.org/3';
const IMG_BASE = 'https://image.tmdb.org/t/p';

const STORAGE_KEY = 'sober.tmdbKey';

/** 读取当前使用的 Key */
export function getTmdbKey(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || DEFAULT_TMDB_KEY;
  } catch {
    return DEFAULT_TMDB_KEY;
  }
}

/** 设置 Key，空串表示恢复默认 */
export function setTmdbKey(key: string): void {
  try {
    if (!key || key.trim() === DEFAULT_TMDB_KEY) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, key.trim());
    }
  } catch {
    /* 存储不可用时忽略 */
  }
}

/** 海报地址 */
export function posterUrl(path?: string | null, size = 'w342'): string | undefined {
  if (!path) return undefined;
  if (path.startsWith('http')) return path;
  return `${IMG_BASE}/${size}${path}`;
}

/** 发起一次 TMDB 请求 */
export async function tmdb<T = any>(
  path: string,
  params: Record<string, string | number> = {},
): Promise<T> {
  const key = getTmdbKey();
  if (!key) throw new Error('未配置 TMDB API Key');

  const sp = new URLSearchParams({
    api_key: key,
    language: 'zh-CN',
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  });

  // 超时 3.5 秒：TMDB 在部分网络下不可达（实测直连挂到 20 秒），
  // 长超时会让每一次列表/搜索都先卡满再回落，得不偿失。
  return httpJson<T>(`${TMDB_BASE}${path}?${sp.toString()}`, { timeoutMs: 3500 });
}
