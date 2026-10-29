import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AUDIO_EFFECTS, audioEffectLabel, type AudioEffect } from './audioFx';

/**
 * 播放控制条
 *
 * ── 设计要点 ────────────────────────────────────────
 * 1. **进度条可拖动**：用原生 `<input type="range">` 而非自绘 div ——
 *    触摸事件、惯性、无障碍、TV 遥控器焦点全都免费拿到。
 * 2. **拖动时不跟随播放进度**：否则会出现「手指还在拖，条子自己跳」的廉价感。
 * 3. **缓冲进度**用背景渐变表示，与已播进度区分开。
 * 4. **倍速是弹出层而非下拉**：竖屏空间有限，弹出层不挤压布局。
 */

export interface PlayerBarProps {
  /** 已播放秒数 */
  position: number;
  /** 总时长秒数 */
  duration: number;
  /** 已缓冲百分比 0-100 */
  buffered: number;
  /** 是否暂停 */
  paused: boolean;
  /** 当前倍速 */
  rate: number;
  /** 可用清晰度档位（空数组 = 源是单码率） */
  qualities: { index: number; height: number; bitrate: number }[];
  /** 当前清晰度索引，-1 = 自动 */
  currentQuality: number;
  /** 播放/暂停 */
  onTogglePlay: () => void;
  /** 拖动进度（秒） */
  onSeek: (sec: number) => void;
  /** 改变倍速 */
  onRateChange: (rate: number) => void;
  /** 改变清晰度（-1 = 自动） */
  onQualityChange: (index: number) => void;
  /** 打开选集 */
  onOpenEpisodes?: () => void;
  /** 上一集（不传则不显示按钮） */
  onPrevEpisode?: () => void;
  /** 下一集（不传则不显示按钮） */
  onNextEpisode?: () => void;
  /** 打开设置菜单（选集/画质等） */
  onOpenMore?: () => void;
  /** 更多菜单项：换一条线 */
  onSwitchLine?: () => void;
  /** 更多菜单项：全部线路 */
  onOpenLines?: () => void;
  /** 线路数量（显示在「全部线路」后） */
  lineCount?: number;
  /** 切换横屏 */
  onToggleLandscape?: () => void;
  /** 当前是否横屏 */
  landscape?: boolean;
  /** 打开投屏设备列表 */
  onOpenCast?: () => void;
  /** 是否正在投屏 */
  casting?: boolean;
  /** 进入画中画小窗 */
  onOpenPip?: () => void;
  /** 打开字幕面板（导入 / 开关 / 移除） */
  onOpenSubtitle?: () => void;
  /** 当前是否有外挂字幕 */
  hasSubtitle?: boolean;
  /** 字幕是否显示中 */
  subtitleOn?: boolean;
  /** 当前音效模式 */
  audioEffect?: AudioEffect;
  /** 切换音效 */
  onAudioEffectChange?: (mode: AudioEffect) => void;
  /** 标题（显示在控制条上方） */
  title?: string;
  /** 副标题 */
  subtitle?: string;
  /**
   * 隐藏控制条（进度条 + 按钮整条淡出）
   *
   * ⚠️ 之前 PlayerBar 是 `.player__overlay` 的**兄弟节点**，
   *    只给 overlay 加 is-hidden 根本藏不住进度条 —— 用户实测反馈
   *    「全屏下方还是有进度条和组件，没有隐藏」。
   */
  hidden?: boolean;
  /** 用户与控制条发生了交互（用于重置自动隐藏计时） */
  onInteract?: () => void;
}

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** 秒 → mm:ss / hh:mm:ss */
export function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function PlayerBar(props: PlayerBarProps) {
  const {
    position,
    duration,
    buffered,
    paused,
    rate,
    qualities,
    currentQuality,
    onTogglePlay,
    onSeek,
    onRateChange,
    onQualityChange,
    onOpenEpisodes,
    onPrevEpisode,
    onNextEpisode,
    onOpenMore,
    onSwitchLine,
    onOpenLines,
    lineCount,
    onToggleLandscape,
    landscape,
    onOpenCast,
    casting,
    onOpenPip,
    onOpenSubtitle,
    hasSubtitle,
    subtitleOn,
    audioEffect = 'off',
    onAudioEffectChange,
    title,
    subtitle,
    hidden = false,
    onInteract,
  } = props;

  const [scrubbing, setScrubbing] = useState(false);
  const [scrubValue, setScrubValue] = useState(0);
  const [menu, setMenu] = useState<'none' | 'rate' | 'quality' | 'more' | 'audio'>('none');
  const rangeRef = useRef<HTMLInputElement | null>(null);
  /** 拖动值的 ref —— 结束拖动时读它，避免闭包拿到旧值 */
  const scrubValueRef = useRef(0);

  const dur = duration > 0 ? duration : 0;
  const played = scrubbing ? scrubValue : position;
  const pct = dur > 0 ? Math.min(100, (played / dur) * 100) : 0;
  const bufferedPct = dur > 0 ? Math.min(100, Math.max(buffered, pct)) : 0;

  // 拖动开始时冻结当前值，避免播放进度与手指「打架」
  const onScrubStart = useCallback(() => {
    setScrubbing(true);
    setScrubValue(position);
  }, [position]);

  const onScrubChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    scrubValueRef.current = v;
    setScrubValue(v);
  }, []);

  // 拖动结束：pointer/mouse/touch 三种都收敛到同一处理
  const onScrubEnd = useCallback(() => {
    // 用最新的 ref 值，避免闭包拿到旧值
    const v = scrubValueRef.current;
    setScrubbing(false);
    if (dur > 0) onSeek(v);
  }, [dur, onSeek]);

  // 点击弹出层外部关闭
  useEffect(() => {
    if (menu === 'none') return;
    const close = () => setMenu('none');
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menu]);

  return (
    <div
      className={`pbar${hidden ? ' is-hidden' : ''}`}
      aria-hidden={hidden}
      onPointerDownCapture={() => onInteract?.()}
    >
      {/* 标题 */}
      {(title || subtitle) && (
        <div className="pbar__head">
          {title && <p className="pbar__title clamp-1">{title}</p>}
          {subtitle && <p className="pbar__sub clamp-1">{subtitle}</p>}
        </div>
      )}

      {/* 进度条 */}
      <div className="pbar__seekrow">
        <span className="pbar__time">{fmtTime(played)}</span>

        <div className="pbar__track">
          {/* 缓冲层 */}
          <div
            className="pbar__buffer"
            style={{ width: `${bufferedPct}%` }}
            aria-hidden="true"
          />
          <input
            ref={rangeRef}
            type="range"
            className="pbar__range"
            min={0}
            max={dur > 0 ? Math.floor(dur) : 0}
            step={1}
            value={Math.floor(played)}
            onChange={onScrubChange}
            onPointerDown={onScrubStart}
            onPointerUp={onScrubEnd}
            onMouseDown={onScrubStart}
            onMouseUp={onScrubEnd}
            onTouchStart={onScrubStart}
            onTouchEnd={onScrubEnd}
            style={
              {
                // 用 CSS 变量把进度传给轨道背景，避免再画一层
                ['--pbar-pct' as string]: `${pct}%`,
              } as React.CSSProperties
            }
            aria-label="播放进度"
          />
        </div>

        <span className="pbar__time pbar__time--total">{fmtTime(dur)}</span>
      </div>

      {/* 操作行 */}
      <div className="pbar__row">
        <button
          className="pbar__btn pbar__btn--play"
          onClick={onTogglePlay}
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

        {/* 横屏 */}
        {onToggleLandscape && (
          <button
            className="pbar__iconbtn"
            onClick={onToggleLandscape}
            aria-label={landscape ? '退出横屏' : '横屏播放'}
            title={landscape ? '退出横屏' : '横屏播放'}
          >
            {landscape ? (
              <svg viewBox="0 0 24 24" width="19" height="19">
                <path
                  d="M4 9V5.5A1.5 1.5 0 015.5 4H9M15 4h3.5A1.5 1.5 0 0120 5.5V9M20 15v3.5a1.5 1.5 0 01-1.5 1.5H15M9 20H5.5A1.5 1.5 0 014 18.5V15"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="19" height="19">
                <rect
                  x="3"
                  y="6"
                  width="18"
                  height="12"
                  rx="2"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  fill="none"
                />
              </svg>
            )}
          </button>
        )}

        {/* 投屏 */}
        {onOpenCast && (
          <button
            className={`pbar__iconbtn ${casting ? 'is-active' : ''}`}
            onClick={onOpenCast}
            aria-label="投屏"
            title="投屏到电视"
          >
            <svg viewBox="0 0 24 24" width="19" height="19">
              <path
                d="M3 17V7a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2h-5"
                stroke="currentColor"
                strokeWidth="1.8"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M8 21h8"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
              <circle cx="17.5" cy="19" r="1.4" fill="currentColor" />
            </svg>
          </button>
        )}

        {/* 画中画 */}
        {onOpenPip && (
          <button
            className="pbar__iconbtn"
            onClick={onOpenPip}
            aria-label="画中画"
            title="画中画小窗"
          >
            <svg viewBox="0 0 24 24" width="19" height="19">
              <rect
                x="3"
                y="5"
                width="18"
                height="14"
                rx="2"
                stroke="currentColor"
                strokeWidth="1.8"
                fill="none"
              />
              <rect x="12.5" y="11" width="7" height="6" rx="1.2" fill="currentColor" />
            </svg>
          </button>
        )}

        <div className="pbar__spacer" />

        {/* 倍速 */}
        <div className="pbar__menuwrap">
          <button
            className={`pbar__chip ${rate !== 1 ? 'is-active' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              setMenu((m) => (m === 'rate' ? 'none' : 'rate'));
            }}
            aria-label="倍速"
          >
            {rate === 1 ? '倍速' : `${rate}×`}
          </button>
          {menu === 'rate' && (
            <div className="pbar__menu" onClick={(e) => e.stopPropagation()}>
              {RATES.map((r) => (
                <button
                  key={r}
                  className={`pbar__menuitem ${Math.abs(rate - r) < 0.01 ? 'is-on' : ''}`}
                  onClick={() => {
                    onRateChange(r);
                    setMenu('none');
                  }}
                >
                  {r === 1 ? '正常' : `${r}×`}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 画质：仅当源有多个码率时显示 */}
        {qualities.length > 1 && (
          <div className="pbar__menuwrap">
            <button
              className="pbar__chip"
              onClick={(e) => {
                e.stopPropagation();
                setMenu((m) => (m === 'quality' ? 'none' : 'quality'));
              }}
              aria-label="画质"
            >
              {currentQuality < 0
                ? '自动'
                : `${qualities.find((q) => q.index === currentQuality)?.height ?? ''}P`}
            </button>
            {menu === 'quality' && (
              <div className="pbar__menu" onClick={(e) => e.stopPropagation()}>
                <button
                  className={`pbar__menuitem ${currentQuality < 0 ? 'is-on' : ''}`}
                  onClick={() => {
                    onQualityChange(-1);
                    setMenu('none');
                  }}
                >
                  自动
                </button>
                {qualities.map((q) => (
                  <button
                    key={q.index}
                    className={`pbar__menuitem ${currentQuality === q.index ? 'is-on' : ''}`}
                    onClick={() => {
                      onQualityChange(q.index);
                      setMenu('none');
                    }}
                  >
                    {q.height}P
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {onPrevEpisode && (
          <button className="pbar__chip" onClick={onPrevEpisode} aria-label="上一集">
            上一集
          </button>
        )}

        {onNextEpisode && (
          <button className="pbar__chip" onClick={onNextEpisode} aria-label="下一集">
            下一集
          </button>
        )}

        {onOpenEpisodes && (
          <button className="pbar__chip" onClick={onOpenEpisodes}>
            选集
          </button>
        )}

        {onOpenMore && (
          <div className="pbar__menuwrap">
            <button
              className={`pbar__chip ${
                audioEffect !== 'off' || (hasSubtitle && subtitleOn !== false) ? 'is-active' : ''
              }`}
              onClick={(e) => {
                e.stopPropagation();
                setMenu((m) => (m === 'more' ? 'none' : 'more'));
              }}
              aria-label="更多"
            >
              更多
            </button>
            {menu === 'more' && (
              <div className="pbar__menu" onClick={(e) => e.stopPropagation()}>
                {onSwitchLine && (
                  <button
                    className="pbar__menuitem"
                    onClick={() => {
                      onSwitchLine();
                      setMenu('none');
                    }}
                  >
                    换一条线
                  </button>
                )}
                {onOpenLines && (
                  <button
                    className="pbar__menuitem"
                    onClick={() => {
                      onOpenLines();
                      setMenu('none');
                    }}
                  >
                    全部线路{lineCount != null ? `（${lineCount}）` : ''}
                  </button>
                )}
                {onOpenSubtitle && (
                  <>
                    <div className="pbar__menusep" aria-hidden="true" />
                    <button
                      className={`pbar__menuitem ${hasSubtitle && subtitleOn !== false ? 'is-on' : ''}`}
                      onClick={() => {
                        onOpenSubtitle();
                        setMenu('none');
                      }}
                    >
                      字幕{hasSubtitle ? (subtitleOn === false ? '（已关闭）' : '（已开启）') : ''}
                    </button>
                  </>
                )}
                {onAudioEffectChange && (
                  <button
                    className={`pbar__menuitem ${audioEffect !== 'off' ? 'is-on' : ''}`}
                    onClick={() => setMenu('audio')}
                  >
                    音效 · {audioEffectLabel(audioEffect)}
                  </button>
                )}
              </div>
            )}
            {menu === 'audio' && (
              <div className="pbar__menu" onClick={(e) => e.stopPropagation()}>
                <button className="pbar__menuback" onClick={() => setMenu('more')}>
                  音效
                </button>
                {AUDIO_EFFECTS.map((fx) => (
                  <button
                    key={fx.id}
                    className={`pbar__menuitem ${audioEffect === fx.id ? 'is-on' : ''}`}
                    onClick={() => {
                      onAudioEffectChange?.(fx.id);
                      setMenu('none');
                    }}
                  >
                    {fx.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
