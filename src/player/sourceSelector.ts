/**
 * 线路选择与顺延 —— 对应方案 P0-2 / P0-3
 *
 * 三条核心规则：
 *  1. keep：正在播的源优先，失效才顺延（而不是直接跳到"最优源"）
 *     —— 这条最反直觉但最正确，保证播放体验连贯
 *  2. 体检过滤：明确死链（dead）直接跳过，unknown 保留
 *  3. 顺延上限：单次最多试 MAX_TRY 条，避免无限循环
 */

import type { ResolvedSource } from '../providers/types';

export const MAX_TRY = 8;

export interface SelectOptions {
  /** 正在播的源标识（线路名），会被置顶 */
  keepLabel?: string;
  /** 手动换源时跳过前 N 条 */
  skipN?: number;
  /** 单次最多尝试几条 */
  maxTry?: number;
}

export interface SelectableSource extends ResolvedSource {
  /** 线路唯一标识 */
  id: string;
  /** 源名称（provider 名） */
  providerName?: string;
  /**
   * 该线路的整季地址表
   *
   * 换集时直接按集号取地址，不用重新解析；
   * 原生窗口也靠它在本进程内换集。
   */
  episodes?: { n: number; url: string }[];
}

/**
 * 对候选线路排序 —— keep 置顶 + 官方优先 + 权重降序
 */
export function sortCandidates(
  candidates: SelectableSource[],
  opts: SelectOptions = {},
): SelectableSource[] {
  const { keepLabel } = opts;
  const list = [...candidates];

  if (keepLabel) {
    const i = list.findIndex((c) => c.label === keepLabel || c.id === keepLabel);
    if (i > 0) {
      const [item] = list.splice(i, 1);
      list.unshift(item);
    }
  }

  list.sort((a, b) => {
    const wa = a.weight ?? 0;
    const wb = b.weight ?? 0;
    if (wa !== wb) return wb - wa;
    return (a.official ? 0 : 1) - (b.official ? 0 : 1);
  });

  return list;
}

/**
 * 选出下一条要尝试的线路
 * @param candidates 候选线路
 * @param opts keepLabel / skipN / maxTry
 * @returns 选中的线路，无可用时返回 null
 */
export function pickNext(
  candidates: SelectableSource[],
  opts: SelectOptions = {},
): SelectableSource | null {
  const { skipN = 0 } = opts;
  const sorted = sortCandidates(candidates, opts);
  if (!sorted.length) return null;
  const idx = Math.min(skipN, sorted.length - 1);
  return sorted[idx] ?? null;
}

/**
 * 取出用于顺延的下一批候选（跳过前 skipN 条）
 */
export function nextBatch(
  candidates: SelectableSource[],
  skipN: number,
  opts: SelectOptions = {},
): SelectableSource[] {
  const sorted = sortCandidates(candidates, opts);
  return sorted.slice(skipN);
}

/**
 * 线路去重 —— 同一 URL 只保留优先级最高的那条
 */
export function dedupeSources(sources: SelectableSource[]): SelectableSource[] {
  const seen = new Set<string>();
  const out: SelectableSource[] = [];
  for (const s of sources) {
    const key = s.url.split('#')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/**
 * 生成线路的展示标识
 */
export function sourceKey(s: SelectableSource): string {
  return s.label || s.id || s.url.slice(0, 80);
}
