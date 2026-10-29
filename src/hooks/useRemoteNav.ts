/**
 * 遥控器 / 键盘导航 —— 对应方案 P3-1 Android TV
 *
 * 设计要点：
 *  1. 焦点用 CSS :focus-visible 管理，不额外维护焦点状态（无障碍更好）
 *  2. 上下左右按「几何最近邻」移动焦点，而非 DOM 顺序 —— 遥控器操作符合直觉
 *  3. 回车/确认触发点击，空格播放暂停
 */

type Focusable = HTMLElement;

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[data-focus]',
].join(',');

function getFocusables(container: ParentNode = document): Focusable[] {
  return Array.from(container.querySelectorAll<Focusable>(FOCUSABLE_SELECTOR)).filter((el) => {
    if (el.hasAttribute('disabled')) return false;
    // 排除不可见元素
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
}

function center(el: Focusable): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/**
 * 在候选集中寻找指定方向的几何最近邻
 */
function findNeighbor(
  from: Focusable,
  candidates: Focusable[],
  dir: 'up' | 'down' | 'left' | 'right',
): Focusable | null {
  const a = center(from);
  let best: Focusable | null = null;
  let bestScore = Infinity;

  for (const el of candidates) {
    if (el === from) continue;
    const b = center(el);

    let along: number; // 主方向距离
    let across: number; // 横向偏移

    switch (dir) {
      case 'up':
        along = a.y - b.y;
        across = Math.abs(a.x - b.x);
        break;
      case 'down':
        along = b.y - a.y;
        across = Math.abs(a.x - b.x);
        break;
      case 'left':
        along = a.x - b.x;
        across = Math.abs(a.y - b.y);
        break;
      default:
        along = b.x - a.x;
        across = Math.abs(a.y - b.y);
        break;
    }

    // 主方向必须在正确的一侧
    if (along <= 4) continue;

    // 跨轴偏移过大 → 不是同一行/列
    const maxAcross = dir === 'up' || dir === 'down' ? 260 : 180;
    if (across > maxAcross) continue;

    // 代价 = 主距离 + 横向偏移惩罚（偏向正对齐的目标）
    const score = along + across * 1.6;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }

  return best;
}

export interface RemoteNavOptions {
  /** 播放/暂停回调（空格键） */
  onTogglePlay?: () => void;
  /** 返回回调（Escape / Android 返回键） */
  onBack?: () => void;
  /** 是否启用（播放全屏时可能需要禁用某些键） */
  enabled?: boolean;
}

let installed = false;
let opts: RemoteNavOptions = {};

/**
 * 安装遥控器导航
 */
export function installRemoteNav(options: RemoteNavOptions = {}): () => void {
  opts = options;
  if (installed) return uninstall;
  installed = true;

  const onKeyDown = (e: KeyboardEvent) => {
    if (opts.enabled === false) return;

    const target = e.target as HTMLElement | null;
    // 输入框内不劫持方向键
    const inInput =
      target &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    if (inInput && e.key !== 'Escape') return;

    const active = document.activeElement as Focusable | null;
    const candidates = getFocusables();

    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowDown':
      case 'ArrowLeft':
      case 'ArrowRight': {
        if (!active || !candidates.includes(active)) {
          // 无焦点时聚焦第一个可聚焦元素
          if (candidates[0]) {
            e.preventDefault();
            candidates[0].focus();
          }
          return;
        }
        const dir =
          e.key === 'ArrowUp'
            ? 'up'
            : e.key === 'ArrowDown'
              ? 'down'
              : e.key === 'ArrowLeft'
                ? 'left'
                : 'right';
        const next = findNeighbor(active, candidates, dir);
        if (next) {
          e.preventDefault();
          next.focus();
          next.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
        break;
      }
      case 'Enter': {
        // 按钮/链接的原生行为已覆盖，这里只处理自定义 [data-focus] 元素
        if (active && active.hasAttribute('data-focus') && active.tagName !== 'BUTTON' && active.tagName !== 'A') {
          e.preventDefault();
          active.click();
        }
        break;
      }
      case ' ': {
        if (opts.onTogglePlay) {
          e.preventDefault();
          opts.onTogglePlay();
        }
        break;
      }
      case 'Escape':
      case 'BrowserBack': {
        if (opts.onBack) {
          e.preventDefault();
          opts.onBack();
        }
        break;
      }
      default:
        break;
    }
  };

  window.addEventListener('keydown', onKeyDown);

  function uninstall() {
    window.removeEventListener('keydown', onKeyDown);
    installed = false;
  }

  return uninstall;
}

/**
 * Android 实体遥控器按键映射（Capacitor 下通过 keydown 的 key 值区分）
 * 部分 Android TV 遥控器会派发自定义事件，这里做兼容
 */
export function installAndroidRemote(): () => void {
  const onKey = (e: Event) => {
    const ev = e as KeyboardEvent;
    // Android 遥控器常见 keyCode：DPAD=19-22, ENTER=66, BACK=4
    const map: Record<number, string> = {
      19: 'ArrowUp',
      20: 'ArrowDown',
      21: 'ArrowLeft',
      22: 'ArrowRight',
      66: 'Enter',
      4: 'Escape',
      62: ' ',
      85: 'Tab',
    };
    const mapped = map[ev.keyCode ?? -1];
    if (!mapped) return;
    if (ev.key === mapped) return; // 已被标准 keydown 处理

    const active = document.activeElement as Focusable | null;
    const candidates = getFocusables();

    if (mapped.startsWith('Arrow')) {
      e.preventDefault();
      const dir = mapped.slice(5).toLowerCase() as 'up' | 'down' | 'left' | 'right';
      if (!active || !candidates.includes(active)) {
        candidates[0]?.focus();
        return;
      }
      const next = findNeighbor(active, candidates, dir);
      next?.focus();
      next?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else if (mapped === 'Enter') {
      if (active && active.tagName !== 'BUTTON' && active.tagName !== 'A') {
        e.preventDefault();
        active.click();
      }
    } else if (mapped === 'Escape') {
      opts.onBack?.();
    }
  };

  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
