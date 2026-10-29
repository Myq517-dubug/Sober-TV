import React, { useCallback, useEffect, useRef } from 'react';

/**
 * 侧边手势：左边缘右滑 → 返回首页
 * ────────────────────────────────────────────────────
 * 交互设计：
 *  1. **触发区**：屏幕左边缘 28px 内（避开 Android 系统返回手势的
 *     约 16px 热区，两者不重叠，手势不会打架）。
 *  2. **进度反馈**：滑动过程中页面跟随手指横向位移（阻尼 0.35），
 *     左侧浮出「返回首页」箭头指示器，箭头随进度填充。
 *  3. **完成判定**：位移超过屏幕宽度的 28%，或速度 > 0.45px/ms
 *     → 触发返回首页；否则回弹。
 *  4. **优先级**：捕获阶段监听 + stopPropagation，
 *     保证播放器的左右滑动快进不会被误触发（起点在边缘条内时）。
 *
 * ⚠️ 为什么用 window 捕获阶段？
 *    播放器的快进手势绑在 <video> 元素上（冒泡阶段）。
 *    我们在捕获阶段先拿到事件并决定是否拦截，
 *    否则边缘滑动会同时触发「快进 10 秒」。
 */

export interface EdgeSwipeState {
  /** 0 ~ 1，滑动进度 */
  progress: number;
  /** 是否正在滑动（用于显示指示器） */
  active: boolean;
  /** 是否已触发返回（指示器变绿） */
  triggered: boolean;
}

const EDGE_WIDTH = 28;
const COMPLETE_RATIO = 0.28;
const VELOCITY_TRIGGER = 0.5;
/** 页面跟随位移的最大值（px），避免拉太远 */
const MAX_SHIFT = 96;

export function useEdgeSwipeBack(enabled: boolean, onHome: () => void) {
  const [state, setState] = React.useState<EdgeSwipeState>({
    progress: 0,
    active: false,
    triggered: false,
  });

  const startX = useRef(0);
  const startY = useRef(0);
  const startT = useRef(0);
  /** 上一次 move 时的累计位移 */
  const prevDx = useRef(0);
  /** 上一次 move 的时间戳 */
  const prevT = useRef(0);
  const tracking = useRef(false);
  const decided = useRef(false); // 是否已判定为横向滑动
  const cancelled = useRef(false);
  const onHomeRef = useRef(onHome);
  onHomeRef.current = onHome;

  const reset = useCallback(() => {
    tracking.current = false;
    decided.current = false;
    cancelled.current = false;
    setState({ progress: 0, active: false, triggered: false });
  }, []);

  useEffect(() => {
    if (!enabled) {
      reset();
      return;
    }

    const onTouchStart = (e: TouchEvent) => {
      if (!e.touches.length) return;
      const t = e.touches[0];
      // 只认左边缘起点
      if (t.clientX > EDGE_WIDTH) return;
      tracking.current = true;
      decided.current = false;
      cancelled.current = false;
      startX.current = t.clientX;
      startY.current = t.clientY;
      prevDx.current = 0;
      startT.current = Date.now();
      prevT.current = startT.current;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!tracking.current || !e.touches.length) return;
      const t = e.touches[0];
      const dx = t.clientX - startX.current;
      const dy = t.clientY - startY.current;

      if (!decided.current) {
        // 纵向滑动优先判定：认为是滚动/上下操作 → 放弃
        if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 12) {
          cancelled.current = true;
          tracking.current = false;
          reset();
          return;
        }
        if (Math.abs(dx) < 8) return;
        decided.current = true;
        // 拦截：不让播放器把它当成快进手势
        if (e.cancelable) e.preventDefault();
      }

      if (cancelled.current) return;
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();

      prevDx.current = dx;
      prevT.current = Date.now();

      const max = Math.max(1, window.innerWidth * COMPLETE_RATIO);
      const progress = Math.max(0, Math.min(1, dx / max));
      setState({ progress, active: true, triggered: progress >= 1 });
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (!tracking.current) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - startX.current;
      const now = Date.now();
      /**
       * 速度判定用「末段手势速度」：末段位移 ÷ 末段时间。
       * - 末段时间取下限 40ms，避免手指滑到一半停住再抬手时 dt≈0 算出假高速
       * - 末段位移用增量（dx - prevDx），而不是累计位移，
       *   否则慢起手 + 快甩尾会被误判为高速
       */
      const segDt = Math.max(40, now - prevT.current);
      const segDx = dx - prevDx.current;
      const velocity = segDx / segDt;

      const max = Math.max(1, window.innerWidth * COMPLETE_RATIO);
      const byDistance = dx >= max;
      const byVelocity = velocity >= VELOCITY_TRIGGER && dx > 60;

      tracking.current = false;
      if (cancelled.current) {
        reset();
        return;
      }

      if (byDistance || byVelocity) {
        setState({ progress: 1, active: true, triggered: true });
        // 稍作停留让指示器呈现「完成」态，再跳转
        window.setTimeout(() => {
          reset();
          onHomeRef.current();
        }, 140);
      } else {
        reset();
      }
    };

    const onTouchCancel = () => {
      tracking.current = false;
      reset();
    };

    window.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
    window.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
    window.addEventListener('touchend', onTouchEnd, { passive: true, capture: true });
    window.addEventListener('touchcancel', onTouchCancel, { passive: true, capture: true });

    return () => {
      window.removeEventListener('touchstart', onTouchStart, { capture: true } as EventListenerOptions);
      window.removeEventListener('touchmove', onTouchMove, { capture: true } as EventListenerOptions);
      window.removeEventListener('touchend', onTouchEnd, { capture: true } as EventListenerOptions);
      window.removeEventListener('touchcancel', onTouchCancel, { capture: true } as EventListenerOptions);
    };
  }, [enabled, reset]);

  /** 页面横向位移（阻尼后） */
  const shift = state.active ? Math.min(MAX_SHIFT, state.progress * MAX_SHIFT) : 0;

  return { ...state, shift };
}
