/**
 * 本地偏好存储 —— 公网直连模式下的「配置层」
 *
 * 本版本已移除自建服务端与隧道依赖，因此原先指向服务端的
 * 线路黑名单 / 广告扫描等能力改为本地实现：
 *   - 黑名单：localStorage 持久化，客户端本地生效
 *   - 广告扫描：公网源不做拦截（默认「标注不拦截」策略，避免误杀正片）
 *
 * 保留本文件的导出名，是为了让 Library 等页面不必大改。
 */

import type { AdVerdict, ResolvedSource, SourceProvider } from '../providers/types';

const BLOCKS_KEY = 'sober.blocks';

/** 读取黑名单 */
export function fetchBlocks(): string[] {
  try {
    const raw = localStorage.getItem(BLOCKS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

/** 拉黑 / 解黑线路，返回最新黑名单 */
export function toggleBlock(label: string, action: 'block' | 'unblock'): string[] {
  const list = fetchBlocks();
  let next: string[];
  if (action === 'block') {
    next = list.includes(label) ? list : [...list, label];
  } else {
    next = list.filter((x) => x !== label);
  }
  try {
    localStorage.setItem(BLOCKS_KEY, JSON.stringify(next));
  } catch {
    /* 存储不可用时仅本次会话生效 */
  }
  return next;
}

/**
 * 插播广告分析
 *
 * 公网直连场景下默认「标注不拦截」：
 * 误杀正片的代价（用户看到缺片段）远大于放过广告。
 * 真正要拦截应基于 m3u8 清单的 EXT-X-CUE-OUT 标记，
 * 而公网源的清单结构不稳定，故此处仅返回保守结论。
 */
export async function scanAds(_url: string): Promise<AdVerdict> {
  return {
    verdict: 'unknown',
    blocked: 0,
    total: 0,
    adBlocks: [],
    reasons: {},
  };
}

/**
 * 兼容旧调用：把本地源信息转成 SourceProvider
 */
export function toProvider(info: {
  id: string;
  name: string;
  type: 'direct' | 'scraper' | 'aggregator';
  categories: string[];
  official: boolean;
  weight: number;
  order: number;
  enabled: boolean;
  note: string;
  url?: string;
  endpoint?: string;
}): SourceProvider {
  return {
    id: info.id,
    name: info.name,
    type: info.type,
    categories: info.categories as SourceProvider['categories'],
    enabled: info.enabled,
    order: info.order,
    weight: info.weight,
    official: info.official,
    endpoint: info.endpoint,
    url: info.url,
  };
}

/** 兼容旧调用：空解析结果 */
export async function resolvePlayback(): Promise<{ url?: string; error?: string }> {
  return { error: '公网直连模式下由 resolve.ts 负责解析' };
}

/** 兼容旧调用：空线路列表 */
export async function fetchAllLines(): Promise<
  { label: string; providerId: string; official: boolean; sources: ResolvedSource[] }[]
> {
  return [];
}

/** 兼容旧调用：不再有自建服务端 */
export function serverBase(): string {
  return '公网直连';
}

/** 兼容旧调用：探测恒为可达（走公网） */
export async function pingServer(): Promise<boolean> {
  return true;
}
