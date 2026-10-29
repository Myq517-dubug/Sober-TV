/**
 * 直播页 —— 平台主播卡片墙
 *
 * ── 形态 ──────────────────────────────────────────────
 *   顶部：平台切换（全部 / B站 / 虎牙 / 斗鱼 / 抖音）+ 关键词搜索
 *   中部：分类（推荐 / 游戏 / 颜值 / 舞蹈 / ASMR / 音乐 / 户外）
 *   主体：主播卡片墙，封面 + 标题 + 主播 + 在线人数
 *
 * ── 只放在播的 ────────────────────────────────────────
 *   四家列表接口本身只返回正在直播的房间；
 *   页面每 60 秒静默刷新一次，下播的主播自然从墙上消失。
 *   点开某个主播解析失败且提示「已下播」时，也会立刻移出列表。
 *
 * ── 点开即播 ──────────────────────────────────────────
 *   点击卡片 → resolveRoom 取带签名的临时播放地址 →
 *   起播放层。虎牙/斗鱼是 HTTP-FLV，必须走原生 ExoPlayer；
 *   抖音的 FLV/HLS 都是无 CORS 的 CDN 直链，同样走原生引擎，
 *   线路上的 nativeOnly 标记会让 PlayerController 直接起原生引擎。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PlayerController, type PlaybackState } from '../player/PlayerController';
import { NativePlayer } from '../player/nativePlayer';
import { LiveDanmaku } from '../components/LiveDanmaku';
import { useAutoHideControls } from '../hooks/useAutoHideControls';
import {
  danmakuSupported,
  readLiveDanmakuPref,
  writeLiveDanmakuPref,
  type DanmakuStatus,
} from '../lib/danmaku';
import {
  getSafeInsets,
  isLandscape as readLandscape,
  isScreenOrientationAvailable,
  setImmersive,
  setLandscape,
  unlockOrientation,
} from '../player/screenOrientation';
import {
  CATEGORIES,
  PLATFORM_META,
  PLATFORM_ORDER,
  formatOnline,
  listRooms,
  parseRoomInput,
  resolveRoom,
  roomFromId,
  searchRooms,
  type CategoryId,
  type LiveRoom,
  type PlatformFilter,
  type PlatformId,
  type RoomStream,
} from '../lib/platformLive';
import './Live.css';

/** 列表静默刷新间隔：下播的主播最多 1 分钟从墙上消失 */
const POLL_MS = 60_000;

/** 回到前台时如果距上次刷新超过这个间隔，立刻补一次 */
const RESUME_MIN_MS = 20_000;

/**
 * 轮询时保持已有卡片的相对位置，只把新开播的主播插到最前面。
 * 否则每次刷新整墙按热度重排，用户正在看的卡片会突然跑走。
 */
function mergeKeepOrder(prev: LiveRoom[], next: LiveRoom[]): LiveRoom[] {
  if (!prev.length) return next;
  const nextMap = new Map(next.map((r) => [r.id, r]));
  const kept = prev.filter((r) => nextMap.has(r.id)).map((r) => nextMap.get(r.id)!);
  if (!kept.length) return next;
  const keptIds = new Set(kept.map((r) => r.id));
  return [...next.filter((r) => !keptIds.has(r.id)), ...kept];
}

const PLATFORM_FILTERS: { id: PlatformFilter; name: string }[] = [
  { id: 'all', name: '全部' },
  ...PLATFORM_ORDER.map((p) => ({ id: p as PlatformFilter, name: PLATFORM_META[p].name })),
];

function initialOf(room: LiveRoom): string {
  return (room.anchor || room.title || '直').replace(/\s+/g, '').slice(0, 1).toUpperCase();
}

export function Live() {
  // ── 列表 ────────────────────────────────────────────
  const [platform, setPlatform] = useState<PlatformFilter>('all');
  const [category, setCategory] = useState<CategoryId>('hot');
  const [query, setQuery] = useState('');
  const [keyword, setKeyword] = useState('');
  const [rooms, setRooms] = useState<LiveRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<PlatformId, string>>>({});
  const [updatedAt, setUpdatedAt] = useState(0);
  const [badImgs, setBadImgs] = useState<string[]>([]);

  // ── 播放层 ──────────────────────────────────────────
  const [opening, setOpening] = useState<LiveRoom | null>(null);
  const [playing, setPlaying] = useState<LiveRoom | null>(null);
  const [stream, setStream] = useState<RoomStream | null>(null);
  const [playState, setPlayState] = useState<PlaybackState>('idle');
  const [paused, setPaused] = useState(true);
  const [error, setError] = useState('');
  const [lineLabel, setLineLabel] = useState('');
  const [showLines, setShowLines] = useState(false);
  const [landscape, setLandscapeState] = useState(false);
  const [insets, setInsets] = useState({ top: 0, bottom: 0, left: 0, right: 0 });
  const [toast, setToast] = useState('');
  /** 当前实际使用的引擎：原生播放时 Web 层的弹幕/控制条都在下层层，看不到 */
  const [engine, setEngine] = useState<'web' | 'native'>('web');
  /** 画面填充：默认完整显示，用户可切铺满（直播单独记忆） */
  const [fill, setFill] = useState(() => localStorage.getItem('sober.liveFill') === '1');
  const [danmakuOn, setDanmakuOn] = useState(() => readLiveDanmakuPref());
  const [dmkState, setDmkState] = useState<DanmakuStatus>('idle');

  const playerRef = useRef<PlayerController | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const toastTimer = useRef<number | null>(null);
  const roomsRef = useRef<LiveRoom[]>([]);
  roomsRef.current = rooms;

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current != null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 2600);
  }, []);

  const controls = useAutoHideControls({ landscape, pinned: showLines });
  const controlsRef = useRef(controls);
  controlsRef.current = controls;

  // ── 安全区 ──────────────────────────────────────────
  const refreshInsets = useCallback(async () => {
    if (!isScreenOrientationAvailable()) return;
    const i = await getSafeInsets();
    setInsets({ top: i.top, bottom: i.bottom, left: i.left, right: i.right });
  }, []);

  // ── 搜索防抖 ────────────────────────────────────────
  useEffect(() => {
    const t = window.setTimeout(() => setKeyword(query.trim()), 400);
    return () => window.clearTimeout(t);
  }, [query]);

  const platforms = useMemo<PlatformId[]>(
    () => (platform === 'all' ? PLATFORM_ORDER : [platform]),
    [platform],
  );

  // ── 拉取列表 ────────────────────────────────────────
  const loadToken = useRef(0);
  const lastLoadedAt = useRef(0);

  /**
   * query：首屏 / 切平台 / 切分类 / 搜索，允许整墙按热度重排
   * manual：点刷新按钮，重新按最新热度排
   * poll：后台静默轮询，保持卡片位置不动
   */
  const load = useCallback(
    async (mode: 'query' | 'manual' | 'poll') => {
      const token = ++loadToken.current;
      if (roomsRef.current.length) setRefreshing(true);
      else setLoading(true);

      const res = keyword
        ? await searchRooms(keyword, platforms)
        : await listRooms(
            platform,
            category,
            (partial) => {
              // 只有首屏才先上墙；刷新时直接等最终结果，避免闪一下再回原位
              if (loadToken.current !== token || mode !== 'query') return;
              setRooms(partial);
              setLoading(false);
            },
            mode !== 'query',
          );

      if (loadToken.current !== token) return;

      // 网络抖动导致本轮全平台都没拉到：保留当前列表，别把墙清空
      if (
        mode !== 'query' &&
        !res.rooms.length &&
        roomsRef.current.length &&
        Object.keys(res.errors).length
      ) {
        setErrors(res.errors);
        setLoading(false);
        setRefreshing(false);
        showToast('刷新失败，已保留当前列表');
        return;
      }

      setRooms(mode === 'poll' ? mergeKeepOrder(roomsRef.current, res.rooms) : res.rooms);
      setErrors(res.errors);
      setUpdatedAt(Date.now());
      lastLoadedAt.current = Date.now();
      setLoading(false);
      setRefreshing(false);
    },
    [keyword, platform, category, platforms, showToast],
  );

  useEffect(() => {
    void load('query');
  }, [load]);

  // 静默轮询：只在页面前台时刷，避免后台白耗流量
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load('poll');
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [load]);

  // 回到前台立刻补一次，不用干等到下一个轮询点
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastLoadedAt.current < RESUME_MIN_MS) return;
      void load('poll');
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  useEffect(() => {
    return () => {
      if (toastTimer.current != null) window.clearTimeout(toastTimer.current);
    };
  }, []);

  /** 粘贴房间链接 / 纯数字房间号时的直连入口 */
  const direct = useMemo(
    () => (keyword ? parseRoomInput(keyword, platform) : null),
    [keyword, platform],
  );

  // ── 播放层生命周期 ──────────────────────────────────
  const closePlayer = useCallback(() => {
    playerRef.current?.destroy();
    playerRef.current = null;
    setPlaying(null);
    setStream(null);
    setShowLines(false);
    setError('');
    setPlayState('idle');
    setDmkState('idle');
    if (isScreenOrientationAvailable()) {
      void unlockOrientation();
      void setImmersive(false);
    }
    setLandscapeState(false);
  }, []);

  /**
   * 起播后只进沉浸模式，不强制转横屏
   *
   * 直播流有竖屏（秀场/颜值）也有横屏（游戏/赛事）两种，
   * 强行转横屏会让竖屏流左右出现大黑边、横屏流又被裁切。
   * 这里跟随手机当前方向，用户想横屏可以点按钮或直接转手机。
   */
  const enterLiveImmersive = useCallback(async () => {
    if (!isScreenOrientationAvailable()) return;
    await setImmersive(true);
    const l = await readLandscape();
    setLandscapeState(l);
    void refreshInsets();
  }, [refreshInsets]);

  /** 点开主播：解析播放地址 → 起播放层 */
  const openRoom = useCallback(
    async (room: LiveRoom) => {
      if (opening) return;
      setOpening(room);
      try {
        const s = await resolveRoom(room);
        if (!s.lines.length) throw new Error('没有可用的直播线路');
        setError('');
        setStream(s);
        setPlaying(room);
        setLineLabel(s.lines[0].label);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/下播/.test(msg)) {
          setRooms((prev) => prev.filter((r) => r.id !== room.id));
          showToast('主播刚刚下播，已从列表移除');
        } else if (/网络|timeout|超时/i.test(msg)) {
          showToast('解析直播地址失败，请检查网络后重试');
        } else {
          showToast(`打不开这个直播间：${msg}`);
        }
      } finally {
        setOpening(null);
      }
    },
    [opening, showToast],
  );

  // 播放层渲染完成后再建控制器：此时 videoRef 才指向新元素
  useEffect(() => {
    if (!playing || !stream) return;
    const video = videoRef.current;
    if (!video) return;

    playerRef.current?.destroy();

    const name = playing.anchor || playing.title;
    const candidates = stream.lines.map((l, i) => ({
      id: `${playing.id}-${i}`,
      url: l.url,
      label: `${name} · ${l.label}`,
      headers: l.headers,
      quality: 'LIVE',
      official: false,
      weight: stream.lines.length - i,
      nativeOnly: l.nativeOnly,
    }));

    const ctrl = new PlayerController({
      live: true,
      livePlatform: playing.platform,
      liveRoomId: playing.roomId,
      onStateChange: (s) => {
        setPlayState(s);
        if (s === 'paused') setPaused(true);
        if (s === 'playing') setPaused(false);
      },
      onReady: () => {
        setPlayState('playing');
        setPaused(false);
        setError('');
        setEngine(ctrl.playbackEngine);
        controlsRef.current.reveal();
        void enterLiveImmersive();
      },
      onError: (m) => {
        setError(m);
        setPlayState('error');
      },
      onExhausted: (n) => {
        setError(`全部 ${n} 条线路都不可用，返回列表换一个主播试试`);
        setPlayState('error');
      },
      onSourceSwitch: (_from, to, reason) => {
        setLineLabel(to);
        if (reason !== '切换线路') showToast(`${reason} → ${to}`);
      },
      onVideoTap: () => controlsRef.current.toggle(),
      onProgress: () => {
        setPaused(playerRef.current?.paused ?? false);
      },
      onNativeClose: () => closePlayer(),
      onNativeLines: () => {
        setShowLines(true);
        void NativePlayer.hide().catch(() => {});
      },
    });

    playerRef.current = ctrl;
    // 先按线路类型预判引擎，避免 FLV 线路在起播前白白建立一次弹幕连接
    setEngine(candidates[0]?.nativeOnly ? 'native' : 'web');
    setDmkState('idle');
    // 原生引擎起播的这几秒用封面铺模糊底图，比一块纯黑更不像「卡死了」
    ctrl.setPoster(playing.cover);
    ctrl.attach(video);
    setError('');
    void ctrl.start(candidates, candidates[0]?.label);
  }, [playing, stream, closePlayer, enterLiveImmersive, showToast]);

  // 退出页面：销毁播放器并恢复方向
  useEffect(() => {
    return () => {
      playerRef.current?.destroy();
      playerRef.current = null;
      if (isScreenOrientationAvailable()) {
        void unlockOrientation();
        void setImmersive(false);
      }
    };
  }, []);

  // 播放中同步真实方向 + 安全区（用户自己转手机也要跟上）
  useEffect(() => {
    if (!playing) return;
    void refreshInsets();
    void readLandscape().then((l) => setLandscapeState(l));
    const onResize = () => {
      void refreshInsets();
      void readLandscape().then((l) => {
        setLandscapeState(l);
        if (l) void setImmersive(true);
      });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [playing, refreshInsets]);

  const toggleLandscape = useCallback(async () => {
    if (!isScreenOrientationAvailable()) {
      showToast('当前环境不支持横屏切换');
      return;
    }
    if (landscape) {
      await unlockOrientation();
      await setImmersive(false);
      setLandscapeState(false);
    } else {
      await setLandscape(true);
      await setImmersive(true);
      setLandscapeState(true);
      void refreshInsets();
    }
  }, [landscape, refreshInsets, showToast]);

  /** 画面填充：完整显示（contain）↔ 铺满裁切（cover） */
  const toggleFill = useCallback(() => {
    const next = !fill;
    setFill(next);
    localStorage.setItem('sober.liveFill', next ? '1' : '0');
    controlsRef.current.reveal();
  }, [fill]);

  const toggleDanmaku = useCallback(() => {
    const next = !danmakuOn;
    setDanmakuOn(next);
    writeLiveDanmakuPref(next);
    if (next) setDmkState('connecting');
    controlsRef.current.reveal();
  }, [danmakuOn]);

  const handleDmkStatus = useCallback((s: DanmakuStatus) => setDmkState(s), []);

  const toggleLines = useCallback(async () => {
    const next = !showLines;
    setShowLines(next);
    controlsRef.current.reveal();
    if (playerRef.current?.playbackEngine === 'native') {
      if (next) await NativePlayer.hide().catch(() => {});
      else await NativePlayer.show().catch(() => {});
    }
  }, [showLines]);

  const switchLine = useCallback(
    async (index: number) => {
      const ctrl = playerRef.current;
      if (!ctrl || !playing || !stream) return;
      const line = stream.lines[index];
      if (!line) return;
      const name = playing.anchor || playing.title;
      const label = `${name} · ${line.label}`;
      const idx = ctrl.list.findIndex((x) => x.label === label);
      setShowLines(false);
      if (idx < 0) return;
      setLineLabel(line.label);
      if (ctrl.playbackEngine === 'native') await NativePlayer.show().catch(() => {});
      await ctrl.switchTo(idx);
    },
    [playing, stream],
  );

  const retryPlay = useCallback(async () => {
    const ctrl = playerRef.current;
    if (!ctrl) return;
    setError('');
    await ctrl.switchNext();
  }, []);

  const markImgBad = useCallback((id: string) => {
    setBadImgs((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);

  /** 直连房间号/链接 */
  const openDirect = useCallback(() => {
    if (!direct) return;
    void openRoom(roomFromId(direct.platform, direct.roomId));
  }, [direct, openRoom]);

  // ── 播放层渲染 ──────────────────────────────────────
  if (playing && stream) {
    const name = playing.anchor || playing.title;
    return (
      <div
        className="live-player player-shell"
        style={
          {
            ['--safe-t' as string]: `${insets.top}px`,
            ['--safe-b' as string]: `${insets.bottom}px`,
            ['--safe-l' as string]: `${insets.left}px`,
            ['--safe-r' as string]: `${insets.right}px`,
          } as React.CSSProperties
        }
      >
        <div
          className={`player__stage${fill ? ' is-fill' : ''}`}
          style={{ ['--stage-w' as string]: '100%', ['--stage-h' as string]: '100%' }}
        >
          <video
            ref={videoRef}
            className="player__video"
            playsInline
            onClick={() => controls.toggle()}
          />
        </div>

        {/* 弹幕层：原生引擎由 PlayerActivity 的 DanmakuLayer 负责，这里只管 Web 引擎 */}
        {engine === 'web' && (
          <LiveDanmaku
            platform={playing.platform}
            roomId={playing.roomId}
            enabled={danmakuOn}
            onStatus={handleDmkStatus}
          />
        )}

        {engine === 'web' && danmakuOn && dmkState === 'error' && (
          <div className="live-dmk__hint">弹幕连接失败，直播画面不受影响</div>
        )}

        <div className={`live-player__ui${controls.visible ? '' : ' is-hidden'}`}>
          <div className="live-player__top">
            <button className="player__back" onClick={closePlayer} aria-label="返回列表">
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
            <div className="live-player__meta">
              <p className="live-player__title clamp-1">{playing.title}</p>
              <p className="live-player__sub clamp-1">
                {name}
                {playing.area ? ` · ${playing.area}` : ''} · {lineLabel}
              </p>
            </div>
            <span className="live-badge">LIVE</span>
          </div>

          <div className="live-player__center">
            {(playState === 'loading' || playState === 'buffering') && (
              <div className="live-player__status">
                <span className="player__spin" aria-hidden="true" />
                {playState === 'loading' ? '正在连接直播信号…' : '缓冲中…'}
              </div>
            )}
            {playState === 'error' && (
              <div className="live-player__err">
                <span>{error || '这个直播间暂时无法播放'}</span>
                <div className="live-player__errops">
                  <button className="live-player__retry" onClick={() => void retryPlay()}>
                    换一条线路
                  </button>
                  <button className="live-player__retry" onClick={closePlayer}>
                    返回列表
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="live-player__bottom">
            <button
              className="live-player__play"
              onClick={() => {
                playerRef.current?.toggle();
                setPaused(playerRef.current?.paused ?? true);
              }}
              aria-label={paused ? '播放' : '暂停'}
            >
              {paused ? (
                <svg viewBox="0 0 24 24" width="24" height="24">
                  <path d="M8 5l11 7-11 7z" fill="currentColor" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="24" height="24">
                  <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" />
                </svg>
              )}
            </button>
            {engine === 'web' && danmakuSupported(playing.platform) && (
              <button
                className={`live-player__btn${danmakuOn ? ' is-on' : ''}`}
                onClick={toggleDanmaku}
              >
                {danmakuOn ? '弹幕开' : '弹幕关'}
              </button>
            )}
            <button
              className={`live-player__btn${showLines ? ' is-on' : ''}`}
              onClick={() => void toggleLines()}
            >
              线路 {stream.lines.length}
            </button>
            <button className="live-player__btn" onClick={toggleFill}>
              {fill ? '铺满' : '完整'}
            </button>
            <button className="live-player__btn" onClick={() => void toggleLandscape()}>
              {landscape ? '竖屏' : '横屏'}
            </button>
            <button className="live-player__btn" onClick={closePlayer}>
              换主播
            </button>
            <div className="live-player__spacer" />
          </div>
        </div>

        {showLines && (
          <div className="live-sheet live-sheet--lines">
            <div className="live-sheet__head">
              <p className="live-sheet__title">
                {name} · 共 {stream.lines.length} 条线路
              </p>
              <button className="live-sheet__close" onClick={() => void toggleLines()} aria-label="关闭">
                ×
              </button>
            </div>
            {stream.lines.map((line, i) => (
              <button
                key={`${line.url}-${i}`}
                className={`live-sheet__line${lineLabel === line.label ? ' is-on' : ''}`}
                onClick={() => void switchLine(i)}
              >
                <span>{line.label}</span>
                <span className="live-sheet__tag">
                  {lineLabel === line.label ? '播放中' : '切换'}
                </span>
              </button>
            ))}
          </div>
        )}

        {toast && <div className="live-toast">{toast}</div>}
      </div>
    );
  }

  // ── 卡片墙 ──────────────────────────────────────────
  const errPlatforms = Object.keys(errors) as PlatformId[];
  const allFailed = !loading && !rooms.length && errPlatforms.length > 0;

  return (
    <div className="live">
      <header className="live__head">
        <div>
          <p className="live__eyebrow">LIVE NOW</p>
          <h1 className="live__title">直播</h1>
          <p className="live__sub">
            {rooms.length
              ? `${rooms.length} 个主播正在直播${
                  updatedAt
                    ? ` · 更新于 ${new Date(updatedAt).toLocaleTimeString('zh-CN', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}`
                    : ''
                }`
              : keyword
                ? `正在搜索「${keyword}」…`
                : '正在拉取正在直播的主播…'}
          </p>
        </div>
        <div className="live__ops">
          <button
            className={`live__iconbtn${refreshing ? ' is-busy' : ''}`}
            onClick={() => void load('manual')}
            disabled={refreshing}
            aria-label="刷新列表"
          >
            <svg viewBox="0 0 24 24" width="19" height="19">
              <path
                d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"
                stroke="currentColor"
                strokeWidth="1.8"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </header>

      <div className="live__search">
        <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
          <circle cx="11" cy="11" r="6.4" fill="none" stroke="currentColor" strokeWidth="1.7" />
          <path d="M16 16l4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索主播 / 游戏 / 分区，如 星秀、王者荣耀"
          spellCheck={false}
          autoComplete="off"
        />
        {query && (
          <button className="live__clear" onClick={() => setQuery('')} aria-label="清空">
            ×
          </button>
        )}
      </div>

      <div className="live__pfilters no-scrollbar">
        {PLATFORM_FILTERS.map((p) => {
          const failed = p.id !== 'all' && !!errors[p.id as PlatformId];
          return (
            <button
              key={p.id}
              className={`live__pchip${platform === p.id ? ' is-on' : ''}${failed ? ' is-failed' : ''}`}
              onClick={() => setPlatform(p.id)}
            >
              {p.name}
              {failed && <span className="live__pwarn" title={errors[p.id as PlatformId]}>!</span>}
            </button>
          );
        })}
      </div>

      {!keyword && (
        <div className="live__cats no-scrollbar">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              className={`live__chip${category === c.id ? ' is-on' : ''}`}
              onClick={() => setCategory(c.id)}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}

      {direct && (
        <button className="live__direct" onClick={openDirect}>
          直接打开直播间 {PLATFORM_META[direct.platform].name} · {direct.roomId}
        </button>
      )}

      {loading && !rooms.length && (
        <div className="lgrid">
          {Array.from({ length: 6 }).map((_, i) => (
            <div className="lroom lroom--skeleton" key={i}>
              <div className="lroom__cover" />
              <div className="lroom__skline" />
              <div className="lroom__skline is-short" />
            </div>
          ))}
        </div>
      )}

      {!loading && rooms.length > 0 && (
        <div className="lgrid">
          {rooms.map((room) => {
            const coverOk = room.cover && !badImgs.includes(`c:${room.id}`);
            const avatarOk = room.avatar && !badImgs.includes(`a:${room.id}`);
            const isOpening = opening?.id === room.id;
            return (
              <button
                className={`lroom${isOpening ? ' is-opening' : ''}`}
                key={room.id}
                onClick={() => void openRoom(room)}
                disabled={!!opening}
              >
                <span className="lroom__cover">
                  {coverOk ? (
                    <img
                      src={room.cover}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      onError={() => markImgBad(`c:${room.id}`)}
                    />
                  ) : (
                    <span className="lroom__ph">{initialOf(room)}</span>
                  )}
                  <span className="lroom__badge">
                    <i />
                    LIVE
                  </span>
                  <span className={`lroom__plat is-${room.platform}`}>
                    {PLATFORM_META[room.platform].name}
                  </span>
                  {room.online > 0 && (
                    <span className="lroom__online">{formatOnline(room.online)}</span>
                  )}
                  {isOpening && (
                    <span className="lroom__opening">
                      <span className="player__spin" aria-hidden="true" />
                      解析中
                    </span>
                  )}
                </span>
                <span className="lroom__title clamp-2">{room.title}</span>
                <span className="lroom__who">
                  {avatarOk ? (
                    <img
                      className="lroom__ava"
                      src={room.avatar}
                      alt=""
                      loading="lazy"
                      onError={() => markImgBad(`a:${room.id}`)}
                    />
                  ) : (
                    <span className="lroom__ava is-ph">{initialOf(room)}</span>
                  )}
                  <span className="lroom__anchor clamp-1">{room.anchor || '主播'}</span>
                  {room.area && <span className="lroom__area clamp-1">{room.area}</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {!loading && !rooms.length && (
        <div className="live-empty">
          <p className="live-empty__title">
            {allFailed ? '直播接口暂时连不上' : keyword ? '没搜到正在直播的主播' : '这个分类暂时没有人在播'}
          </p>
          <p className="live-empty__desc">
            {allFailed
              ? `当前网络访问这些平台失败：${errPlatforms
                  .map((p) => `${PLATFORM_META[p].name}（${errors[p]}）`)
                  .join('、')}。可以换个平台或稍后重试。`
              : keyword
                ? '换个关键词试试，比如「星秀」「王者荣耀」「舞蹈」。搜索只返回正在直播的主播。'
                : '直播是实时变化的，换一个分类，或者点右上角刷新一下。'}
          </p>
          <button className="live-empty__btn" onClick={() => void load('manual')}>
            重新拉取
          </button>
        </div>
      )}

      {toast && <div className="live-toast">{toast}</div>}
    </div>
  );
}
