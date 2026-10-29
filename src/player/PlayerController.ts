/**
 * 播放器控制器 —— 双引擎（Web 优先 + 自动降级）
 *
 * ── 引擎策略（v1.4.0 重大修正）──────────────────────
 * 旧结论是「播放必须下沉原生 ExoPlayer」，依据是「公网影视源无 CORS 头」。
 * **那个结论只对 CMS 接口成立，对播放 CDN 不成立。** 实测结果：
 *
 *   · CMS 采集接口（如 cj.ffzyapi.com）→ 确实无 Access-Control-Allow-Origin，
 *     所以接口层必须走 CapacitorHttp.request()（原生网络栈）。
 *   · **播放 CDN（vod.ffzy-bofang.com / vip.dytt-cinema.com / vod1.maowushi.com…）
 *     的主清单、子清单、分片全部带 `Access-Control-Allow-Origin: *`**
 *     → hls.js 可以在 WebView 里直接播！
 *   · 用户的真机诊断页也印证了这点：诊断用的是 WebView 原生 fetch
 *     （capacitor.config.ts 里 CapacitorHttp.enabled=false，不劫持 XHR），
 *     结果拿到「HTTP 200 · 合法 HLS」。
 *
 * 而且 `CapacitorHttp.enabled = false` 意味着 XHR **不会**被原生补丁劫持，
 * `responseType` 得以保留 → hls.js 能正确读到二进制分片（这正是当初
 * 「必须下沉原生」的第二个理由，同样不成立）。
 *
 * 所以现在的策略是：
 *   **默认 Web 引擎（hls.js）** —— 画面直接渲染在 WebView 里，
 *   没有原生视图覆盖、没有 Surface 层级问题、没有 Dialog 遮挡 UI 的问题。
 *   三轮黑屏修复所引入的全部复杂度（Dialog + TextureView + 触摸穿透）
 *   一次性消失。
 *
 *   **Web 起播失败 → 自动降级原生 ExoPlayer** ——
 *   少数源的分片不带 CORS（如 snm3u8 / bfzym3u8 实测分片无 ACAO），
 *   这类源 WebView 拉不到分片，此时用原生网络栈兜底。
 *
 * ── 容错策略 ──────────────────────────────────────────
 *   播放失败 → 体检该线路 → 死链直接跳过 → 顺延下一条
 *   顺延上限 MAX_TRY 条，避免无限循环。
 *   keep 语义：正在播的源优先，失效才顺延，保证播放体验连贯。
 */

import Hls from 'hls.js';
import { checkLineHealth } from '../providers/health';
import { MAX_TRY, type SelectableSource } from './sourceSelector';
import { NativePlayer, isNativePlayerAvailable } from './nativePlayer';
import { cueAt, parseSubtitles, type Cue } from './subtitle';
import { readLiveDanmakuPref } from '../lib/danmaku';
import {
  getWebAudioFx,
  readAudioEffect,
  type AudioEffect,
  type WebAudioFx,
} from './audioFx';

export interface PlayerOptions {
  /** 起播失败重试次数 */
  maxRetries?: number;
  /** 每条线路的体检超时 */
  healthTimeoutMs?: number;
  /**
   * 直播模式
   *
   * 直播与点播的分支差异：
   *   · hls.js 走直播参数（追到直播边缘、更短的缓冲）
   *   · 不做「按时间 seek 续播」「片头片尾跳过」「自动连播」
   *   · 控制条由调用方渲染成「LIVE」形态
   */
  live?: boolean;
  /** 直播平台（bili / huya / douyu / douyin），原生弹幕层据此选协议 */
  livePlatform?: string;
  /** 直播平台房间号，原生弹幕层订阅用 */
  liveRoomId?: string;
  /** 顺延回调 —— 通知 UI 已切到哪条线 */
  onSourceSwitch?: (from: string | null, to: string, reason: string) => void;
  /** 顺延耗尽 */
  onExhausted?: (tried: number) => void;
  /** 播放状态变化 */
  onStateChange?: (state: PlaybackState) => void;
  /** 就绪 */
  onReady?: () => void;
  /** 错误 */
  onError?: (message: string) => void;
  /** 缓冲进度 0-100 */
  onBuffer?: (percent: number) => void;
  /** 进度（秒） */
  onProgress?: (positionSec: number, durationSec: number) => void;
  /** 视频区被点击（原生引擎下用于切换控制条显隐） */
  onVideoTap?: () => void;
  /** 原生控制条「返回」被点击 */
  onNativeClose?: () => void;
  /** 原生控制条「换一条线」被点击 */
  onNativeNext?: () => void;
  /** 首帧已渲染（用于确认画面真的出来了） */
  onFirstFrame?: () => void;
  /**
   * 视频真实尺寸变化
   *
   * ⚠️ 播放台的宽高比**完全依赖**这个回调。
   * 拿不到 → 只能按默认 16:9 猜 → 宽银幕片（2.35:1）在横屏下
   * 被塞进 16:9 的框，画面上下左右全是假黑边（用户实测反馈）。
   *
   * 两条引擎路径都要报：
   *   Web    → 读 video.videoWidth/videoHeight
   *   原生   → 监听 NativePlayer 的 videoSize 事件
   */
  onVideoSize?: (size: { w: number; h: number }) => void;
  /** 原生控制条「全部线路」被点击 */
  onNativeLines?: () => void;
  /**
   * 原生选集面板选了某一集 / 播完自动下一集
   * @param episode 目标集号
   * @param auto    是否由「播完自动续播」触发
   * @param handled 原生是否已经自己完成换集（true = 前端只同步状态，不要重新起播）
   */
  onNativeEpisode?: (episode: number, auto: boolean, handled: boolean) => void;
  /**
   * 原生预加载已无缝接管下一集
   *
   * 与 onNativeEpisode 不同：播放已经续上了，前端只同步集数即可，
   * 不要再重新解析、重新起播。
   */
  onNativeAutoAdvance?: (episode: number) => void;
  /**
   * 当前字幕行变化（Web 引擎）
   *
   * 原生引擎的字幕由 ExoPlayer 直接画在画面上，不会触发这个回调；
   * 前端只需把文本渲染在自己的字幕层里。
   */
  onSubtitle?: (text: string) => void;
}

export type PlaybackState =
  | 'idle'
  | 'loading'
  | 'buffering'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'error';

type Engine = 'native' | 'web';

/**
 * 是否允许降级到原生引擎
 *
 * 降级只在「Web 引擎起播失败」时发生，且每条线路最多降级一次，
 * 避免 native ↔ web 无限来回切换。
 */
let nativeFallbackAllowed = true;

export class PlayerController {
  private hls: Hls | null = null;
  private video: HTMLVideoElement | null = null;
  private candidates: SelectableSource[] = [];
  private currentIndex = -1;
  private currentLabel: string | null = null;
  private skipCount = 0;
  private switching = false;
  private destroyed = false;
  private retryTimer: number | null = null;
  private nativeHandle: { remove: () => void } | null = null;
  private videoTapHandle: { remove: () => void } | null = null;
  /** 原生引擎的视频尺寸事件句柄 */
  private nativeVideoSizeHandle: { remove: () => void } | null = null;
  private nativeCtrlHandles: Array<{ remove: () => void }> = [];
  private engine: Engine = 'web';
  /** 直播模式（由调用方在构造时决定，运行期不变） */
  private liveMode = false;
  /** 直播看门狗定时器（Web 引擎） */
  private liveWatchdog: number | null = null;
  /** 原生引擎的当前播放态，用于 toggle 判断 */
  private nativePlaying = false;
  /** 原生引擎的进度与时长 */
  private nativePosition = 0;
  private nativeDuration = 0;
  /** 当前倍速 */
  private playbackRate = 1;
  /** 选集列表（原生窗口的选集面板需要） */
  private episodeItems: { n: number; label: string }[] = [];
  /** 整季地址表（原生窗口自己换集用） */
  private episodeUrls: { n: number; url: string }[] = [];
  /** 当前集号（原生窗口标题与选集高亮需要） */
  private episodeNumber = 1;
  /** 起播前海报（原生窗口铺模糊底图用） */
  private posterUrl = '';
  /** 外挂字幕原文（换集/换线重建播放器时要重新下发） */
  private subtitleRaw = '';
  private subtitleMime = 'application/x-subrip';
  /** 解析后的字幕行（Web 引擎按进度取行） */
  private subtitleCues: Cue[] = [];
  private subtitleOn = true;
  /** 上一次推给 UI 的字幕行，用于去重（timeupdate 约 4Hz） */
  private lastCueText = '';
  /** 音效模式（两套引擎共用同一份偏好） */
  private audioEffect: AudioEffect = readAudioEffect();
  private webFx: WebAudioFx | null = null;
  private opts: Required<
    Omit<
      PlayerOptions,
      | 'onSourceSwitch'
      | 'onExhausted'
      | 'onStateChange'
      | 'onReady'
      | 'onError'
      | 'onBuffer'
      | 'onProgress'
      | 'onVideoTap'
      | 'onNativeClose'
      | 'onNativeNext'
      | 'onFirstFrame'
      | 'onNativeLines'
      | 'onNativeEpisode'
      | 'onVideoSize'
      | 'onNativeAutoAdvance'
      | 'onSubtitle'
      | 'live'
      | 'livePlatform'
      | 'liveRoomId'
    >
  > &
    PlayerOptions;

  constructor(options: PlayerOptions = {}) {
    this.opts = {
      maxRetries: MAX_TRY,
      healthTimeoutMs: 6000,
      ...options,
    };
    this.liveMode = options.live === true;
    // 默认 Web 引擎（hls.js）。
    //
    // 实测播放 CDN 全部带 CORS，且 CapacitorHttp.enabled=false 时 XHR
    // 不被劫持、responseType 得以保留 → hls.js 在 WebView 内可正常工作。
    // 只有当 Web 起播失败时才降级到原生 ExoPlayer。
    this.engine = 'web';
  }

  /** 当前使用的播放引擎 */
  get playbackEngine(): Engine {
    return this.engine;
  }

  /** 是否直播模式 */
  get isLive(): boolean {
    return this.liveMode;
  }

  /** 挂载 video 元素（仅 Web 引擎需要） */
  attach(video: HTMLVideoElement) {
    this.video = video;
    video.addEventListener('play', () => this.setState('playing'));
    video.addEventListener('pause', () => {
      if (!video.ended) this.setState('paused');
    });
    video.addEventListener('ended', () => this.setState('ended'));
    video.addEventListener('waiting', () => this.setState('buffering'));

    // ── 进度上报（控制条进度条需要）────────────────────
    // 用 timeupdate 事件（WebView 里约 4Hz），比轮询省电。
    video.addEventListener('timeupdate', () => {
      this.opts.onProgress?.(video.currentTime, video.duration || 0);
      this.opts.onBuffer?.(this.bufferPercent(video));
      this.pushSubtitle(video.currentTime);
    });

    video.addEventListener('progress', () => {
      this.opts.onBuffer?.(this.bufferPercent(video));
    });

    video.addEventListener('loadedmetadata', () => {
      this.opts.onProgress?.(video.currentTime, video.duration || 0);
    });

    /**
     * 上报视频真实尺寸（Web 引擎）
     *
     * ⚠️ 不能只靠 Detail.tsx 监听 'loadedmetadata'：
     *   hls.js 走 MSE 时，metadata 可能在某些源上不触发或触发时宽高还是 0，
     *   导致播放台永远按 16:9 算。
     * 这里在三个时机都上报，取到有效值为止。
     */
    const reportSize = () => {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (w > 0 && h > 0) {
        this.opts.onVideoSize?.({ w, h });
      }
    };
    video.addEventListener('loadedmetadata', reportSize);
    video.addEventListener('resize', reportSize);
    video.addEventListener('durationchange', reportSize);
    // 部分源 metadata 迟到，兜底轮询几次
    let tries = 0;
    const poll = window.setInterval(() => {
      reportSize();
      if (video.videoWidth > 0 || ++tries > 20) {
        window.clearInterval(poll);
      }
    }, 300);
  }

  /** 计算已缓冲百分比（基于 video.buffered 区间） */
  private bufferPercent(video: HTMLVideoElement): number {
    try {
      const dur = video.duration;
      if (!dur || !isFinite(dur) || dur <= 0) return 0;
      const ranges = video.buffered;
      if (!ranges || ranges.length === 0) return 0;
      // 取包含当前播放点的区间末端
      const t = video.currentTime;
      for (let i = 0; i < ranges.length; i++) {
        if (t >= ranges.start(i) && t <= ranges.end(i)) {
          return Math.min(100, (ranges.end(i) / dur) * 100);
        }
      }
      return Math.min(100, (ranges.end(ranges.length - 1) / dur) * 100);
    } catch {
      return 0;
    }
  }

  /**
   * 下发选集上下文
   *
   * 原生播放窗口是独立 Activity，前端 UI 的选集面板在它下面根本点不到，
   * 所以把剧集列表和当前集号同步过去，让原生窗口自己渲染选集面板。
   */
  setEpisodeContext(items: { n: number; label: string }[], current: number) {
    this.episodeItems = items.map((x) => ({ n: x.n, label: x.label }));
    this.episodeNumber = current;
  }

  /**
   * 下发整季地址表
   *
   * 原生窗口据此自己换集：选集点选、播完自动续播都不再回 JS 解析，
   * 避免「事件丢失 / 解析失败」时静默退回当前集。
   */
  setEpisodeUrls(list: { n: number; url: string }[]) {
    this.episodeUrls = list.map((x) => ({ n: x.n, url: x.url }));
  }

  /** 起播前海报（原生窗口用来铺模糊底图） */
  setPoster(url?: string) {
    this.posterUrl = url || '';
  }

  // ── 外挂字幕 ────────────────────────────────────────

  /** 挂载/替换外挂字幕（SRT / VTT 原文） */
  setSubtitle(text: string, mime?: string) {
    this.subtitleRaw = text || '';
    this.subtitleMime = mime || 'application/x-subrip';
    this.subtitleCues = this.subtitleRaw ? parseSubtitles(this.subtitleRaw) : [];
    this.lastCueText = '';
    this.pushSubtitle(this.video ? this.video.currentTime : 0);

    if (this.engine !== 'native') return;
    if (!this.subtitleRaw) {
      void NativePlayer.clearSubtitle().catch(() => {});
      return;
    }
    void NativePlayer.setSubtitle({ text: this.subtitleRaw, mime: this.subtitleMime }).catch(
      () => {},
    );
  }

  /** 卸载外挂字幕 */
  clearSubtitle() {
    this.subtitleRaw = '';
    this.subtitleCues = [];
    this.lastCueText = '';
    this.opts.onSubtitle?.('');
    if (this.engine === 'native') void NativePlayer.clearSubtitle().catch(() => {});
  }

  /**
   * 显示/隐藏字幕轨
   *
   * 原生侧用 TrackSelectionParameters 禁掉 TEXT 轨，不重建 MediaItem，
   * 所以切换是瞬时的；Web 侧只是不再推文本。
   */
  setSubtitleEnabled(on: boolean) {
    this.subtitleOn = on;
    if (!on) {
      this.lastCueText = '';
      this.opts.onSubtitle?.('');
    } else {
      this.pushSubtitle(this.video ? this.video.currentTime : 0);
    }
    if (this.engine === 'native') {
      void NativePlayer.setSubtitleEnabled({ enabled: on }).catch(() => {});
    }
  }

  get hasSubtitle(): boolean {
    return this.subtitleCues.length > 0;
  }

  get subtitleEnabled(): boolean {
    return this.subtitleOn;
  }

  private pushSubtitle(time: number) {
    if (!this.subtitleOn || !this.subtitleCues.length) return;
    const text = cueAt(this.subtitleCues, time);
    if (text === this.lastCueText) return;
    this.lastCueText = text;
    this.opts.onSubtitle?.(text);
  }

  // ── 音效 ────────────────────────────────────────────

  setAudioEffect(mode: AudioEffect) {
    this.audioEffect = mode;
    if (this.engine === 'native') {
      void NativePlayer.setAudioEffect({ mode }).catch(() => {});
      return;
    }
    this.applyWebAudioFx();
  }

  get audioEffectMode(): AudioEffect {
    return this.audioEffect;
  }

  private applyWebAudioFx() {
    if (this.engine !== 'web' || !this.video) return;
    // 「原声」且还没建链 → 不碰音频图，避免无谓地接管 WebView 的音频输出
    if (this.audioEffect === 'off' && !this.webFx) return;
    if (!this.webFx) this.webFx = getWebAudioFx(this.video);
    this.webFx.setMode(this.audioEffect);
  }

  private applyAudioEffectForEngine() {
    if (this.engine === 'native') {
      if (this.audioEffect !== 'off') {
        void NativePlayer.setAudioEffect({ mode: this.audioEffect }).catch(() => {});
      }
      return;
    }
    this.applyWebAudioFx();
  }

  /** 原生 play() 的统一参数（带上选集上下文与播放偏好） */
  private nativePlayOptions(src: SelectableSource) {
    const autoNext = !this.liveMode && localStorage.getItem('sober.autoNext') !== '0';
    const skipOn = !this.liveMode && localStorage.getItem('sober.skipIntro') === '1';
    const skipIntroSec = skipOn ? Number(localStorage.getItem('sober.skipIntroSec') || 90) : 0;
    const skipOutroSec = skipOn ? Number(localStorage.getItem('sober.skipOutroSec') || 30) : 0;

    return {
      url: src.url,
      headers: src.headers ? JSON.stringify(src.headers) : undefined,
      title: src.label || '',
      episode: this.episodeNumber,
      episodes: this.episodeItems.length > 1 ? JSON.stringify(this.episodeItems) : '',
      episodeUrls: this.episodeUrls.length > 1 ? JSON.stringify(this.episodeUrls) : '',
      skipIntroSec: Number.isFinite(skipIntroSec) ? skipIntroSec : 0,
      skipOutroSec: Number.isFinite(skipOutroSec) ? skipOutroSec : 0,
      autoNext,
      live: this.liveMode,
      // 直播弹幕：原生 Activity 自己连 WebSocket 收弹幕，
      // 主 WebView 在原生播放时会被 pauseTimers() 冻结，JS 侧连接会断流。
      danmakuPlatform: this.liveMode ? this.opts.livePlatform || '' : '',
      danmakuRoom: this.liveMode ? this.opts.liveRoomId || '' : '',
      danmakuOn: this.liveMode ? readLiveDanmakuPref() : false,
      poster: this.posterUrl || undefined,
      subtitleText: this.subtitleRaw || undefined,
      subtitleMime: this.subtitleRaw ? this.subtitleMime : undefined,
    };
  }

  /** 候选取自于线路解析结果，顺带把该线路的整季地址表同步过来 */
  private syncEpisodes(src: SelectableSource) {
    if (src.episodes && src.episodes.length) {
      this.episodeUrls = src.episodes.map((x) => ({ n: x.n, url: x.url }));
    }
  }

  /**
   * 预加载下一集（仅原生引擎生效）
   *
   * 前端解析出下一集地址后调用；原生侧静音缓冲，
   * 当前集播完直接接管画面，实现多集连续播放不中断。
   */
  preloadEpisode(src: SelectableSource, episode: number) {
    if (this.engine !== 'native') return;
    void NativePlayer.preload({
      url: src.url,
      headers: src.headers ? JSON.stringify(src.headers) : undefined,
      title: src.label || '',
      episode,
    }).catch(() => {});
  }

  /** 进入画中画小窗（原生侧实现，Web 端由调用方回退到 video API） */
  async enterPip(): Promise<boolean> {
    if (this.engine !== 'native') return false;
    try {
      await NativePlayer.enterPip();
      return true;
    } catch {
      return false;
    }
  }

  /** 设置候选线路并起播 */
  async start(candidates: SelectableSource[], keepLabel?: string) {
    this.candidates = [...candidates];
    this.currentIndex = -1;
    this.currentLabel = keepLabel ?? null;
    this.skipCount = 0;

    if (keepLabel) {
      const i = this.candidates.findIndex((c) => c.label === keepLabel || c.id === keepLabel);
      if (i > 0) {
        const [item] = this.candidates.splice(i, 1);
        this.candidates.unshift(item);
      }
    }

    // 引擎：默认 Web（hls.js）。原生仅作为降级目标。
    //
    // 用户可在设置页勾选「强制使用原生播放器」——用于个别线路
    // 在 WebView 内始终无法起播的情况。
    // 直播平台的 HTTP-FLV 线路没有 HLS 清单，标了 nativeOnly，
    // 这类线路直接起原生引擎，省掉 Web 侧必然失败的 9 秒等待。
    const forceNative =
      typeof localStorage !== 'undefined' &&
      localStorage.getItem('sober.forceNativeEngine') === '1';
    const needNative = forceNative || this.candidates[0]?.nativeOnly === true;

    if (needNative && (await isNativePlayerAvailable())) {
      this.engine = 'native';
      nativeFallbackAllowed = false;
      await this.prepareNative();
    } else {
      this.engine = 'web';
      nativeFallbackAllowed = true;
    }

    // 音效在引擎确定后立刻套用：Web 侧建音频链，原生侧委托给 audiofx
    this.applyAudioEffectForEngine();

    await this.playCurrent();
  }

  /** 原生引擎：准备播放器视图与事件监听 */
  private async prepareNative() {
    try {
      await NativePlayer.prepare();
      if (this.nativeHandle) {
        await this.nativeHandle.remove();
        this.nativeHandle = null;
      }
      const handle = await NativePlayer.addListener('stateChange', (payload) => {
        this.onNativeState(payload);
      });
      this.nativeHandle = handle;

      // 视频区点击 → 通知前端切换控制条
      if (this.videoTapHandle) {
        await this.videoTapHandle.remove();
        this.videoTapHandle = null;
      }
      this.videoTapHandle = await NativePlayer.addListener('videoTap', () => {
        this.opts.onVideoTap?.();
      });

      /**
       * 原生引擎的视频尺寸事件
       *
       * ⚠️ 原生播放器是覆盖在 WebView 上的系统级 View，
       *   Web 侧拿不到 videoWidth/videoHeight → 播放台只能猜 16:9，
       *   宽银幕片在横屏下全是假黑边（用户实测截图）。
       *   原生侧 onVideoSizeChanged 上报的尺寸是唯一可靠来源。
       */
      this.nativeVideoSizeHandle = await NativePlayer.addListener(
        'videoSize',
        (payload) => {
          const w = payload.width ?? 0;
          const h = payload.height ?? 0;
          if (w > 0 && h > 0) {
            this.opts.onVideoSize?.({ w, h });
          }
        },
      );

      // 原生控制条事件
      this.nativeCtrlHandles = [
        await NativePlayer.addListener('nativeClose', () => {
          this.opts.onNativeClose?.();
        }),
        await NativePlayer.addListener('nativeNext', () => {
          this.opts.onNativeNext?.();
        }),
        await NativePlayer.addListener('firstFrame', () => {
          this.opts.onFirstFrame?.();
        }),
        await NativePlayer.addListener('nativeLines', () => {
          this.opts.onNativeLines?.();
        }),
        await NativePlayer.addListener('nativeEpisode', (p) => {
          if (this.destroyed) return;
          if (typeof p.episode === 'number') {
            this.episodeNumber = p.episode;
            this.opts.onNativeEpisode?.(p.episode, p.auto === true, p.handled === true);
          }
        }),
        // 预加载无缝接管：只同步集数，不能再触发重新起播
        await NativePlayer.addListener('nativeAutoAdvanced', (p) => {
          if (this.destroyed) return;
          if (typeof p.episode === 'number') {
            this.episodeNumber = p.episode;
            this.nativePosition = 0;
            this.nativeDuration = 0;
            this.opts.onNativeAutoAdvance?.(p.episode);
          }
        }),
        // 原生窗口在独立 Activity 里，进度只能由原生侧每秒推送。
        // 缺了这条，续播记忆与 Web 端进度会一直停在起播时刻。
        await NativePlayer.addListener('progress', (p) => {
          if (this.destroyed) return;
          if (typeof p.position === 'number') this.nativePosition = p.position / 1000;
          if (typeof p.duration === 'number') this.nativeDuration = p.duration / 1000;
          this.opts.onProgress?.(this.nativePosition, this.nativeDuration);
        }),
      ];
    } catch (err) {
      this.opts.onError?.(`原生播放器初始化失败: ${err instanceof Error ? err.message : err}`);
      this.setState('error');
    }
  }

  /** 原生引擎的状态回调 */
  private onNativeState(payload: {
    state: string;
    position?: number;
    duration?: number;
    message?: string;
  }) {
    if (this.destroyed) return;
    switch (payload.state) {
      case 'buffering':
        this.setState('buffering');
        break;
      case 'playing':
        this.nativePlaying = true;
        this.setState('playing');
        this.opts.onReady?.();
        /**
         * 播放窗口是 startActivity 异步拉起的，起播前调 setAudioEffect /
         * setSubtitleEnabled 时 Activity 可能还不存在（调用被丢弃）。
         * 等第一次真正 playing 时补一次，保证偏好生效。
         */
        this.applyAudioEffectForEngine();
        if (!this.subtitleOn) {
          void NativePlayer.setSubtitleEnabled({ enabled: false }).catch(() => {});
        }
        break;
      case 'paused':
        this.nativePlaying = false;
        this.setState('paused');
        break;
      case 'ended':
        this.nativePlaying = false;
        this.setState('ended');
        break;
      case 'idle':
        this.setState('idle');
        break;
      case 'error':
        this.nativePlaying = false;
        // 关键：原生窗口是全屏的，若不隐藏，用户只会看到一片黑，
        // 看不到 Web UI 里的错误提示，也无法点「换一条线」。
        // 隐藏后错误信息与操作按钮才重新可见。
        void NativePlayer.hide().catch(() => {});
        this.opts.onError?.(payload.message || '播放失败');
        this.setState('error');
        void this.advance('源失效');
        break;
      default:
        break;
    }
    if (typeof payload.position === 'number') this.nativePosition = payload.position / 1000;
    if (typeof payload.duration === 'number') this.nativeDuration = payload.duration / 1000;
    if (typeof payload.position === 'number' && typeof payload.duration === 'number') {
      this.opts.onProgress?.(payload.position / 1000, payload.duration / 1000);
    }
  }

  /** 线路强制要求原生引擎时切换引擎（FLV 等 Web 引擎播不了的格式） */
  private async ensureEngineFor(src: SelectableSource): Promise<void> {
    if (!src.nativeOnly || this.engine === 'native') return;
    if (!(await isNativePlayerAvailable())) {
      throw new Error('这条直播线路需要原生播放器，当前环境不支持');
    }
    this.engine = 'native';
    await this.prepareNative();
  }

  /** 播放当前下标对应的线路 */
  private async playCurrent(): Promise<void> {
    if (this.destroyed) return;
    if (this.currentIndex < 0) this.currentIndex = 0;
    if (this.currentIndex >= this.candidates.length) {
      this.opts.onExhausted?.(this.skipCount);
      this.setState('error');
      return;
    }

    const src = this.candidates[this.currentIndex];
    const from = this.currentLabel;
    this.currentLabel = src.label || src.id;

    this.setState('loading');

    if (this.engine === 'native') {
      try {
        await NativePlayer.play(this.nativePlayOptions(src));
        if (from !== this.currentLabel) {
          this.opts.onSourceSwitch?.(from, this.currentLabel, '切换线路');
        }
      } catch (err) {
        this.opts.onError?.(err instanceof Error ? err.message : String(err));
        await this.advance('起播失败');
      }
      return;
    }

    // Web 引擎（默认）
    this.attachWebSource(src);
    let ok = await this.waitForReady();
    if (ok) {
      if (from !== this.currentLabel) {
        this.opts.onSourceSwitch?.(from, this.currentLabel, '切换线路');
      }
      this.opts.onReady?.();
      return;
    }

    // ── 降级：Web 起播失败 → 换原生 ExoPlayer ──────────
    //
    // 少数源的分片不带 CORS（实测 snm3u8 / bfzym3u8），
    // WebView 拉不到分片 → 用原生网络栈兜底。
    if (await this.fallbackToNative(src)) {
      if (from !== this.currentLabel) {
        this.opts.onSourceSwitch?.(from, this.currentLabel, '已切换播放内核');
      }
      this.opts.onReady?.();
      return;
    }

    await this.advance('起播失败');
  }

  /**
   * 降级到原生 ExoPlayer
   *
   * 触发场景：Web 引擎（hls.js）起播超时/失败。
   * 典型原因：播放 CDN 的**分片**不带 Access-Control-Allow-Origin，
   * WebView 内 XHR 被浏览器同源策略拦截 → 拿不到二进制分片。
   *
   * 原生 ExoPlayer 走 OkHttp/HttpURLConnection 原生网络栈，不受 CORS 限制。
   */
  private async fallbackToNative(src: SelectableSource): Promise<boolean> {
    if (!nativeFallbackAllowed || this.destroyed) return false;
    if (!(await isNativePlayerAvailable())) return false;

    nativeFallbackAllowed = false;
    this.engine = 'native';

    try {
      await this.prepareNative();
      await NativePlayer.play(this.nativePlayOptions(src));
      // 原生引擎的成功信号走 onNativeState('playing')
      return true;
    } catch (err) {
      this.opts.onError?.(`原生兜底失败: ${err instanceof Error ? err.message : err}`);
      this.engine = 'web';
      return false;
    }
  }

  /** 手动换下一条源 */
  async switchNext(): Promise<void> {
    this.skipCount++;
    await this.advance('手动换源');
  }

  /** 手动换指定线路 */
  async switchTo(index: number): Promise<void> {
    if (index < 0 || index >= this.candidates.length) return;
    this.currentIndex = index;
    const from = this.currentLabel;
    const src = this.candidates[index];
    this.currentLabel = src.label || src.id;
    this.syncEpisodes(src);
    this.setState('loading');

    try {
      await this.ensureEngineFor(src);
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err.message : String(err));
      this.setState('error');
      return;
    }

    if (this.engine === 'native') {
      try {
        await NativePlayer.play(this.nativePlayOptions(src));
        if (from !== this.currentLabel) {
          this.opts.onSourceSwitch?.(from, this.currentLabel, '切换线路');
        }
      } catch (err) {
        this.opts.onError?.(err instanceof Error ? err.message : String(err));
      }
      return;
    }

    this.attachWebSource(src);
    const ok = await this.waitForReady();
    if (ok && from !== this.currentLabel) {
      this.opts.onSourceSwitch?.(from, this.currentLabel, '切换线路');
    }
  }

  /** 顺延到下一条 */
  private async advance(reason: string): Promise<void> {
    if (this.switching || this.destroyed) return;
    this.switching = true;

    try {
      const tried = this.currentIndex + 1;
      if (tried >= Math.min(this.candidates.length, this.opts.maxRetries)) {
        this.opts.onExhausted?.(tried);
        this.setState('error');
        return;
      }

      const from = this.currentLabel;
      this.currentIndex++;

      const next = this.candidates[this.currentIndex];
      if (!next) {
        this.opts.onExhausted?.(tried);
        this.setState('error');
        return;
      }

      // 体检 —— 明确死链直接跳过
      const health = await checkLineHealth(next.url, next.headers, this.opts.healthTimeoutMs);
      if (health.status === 'dead') {
        this.opts.onSourceSwitch?.(from, next.label || next.id, `${reason} · 线路失效`);
        this.currentLabel = next.label || next.id;
        await this.advance(`${reason}（线路失效）`);
        return;
      }

      this.setState('loading');
      this.syncEpisodes(next);

      try {
        await this.ensureEngineFor(next);
      } catch (err) {
        this.opts.onError?.(err instanceof Error ? err.message : String(err));
        this.setState('error');
        return;
      }

      if (this.engine === 'native') {
        try {
          await NativePlayer.play(this.nativePlayOptions(next));
          this.opts.onSourceSwitch?.(from, this.currentLabel || '', reason);
        } catch (err) {
          this.opts.onError?.(err instanceof Error ? err.message : String(err));
          await this.advance(reason);
        }
        return;
      }

      this.attachWebSource(next);
      const ok = await this.waitForReady();
      if (ok) {
        this.opts.onSourceSwitch?.(from, this.currentLabel || '', reason);
      } else {
        await this.advance(reason);
      }
    } finally {
      this.switching = false;
    }
  }

  /** Web 引擎：把线路挂到 hls.js */
  private attachWebSource(src: SelectableSource) {
    this.destroyHls();
    if (!this.video) return;

    const url = src.url;
    const video = this.video;

    if (Hls.isSupported()) {
      const hls = new Hls(
        this.liveMode
          ? {
              enableWorker: true,
              // 直播：3 个目标分片就够，缓冲拉太长反而延迟大
              liveSyncDurationCount: 3,
              liveMaxLatencyDurationCount: 8,
              maxBufferLength: 12,
              maxMaxBufferLength: 24,
              backBufferLength: 8,
              manifestLoadingTimeOut: 12000,
              manifestLoadingMaxRetry: 3,
              levelLoadingTimeOut: 12000,
              fragLoadingTimeOut: 20000,
              fragLoadingMaxRetry: 4,
              xhrSetup: (xhr) => {
                const h = src.headers || {};
                if (h.Referer || h.referer) xhr.setRequestHeader('Referer', h.Referer || h.referer);
                if (h['User-Agent'] || h['user-agent']) {
                  xhr.setRequestHeader('User-Agent', h['User-Agent'] || h['user-agent']);
                }
                if (h.Cookie || h.cookie) xhr.setRequestHeader('Cookie', h.Cookie || h.cookie);
              },
            }
          : {
              enableWorker: true,
              lowLatencyMode: false,
              backBufferLength: 90,
              maxBufferLength: 30,
              maxMaxBufferLength: 60,
              manifestLoadingTimeOut: 12000,
              manifestLoadingMaxRetry: 2,
              levelLoadingTimeOut: 12000,
              fragLoadingTimeOut: 20000,
              fragLoadingMaxRetry: 3,
              xhrSetup: (xhr) => {
                const h = src.headers || {};
                if (h.Referer || h.referer) xhr.setRequestHeader('Referer', h.Referer || h.referer);
                if (h['User-Agent'] || h['user-agent']) {
                  xhr.setRequestHeader('User-Agent', h['User-Agent'] || h['user-agent']);
                }
                if (h.Cookie || h.cookie) xhr.setRequestHeader('Cookie', h.Cookie || h.cookie);
              },
            },
      );
      this.hls = hls;

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        void video.play().catch(() => {
          /* 自动播放被拦截，等用户手势 */
        });
        if (this.liveMode) this.startLiveWatchdog(hls, video);
      });

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        void this.handleFatalError(data);
      });

      hls.loadSource(url);
      hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      void video.play().catch(() => {});
    } else {
      // WebView 不支持 HLS（极少见）→ 交给上层降级原生
      this.opts.onError?.('当前设备不支持 HLS 播放');
      this.setState('error');
    }
  }

  /** 处理 hls.js 致命错误（仅 Web 引擎） */
  private async handleFatalError(data: { type: string; details: string }) {
    if (this.destroyed || this.engine !== 'web') return;

    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      try {
        this.hls?.recoverMediaError();
        this.opts.onSourceSwitch?.(this.currentLabel, this.currentLabel || '', '媒体错误恢复中');
        return;
      } catch {
        /* 恢复失败 → 顺延 */
      }
    }

    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      // 网络错误最常见的原因就是「分片被 CORS 拦截」
      // （WebView 内 XHR 受同源策略限制，而播放 CDN 的分片未必带 ACAO）。
      // 这时不该直接顺延换源 —— 换源大概率同样失败。
      // 正确做法：降级到原生 ExoPlayer 用原生网络栈重试同一条线路。
      const src = this.current;
      if (src && (await this.fallbackToNative(src))) {
        this.opts.onSourceSwitch?.(this.currentLabel, this.currentLabel || '', '已切换播放内核');
        return;
      }
      await this.advance('源失效');
      return;
    }

    try {
      this.hls?.startLoad();
    } catch {
      await this.advance('播放异常');
    }
  }

  /** 等待播放器就绪（仅 Web 引擎） */
  private waitForReady(timeoutMs = 9000): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.video) {
        resolve(false);
        return;
      }
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        if (this.retryTimer != null) {
          window.clearTimeout(this.retryTimer);
          this.retryTimer = null;
        }
        resolve(ok);
      };

      const onLoaded = () => {
        void this.video?.play().catch(() => {});
        finish(true);
      };
      const onError = () => finish(false);

      this.video.addEventListener('loadeddata', onLoaded, { once: true });
      this.video.addEventListener('error', onError, { once: true });

      this.retryTimer = window.setTimeout(() => finish(false), timeoutMs);
    });
  }

  private setState(s: PlaybackState) {
    this.opts.onStateChange?.(s);
  }

  private destroyHls() {
    this.stopLiveWatchdog();
    if (this.hls) {
      try {
        this.hls.destroy();
      } catch {
        /* ignore */
      }
      this.hls = null;
    }
  }

  /**
   * 直播看门狗（Web 引擎）
   *
   * 直播比点播多两类故障，hls.js 都不会主动报 fatal：
   *   1. 网络抖动后播放点越落越后，延迟一路攒到十几秒；
   *   2. 卡在缓冲里一直不动，永远停在 buffering。
   * 每 8 秒检查一次：落后直播边缘超过 12 秒就跳到推荐位置，
   * 连续 24 秒没有前进则重拉一次分片。
   * 用户手动暂停时不做任何干预。
   */
  private startLiveWatchdog(hls: Hls, video: HTMLVideoElement) {
    this.stopLiveWatchdog();
    let lastTime = video.currentTime;
    let lastMoveAt = Date.now();

    this.liveWatchdog = window.setInterval(() => {
      if (this.destroyed || this.hls !== hls) return;
      const now = Date.now();
      if (video.paused) {
        lastMoveAt = now;
        return;
      }
      if (video.currentTime > lastTime + 0.25) {
        lastTime = video.currentTime;
        lastMoveAt = now;
      }

      const sync = hls.liveSyncPosition;
      if (typeof sync === 'number' && sync > 0 && sync - video.currentTime > 12) {
        try {
          video.currentTime = sync;
        } catch {
          /* 位置还没进入可跳区间，下一轮再试 */
        }
        return;
      }

      if (now - lastMoveAt > 24_000) {
        lastMoveAt = now;
        try {
          hls.startLoad(-1);
        } catch {
          /* 重拉失败交给线路顺延 */
        }
      }
    }, 8000);
  }

  private stopLiveWatchdog() {
    if (this.liveWatchdog != null) {
      window.clearInterval(this.liveWatchdog);
      this.liveWatchdog = null;
    }
  }

  /** 当前线路 */
  get current(): SelectableSource | null {
    return this.currentIndex >= 0 ? this.candidates[this.currentIndex] ?? null : null;
  }

  /** 全部候选 */
  get list(): SelectableSource[] {
    return this.candidates;
  }

  /** 跳转 */
  seek(seconds: number) {
    if (this.engine === 'native') {
      void NativePlayer.seek({ position: Math.round(seconds * 1000) });
      return;
    }
    if (this.video) this.video.currentTime = seconds;
  }

  /** 播放/暂停 */
  toggle() {
    if (this.engine === 'native') {
      if (this.nativePlaying) {
        void NativePlayer.pause();
      } else {
        void NativePlayer.resume();
      }
      return;
    }
    if (!this.video) return;
    if (this.video.paused) void this.video.play();
    else this.video.pause();
  }

  /** 音量 */
  setVolume(v: number) {
    if (this.video) this.video.volume = Math.max(0, Math.min(1, v));
  }

  /** 是否处于暂停状态 */
  get paused(): boolean {
    if (this.engine === 'native') return !this.nativePlaying;
    return this.video ? this.video.paused : true;
  }

  /** 当前播放位置（秒） */
  get position(): number {
    if (this.engine === 'native') return this.nativePosition;
    return this.video ? this.video.currentTime : 0;
  }

  /** 总时长（秒） */
  get duration(): number {
    if (this.engine === 'native') return this.nativeDuration;
    const d = this.video ? this.video.duration : 0;
    return isFinite(d) ? d : 0;
  }

  /**
   * 设置倍速
   *
   * Web 引擎用 video.playbackRate（原生支持，无需插件）。
   * 原生引擎用 Media3 的 PlaybackParameters。
   */
  setPlaybackRate(rate: number) {
    const r = Math.max(0.25, Math.min(3, rate));
    this.playbackRate = r;
    if (this.engine === 'native') {
      void NativePlayer.setPlaybackSpeed({ speed: r }).catch(() => {});
      return;
    }
    if (this.video) this.video.playbackRate = r;
  }

  /** 当前倍速 */
  get rate(): number {
    return this.playbackRate;
  }

  /**
   * 可用的清晰度档位
   *
   * ⚠️ 实测：这些公网源的主清单普遍只有 1 条 `EXT-X-STREAM-INF`
   *    → 手动切清晰度基本没意义。
   *    但 hls.js 的 **ABR（自适应码率）**仍然有效 ——
   *    多码率源会自动切，单码率源就是固定清晰度。
   *    所以这里返回的是 hls.js 探测到的档位，而非源声明的。
   */
  get qualityLevels(): { index: number; height: number; bitrate: number }[] {
    if (!this.hls) return [];
    try {
      const levels = this.hls.levels || [];
      return levels
        .map((l, i) => ({
          index: i,
          height: l.height || 0,
          bitrate: l.bitrate || 0,
        }))
        .filter((l) => l.height > 0);
    } catch {
      return [];
    }
  }

  /** 当前清晰度档位索引（-1 = 自动） */
  get currentQuality(): number {
    if (!this.hls) return -1;
    try {
      return this.hls.currentLevel;
    } catch {
      return -1;
    }
  }

  /**
   * 切换清晰度
   * @param index -1 表示交给 ABR 自动选择
   */
  setQuality(index: number) {
    if (!this.hls) return;
    try {
      this.hls.currentLevel = index;
    } catch {
      /* 忽略 */
    }
  }

  /**
   * 开启/关闭 ABR 自适应码率
   *
   * hls.js 的 `autoLevelEnabled` 是只读属性，
   * 用 `currentLevel = -1` 表达「交给 ABR 自动选择」，
   * `currentLevel >= 0` 则是锁定到指定档位。
   */
  setAutoQuality(on: boolean) {
    if (!this.hls) return;
    try {
      this.hls.currentLevel = on ? -1 : Math.max(0, this.hls.currentLevel);
    } catch {
      /* 忽略 */
    }
  }

  /**
   * 只解绑事件，不销毁原生播放窗口
   *
   * 切集时新的 PlayerController 会接管同一个 PlayerActivity。
   * 若走 destroy()，原生侧会直接关掉窗口 → 切集瞬间闪黑再重开。
   * 不销毁又会让旧监听器继续响应（换线/选集事件重复触发），
   * 所以单独提供这个方法只做解绑。
   */
  detach() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.retryTimer != null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.destroyHls();
    void this.nativeHandle?.remove();
    this.nativeHandle = null;
    void this.videoTapHandle?.remove();
    this.videoTapHandle = null;
    void this.nativeVideoSizeHandle?.remove();
    this.nativeVideoSizeHandle = null;
    for (const h of this.nativeCtrlHandles) void h.remove();
    this.nativeCtrlHandles = [];
  }

  /** 销毁 */
  destroy() {
    this.destroyed = true;
    if (this.retryTimer != null) window.clearTimeout(this.retryTimer);
    this.destroyHls();
    this.webFx?.dispose();
    this.webFx = null;

    if (this.engine === 'native') {
      void this.nativeHandle?.remove();
      this.nativeHandle = null;
      void this.videoTapHandle?.remove();
      this.videoTapHandle = null;
      void this.nativeVideoSizeHandle?.remove();
      this.nativeVideoSizeHandle = null;
      for (const h of this.nativeCtrlHandles) {
        void h.remove();
      }
      this.nativeCtrlHandles = [];
      void NativePlayer.destroy().catch(() => {});
      return;
    }

    if (this.video) {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
    }
  }
}
