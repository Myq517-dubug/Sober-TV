/**
 * 分批并发加载器 —— 借鉴 flixquest provider_loader 的「既并发又保序」思路
 *
 * 为什么不能全并发：
 *   - 10 个源全并发 → 对上游压力大，容易触发 429
 *   - 串行加载     → 起播时间 = 所有源耗时之和，慢得离谱
 *
 * 折中：每批 3 个并发启动，按配置顺序逐个裁决。
 * 快但优先级低的源即便先返回，也要等前面的源裁决完 —— 保证「高质量源优先」。
 */

import type { LoadContext, SourceProvider, SourceResult } from './types';

const BATCH_SIZE = 3;

export interface LoadedCandidate {
  provider: SourceProvider;
  sources: SourceResult['sources'];
  elapsedMs: number;
}

export interface SelectionResult {
  /** 选中的源下标（对应入参 providers 数组） */
  index: number;
  provider: SourceProvider;
  sources: SourceResult['sources'];
  /** 本批内所有源的结果，供换源面板展示 */
  batchResults: Map<string, SourceResult>;
}

/**
 * 加载第一个可用的源
 *
 * @param providers 按优先级排序的源列表
 * @param load      单个源的加载函数
 * @param onResult  每完成一个源的回调（用于 UI 实时反馈）
 */
export async function loadFirstSuccessful(
  providers: SourceProvider[],
  load: (p: SourceProvider) => Promise<SourceResult>,
  onResult?: (index: number, provider: SourceProvider, result: SourceResult) => void,
): Promise<SelectionResult | null> {
  const batchResults = new Map<string, SourceResult>();

  for (let start = 0; start < providers.length; start += BATCH_SIZE) {
    const slice = providers.slice(start, start + BATCH_SIZE);

    // 批内并发启动（创建所有 promise 但不 await）
    const requests = slice.map(async (provider) => {
      try {
        return await load(provider);
      } catch (err) {
        return {
          sources: [],
          error: err instanceof Error ? err.message : String(err),
        } satisfies SourceResult;
      }
    });

    // 按配置顺序逐个裁决 —— 保证优先级高的源先返回
    for (let i = 0; i < requests.length; i++) {
      const result = await requests[i];
      const provider = slice[i];
      batchResults.set(provider.id, result);
      onResult?.(start + i, provider, result);

      if (result.sources && result.sources.length > 0) {
        return {
          index: start + i,
          provider,
          sources: result.sources,
          batchResults,
        };
      }
    }
  }

  return null;
}

/**
 * 加载全部源（换源面板用）—— 全并发但带并发上限
 */
export async function loadAll(
  providers: SourceProvider[],
  load: (p: SourceProvider) => Promise<SourceResult>,
  concurrency = 4,
  onResult?: (index: number, provider: SourceProvider, result: SourceResult) => void,
): Promise<Map<string, SourceResult>> {
  const results = new Map<string, SourceResult>();
  let idx = 0;

  async function worker() {
    while (idx < providers.length) {
      const i = idx++;
      const provider = providers[i];
      let result: SourceResult;
      try {
        result = await load(provider);
      } catch (err) {
        result = { sources: [], error: err instanceof Error ? err.message : String(err) };
      }
      results.set(provider.id, result);
      onResult?.(i, provider, result);
    }
  }

  const n = Math.min(concurrency, Math.max(1, providers.length));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

export type { LoadContext };
