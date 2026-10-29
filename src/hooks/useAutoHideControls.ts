import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 播放器控制条自动隐藏
 * ────────────────────────────────────────────────────
 * 需求：横屏全屏观影时，进度条和按钮不该挡着画面。
 *
 * 规则：
 *  1. **只有横屏才自动隐藏** —— 竖屏是「详情页 + 小播放器」形态，
 *     控制条常驻是合理的（还能看到进度、集数）
 *  2. 进入横屏后额外等 `enterDelay` 才首次隐藏，
 *     免得刚转屏控件就消失（用户会以为「功能坏了」）
 *  3. 显示状态下 `idleDelay` 毫秒无操作自动收起
 *  4. 任何交互（点视频区 / 拖进度 / 开面板）立即恢复显示并重置计时
 *  5. 面板打开期间 `pinned` → 不自动隐藏（否则操作到一半控件消失）
 *
 * ⚠️ 计时器的唯一管理者是那个 useEffect。
 *    reveal() 绝不能自己去 clearTimer —— 否则：
 *    「visible 已经是 true（无重渲染）→ reveal 清掉计时器
 *      → 状态没变 → effect 不重跑 → 永远不会再隐藏」。
 *    这正是 pinned 解除后控制条再也不消失的 bug 根因。
 *    reveal 只改状态，用 resetToken 触发 effect 重跑。
 */

export interface AutoHideControlsOptions {
  /** 是否处于横屏（全屏） */
  landscape: boolean;
  /** 是否有面板/交互正在进行（期间不自动隐藏） */
  pinned?: boolean;
  /** 首次进入横屏后的额外延迟（毫秒） */
  enterDelay?: number;
  /** 无操作自动收起的等待（毫秒） */
  idleDelay?: number;
}

export interface AutoHideControls {
  /** 控制条是否应该显示 */
  visible: boolean;
  /** 显示控制条并重置计时 */
  reveal: () => void;
  /** 隐藏控制条 */
  hide: () => void;
  /** 切换显隐（点视频区用） */
  toggle: () => void;
}

export function useAutoHideControls(options: AutoHideControlsOptions): AutoHideControls {
  const {
    landscape,
    pinned = false,
    enterDelay = 2500,
    idleDelay = 4000,
  } = options;

  const [visible, setVisible] = useState(true);
  /** 手动 reveal 计数 —— 用来在 visible 未变时也能重启计时 */
  const [resetToken, setResetToken] = useState(0);
  /** 进入横屏的时刻（用于算首次隐藏的额外延迟） */
  const enteredAt = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const reveal = useCallback(() => {
    setVisible(true);
    // 即使 visible 已经是 true，也要重启计时
    setResetToken((t) => t + 1);
  }, []);

  const hide = useCallback(() => {
    setVisible(false);
  }, []);

  const toggle = useCallback(() => {
    setVisible((v) => {
      if (v) {
        clearTimer();
        return false;
      }
      return true;
    });
    // 从隐藏切到显示时也要重启计时
    setResetToken((t) => t + 1);
  }, [clearTimer]);

  // 记录进入横屏的时刻
  useEffect(() => {
    if (landscape) {
      if (enteredAt.current === null) enteredAt.current = Date.now();
    } else {
      enteredAt.current = null;
    }
  }, [landscape]);

  // 自动隐藏计时（唯一的计时器管理者）
  useEffect(() => {
    clearTimer();
    if (!landscape || !visible || pinned) return;

    const now = Date.now();
    const sinceEnter = enteredAt.current === null ? enterDelay : now - enteredAt.current;
    // 刚进横屏：等 enterDelay 缓冲 + idleDelay 空闲才隐藏
    const delay = Math.max(0, enterDelay - sinceEnter) + idleDelay;

    timerRef.current = window.setTimeout(() => {
      setVisible(false);
      timerRef.current = null;
    }, delay);

    return clearTimer;
  }, [landscape, visible, pinned, resetToken, enterDelay, idleDelay, clearTimer]);

  // 组件卸载时清理
  useEffect(() => clearTimer, [clearTimer]);

  return { visible, reveal, hide, toggle };
}
