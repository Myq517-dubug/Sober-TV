/**
 * 直播弹幕滚动层（Web 引擎专用）
 *
 * ── 只负责「画」 ──────────────────────────────────────
 *   WebSocket 接收在 lib/danmaku.ts，这里只做轨道分配与上屏。
 *   原生 ExoPlayer 播放时用的是 PlayerActivity 里的 DanmakuLayer，
 *   两个实现视觉规则保持一致：6 条轨道、每秒最多 8 条、横穿约 7~13 秒。
 *
 * ── 为什么要丢弹幕 ────────────────────────────────────
 *   热门直播间一秒能推几十条，全部上屏会糊成一片且拖慢 WebView。
 *   轨道占满后直接丢弃，弹幕允许丢，保住画面流畅度。
 */

import { useEffect, useRef, useState } from 'react';
import { connectDanmaku, danmakuSupported, type DanmakuStatus } from '../lib/danmaku';

interface Props {
  platform: string;
  roomId: string;
  enabled: boolean;
  onStatus?: (state: DanmakuStatus, detail?: string) => void;
}

interface Item {
  id: number;
  text: string;
  top: number;
  dur: number;
}

/** 轨道数：与原生 DanmakuLayer 一致 */
const LANES = 6;
const LANE_H = 30;
/** DOM 上限，超出时丢掉最老的，避免长时间挂机堆积 */
const MAX_ITEMS = 40;

export function LiveDanmaku({ platform, roomId, enabled, onStatus }: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const seq = useRef(0);
  const lanes = useRef<number[]>(new Array(LANES).fill(0));
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  useEffect(() => {
    setItems([]);
    lanes.current = new Array(LANES).fill(0);
    if (!enabled || !danmakuSupported(platform) || !roomId) return;

    const session = connectDanmaku({
      platform,
      roomId,
      onMessage: (m) => {
        const now = Date.now();
        let lane = -1;
        for (let i = 0; i < LANES; i++) {
          if (lanes.current[i] <= now) {
            lane = i;
            break;
          }
        }
        if (lane < 0) return;

        const text = m.name ? `${m.name}：${m.text}` : m.text;
        const dur = Math.min(13, 7 + text.length * 0.16);
        lanes.current[lane] = now + Math.min(2200, 900 + text.length * 40);

        const id = ++seq.current;
        setItems((prev) => {
          const next = prev.length >= MAX_ITEMS ? prev.slice(prev.length - MAX_ITEMS + 1) : prev;
          return [...next, { id, text, top: lane * LANE_H, dur }];
        });
        window.setTimeout(
          () => setItems((prev) => prev.filter((x) => x.id !== id)),
          dur * 1000 + 400,
        );
      },
      onStatus: (s, d) => onStatusRef.current?.(s, d),
    });

    return () => session.close();
  }, [platform, roomId, enabled]);

  if (!enabled || !danmakuSupported(platform)) return null;

  return (
    <div className="live-dmk" aria-hidden="true">
      {items.map((it) => (
        <span
          key={it.id}
          className="live-dmk__item"
          style={{ top: it.top, animationDuration: `${it.dur}s` }}
        >
          {it.text}
        </span>
      ))}
    </div>
  );
}
