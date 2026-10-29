import { Capacitor, registerPlugin } from '@capacitor/core';

/**
 * 屏幕方向与沉浸式（原生）
 *
 * Web 侧没有强制横屏的能力，必须调 Activity 的 setRequestedOrientation。
 * Manifest 里写的是 `fullUser`（跟随系统），用户关了自动旋转就转不了。
 */
interface ScreenOrientationPlugin {
  /** 强制横屏（并进入沉浸式，隐藏状态栏/导航栏） */
  setLandscape(options: { enable: boolean }): Promise<void>;
  /** 恢复为跟随系统的自动旋转 */
  unlock(): Promise<void>;
  /** 当前是否横屏 */
  isLandscape(): Promise<{ landscape: boolean }>;
  /** 单独开关沉浸式（不改方向） */
  setImmersive(options: { enable: boolean }): Promise<void>;
  /** 系统栏/刘海安全内边距（dp = CSS px） */
  getInsets(): Promise<{
    top: number;
    bottom: number;
    left: number;
    right: number;
    immersive: boolean;
  }>;
}

const ScreenOrientation = registerPlugin<ScreenOrientationPlugin>('ScreenOrientation');

/** 强制横屏 */
export function setLandscape(enable = true): Promise<void> {
  return ScreenOrientation.setLandscape({ enable }).catch(() => {});
}

/** 恢复自动旋转 */
export function unlockOrientation(): Promise<void> {
  return ScreenOrientation.unlock().catch(() => {});
}

/** 当前是否横屏 */
export async function isLandscape(): Promise<boolean> {
  try {
    const r = await ScreenOrientation.isLandscape();
    return !!r.landscape;
  } catch {
    return false;
  }
}

/**
 * 开关沉浸式（隐藏状态栏 + 导航栏）
 *
 * 与 setLandscape 分开的原因：
 *   横屏 ≠ 全屏。用户在竖屏看短视频时也想隐藏状态栏，
 *   而用户手动旋转手机时也应该自动进入沉浸式。
 */
export function setImmersive(enable = true): Promise<void> {
  return ScreenOrientation.setImmersive({ enable }).catch(() => {});
}

export interface SafeInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
  immersive: boolean;
}

/**
 * 读取安全区内边距
 *
 * 为什么不用 env(safe-area-inset-*)：
 *   Android WebView 对 safe-area 支持不稳定，尤其横屏挖孔屏上常返回 0，
 *   导致左/右侧按钮被刘海切掉。原生 inset 是真实值。
 */
export async function getSafeInsets(): Promise<SafeInsets> {
  const zero = { top: 0, bottom: 0, left: 0, right: 0, immersive: false };
  try {
    const r = await ScreenOrientation.getInsets();
    return {
      top: Number(r?.top) || 0,
      bottom: Number(r?.bottom) || 0,
      left: Number(r?.left) || 0,
      right: Number(r?.right) || 0,
      immersive: !!r?.immersive,
    };
  } catch {
    return zero;
  }
}

/**
 * 屏幕方向插件是否可用
 *
 * 浏览器预览环境下没有原生插件。
 */
export function isScreenOrientationAvailable(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('ScreenOrientation');
  } catch {
    return false;
  }
}
