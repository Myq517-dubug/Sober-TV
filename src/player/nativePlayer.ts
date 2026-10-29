/**
 * 原生播放器（Media3 ExoPlayer）JS 封装
 *
 * 对应安卓端 NativePlayerPlugin.java。
 *
 * 存在的理由：
 *   公网影视源无 CORS 头，且 CapacitorHttp 的 XHR 补丁会丢弃 responseType，
 *   导致 hls.js 无法取得二进制分片。原生 ExoPlayer 走系统网络栈，
 *   不受同源策略约束，且 HLS 切片/加密/多码率均由它负责。
 *
 * 在 Web 预览环境（浏览器）下本模块不可用，调用方需回退到 hls.js。
 */

import { Capacitor, registerPlugin } from '@capacitor/core';

export interface NativePlayerState {
  state: 'idle' | 'loading' | 'buffering' | 'playing' | 'paused' | 'ended' | 'error';
  position?: number;
  duration?: number;
  message?: string;
}

interface NativePlayerPlugin {
  prepare(): Promise<{ ok: boolean }>;
  play(options: {
    url: string;
    headers?: string;
    title?: string;
    /** 选集列表（JSON 字符串，形如 [{"n":1,"label":"第 1 集"}]），原生窗口里的选集面板用 */
    episodes?: string;
    /**
     * 整季地址表（JSON 字符串，形如 [{"n":1,"url":"https://..."}]）
     *
     * 原生窗口拿到后可以自己换集：选集面板点选、播完自动续播
     * 都在播放进程内完成，不必回 JS 重新解析再起播。
     */
    episodeUrls?: string;
    /** 当前集号 */
    episode?: number;
    /** 起播后跳过片头秒数（0 = 不跳） */
    skipIntroSec?: number;
    /** 剩余不足该秒数时直接进入下一集（0 = 不跳片尾） */
    skipOutroSec?: number;
    /** 播完是否自动续下一集 */
    autoNext?: boolean;
    /** 起播前展示的模糊海报底图 */
    poster?: string;
    /** 直播模式：原生控制条隐藏进度/倍速/选集，只留播放与返回 */
    live?: boolean;
    /**
     * 画面填充：true = 铺满裁切，false = 完整显示
     *
     * 不传时由原生侧自行决定（直播默认完整、点播沿用上次偏好），
     * 所以这里必须是可选且允许缺省。
     */
    fill?: boolean;
    /** 直播弹幕平台（bili / douyu），原生侧据此选协议 */
    danmakuPlatform?: string;
    /** 直播平台房间号 */
    danmakuRoom?: string;
    /** 直播弹幕开关 */
    danmakuOn?: boolean;
    /** 外挂字幕全文（SRT / VTT），随起播一起挂载 */
    subtitleText?: string;
    /** 字幕 MIME（text/vtt | application/x-subrip） */
    subtitleMime?: string;
  }): Promise<void>;
  /**
   * 运行中挂载/替换外挂字幕
   *
   * 原生侧会把文本落到缓存文件再交给 ExoPlayer：
   * 字幕动辄几百 KB，直接塞 Intent 会撞上 Binder 1MB 上限。
   */
  setSubtitle(options: { text: string; mime?: string }): Promise<void>;
  /** 移除外挂字幕 */
  clearSubtitle(): Promise<void>;
  /** 显示/隐藏字幕轨（不卸载） */
  setSubtitleEnabled(options: { enabled: boolean }): Promise<void>;
  /** 音效模式：off | dolby | spatial | dialog | bass */
  setAudioEffect(options: { mode: string }): Promise<void>;
  getAudioEffect(): Promise<{ mode: string }>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  seek(options: { position: number }): Promise<void>;
  getPosition(): Promise<{ position: number; duration: number }>;
  hide(): Promise<void>;
  show(): Promise<void>;
  destroy(): Promise<void>;
  /** 保持屏幕常亮（两种引擎都需要，Web 引擎下无 Dialog 时尤其必要） */
  keepAwake(options: { enable: boolean }): Promise<void>;
  /** 设置倍速（仅原生引擎用到，Web 引擎用 video.playbackRate） */
  setPlaybackSpeed(options: { speed: number }): Promise<void>;
  /** 进入画中画小窗（Android 8.0+） */
  enterPip(): Promise<void>;
  /**
   * 预加载下一集（多集连续缓存）
   *
   * 原生侧会建一个静音实例提前拉流缓冲，当前集播完直接接管画面。
   * 前端负责解析出下一集的真实地址后调用。
   */
  preload(options: {
    url: string;
    headers?: string;
    title?: string;
    episode?: number;
  }): Promise<void>;
  /**
   * 画面填充模式（仅原生引擎）
   *
   * fill=true  → 等比放大铺满整屏，溢出部分居中裁切（对应 CSS object-fit: cover）
   * fill=false → 完整显示画面，可能留黑边（对应 object-fit: contain）
   */
  setFillMode(options: { fill: boolean }): Promise<void>;
  /** 诊断：确认原生侧是否就绪 */
  diagnose(): Promise<{
    available: boolean;
    pluginId?: string;
    hasPlayer?: boolean;
    hasDialog?: boolean;
    dialogShowing?: boolean;
    width?: number;
    height?: number;
    visible?: boolean;
    surfaceReady?: boolean;
    /** 画面承载视图类型（SurfaceView / TextureView），用于确认合成方式 */
    surfaceType?: string;
    /** 画面 surface 是否已提到窗口之上（true = 不依赖窗口透明区） */
    surfaceOnTop?: boolean;
    playbackState?: number;
    isPlaying?: boolean;
    playWhenReady?: boolean;
    videoWidth?: number;
    videoHeight?: number;
    /** 首帧是否已真正渲染（排查「有声无画」时最有用） */
    firstFrameRendered?: boolean;
    /** 安装包版本号 */
    version?: string;
    /** 视频轨 / 音频轨数量 */
    videoTrackCount?: number;
    audioTrackCount?: number;
    /** 选中视频轨的编码（如 video/avc、video/hevc） */
    videoMime?: string;
  }>;
  addListener(
    eventName: 'stateChange',
    listener: (payload: NativePlayerState) => void,
  ): Promise<{ remove: () => void }>;
  /** 视频区点击（用于切换控制条显隐） */
  addListener(
    eventName: 'videoTap',
    listener: () => void,
  ): Promise<{ remove: () => void }>;
  /** 原生控制条「返回」 */
  addListener(eventName: 'nativeClose', listener: () => void): Promise<{ remove: () => void }>;
  /** 原生控制条「换一条线」 */
  addListener(eventName: 'nativeNext', listener: () => void): Promise<{ remove: () => void }>;
  /** 播放窗口被关闭 */
  addListener(eventName: 'nativeClosed', listener: () => void): Promise<{ remove: () => void }>;
  /** 首帧渲染 */
  addListener(eventName: 'firstFrame', listener: () => void): Promise<{ remove: () => void }>;
  /** 原生控制条「全部线路」 */
  addListener(eventName: 'nativeLines', listener: () => void): Promise<{ remove: () => void }>;
  /**
   * 原生选集面板选中了某一集，或播完自动续下一集
   *
   * `handled=true` 表示原生已经用整季地址表自己换集了，
   * 前端只同步集数即可，**不要**再调 play() 重新起播，否则会把画面打断一次。
   */
  addListener(
    eventName: 'nativeEpisode',
    listener: (payload: {
      episode: number;
      label?: string;
      auto?: boolean;
      handled?: boolean;
    }) => void,
  ): Promise<{ remove: () => void }>;
  /**
   * 预加载接管了下一集
   *
   * 与 nativeEpisode 的区别：这一集已经在原生侧无缝续播，
   * 前端只需同步集数，**不要**再调 play() 重新起播。
   */
  addListener(
    eventName: 'nativeAutoAdvanced',
    listener: (payload: { episode: number; auto?: boolean; preloaded?: boolean }) => void,
  ): Promise<{ remove: () => void }>;
  /**
   * 播放进度（原生引擎每秒推送一次）
   *
   * 原生窗口的画面在独立 Activity 里，Web 端读不到 video.currentTime，
   * 续播记忆与进度展示只能依赖这个事件。
   */
  addListener(
    eventName: 'progress',
    listener: (payload: { position: number; duration: number }) => void,
  ): Promise<{ remove: () => void }>;
  /**
   * 视频真实尺寸（原生引擎）
   *
   * 原生播放器是覆盖在 WebView 上的系统级 View，
   * Web 侧读不到 videoWidth → 播放台宽高比只能靠这个事件。
   */
  addListener(
    eventName: 'videoSize',
    listener: (payload: { width: number; height: number; pixelAspectRatio?: number }) => void,
  ): Promise<{ remove: () => void }>;
}

const NativePlayer = registerPlugin<NativePlayerPlugin>('NativePlayer');

/**
 * 原生播放器是否可用
 *
 * ── 为什么不能只用 Capacitor.isPluginAvailable() ────────
 * `isPluginAvailable` 查的是 JS 侧的 `PluginHeaders` 快照。
 * 自建插件通过 `MainActivity.registerPlugin()` 运行时注册，
 * 若注册时序导致 JS 快照里没有它，就会误判为「不可用」→
 * 静默回退到 hls.js → 而 hls.js 在 WebView 里因 CORS 拉不到分片
 * → **表现为「点播放一直黑屏」，且没有任何报错**。
 *
 * 所以这里直接调原生方法做探测，用「原生能响应」作为唯一判据。
 */
export async function isNativePlayerAvailable(): Promise<boolean> {
  try {
    if (!Capacitor.isNativePlatform()) return false;
    const diag = await NativePlayer.diagnose();
    return diag?.available === true;
  } catch {
    return false;
  }
}

/** 同步版本的粗判（仅用于 UI 文案展示，播放前仍需 await 探测） */
export function isNativePlatformOnly(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

export { NativePlayer };
export type { NativePlayerPlugin };
