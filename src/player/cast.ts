import { Capacitor, registerPlugin } from '@capacitor/core';

/**
 * DLNA 投屏
 *
 * ── 机制 ────────────────────────────────────────────
 * 把 m3u8 URL 推给电视端，**电视自己去拉流**。
 * 好处：完全不经过手机的解码与 CORS 限制 ——
 *      这些源在手机 WebView 里能播，电视端拉同一个 CDN 也没问题。
 * 代价：进度无法实时回传手机（控制能力弱）。
 *
 * ── 为什么不用 Google Cast ──────────────────────────
 * Cast SDK 强依赖 Google Play 服务，国内 ROM（无 GMS）装上也是废的；
 * MediaRouter 是系统自带组件，不依赖任何 Google 服务。
 */

export interface CastDevice {
  id: string;
  name: string;
  description: string;
  selected: boolean;
}

export interface CastState {
  connected: boolean;
  routeId?: string;
  state?: number;
  position?: number;
  duration?: number;
  playbackState?: number;
}

interface CastPluginApi {
  /** 扫描局域网可投屏设备 */
  listDevices(): Promise<{ devices: CastDevice[]; count: number }>;
  /** 选设备并推流 */
  play(options: {
    routeId: string;
    url: string;
    title?: string;
    position?: number;
  }): Promise<void>;
  /** 停止投屏 */
  stop(): Promise<void>;
  /** 当前状态 */
  status(): Promise<{ connected: boolean; routeId?: string }>;
  addListener(
    eventName: 'castState',
    listener: (payload: CastState) => void,
  ): Promise<{ remove: () => void }>;
  addListener(
    eventName: 'castError',
    listener: (payload: { error: string }) => void,
  ): Promise<{ remove: () => void }>;
}

const Cast = registerPlugin<CastPluginApi>('Cast');

/** 投屏插件是否可用 */
export function isCastAvailable(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('Cast');
  } catch {
    return false;
  }
}

/** 扫描可投屏设备 */
export async function listCastDevices(): Promise<CastDevice[]> {
  try {
    const r = await Cast.listDevices();
    return r.devices || [];
  } catch {
    return [];
  }
}

/** 推流到指定设备 */
export async function castTo(
  routeId: string,
  url: string,
  title?: string,
  positionMs = 0,
): Promise<boolean> {
  try {
    await Cast.play({ routeId, url, title, position: positionMs });
    return true;
  } catch {
    return false;
  }
}

/** 停止投屏 */
export async function stopCast(): Promise<void> {
  try {
    await Cast.stop();
  } catch {
    /* ignore */
  }
}

/** 当前投屏状态 */
export async function getCastStatus(): Promise<{ connected: boolean; routeId?: string }> {
  try {
    return await Cast.status();
  } catch {
    return { connected: false };
  }
}

/** 监听投屏状态变化 */
export function onCastState(
  cb: (payload: CastState) => void,
): Promise<{ remove: () => void }> {
  return Cast.addListener('castState', cb);
}

/** 监听投屏错误 */
export function onCastError(cb: (payload: { error: string }) => void): Promise<{ remove: () => void }> {
  return Cast.addListener('castError', cb);
}
