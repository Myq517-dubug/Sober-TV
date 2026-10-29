import React, { useCallback, useEffect, useRef } from 'react';

/**
 * 播放器手势
 *
 * ── 手势设计 ────────────────────────────────────────
 * | 手势 | 行为 |
 * |---|---|
 * | 单击视频区 | 显示/隐藏控制条 |
 * | 双击视频区 | 播放/暂停 |
 * | 左右滑动 | 快进 / 快退（10 秒一步） |
 * | 上下滑动（右侧）| 音量 |
 * | 上下滑动（左侧）| 亮度（WebView 无法调系统亮度 → 改为显示进度提示） |
 *
 * ⚠️ 关键实现要点：
 * 1. **单击与双击必须区分**：单击用 260ms 定时器延迟判定，
 *    双击命中则取消单击。双击时也要取消单击的「显示控制条」。
 * 2. **滑动阈值 24px**：小于这个值视为误触。
 * 3. **纵向优先级高于横向**：先判断 |dy| > |dx| 才算纵向滑动，
 *    否则上下滑动会被误判为快进。
 * 4. 手势区只在视频层，不拦截控制条上的操作。
 */

export interface PlayerGesturesProps {
  /** 视频元素（用于全屏点击区域参考） */
  targetRef: React.RefObject<HTMLElement | null>;
  /** 当前播放位置（秒） */
  position: number;
  /** 总时长（秒） */
  duration: number;
  /** 跳转 */
  onSeek: (sec: number) => void;
  /** 切换播放/暂停 */
  onTogglePlay: () => void;
  /** 单击（显示/隐藏控制条） */
  onTap?: () => void;
  /** 手势提示（显示 ±10s 之类） */
  onHint?: (text: string) => void;
  /**
   * 长按临时倍速
   *
   * 传入 3 表示开始长按加速，传入 null 表示松手恢复原倍速。
   * 原生引擎与 Web 引擎共用同一套手势语义。
   */
  onRateHold?: (rate: number | null) => void;
  /** 当前音量 0-1（右侧上下滑动） */
  volume?: number;
  /** 音量变化回调 */
  onVolumeChange?: (volume: number) => void;
  /** 当前亮度倍率（左侧上下滑动，1 = 原始亮度） */
  brightness?: number;
  /** 亮度变化回调 */
  onBrightnessChange?: (brightness: number) => void;
  /** 是否启用 */
  enabled?: boolean;
}

const SWIPE_THRESHOLD = 24;
const SEEK_STEP = 10;
const DOUBLE_TAP_DELAY = 260;
/** 长按多久触发临时倍速 */
const LONG_PRESS_DELAY = 480;
/** 亮度可调范围（CSS filter 倍率） */
const BRIGHTNESS_MIN = 0.2;
const BRIGHTNESS_MAX = 1.6;

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

export function PlayerGestures(props: PlayerGesturesProps) {
  const { targetRef, duration, enabled = true } = props;

  const startX = useRef(0);
  const startY = useRef(0);
  const startTime = useRef(0);
  const moved = useRef(false);
  const tapTimer = useRef<number | null>(null);
  const lastTapAt = useRef(0);
  /** 当前手势类型 */
  const mode = useRef<'none' | 'horizontal' | 'vertical'>('none');
  /** 基准位置（滑动开始时） */
  const basePosition = useRef(0);
  /** 长按加速：定时器与当前是否处于加速态 */
  const holdTimer = useRef<number | null>(null);
  const holding = useRef(false);
  /** 纵滑起始值：音量 / 亮度，以及触摸落点在左半屏还是右半屏 */
  const baseVolume = useRef(1);
  const baseBrightness = useRef(1);
  const verticalSide = useRef<'volume' | 'brightness'>('volume');

  // 用 ref 持有最新 props，避免每次渲染重建监听
  const cbRef = useRef(props);
  cbRef.current = props;

  /** 读取当前 props 的便捷方法 */
  const cur = useCallback(() => cbRef.current, []);

  const clearTapTimer = useCallback(() => {
    if (tapTimer.current != null) {
      window.clearTimeout(tapTimer.current);
      tapTimer.current = null;
    }
  }, []);

  /** 结束长按加速并恢复原倍速 */
  const endHold = useCallback(() => {
    if (holdTimer.current != null) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    if (holding.current) {
      holding.current = false;
      cbRef.current.onRateHold?.(null);
      cbRef.current.onHint?.('');
    }
  }, []);

  useEffect(() => {
    const el = targetRef.current;
    if (!el || !enabled) return;

    const onTouchStart = (e: TouchEvent) => {
      if (!e.touches.length) return;
      const t = e.touches[0];
      startX.current = t.clientX;
      startY.current = t.clientY;
      startTime.current = Date.now();
      moved.current = false;
      mode.current = 'none';
      holding.current = false;
      basePosition.current = cbRef.current.position;

      // 右半屏滑音量、左半屏滑亮度（和原生播放器一致）
      const rect = el.getBoundingClientRect();
      verticalSide.current =
        t.clientX - rect.left < rect.width / 2 ? 'brightness' : 'volume';
      baseVolume.current = cbRef.current.volume ?? 1;
      baseBrightness.current = cbRef.current.brightness ?? 1;

      // 长按 480ms 且没有位移 → 临时 3 倍速
      if (holdTimer.current != null) window.clearTimeout(holdTimer.current);
      holdTimer.current = window.setTimeout(() => {
        holdTimer.current = null;
        if (moved.current) return;
        holding.current = true;
        cbRef.current.onRateHold?.(3);
        cbRef.current.onHint?.('3× 倍速中');
      }, LONG_PRESS_DELAY);
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!e.touches.length) return;
      const t = e.touches[0];
      const dx = t.clientX - startX.current;
      const dy = t.clientY - startY.current;

      if (!moved.current) {
        if (Math.abs(dx) < SWIPE_THRESHOLD && Math.abs(dy) < SWIPE_THRESHOLD) return;
        moved.current = true;
        // 一旦开始滑动就取消长按，避免「滑动加速」这种混乱行为
        endHold();
        // 纵向优先：只有横向明显大于纵向才算快进退
        mode.current = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
      }

      if (mode.current === 'horizontal') {
        e.preventDefault();
        const steps = Math.trunc(dx / 60);
        const target = Math.max(
          0,
          Math.min(duration || 1e9, basePosition.current + steps * SEEK_STEP),
        );
        const delta = target - basePosition.current;
        cur().onHint?.(`${delta >= 0 ? '+' : ''}${Math.round(delta)} 秒`);
        return;
      }

      if (mode.current === 'vertical') {
        e.preventDefault();
        const span = Math.max(el.clientHeight * 0.7, 1);
        const ratio = -dy / span;
        if (verticalSide.current === 'volume') {
          const v = clamp(baseVolume.current + ratio, 0, 1);
          cur().onVolumeChange?.(v);
          cur().onHint?.(`音量 ${Math.round(v * 100)}%`);
        } else {
          const b = clamp(baseBrightness.current + ratio, BRIGHTNESS_MIN, BRIGHTNESS_MAX);
          cur().onBrightnessChange?.(b);
          cur().onHint?.(`亮度 ${Math.round(b * 100)}%`);
        }
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      const t = e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - startX.current;
      const dt = Date.now() - startTime.current;

      // 长按加速期间松手 → 恢复原倍速，且不判定为点击
      if (holding.current) {
        endHold();
        return;
      }
      if (holdTimer.current != null) {
        window.clearTimeout(holdTimer.current);
        holdTimer.current = null;
      }

      if (mode.current === 'horizontal') {
        const steps = Math.trunc(dx / 60);
        if (steps !== 0) {
          const target = Math.max(
            0,
            Math.min(duration || 1e9, basePosition.current + steps * SEEK_STEP),
          );
          cur().onSeek(target);
          cbRef.current.onHint?.(`${steps > 0 ? '+' : ''}${steps * SEEK_STEP} 秒`);
        }
        cur().onHint?.('');
        return;
      }

      if (mode.current === 'vertical') {
        cur().onHint?.('');
        return;
      }

      // ── 点击判定 ──────────────────────────────────
      if (moved.current || dt > 500) return;

      const now = Date.now();
      const isDouble = now - lastTapAt.current < DOUBLE_TAP_DELAY * 1.6;
      lastTapAt.current = now;

      if (isDouble) {
        clearTapTimer();
        cur().onTogglePlay();
        cur().onHint?.('');
        return;
      }

      // 单击：延迟 DOUBLE_TAP_DELAY 判定，避免与双击冲突
      clearTapTimer();
      tapTimer.current = window.setTimeout(() => {
        cur().onTap?.();
      }, DOUBLE_TAP_DELAY);
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });

    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
      clearTapTimer();
      endHold();
    };
  }, [targetRef, enabled, clearTapTimer, endHold]);

  return null;
}
