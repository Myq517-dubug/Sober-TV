import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { Button } from '../components/Button';
import { fetchDetail, fetchSeasons, loadCatalogue, type MediaItem } from '../lib/catalogue';
import { PosterCard } from '../components/PosterCard';
import { isFavorite, toggleFavorite } from '../lib/favorites';
import { resolveDirect, resolveLines, type ResolvedLine } from '../lib/resolve';
import { PlayerController } from '../player/PlayerController';
import { NativePlayer, isNativePlatformOnly } from '../player/nativePlayer';
import { PlayerBar, fmtTime } from '../player/PlayerBar';
import { PlayerGestures } from '../player/PlayerGestures';
import { useAutoHideControls } from '../hooks/useAutoHideControls';
import type { SelectableSource } from '../player/sourceSelector';
import { getMemory, resumePosition, saveMemory, clearMemory } from '../lib/memory';
import {
  getSubtitle,
  saveSubtitle,
  removeSubtitle,
  type StoredSubtitle,
} from '../lib/subtitleStore';
import { MAX_SUBTITLE_BYTES, parseSubtitles } from '../player/subtitle';
import { readAudioEffect, saveAudioEffect, audioEffectLabel, type AudioEffect } from '../player/audioFx';
import { httpText } from '../lib/net';
import {
  isScreenOrientationAvailable,
  setLandscape,
  unlockOrientation,
  isLandscape,
  setImmersive,
  getSafeInsets,
} from '../player/screenOrientation';
import {
  isCastAvailable,
  listCastDevices,
  castTo,
  stopCast,
  onCastState,
  type CastDevice,
} from '../player/cast';
import './Detail.css';
import '../player/PlayerBar.css';

/** 读取本地持久化的数值（音量/亮度），缺失或非法时回退默认值 */
function readStoredNumber(key: string, fallback: number): number {
  const raw = localStorage.getItem(key);
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** 按文件名推断字幕 MIME（VTT / SRT） */
function subtitleMimeOf(name: string): string {
  return /\.vtt$/i.test(name) ? 'text/vtt' : 'application/x-subrip';
}

/**
 * 详情页 + 播放
 *
 * 播放链路（公网直连）：
 *   影片名 → CMS 跨源搜索 → 详情 → 解析 m3u8 → 原生 ExoPlayer 起播
 *
 * 播放失败自动顺延，UI 上以轻提示告知用户已切换线路。
 */
export function Detail() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const mediaType = params.get('type') || 'movie';

  const [detail, setDetail] = useState<any>(null);
  const [seasons, setSeasons] = useState<any[]>([]);
  const [season, setSeason] = useState(1);
  const [episode, setEpisode] = useState(1);
  const [loading, setLoading] = useState(true);

  const [playing, setPlaying] = useState(false);
  const [playState, setPlayState] = useState<string>('idle');
  const [currentLabel, setCurrentLabel] = useState<string>('');
  const [toast, setToast] = useState<string>('');
  const [lines, setLines] = useState<ResolvedLine[]>([]);
  const [resolving, setResolving] = useState(false);
  const [showLines, setShowLines] = useState(false);
  const [error, setError] = useState<string>('');
  /** 控制条显隐（横屏全屏时自动收起，见 useAutoHideControls） */
  /**
   * 控制条是否强制常驻
   *
   * 场景：用户正在拖进度条 / 打开选集面板 / 菜单展开时，
   * 不能被自动隐藏计时器收走，否则操作到一半控件消失。
   */
  const [controlsPinned, setControlsPinned] = useState(false);  /** 是否已渲染首帧（用于看门狗判断） */
  const firstFrameRef = React.useRef(false);

  // ── 播放器控制条状态 ────────────────────────────────
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [paused, setPaused] = useState(true);
  const [rate, setRate] = useState(1);
  /** 音量 / 亮度：手势调节后持久化，下次起播自动恢复 */
  const [volume, setVolume] = useState(() => readStoredNumber('sober.volume', 1));
  const [brightness, setBrightness] = useState(() =>
    readStoredNumber('sober.brightness', 1),
  );
  const [qualities, setQualities] = useState<{ index: number; height: number; bitrate: number }[]>([]);
  const [currentQuality, setCurrentQuality] = useState(-1);
  const [showEpisodes, setShowEpisodes] = useState(false);
  /** 续播提示（显示「继续观看 xx:xx」） */
  const [resumeTip, setResumeTip] = useState<number | null>(null);
  void resumeTip;
  /** 已跳过的续播提示 */
  const resumeAppliedRef = React.useRef(false);
  /** 进度保存节流时间戳 */
  const lastSaveRef = React.useRef(0);
  /** 手势提示文字（空字符串 = 不显示） */
  const [gestureHint, setGestureHint] = useState('');
  /** 视频原始宽高（用于让播放台贴合画面，避免大片黑边） */
  const [videoSize, setVideoSize] = useState<{ w: number; h: number } | null>(null);
  /** 播放台的像素尺寸（按视频宽高比算，保证画面完整可见） */
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  /**
   * 铺满模式（横屏宽银幕片）
   *
   * true → 画面用 object-fit: cover 裁切填满舞台（左右上下都铺满）
   * false → 用 contain 完整显示（可能有黑边）
   */
  const [fillMode, setFillMode] = useState(false);
  /** 铺满偏好（设置页「横屏全屏铺满屏幕」开关，默认开启） */
  const [fillEnabled] = useState(() => localStorage.getItem('sober.videoFillMode') !== '0');

  /** 控制条距屏幕底部的距离 */
  const [barBottom, setBarBottom] = useState(0);
  /** 系统栏/刘海安全内边距（原生实测值） */
  const [insets, setInsets] = useState({ top: 0, bottom: 0, left: 0, right: 0 });
  /** 是否横屏 */
  const [landscape, setLandscapeState] = useState(false);
  /** 是否已自动进入全屏（避免重复触发） */
  const autoFullscreenRef = React.useRef(false);
  /** 投屏设备列表面板 */
  const [showCast, setShowCast] = useState(false);
  /** 可投屏设备 */
  const [castDevices, setCastDevices] = useState<CastDevice[]>([]);
  /** 正在扫描设备 */
  const [casting, setCasting] = useState(false);
  /** 投屏扫描提示 */
  const [castHint, setCastHint] = useState('');

  // ── 外挂字幕 ────────────────────────────────────────
  /** 已保存的字幕记录（按影片 ID 留存，最多 5 部） */
  const [storedSub, setStoredSub] = useState<StoredSubtitle | null>(null);
  /** 字幕开关（关闭只是不显示，不删除） */
  const [subtitleOn, setSubtitleOn] = useState(
    () => localStorage.getItem('sober.subtitleOn') !== '0',
  );
  /** Web 引擎当前字幕行（原生引擎由 ExoPlayer 自己画） */
  const [cueText, setCueText] = useState('');
  /** 字幕面板 */
  const [showSubtitle, setShowSubtitle] = useState(false);
  /** 字幕导入中 */
  const [subLoading, setSubLoading] = useState(false);
  /** 字幕链接输入 */
  const [subUrl, setSubUrl] = useState('');
  /** 字幕提示（导入失败原因等） */
  const [subHint, setSubHint] = useState('');
  const subFileRef = React.useRef<HTMLInputElement | null>(null);
  /** 字幕外观偏好（设置页可改） */
  const [subSize] = useState(() => localStorage.getItem('sober.subtitleSize') || 'md');
  const [subBg] = useState(() => localStorage.getItem('sober.subtitleBg') || 'shadow');

  // ── 音效 ────────────────────────────────────────────
  const [audioEffect, setAudioEffect] = useState<AudioEffect>(() => readAudioEffect());
  /** 当前实际引擎（原生引擎的字幕与音效由播放窗口自己处理） */
  const [nativeEngine, setNativeEngine] = useState(false);

  const playerRef = React.useRef<PlayerController | null>(null);
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const keepLabelRef = React.useRef<string>('');
  /**
   * 当前集数的 ref
   *
   * 原生预加载接管下一集后，播放没有重新起播，
   * 但进度回调仍跑在旧的闭包里 → 必须从 ref 读最新集数，
   * 否则续播记忆会把「第 5 集」写成「第 4 集」。
   */
  const episodeRef = React.useRef(episode);
  episodeRef.current = episode;
  /** 预加载下一集（函数定义在 startPlayback 之后，用 ref 转发） */
  const preloadNextRef = React.useRef<(ep: number) => Promise<void>>(async () => {});
  /** startPlayback 的转发 ref：原生选集 / 自动续播回调里需要重新起播 */
  const startPlaybackRef = React.useRef<(ep?: number) => Promise<void>>(async () => {});
  /** 整季地址表：换集时优先直接取地址，解析失败也能换集 */
  const episodeUrlsRef = React.useRef<{ n: number; url: string }[]>([]);
  /** 地址表所属线路的元信息（换集时复用，不必再解析） */
  const lineMetaRef = React.useRef<ResolvedLine | null>(null);
  /** 本集是否已执行过片头跳过 */
  const introSkippedRef = React.useRef(false);
  /** 本集是否已触发过片尾跳过（避免每 250ms 重复触发） */
  const outroFiredRef = React.useRef(false);
  /**
   * 自动全屏 / 读取安全区的转发 ref
   *
   * 这两个函数在组件体中定义于 startPlayback 之后，
   * 但 startPlayback 的 onReady 回调里要用它们。
   * 用 ref 转发，避免 TDZ（暂时性死区）问题与依赖数组的循环依赖。
   */
  const autoFullscreenRef2 = React.useRef<() => Promise<void>>(async () => {});
  const refreshInsetsRef = React.useRef<() => Promise<void>>(async () => {});

  // 加载元数据
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      const d = await fetchDetail(id, mediaType);
      if (!cancelled) setDetail(d);
      if (mediaType === 'tv') {
        const s = await fetchSeasons(id, mediaType);
        if (!cancelled && s.length) {
          setSeasons(s);
          setSeason(s[0].season);
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [id, mediaType]);

  /** 收藏状态（本地存储，无需请求） */
  const [faved, setFaved] = useState(() => (id ? isFavorite(id) : false));
  useEffect(() => {
    setFaved(id ? isFavorite(id) : false);
  }, [id]);

  /** 读取本片已保存的字幕（换片时重新读） */
  useEffect(() => {
    setStoredSub(id ? getSubtitle(String(id)) : null);
    setCueText('');
    setSubHint('');
    setSubUrl('');
    setShowSubtitle(false);
  }, [id]);

  /** 相似推荐：同类型优先，其次同媒体类型，取自片库缓存 */
  const [similar, setSimilar] = useState<MediaItem[]>([]);
  useEffect(() => {
    if (!detail) return;
    let cancelled = false;
    (async () => {
      try {
        const c = await loadCatalogue();
        const pool = c.rows.flatMap((r) => r.items).filter((x) => String(x.id) !== String(id));
        const seen = new Set<string>();
        const pick: MediaItem[] = [];
        const push = (x: MediaItem) => {
          const k = String(x.id);
          if (seen.has(k) || pick.length >= 12) return;
          seen.add(k);
          pick.push(x);
        };
        if (detail.typeLabel) {
          pool.filter((x) => x.typeLabel === detail.typeLabel).forEach(push);
        }
        pool.filter((x) => x.mediaType === detail.mediaType).forEach(push);
        if (!cancelled) setSimilar(pick);
      } catch {
        /* 片库不可用时不出推荐区 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [detail, id]);

  // ── 控制条自动隐藏（横屏全屏）────────────────────────
  //
  // 需求：全屏观影时不该有进度条和按钮挡着画面。
  // 逻辑抽到 hooks/useAutoHideControls.ts（可被端到端测试直接挂载验证）。
  const controls = useAutoHideControls({
    landscape,
    pinned: controlsPinned,
  });

  /** 显示控制条并重置自动隐藏计时 */
  const revealControls = controls.reveal;

  /**
   * 面板打开时 pin 住控制条
   *
   * 选集 / 线路 / 投屏面板都是覆盖在控制条之上的，
   * 若此时控制条被自动隐藏，用户会以为「面板怎么没有底栏了」。
   * 面板全部关闭后自动解除 pin。
   */
  React.useEffect(() => {
    const anyPanelOpen = showEpisodes || showLines || showCast || showSubtitle;
    setControlsPinned(anyPanelOpen);
    if (anyPanelOpen) {
      // 面板打开时把控制条也显示出来（面板可能盖住它）
      controls.reveal();
    }
  }, [showEpisodes, showLines, showCast, showSubtitle, controls]);


  /**
   * 播放记忆 —— 恢复上次看的集数与线路
   *
   * 场景：用户上次看到第 5 集、用的是「非凡资源」线路，
   *       再次进入该剧时应直接续上，而不是回到第 1 集。
   *
   * 注意：只在「首次进入该影片」时应用一次（用 ref 标记），
   *       否则用户手动换集后会被记忆覆盖回去。
   */
  const memoryAppliedRef = React.useRef(false);
  useEffect(() => {
    if (!id || memoryAppliedRef.current) return;
    const mem = getMemory(String(id));
    if (!mem) return;
    memoryAppliedRef.current = true;

    // 恢复集数
    if (mem.episode > 1) {
      setEpisode(mem.episode);
    }
    // 恢复线路（keep 语义：优先用上次成功的那条）
    if (mem.keepLabel) {
      keepLabelRef.current = mem.keepLabel;
    }
  }, [id]);

  /**
   * 解析线路
   *
   * 优先「直连」：条目本身带 sourceId + vodId 时直接取播放地址，
   * 跳过按片名跨源搜索（搜索是详情页最慢的一步）。
   * 直连失败（源临时不可用）再回落到跨源搜索。
   */
  const doResolve = useCallback(
    async (ep: number, keep?: string): Promise<ResolvedLine[]> => {
      const m = String(id).match(/^cms~(.+)~(\d+)$/);
      if (m) {
        const direct = await resolveDirect(m[1], Number(m[2]), ep);
        if (direct.length) {
          if (keep) {
            const i = direct.findIndex((s) => s.label === keep);
            if (i > 0) {
              const [item] = direct.splice(i, 1);
              direct.unshift(item);
            }
          }
          return direct;
        }
      }
      if (!detail?.title) return [];
      return resolveLines({
        title: detail.title,
        mediaType: mediaType as 'movie' | 'tv' | 'anime' | 'live',
        episode: ep,
        keep,
      });
    },
    [id, detail?.title, mediaType],
  );

  // 解析全部线路（换源面板用）
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setResolving(true);
    doResolve(mediaType === 'movie' ? 1 : episode)
      .then((l) => {
        if (!cancelled) setLines(l);
      })
      .catch(() => {
        /* 拿不到线路不影响元数据展示 */
      })
      .finally(() => {
        if (!cancelled) setResolving(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, doResolve, mediaType, episode]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(''), 2600);
  }, []);

  // ── 字幕 ────────────────────────────────────────────

  /** 导入字幕文本（本地文件与链接共用） */
  const importSubtitleText = useCallback(
    (name: string, raw: string) => {
      if (!id) return;
      const cues = parseSubtitles(raw);
      if (!cues.length) {
        setSubHint('没有解析到字幕行，请确认是 SRT / VTT 文件');
        return;
      }
      const rec = saveSubtitle(String(id), { name, text: raw });
      if (!rec) {
        setSubHint('字幕保存失败：本地存储空间不足');
        return;
      }
      setStoredSub(rec);
      setSubHint(`已导入「${name}」· ${cues.length} 行`);
      setSubtitleOn(true);
      localStorage.setItem('sober.subtitleOn', '1');
      const ctrl = playerRef.current;
      if (ctrl) {
        ctrl.setSubtitle(rec.text, subtitleMimeOf(name));
        ctrl.setSubtitleEnabled(true);
      }
    },
    [id],
  );

  /** 本地文件导入 */
  const onPickSubtitleFile = useCallback(
    async (file: File) => {
      if (file.size > MAX_SUBTITLE_BYTES) {
        setSubHint('字幕文件超过 2 MB，请确认没有选到视频文件');
        return;
      }
      setSubLoading(true);
      setSubHint('正在读取字幕…');
      try {
        const text = await file.text();
        importSubtitleText(file.name, text);
      } catch {
        setSubHint('读取字幕失败');
      } finally {
        setSubLoading(false);
      }
    },
    [importSubtitleText],
  );

  /** 链接导入（走原生网络栈，绕过字幕站点的跨域限制） */
  const importSubtitleFromUrl = useCallback(async () => {
    const u = subUrl.trim();
    if (!u) return;
    setSubLoading(true);
    setSubHint('正在下载字幕…');
    try {
      const res = await httpText(u, { timeoutMs: 12000 });
      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
      const raw = u.split('/').pop() || '外挂字幕';
      let name = raw;
      try {
        name = decodeURIComponent(raw);
      } catch {
        /* 已编码的路径片段解不出来就用原文 */
      }
      importSubtitleText(name || '外挂字幕', res.body);
    } catch (e) {
      setSubHint(`下载失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSubLoading(false);
    }
  }, [subUrl, importSubtitleText]);

  /** 字幕显示开关（只隐藏，不删文件） */
  const toggleSubtitle = useCallback((on: boolean) => {
    setSubtitleOn(on);
    localStorage.setItem('sober.subtitleOn', on ? '1' : '0');
    playerRef.current?.setSubtitleEnabled(on);
    if (!on) setCueText('');
  }, []);

  /** 移除本片字幕 */
  const dropSubtitle = useCallback(() => {
    if (!id) return;
    removeSubtitle(String(id));
    setStoredSub(null);
    setCueText('');
    playerRef.current?.clearSubtitle();
    setSubHint('已移除本片字幕');
  }, [id]);

  /** 打开/关闭字幕面板（原生窗口会挡住 WebView，需要临时收起） */
  const toggleSubtitlePanel = useCallback(async () => {
    const next = !showSubtitle;
    setShowSubtitle(next);
    if (playerRef.current?.playbackEngine === 'native') {
      if (next) await NativePlayer.hide().catch(() => {});
      else await NativePlayer.show().catch(() => {});
    }
  }, [showSubtitle]);

  /** 关闭字幕面板（点遮罩 / 关闭按钮共用，顺带把原生窗口放回来） */
  const closeSubtitlePanel = useCallback(async () => {
    setShowSubtitle(false);
    if (playerRef.current?.playbackEngine === 'native') {
      await NativePlayer.show().catch(() => {});
    }
  }, []);

  /** 切换音效 */
  const changeAudioEffect = useCallback(
    (m: AudioEffect) => {
      setAudioEffect(m);
      saveAudioEffect(m);
      playerRef.current?.setAudioEffect(m);
      showToast(`音效：${audioEffectLabel(m)}`);
    },
    [showToast],
  );

  const currentSeason = seasons.find((s) => s.season === season);

  /**
   * 选集列表
   *
   * 优先用季数据（`currentSeason.episodes`，含真实集名），
   * 没有季数据时回退到 `detail.episodeCount` 推断出的集数。
   *
   * 这份数据要下发给原生播放窗口（原生侧自己渲染选集面板）。
   */
  const episodeItems = React.useMemo<{ n: number; label: string }[]>(() => {
    if (currentSeason?.episodes?.length) {
      return currentSeason.episodes.map((ep: any) => ({
        n: ep.ep,
        label: ep.name || ep.title || `第 ${ep.ep} 集`,
      }));
    }
    const count = detail?.episodeCount || 0;
    if (!count) return [];
    return Array.from({ length: Math.min(count, 200) }, (_, i) => ({
      n: i + 1,
      label: `第 ${i + 1} 集`,
    }));
  }, [currentSeason, detail?.episodeCount]);

  /** 上一集 / 下一集（按集号找相邻项，中间缺集时也能跨过去） */
  const prevEpisode = React.useMemo(
    () => [...episodeItems].reverse().find((e) => e.n < episode),
    [episodeItems, episode],
  );
  const nextEpisode = React.useMemo(
    () => episodeItems.find((e) => e.n > episode),
    [episodeItems, episode],
  );
  /** 选集面板里当前集按钮，打开面板时滚到它 */
  const currentEpRef = React.useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!showEpisodes) return;
    currentEpRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [showEpisodes]);

  /** 起播 */
  const startPlayback = useCallback(async (targetEp?: number) => {
    setError('');
    setPlaying(true);
    setPlayState('loading');

    // 旧控制器先解绑事件（不销毁原生窗口，否则切集瞬间闪黑重开）
    playerRef.current?.detach();
    playerRef.current = null;

    // ── 屏幕常亮 ──────────────────────────────────────
    // v1.4.0 起默认走 Web 引擎（无原生 Dialog），
    // 而 FLAG_KEEP_SCREEN_ON 原本只设在 Dialog 的 Window 上 →
    // 播放时屏幕会正常息屏，用户看几秒就黑屏。
    // 这里对 Activity 窗口设常亮，两种引擎都生效。
    void NativePlayer.keepAwake({ enable: true }).catch(() => {});
    // 把「铺满 / 适应」偏好同步给原生引擎（Web 引擎由 CSS object-fit 处理）
    void NativePlayer.setFillMode({ fill: fillEnabled }).catch(() => {});

    // 指定集数时用它（选集面板），否则用当前集
    const ep = targetEp ?? episode;

    // 片头片尾跳过偏好（每次起播读一次）
    const skipOn = localStorage.getItem('sober.skipIntro') === '1';
    const skipIntroSec = skipOn ? Number(localStorage.getItem('sober.skipIntroSec') || 90) : 0;
    const skipOutroSec = skipOn ? Number(localStorage.getItem('sober.skipOutroSec') || 30) : 0;
    const autoNextOn = localStorage.getItem('sober.autoNext') !== '0';
    introSkippedRef.current = false;
    outroFiredRef.current = false;

    try {
      /**
       * 换集优先走整季地址表
       *
       * 同一条线路的地址在首次起播时就全拿到了，切集直接取用：
       * 秒切、不依赖 CMS 再搜一次，也避免「集名匹配不上就退回第 1 集」。
       */
      const mapped = episodeUrlsRef.current.find((x) => x.n === ep && !!x.url);
      const meta = lineMetaRef.current;

      let resolved: ResolvedLine[];
      if (mapped && meta) {
        resolved = [{ ...meta, url: mapped.url, episodeIndex: ep - 1 }];
      } else {
        resolved = await doResolve(
          mediaType === 'movie' ? 1 : ep,
          keepLabelRef.current || undefined,
        );
      }

      /**
       * 解析失败时用整季地址表兜底
       *
       * CMS 的集名格式五花八门（「第03集」「03」「正片」），按集号匹配
       * 偶尔会挑不中。地址表是首次起播时同一条线路返回的原始数据，
       * 直接按集号取用最可靠 —— 否则表现就是「点了第 5 集还是播第 1 集」。
       */
      if (!resolved.length) {
        const mapped = episodeUrlsRef.current.find((x) => x.n === ep);
        if (mapped) {
          resolved = [
            {
              id: `mapped-${ep}`,
              url: mapped.url,
              label: keepLabelRef.current || '',
              lineName: '',
              sourceId: '',
              vodId: 0,
              episodeIndex: ep - 1,
              quality: 'AUTO',
              official: false,
              weight: 0,
            },
          ];
        }
      }

      if (!resolved.length) {
        setError('暂无可播线路');
        setPlayState('error');
        setLines(resolved);
        return;
      }

      setLines(resolved);

      // 记住这条线路的整季地址表：换集时优先直接用，避免再解析一次
      const lineWithEps = resolved.find((r) => r.episodes && r.episodes.length > 1);
      if (lineWithEps?.episodes?.length) {
        episodeUrlsRef.current = lineWithEps.episodes;
        lineMetaRef.current = lineWithEps;
      } else if (!mapped || !meta) {
        // 新线路没有地址表 → 丢掉旧表，避免拿上一条线路的地址换集
        episodeUrlsRef.current = [];
        lineMetaRef.current = resolved[0] ?? null;
      }

      const candidates: SelectableSource[] = resolved.map((r) => ({
        id: r.id,
        url: r.url,
        quality: r.quality,
        headers: r.headers,
        subtitles: r.subtitles,
        label: r.label,
        official: r.official,
        weight: r.weight,
        episodes: r.episodes,
      }));

      const ctrl = new PlayerController({
        onSourceSwitch: (_from, to, reason) => {
          keepLabelRef.current = to;
          setCurrentLabel(to);
          // 线路换了 → 地址表跟着换，否则换集会播到上一条线路的地址
          const l = resolved.find((r) => r.label === to || r.id === to);
          if (l) {
            lineMetaRef.current = l;
            episodeUrlsRef.current = l.episodes && l.episodes.length > 1 ? l.episodes : [];
            ctrl.setEpisodeUrls(episodeUrlsRef.current);
          }
          showToast(`${reason} → ${to}`);
        },
        onStateChange: (s) => {
          setPlayState(s);
          /**
           * Web 引擎播完自动续下一集
           *
           * 原生引擎由播放窗口自己接管（预加载/无缝换集），
           * 这里只处理 WebView 内的 hls.js 播放。
           */
          if (s === 'ended' && ctrl.playbackEngine !== 'native' && autoNextOn) {
            const nextItem = episodeItems.find((e) => e.n > episodeRef.current);
            if (nextItem) void startPlaybackRef.current(nextItem.n);
          }
        },
        onReady: () => {
          /**
           * 原生引擎的 STATE_READY 只代表「缓冲够了」，此时可能仍是黑屏；
           * 画面是否真的出来，要等 firstFrame 事件。若这里直接标记首帧，
           * 下面的 15 秒看门狗就永远不会触发 → 用户会一直卡在黑屏里。
           */
          if (ctrl.playbackEngine !== 'native') firstFrameRef.current = true;
          setPlayState('playing');

          /**
           * 片头跳过（Web 引擎）
           *
           * 断点续播时不动画面（用户本来就从中途接着看），
           * 只有从头起播才跳到片头之后。原生引擎由播放窗口自己处理。
           */
          if (
            ctrl.playbackEngine !== 'native' &&
            !resumeAppliedRef.current &&
            !introSkippedRef.current &&
            skipIntroSec > 0
          ) {
            introSkippedRef.current = true;
            ctrl.seek(skipIntroSec);
            showToast(`已跳过片头 ${skipIntroSec} 秒`);
          }

          // 起播成功 → 自动进入沉浸式横屏全屏
          void autoFullscreenRef2.current();
        },
        onExhausted: () => {
          setError('所有线路均不可用');
          setPlayState('error');
        },
        onError: (m) => {
          setError(m);
          setPlayState('error');
        },
        onVideoTap: () => {
          // 点击视频区：显示/隐藏切换（显示时自动重置隐藏计时）
          controls.toggle();
        },
        onProgress: (pos, dur) => {
          setPosition(pos);
          if (dur > 0) setDuration(dur);
          setPaused(playerRef.current?.paused ?? false);

          /**
           * 片尾跳过（Web 引擎）
           *
           * 剩不到 N 秒时直接进下一集，省掉片尾字幕的等待。
           * 原生引擎在播放窗口里用整季地址表做同样的判断。
           */
          if (
            ctrl.playbackEngine !== 'native' &&
            autoNextOn &&
            skipOutroSec > 0 &&
            dur > 0 &&
            !outroFiredRef.current &&
            dur - pos <= skipOutroSec
          ) {
            const nextItem = episodeItems.find((e) => e.n > episodeRef.current);
            if (nextItem) {
              outroFiredRef.current = true;
              showToast(`片尾已跳过，播放第 ${nextItem.n} 集`);
              void startPlaybackRef.current(nextItem.n);
            }
          }

          // ── 记忆持久化（节流 5 秒）───────────────────
          // 一次写全：进度 + 集数 + 线路 + 片名/海报，
          // 这样「继续观看」行不需要再发请求就能渲染。
          const now = Date.now();
          if (now - lastSaveRef.current > 5000 && id) {
            lastSaveRef.current = now;
            saveMemory(String(id), {
              position: pos,
              duration: dur,
              episode: episodeRef.current,
              keepLabel: keepLabelRef.current || undefined,
              title: detail?.title ?? '',
              poster: detail?.poster,
              mediaType: (mediaType as 'movie' | 'tv' | 'anime' | 'live') ?? 'movie',
              totalEpisodes: detail?.episodeCount,
            });
          }
        },
        onBuffer: (pct) => setBuffered(pct),
        onNativeClose: () => {
          playerRef.current?.destroy();
          playerRef.current = null;
          void NativePlayer.keepAwake({ enable: false }).catch(() => {});
          setPlaying(false);
        },
        onNativeNext: async () => {
          keepLabelRef.current = '';
          await playerRef.current?.switchNext();
        },
        onNativeLines: () => {
          // 原生控制条点了「全部线路」→ Dialog 已隐藏，这里弹出 Web 端列表
          setShowLines(true);
        },
        onNativeEpisode: (n, auto, handled) => {
          // 原生窗口里的选集面板 / 播完自动续播
          episodeRef.current = n;
          setEpisode(n);
          setPosition(0);
          setDuration(0);
          setPaused(false);
          setResumeTip(null);
          clearMemory(String(id));

          /**
           * handled=true：原生已用整季地址表自己换集了。
           * 这里只同步 UI，绝不能再起播 —— 否则会把刚接上的画面重开一次。
           */
          if (handled) {
            resumeAppliedRef.current = true;
            showToast(auto ? `已自动播放第 ${n} 集` : `正在播放第 ${n} 集`);
            window.setTimeout(() => {
              void preloadNextRef.current(n);
            }, 3000);
            return;
          }

          // 原生没有地址（老版本/单集资源）→ 回前端重新解析线路起播
          resumeAppliedRef.current = false;
          if (auto) showToast(`即将播放第 ${n} 集`);
          void startPlaybackRef.current(n);
        },
        onNativeAutoAdvance: (n) => {
          /**
           * 预加载已经无缝接管下一集：这里只同步 UI 状态，不能再起播，
           * 否则会把刚接上的画面重新打断一次。
           */
          episodeRef.current = n;
          setEpisode(n);
          setPosition(0);
          setDuration(0);
          setPaused(false);
          setResumeTip(null);
          resumeAppliedRef.current = true;
          clearMemory(String(id));
          showToast(`已自动播放第 ${n} 集`);
          // 接着预加载再下一集，长剧集可以一直连播
          window.setTimeout(() => {
            void preloadNextRef.current(n);
          }, 3000);
        },
        onFirstFrame: () => {
          firstFrameRef.current = true;
        },
        onVideoSize: (s) => {
          // 视频真实尺寸 → 播放台宽高比
          //
          // ⚠️ 这是「横屏画面没铺满」的关键：
          //   拿不到尺寸只能按 16:9 猜 → 宽银幕片（2.35:1）
          //   被塞进 16:9 的框 → 上下左右全是假黑边。
          //   Web 引擎从 video.videoWidth 拿，
          //   原生引擎从原生插件的 videoSize 事件拿。
          setVideoSize({ w: s.w, h: s.h });
        },
        onSubtitle: (t) => setCueText(t),
      });

      // 外挂字幕 + 音效：换集 / 换线都会重建控制器，这里重新挂上
      const savedSub = id ? getSubtitle(String(id)) : null;
      if (savedSub?.text) ctrl.setSubtitle(savedSub.text, subtitleMimeOf(savedSub.name));
      ctrl.setSubtitleEnabled(localStorage.getItem('sober.subtitleOn') !== '0');
      ctrl.setAudioEffect(readAudioEffect());

      // 把选集数据下发原生窗口（原生侧自己渲染选集面板）
      ctrl.setEpisodeContext(episodeItems, ep);
      // 整季地址表：原生窗口据此自己换集，不再依赖 JS 往返
      ctrl.setEpisodeUrls(episodeUrlsRef.current);
      // 起播前的模糊海报底图（原生窗口用）
      ctrl.setPoster(detail?.backdrop || detail?.poster || '');

      // 注意：引擎在 start() 内部异步探测，
      // 所以此处不能判断 playbackEngine 来决定是否 attach video。
      // 统一交给 PlayerController：探测到 web 引擎时若已有 video 则自动挂载。
      playerRef.current = ctrl;
      if (videoRef.current) {
        ctrl.attach(videoRef.current);
      }
      firstFrameRef.current = false;
      await ctrl.start(candidates, keepLabelRef.current || undefined);
      setCurrentLabel(candidates[0]?.label || '');
      setNativeEngine(ctrl.playbackEngine === 'native');

      // 剧集 + 原生引擎 → 稍后后台解析并预加载下一集，
      // 当前集播完由原生侧直接接管，做到多集连播几乎零等待。
      if (mediaType !== 'movie' && mediaType !== 'live') {
        window.setTimeout(() => {
          if (playerRef.current === ctrl) void preloadNextRef.current(ep);
        }, 4000);
      }

      // ── 续播：起播成功后跳到上次位置 ─────────────────
      //
      // 只在「本次是首次进入该集」时应用一次，
      // 用户手动换集/换源后不再重复跳。
      if (!resumeAppliedRef.current && id) {
        resumeAppliedRef.current = true;
        const rp = resumePosition(String(id));
        if (rp && rp > 3) {
          // 等视频真正有 duration 再 seek，否则部分浏览器会忽略
          window.setTimeout(() => {
            ctrl.seek(rp);
            setPosition(rp);
            setResumeTip(rp);
            showToast(`已续播至 ${fmtTime(rp)}`);
          }, 600);
        }
      }

      // 读取清晰度档位（hls.js 探测到后才有值）
      window.setTimeout(() => {
        const lv = ctrl.qualityLevels;
        if (lv.length) setQualities(lv);
        setCurrentQuality(ctrl.currentQuality);
      }, 1500);

      // 看门狗：15 秒内没有画面 → 明确报错并自动换线
      // （避免「无声黑屏」——用户无法判断是卡住还是死了）
      //
      // Web 引擎下 hls.js 起播成功会触发 onReady → onFirstFrame；
      // 原生引擎下由插件的 firstFrame 事件触发。
      window.setTimeout(() => {
        if (!firstFrameRef.current && playerRef.current === ctrl) {
          // 若已降级到原生引擎，原生窗口是全屏的 → 必须隐藏，
          // 否则 Web UI 的错误提示与「换一条线」按钮点不到。
          if (ctrl.playbackEngine === 'native') {
            void NativePlayer.hide().catch(() => {});
          }
          setError('该线路未能起播，正在尝试下一条');
          setPlayState('error');
          void ctrl.switchNext();
        }
      }, 15000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPlayState('error');
    }
  }, [doResolve, mediaType, episode, showToast, fillEnabled, episodeItems, id]);

  // 原生选集 / 自动续播回调里通过 ref 重新起播，避免闭包拿到旧状态
  startPlaybackRef.current = startPlayback;

  /** 选集 / 上一集 / 下一集共用入口：清掉当前集记忆再从目标集起播 */
  const selectEpisode = useCallback(
    (n: number) => {
      setShowEpisodes(false);
      setEpisode(n);
      setResumeTip(null);
      resumeAppliedRef.current = false;
      if (id) clearMemory(String(id));
      void startPlayback(n);
    },
    [id, startPlayback],
  );

  /**
   * 预加载下一集（仅原生引擎）
   *
   * 解析下一集的线路后交给原生侧静音预缓冲。
   * 失败直接忽略 —— 用户此刻正在看当前集，预加载只是锦上添花。
   */
  const preloadNextEpisode = useCallback(
    async (currentEp: number) => {
      if (mediaType === 'movie' || mediaType === 'live') return;
      const ctrl = playerRef.current;
      if (!ctrl || ctrl.playbackEngine !== 'native') return;
      const nextItem = episodeItems.find((e) => e.n > currentEp);
      if (!nextItem) return;
      try {
        const resolved = await doResolve(nextItem.n, keepLabelRef.current || undefined);
        const r = resolved[0];
        if (!r || playerRef.current !== ctrl) return;
        ctrl.preloadEpisode(
          {
            id: r.id,
            url: r.url,
            quality: r.quality,
            headers: r.headers,
            subtitles: r.subtitles,
            label: r.label,
            official: r.official,
            weight: r.weight,
          },
          nextItem.n,
        );
      } catch {
        /* 预加载失败不影响当前播放 */
      }
    },
    [doResolve, episodeItems, mediaType],
  );
  preloadNextRef.current = preloadNextEpisode;

  /**
   * 监听视频元数据 → 计算播放台宽高比
   *
   * ⚠️ 这只是**兜底**路径。
   *   主路径是 PlayerController 的 onVideoSize 回调
   *   （原生引擎下 <video> 元素根本没有内容，读不到宽高）。
   *   这里保留是为了覆盖「Web 引擎 metadata 早于 attach 触发」的时序。
   */
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onMeta = () => {
      if (v.videoWidth > 0 && v.videoHeight > 0) {
        setVideoSize({ w: v.videoWidth, h: v.videoHeight });
      }
    };
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('resize', onMeta);
    onMeta();
    return () => {
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('resize', onMeta);
    };
  }, [playing]);

  /**
   * 音量 / 亮度落到 <video> 上
   *
   * 音量走 video.volume；亮度用 CSS filter 模拟（WebView 改不了系统亮度）。
   * 每次起播都要重设 —— 换 src 会把 volume 重置回 1。
   */
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = Math.max(0, Math.min(1, volume));
    v.style.filter =
      Math.abs(brightness - 1) < 0.01 ? '' : `brightness(${brightness.toFixed(2)})`;
    localStorage.setItem('sober.volume', String(volume));
    localStorage.setItem('sober.brightness', String(brightness));
  }, [playing, volume, brightness]);

  /**
   * 读取系统安全区（刘海 / 状态栏 / 导航条）
   *
   * Android WebView 的 env(safe-area-inset-*) 不可靠，
   * 横屏挖孔屏上常返回 0 → 左/右侧按钮被刘海切掉。
   * 用原生实测 inset 兜底。
   */
  const refreshInsets = useCallback(async () => {
    if (!isScreenOrientationAvailable()) return;
    const i = await getSafeInsets();
    setInsets({ top: i.top, bottom: i.bottom, left: i.left, right: i.right });
  }, []);
  refreshInsetsRef.current = refreshInsets;

  useEffect(() => {
    if (!playing) return;
    void refreshInsets();
    const onResize = () => void refreshInsets();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [playing, refreshInsets]);

  /**
   * 播放台布局
   *
   * ── 为什么不再用 JS 算像素位置 ──────────────────────
   * 旧实现把舞台的宽高与左上角都算成像素（--stage-w/h/x/y），有两个硬伤：
   *
   *  1) 拿不到真实宽高比时按 16:9 建舞台。
   *     截图实测：2844×1280 屏上舞台宽 2275 —— 正好 1280×16/9，
   *     而影片实际是 2.38:1，于是视频在 16:9 的框里又被 contain 一次，
   *     左右各留 12.66% / 7.35% 的假黑边。
   *
   *  2) 舞台居中用的是「可用宽」（屏宽 - 左右 inset），而不是整屏。
   *     横屏挖孔屏左右 inset 不等（实测 safeL≈151px、safeR=0），
   *     画面整体右移：左黑边 360 / 右黑边 209，肉眼就是「不对称」。
   *
   * 现在：舞台铺满整屏，比例交给 CSS object-fit 按视频**内在**宽高比处理 ——
   * 浏览器自己保证居中对称，也不再依赖 JS 是否及时拿到视频尺寸。
   * JS 只负责三件事：
   *   - 横屏且影片比屏幕更宽 → cover（左右用满、上下对称裁切）
   *   - 竖屏 → 底部预留控制条高度
   *   - 竖屏 → 把控制条贴到画面下沿
   */
  useEffect(() => {
    const BAR_H = 132;

    const calc = () => {
      const shellW = window.innerWidth;
      const shellH = window.innerHeight;
      if (!shellW || !shellH) return;

      const isLand = shellW >= shellH;
      const hasRealRatio = !!videoSize && videoSize.w > 0 && videoSize.h > 0;
      const ratio = hasRealRatio ? videoSize.w / videoSize.h : null;

      // 舞台：横向永远用满整屏；竖向在底部给控制条留位
      const stageH = isLand ? shellH : Math.max(1, shellH - BAR_H);
      setStageSize({ w: Math.round(shellW), h: Math.round(stageH) });

      // 恒定铺满：横屏且用户开启「铺满」时一律 cover（不论影片比例），
      // 多余部分居中裁切；关闭铺满或竖屏则完整显示画面
      setFillMode(isLand && fillEnabled);

      // 控制条：横屏浮在屏幕底；竖屏贴画面下沿
      if (isLand) {
        setBarBottom(0);
        return;
      }
      const picH = ratio ? Math.min(stageH, shellW / ratio) : stageH;
      setBarBottom(Math.max(0, Math.round(shellH - ((stageH - picH) / 2 + picH))));
    };

    // 旋转瞬间 innerWidth/innerHeight 可能还是旧值：补一帧 + 延迟再算一次
    const recalc = () => {
      calc();
      requestAnimationFrame(calc);
      window.setTimeout(calc, 150);
    };

    recalc();
    window.addEventListener('resize', recalc);
    window.addEventListener('orientationchange', recalc);
    return () => {
      window.removeEventListener('resize', recalc);
      window.removeEventListener('orientationchange', recalc);
    };
  }, [videoSize, landscape, fillEnabled]);

  // ── 横屏切换 ──────────────────────────────────────
  const toggleLandscape = useCallback(async () => {
    if (!isScreenOrientationAvailable()) {
      showToast('当前环境不支持横屏切换');
      return;
    }
    const next = !landscape;
    if (next) {
      await setLandscape(true);
    } else {
      await unlockOrientation();
      // 退出横屏时恢复系统栏（竖屏下没必要一直沉浸）
      await setImmersive(false);
    }
    setLandscapeState(next);
    autoFullscreenRef.current = false; // 用户手动操作过，不再自动触发
    showToast(next ? '已切换横屏' : '已恢复竖屏');
  }, [landscape, showToast]);

  /**
   * 自动进入横屏全屏
   *
   * 用户实测反馈「没有自动全屏」—— 起播后应当直接进入
   * 沉浸式横屏（隐藏状态栏 + 导航栏），画面铺满整屏。
   *
   * 触发时机：起播成功（拿到首帧）后，避免在解析阶段就转屏。
   * 只做一次（autoFullscreenRef），用户手动切回竖屏后不再打扰。
   */
  const enterAutoFullscreen = useCallback(async () => {
    if (autoFullscreenRef.current) return;
    if (!isScreenOrientationAvailable()) return;
    // 用户可在设置里关闭「播放时自动横屏全屏」
    if (localStorage.getItem('sober.autoLandscape') === '0') return;
    autoFullscreenRef.current = true;

    await setLandscape(true);
    await setImmersive(true);
    setLandscapeState(true);
    void refreshInsetsRef.current();
  }, []);
  autoFullscreenRef2.current = enterAutoFullscreen;

  // 监听方向变化（用户自己转手机时同步状态）
  useEffect(() => {
    if (!isScreenOrientationAvailable()) return;
    const onResize = () => {
      void isLandscape().then((l) => {
        setLandscapeState(l);
        // 用户手动转成横屏时，同样进入沉浸式
        if (l && playing) {
          void setImmersive(true);
        }
      });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [playing]);

  // 退出播放页时恢复方向与系统栏（不能把 App 永久留在横屏/沉浸式）
  useEffect(() => {
    return () => {
      if (isScreenOrientationAvailable()) {
        void unlockOrientation();
        void setImmersive(false);
      }
    };
  }, []);

  // ── 投屏 ──────────────────────────────────────────
  /** 打开投屏面板并扫描设备 */
  const openCast = useCallback(async () => {
    if (!isCastAvailable()) {
      showToast('当前环境不支持投屏');
      return;
    }
    setShowCast(true);
    setCastHint('正在搜索设备…');
    const devices = await listCastDevices();
    setCastDevices(devices);
    setCastHint(
      devices.length
        ? `找到 ${devices.length} 台设备`
        : '未发现可投屏设备（请确认电视已开启 DLNA/投屏功能，且与手机在同一 WiFi）',
    );
  }, [showToast]);

  /** 选中设备 → 推流 */
  const doCast = useCallback(
    async (device: CastDevice) => {
      const url = playerRef.current?.current?.url;
      if (!url) {
        setCastHint('当前没有可投屏的播放地址');
        return;
      }
      setCasting(true);
      setCastHint(`正在推送到「${device.name}」…`);
      const ok = await castTo(
        device.id,
        url,
        detail?.title ?? '',
        Math.round((playerRef.current?.position ?? 0) * 1000),
      );
      if (ok) {
        setCastHint(`已投屏到「${device.name}」，电视端正在播放`);
        showToast('投屏成功');
        // 投屏后停掉手机本地播放，避免两边同时出声
        playerRef.current?.toggle();
      } else {
        setCastHint('投屏失败，请重试或换一台设备');
        setCasting(false);
      }
    },
    [detail?.title, showToast],
  );

  // 监听投屏状态
  useEffect(() => {
    if (!isCastAvailable()) return;
    let handle: { remove: () => void } | null = null;
    void onCastState((st) => {
      if (!st.connected) {
        setCasting(false);
        setCastHint('投屏已断开');
      }
    }).then((h) => {
      handle = h;
    });
    return () => {
      void handle?.remove();
    };
  }, []);

  /**
   * 画中画小窗
   *
   * 原生引擎：由 PlayerActivity 自己进 PiP（小窗里只有画面）。
   * Web 引擎：优先用浏览器 PiP API；WebView 不支持时退化为原生整体 PiP。
   */
  const openPip = useCallback(async () => {
    const ctrl = playerRef.current;
    if (ctrl && (await ctrl.enterPip())) return;

    const v = videoRef.current;
    if (v && typeof document !== 'undefined' && document.pictureInPictureEnabled) {
      try {
        await v.requestPictureInPicture();
        return;
      } catch {
        /* 忽略，继续尝试原生整体 PiP */
      }
    }

    if (isNativePlatformOnly()) {
      try {
        await NativePlayer.enterPip();
        return;
      } catch {
        /* 落到统一提示 */
      }
    }
    showToast('当前环境不支持画中画');
  }, [showToast]);

  // 组件卸载时销毁播放器 + 关闭屏幕常亮
  useEffect(() => {
    return () => {
      playerRef.current?.destroy();
      playerRef.current = null;
      void NativePlayer.keepAwake({ enable: false }).catch(() => {});
    };
  }, []);

  /** 起播等待时的模糊海报底图 */
  const backdropUrl = detail?.backdrop || detail?.poster || '';

  if (loading) {
    return (
      <div className="detail">
        <div className="detail__hero skeleton" style={{ height: 300 }} />
      </div>
    );
  }

  return (
    <div className={`detail ${playing ? 'detail--playing' : ''}`}>
      {playing && (
        <div
          className={`player-shell ${landscape ? 'is-landscape' : ''}`}
          style={
            {
              ['--stage-w' as string]: `${stageSize.w}px`,
              ['--stage-h' as string]: `${stageSize.h}px`,
              ['--pbar-bottom' as string]: `${barBottom}px`,
              ['--safe-t' as string]: `${insets.top}px`,
              ['--safe-b' as string]: `${insets.bottom}px`,
              ['--safe-l' as string]: `${insets.left}px`,
              ['--safe-r' as string]: `${insets.right}px`,
            } as React.CSSProperties
          }
        >
          {/* 播放台：铺满整屏，宽高比由 object-fit 处理；竖屏控制条贴画面下沿 */}
          <div className={`player__stage${fillMode ? ' is-fill' : ''}`}>
            {/* Web 引擎用的 video；原生引擎下由原生 PlayerView 覆盖显示 */}
            <video ref={videoRef} className="player__video" playsInline />
          </div>

          {/* 起播前：海报模糊底图，避免长时间纯黑等待 */}
          <div
            className={`player__backdrop ${playState === 'playing' ? 'is-hidden' : ''}`}
            style={{
              backgroundImage: backdropUrl ? `url("${backdropUrl}")` : undefined,
            }}
            aria-hidden="true"
          />

          <div className={`player__overlay ${controls.visible ? '' : 'is-hidden'}`}>
            <button
              className="player__back"
              onClick={() => {
                // 必须销毁播放器：原生视图是覆盖在 WebView 上的系统级 View，
                // 不销毁会残留在屏幕上（表现为退不出播放页 / 全屏黑屏）
                playerRef.current?.destroy();
                playerRef.current = null;
                void NativePlayer.keepAwake({ enable: false }).catch(() => {});
                setPlaying(false);
              }}
              aria-label="返回"
            >
              <svg viewBox="0 0 24 24" width="22" height="22">
                <path
                  d="M15 5l-7 7 7 7"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>

            <div className="player__status">
              {playState === 'loading' && (
                <>
                  <span className="player__spin" aria-hidden="true" />
                  正在连接「{currentLabel || '线路'}」…
                </>
              )}
              {playState === 'buffering' && '缓冲中…'}
              {playState === 'playing' && currentLabel}
              {playState === 'error' && error}
            </div>

            {showLines && (
              <div className="lines-panel">
                {lines.length === 0 && (
                  <p className="lines-panel__empty">
                    {resolving ? '正在解析线路…' : '暂无可播线路'}
                  </p>
                )}
                {lines.map((l) => (
                  <div className="lines-group" key={l.id}>
                    <p className="lines-group__name">{l.label}</p>
                    <button
                      className="lines-item"
                      onClick={async () => {
                        const idx = playerRef.current?.list.findIndex((x) => x.url === l.url) ?? -1;
                        if (idx >= 0 && playerRef.current) {
                          await playerRef.current.switchTo(idx);
                          keepLabelRef.current = l.label ?? '';
                          setCurrentLabel(l.label ?? '');
                          setShowLines(false);
                          // 收起面板后把原生播放窗口放回来（仅原生引擎需要）
                          if (playerRef.current?.playbackEngine === 'native') {
                            await NativePlayer.show().catch(() => {});
                          }
                        }
                      }}
                    >
                      <span className="lines-item__quality">{l.quality || '默认'}</span>
                      <span className="lines-item__name clamp-1">{l.label}</span>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── 手势层 ── */}
          <PlayerGestures
            targetRef={videoRef}
            position={position}
            duration={duration}
            onSeek={(sec) => {
              playerRef.current?.seek(sec);
              setPosition(sec);
              if (id) saveMemory(String(id), { position: sec, duration });
            }}
            onTogglePlay={() => {
              playerRef.current?.toggle();
              setPaused(playerRef.current?.paused ?? true);
            }}
            onTap={() => {
              controls.toggle();
            }}
            onHint={(t) => setGestureHint(t)}
            volume={volume}
            onVolumeChange={setVolume}
            brightness={brightness}
            onBrightnessChange={setBrightness}
            onRateHold={(r) => {
              // 长按临时 3 倍速，松手恢复到用户选定的倍速
              playerRef.current?.setPlaybackRate(r == null ? rate : r);
            }}
          />

          {/* 手势提示 */}
          {gestureHint && (
            <div className="player__gesturehint">{gestureHint}</div>
          )}

          {/* 外挂字幕（原生引擎由 ExoPlayer 直接画在画面上） */}
          {!nativeEngine && cueText && subtitleOn && (
            <div
              className={`player__cue player__cue--${subSize} player__cue--bg-${subBg}${
                controls.visible ? ' is-lifted' : ''
              }`}
            >
              {cueText.split('\n').map((line, i) => (
                <span key={i} className="player__cue-line">
                  {line}
                </span>
              ))}
            </div>
          )}

          {/* ── 播放控制条 ── */}
          <PlayerBar
            hidden={!controls.visible}
            onInteract={() => {
              // 用户正在操作控制条 → 解除 pin，避免自动隐藏打断操作
              setControlsPinned(false);
              revealControls();
            }}
            position={position}
            duration={duration}
            buffered={buffered}
            paused={paused}
            rate={rate}
            qualities={qualities}
            currentQuality={currentQuality}
            title={detail?.title}
            subtitle={
              mediaType === 'movie'
                ? currentLabel
                : `第 ${episode} 集${currentLabel ? ' · ' + currentLabel : ''}`
            }
            onTogglePlay={() => {
              playerRef.current?.toggle();
              setPaused(playerRef.current?.paused ?? true);
            }}
            onSeek={(sec) => {
              playerRef.current?.seek(sec);
              setPosition(sec);
              if (id) saveMemory(String(id), { position: sec, duration });
            }}
            onRateChange={(r) => {
              playerRef.current?.setPlaybackRate(r);
              setRate(r);
            }}
            onQualityChange={(i) => {
              playerRef.current?.setQuality(i);
              setCurrentQuality(i);
            }}
            onOpenEpisodes={
              episodeItems.length > 0 ? () => setShowEpisodes(true) : undefined
            }
            onPrevEpisode={
              prevEpisode ? () => selectEpisode(prevEpisode.n) : undefined
            }
            onNextEpisode={
              nextEpisode ? () => selectEpisode(nextEpisode.n) : undefined
            }
            onOpenMore={() => setShowLines((v) => !v)}
            onSwitchLine={async () => {
              keepLabelRef.current = '';
              await playerRef.current?.switchNext();
            }}
            onOpenLines={async () => {
              const next = !showLines;
              setShowLines(next);
              // 换源面板在 WebView 内。若当前用的是原生引擎（降级后），
              // 原生播放窗口会挡住它 → 临时隐藏。
              if (playerRef.current?.playbackEngine === 'native') {
                if (next) {
                  await NativePlayer.hide().catch(() => {});
                } else {
                  await NativePlayer.show().catch(() => {});
                }
              }
            }}
            lineCount={lines.length}
            onToggleLandscape={
              isScreenOrientationAvailable() ? toggleLandscape : undefined
            }
            landscape={landscape}
            onOpenCast={isCastAvailable() ? openCast : undefined}
            casting={casting}
            onOpenPip={openPip}
            onOpenSubtitle={() => void toggleSubtitlePanel()}
            hasSubtitle={!!storedSub}
            subtitleOn={subtitleOn}
            audioEffect={audioEffect}
            onAudioEffectChange={changeAudioEffect}
          />

          {/* ── 选集面板 ── */}
          {showEpisodes && (
            <div className="episodes-panel" onClick={() => setShowEpisodes(false)}>
              <div className="episodes-panel__inner" onClick={(e) => e.stopPropagation()}>
                <div className="episodes-panel__head">
                  <h3 className="episodes-panel__title">选集</h3>
                  <button
                    className="episodes-panel__close"
                    onClick={() => setShowEpisodes(false)}
                    aria-label="关闭"
                  >
                    ×
                  </button>
                </div>
                <div className="episodes-panel__grid">
                  {episodeItems.map((ep: { n: number; label: string }) => (
                    <button
                      key={ep.n}
                      ref={ep.n === episode ? currentEpRef : undefined}
                      className={`episodes-panel__item ${ep.n === episode ? 'is-on' : ''}`}
                      onClick={() => selectEpisode(ep.n)}
                    >
                      {ep.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ── 投屏设备面板 ── */}
          {showCast && (
            <div className="cast-panel" onClick={() => setShowCast(false)}>
              <div className="cast-panel__inner" onClick={(e) => e.stopPropagation()}>
                <div className="cast-panel__head">
                  <h3 className="cast-panel__title">投屏设备</h3>
                  <button
                    className="episodes-panel__close"
                    onClick={() => setShowCast(false)}
                    aria-label="关闭"
                  >
                    ×
                  </button>
                </div>

                <p className="cast-panel__hint">{castHint}</p>

                <div className="cast-panel__list">
                  {castDevices.map((d) => (
                    <button
                      key={d.id}
                      className="cast-panel__item"
                      onClick={() => void doCast(d)}
                    >
                      <span className="cast-panel__name clamp-1">{d.name}</span>
                      <span className="cast-panel__desc clamp-1">{d.description}</span>
                    </button>
                  ))}
                </div>

                {casting && (
                  <Button
                    variant="tonal"
                    size="sm"
                    onClick={async () => {
                      await stopCast();
                      setCasting(false);
                      setCastHint('已停止投屏');
                    }}
                  >
                    停止投屏
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* ── 字幕面板 ── */}
          {showSubtitle && (
            <div className="sub-panel" onClick={() => void closeSubtitlePanel()}>
              <div className="sub-panel__inner" onClick={(e) => e.stopPropagation()}>
                <div className="sub-panel__head">
                  <h3 className="sub-panel__title">字幕</h3>
                  <button
                    className="episodes-panel__close"
                    onClick={() => void closeSubtitlePanel()}
                    aria-label="关闭"
                  >
                    ×
                  </button>
                </div>

                <div className="sub-panel__current">
                  <span className="sub-panel__name clamp-1">
                    {storedSub?.name || '未导入字幕'}
                  </span>
                  {storedSub && (
                    <button
                      type="button"
                      role="switch"
                      aria-checked={subtitleOn}
                      className={`sub-panel__switch ${subtitleOn ? 'is-on' : ''}`}
                      onClick={() => toggleSubtitle(!subtitleOn)}
                    >
                      {subtitleOn ? '显示中' : '已关闭'}
                    </button>
                  )}
                </div>

                <p className="sub-panel__hint">
                  {subHint ||
                    '支持 SRT / VTT。字幕只保存在本机，换片会自动切到该片自己的字幕。'}
                </p>

                <div className="sub-panel__actions">
                  <Button
                    variant="tonal"
                    size="sm"
                    loading={subLoading}
                    onClick={() => subFileRef.current?.click()}
                  >
                    选择本地字幕
                  </Button>
                  {storedSub && (
                    <Button variant="outlined" size="sm" onClick={dropSubtitle}>
                      移除字幕
                    </Button>
                  )}
                </div>

                <div className="sub-panel__url">
                  <input
                    className="field__input"
                    placeholder="粘贴字幕链接（.srt / .vtt）"
                    value={subUrl}
                    onChange={(e) => setSubUrl(e.target.value)}
                    autoComplete="off"
                    inputMode="url"
                  />
                  <Button
                    variant="filled"
                    size="sm"
                    loading={subLoading}
                    onClick={() => void importSubtitleFromUrl()}
                  >
                    导入
                  </Button>
                </div>

                <input
                  ref={subFileRef}
                  type="file"
                  accept=".srt,.vtt,text/vtt,application/x-subrip,text/plain"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void onPickSubtitleFile(f);
                    e.target.value = '';
                  }}
                />
              </div>
            </div>
          )}

          {toast && <div className="toast">{toast}</div>}
        </div>
      )}

      {!playing && (
        <>
          <div className="detail__hero">
            {detail?.backdrop && (
              <div className="detail__bg">
                <img
                  src={detail.backdrop}
                  alt=""
                  aria-hidden="true"
                  decoding="async"
                  fetchPriority="high"
                  referrerPolicy="no-referrer"
                />
                <div className="detail__scrim" />
              </div>
            )}
            <button className="detail__back" onClick={() => navigate(-1)} aria-label="返回">
              <svg viewBox="0 0 24 24" width="22" height="22">
                <path
                  d="M15 5l-7 7 7 7"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>

            <div className="detail__body">
              <h1 className="detail__title">{detail?.title || '加载中'}</h1>
              <div className="detail__meta">
                {detail?.year && <span>{detail.year}</span>}
                {detail?.rating != null && detail.rating > 0 && (
                  <span className="detail__score">{detail.rating.toFixed(1)}</span>
                )}
                <span>{mediaType === 'tv' ? '剧集' : '电影'}</span>
                {detail?.episodeCount ? <span>共 {detail.episodeCount} 集</span> : null}
              </div>
              {detail?.overview && <p className="detail__overview">{detail.overview}</p>}

              {mediaType === 'tv' && seasons.length > 0 && (
                <div className="detail__seasons">
                  <div className="detail__season-tabs">
                    {seasons.map((s) => (
                      <button
                        key={s.season}
                        className={`season-tab ${s.season === season ? 'is-active' : ''}`}
                        onClick={() => {
                          setSeason(s.season);
                          setEpisode(1);
                        }}
                      >
                        第 {s.season} 季
                      </button>
                    ))}
                  </div>
                  {currentSeason && (
                    <div className="detail__episodes">
                      {currentSeason.episodes.map((ep: any) => (
                        <button
                          key={ep.ep}
                          className={`ep-chip ${ep.ep === episode ? 'is-active' : ''}`}
                          onClick={() => setEpisode(ep.ep)}
                        >
                          {ep.ep}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div className="detail__actions">
                <Button variant="filled" size="lg" onClick={() => void startPlayback()}>
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                    <path d="M8 5.5v13l11-6.5-11-6.5Z" fill="currentColor" />
                  </svg>
                  播放
                </Button>
                <Button
                  variant="outlined"
                  size="lg"
                  onClick={() => {
                    if (!detail) return;
                    const next = toggleFavorite({
                      id: String(id),
                      title: detail.title || '',
                      poster: detail.poster,
                      mediaType: (mediaType as 'movie' | 'tv' | 'anime' | 'live') ?? 'movie',
                      typeLabel: detail.typeLabel,
                      year: detail.year,
                      rating: detail.rating,
                    });
                    setFaved(next);
                    showToast(next ? '已加入收藏' : '已取消收藏');
                  }}
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                    <path
                      d="M12 4.6l2.3 4.7 5.2.8-3.8 3.6.9 5.1-4.6-2.4-4.6 2.4.9-5.1L4.5 10l5.2-.8L12 4.6Z"
                      fill={faved ? 'currentColor' : 'none'}
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinejoin="round"
                    />
                  </svg>
                  {faved ? '已收藏' : '收藏'}
                </Button>
              </div>
            </div>
          </div>

          {similar.length > 0 && (
            <section className="detail__similar">
              <h2 className="detail__similar-title">相似推荐</h2>
              <div className="detail__similar-grid">
                {similar.map((s, i) => (
                  <PosterCard
                    key={String(s.id)}
                    id={s.id}
                    title={s.title}
                    poster={s.poster}
                    year={s.year}
                    rating={s.rating}
                    subtitle={s.typeLabel}
                    to={`/detail/${encodeURIComponent(String(s.id))}?type=${s.mediaType}`}
                    index={i}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
