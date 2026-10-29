/**
 * 源契约 —— 借鉴 Nivio 的极简契约思路
 *
 * 关键设计：源只负责「解析出可播放地址」，不关心播放器、UI、状态。
 * 契约保持最小，新写一个源的样板成本极低。
 */

export type SourceCategory = 'movie' | 'tv' | 'anime' | 'live' | 'variety' | 'doc';

export type SourceType = 'direct' | 'scraper' | 'aggregator';

export interface SubtitleTrack {
  url: string;
  lang: string;
  /** 展示名，默认取 lang */
  label?: string;
  /** 部分站点需要 Referer 才能下载 */
  headers?: Record<string, string>;
}

export interface ResolvedSource {
  /** 播放地址 */
  url: string;
  /** 清晰度标签，如 1080P / 4K / AUTO */
  quality?: string;
  /** 防盗链请求头，播放时透传给 hls.js */
  headers?: Record<string, string>;
  /** 字幕轨 */
  subtitles?: SubtitleTrack[];
  /** 该源的展示名（线路名） */
  label?: string;
  /** 是否官方线路 */
  official?: boolean;
  /** 服务端下发的权重 */
  weight?: number;
  /**
   * 该线路只能由原生 ExoPlayer 播放
   *
   * 直播平台的 HTTP-FLV 流没有 HLS 清单，hls.js 无法解析；
   * 标了它就直接起原生引擎，不必先等 Web 引擎超时再降级。
   */
  nativeOnly?: boolean;
}

export interface SourceProvider {
  /** 唯一标识 */
  id: string;
  /** 展示名 */
  name: string;
  type: SourceType;
  /** 覆盖的分类 */
  categories: SourceCategory[];
  enabled?: boolean;
  /** 排序权重，越小越靠前 */
  order?: number;
  /** 线路优先级，越大越优先 */
  weight?: number;
  official?: boolean;
  /** 刮削型源的解析端点 */
  endpoint?: string;
  /** 直连型源的固定地址 */
  url?: string;
}

export interface LoadContext {
  /** 影片 ID（TMDB 或内部 ID） */
  mediaId: string | number;
  /** 类型 */
  mediaType: 'movie' | 'tv' | 'anime' | 'live';
  /** 剧集季号 */
  season?: number;
  /** 剧集集号 */
  episode?: number;
  /** 是否为「完整版」 */
  full?: boolean;
  /** 取消信号 */
  signal?: AbortSignal;
}

export interface SourceResult {
  /** 成功解析出的线路 */
  sources: ResolvedSource[];
  /** 失败原因 */
  error?: string;
  /** 该源本次耗时 */
  elapsedMs?: number;
}

/** 线路健康状态 */
export type HealthStatus = 'playable' | 'dead' | 'unknown';

export interface HealthResult {
  status: HealthStatus;
  latencyMs: number;
  contentType?: string;
  reason?: string;
}

/** 插播广告分析结论 */
export interface AdVerdict {
  verdict: 'clean' | 'ad' | 'unknown';
  blocked: number;
  total: number;
  adBlocks: { startSec: number; durationSec: number; signals: string[] }[];
  reasons: Record<string, number>;
}
