/**
 * 观看记忆 —— 进度 + 集数 + 线路
 *
 * ── 一份存储，三处复用 ──────────────────────────────
 * 本模块同时支撑三个需求，避免拆成多套 key：
 *   1. **续播**：记住上次播到哪一秒
 *   2. **播放记忆**：记住上次看的是第几集、用的哪条线路
 *   3. **继续观看**：首页展示最近观看的片单
 *
 * ── 存储结构 ────────────────────────────────────────
 * 主表（按「影片 id」组织，一个影片一条记录）：
 *   sober.memory.<mediaId> → {
 *     title, poster, mediaType,      // 展示用
 *     episode, keepLabel,             // 播放记忆：集数 + 线路
 *     position, duration,             // 续播：进度
 *     updatedAt
 *   }
 *
 * 为什么按影片而不是「影片+集数」：
 *   「继续观看」要展示的是**片**（一部剧一个卡片），不是「片+集数」条目。
 *   每部剧只保留最新那集的进度 —— 这也是用户心智：回来继续看这剧。
 *   （v1.5.0 曾用 `sober.progress.<mediaId>.<episode>` 分集存储，
 *     首页无法直接出行，且同一部剧会产生多条记录，已改为本结构。）
 *
 * ── 迁移 ────────────────────────────────────────────
 * 旧版 `sober.progress.*` 的数据在首次读取时自动迁移，避免用户丢进度。
 */

const MEM_KEY_PREFIX = 'sober.memory.';
const LEGACY_PREFIX = 'sober.progress.';
const MAX_RECORDS = 60;

/** 回看偏移：续播时从 position - 10 秒开始 */
const REWIND_OFFSET = 10;
/** 低于此进度视为「刚开始」，不记录（避免误触产生垃圾记录） */
const MIN_RECORD_SEC = 15;
/** 播放超过此比例视为看完，不再显示在「继续观看」 */
const FINISHED_RATIO = 0.95;

export interface MediaType {
  id: string;
  title: string;
  poster?: string;
  mediaType: 'movie' | 'tv' | 'anime' | 'live';
  /** 上次观看的集数（电影为 1） */
  episode: number;
  /** 上次使用的线路名（换源时保持一致） */
  keepLabel?: string;
  /** 上次播放位置（秒） */
  position: number;
  /** 该集总时长（秒） */
  duration: number;
  /** 总集数（用于「继续观看」卡片上显示「第 N 集」） */
  totalEpisodes?: number;
  updatedAt: number;
}

function key(mediaId: string): string {
  return `${MEM_KEY_PREFIX}${mediaId}`;
}

/** 读取某部片的记忆 */
export function getMemory(mediaId: string): MediaType | null {
  if (!mediaId) return null;
  try {
    const raw = localStorage.getItem(key(mediaId));
    if (raw) {
      const rec = JSON.parse(raw) as MediaType;
      return rec && typeof rec.position === 'number' ? rec : null;
    }
    // 尝试从旧版分集记录迁移
    return migrateLegacy(mediaId);
  } catch {
    return null;
  }
}

/**
 * 从旧版 `sober.progress.<mediaId>.<episode>` 迁移
 *
 * 取集号最大的一条（用户最后看的那集）。
 */
function migrateLegacy(mediaId: string): MediaType | null {
  try {
    let best: MediaType | null = null;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(LEGACY_PREFIX)) continue;
      const rest = k.slice(LEGACY_PREFIX.length);
      const dot = rest.lastIndexOf('.');
      if (dot < 0) continue;
      if (rest.slice(0, dot) !== mediaId) continue;
      const ep = Number(rest.slice(dot + 1));
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      const rec = JSON.parse(raw) as { position: number; duration: number; updatedAt: number };
      if (!best || ep > best.episode) {
        best = {
          id: mediaId,
          title: '',
          mediaType: 'tv',
          episode: ep,
          position: rec.position,
          duration: rec.duration,
          updatedAt: rec.updatedAt || Date.now(),
        };
      }
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * 保存记忆
 *
 * 用「部分更新」语义 —— 播放过程中只更新 position 时，
 * 不要把已有的 title/poster/episode 覆盖掉。
 */
export function saveMemory(mediaId: string, patch: Partial<MediaType>): void {
  if (!mediaId) return;
  try {
    const prev = getMemory(mediaId);
    const next: MediaType = {
      id: mediaId,
      title: patch.title ?? prev?.title ?? '',
      poster: patch.poster ?? prev?.poster,
      mediaType: patch.mediaType ?? prev?.mediaType ?? 'movie',
      episode: patch.episode ?? prev?.episode ?? 1,
      keepLabel: patch.keepLabel ?? prev?.keepLabel,
      position: patch.position ?? prev?.position ?? 0,
      duration: patch.duration ?? prev?.duration ?? 0,
      totalEpisodes: patch.totalEpisodes ?? prev?.totalEpisodes,
      updatedAt: Date.now(),
    };
    localStorage.setItem(key(mediaId), JSON.stringify(next));
    prune();
  } catch {
    /* 存储不可用时忽略 */
  }
}

/** 清除某部片的记忆 */
export function clearMemory(mediaId: string): void {
  try {
    localStorage.removeItem(key(mediaId));
  } catch {
    /* ignore */
  }
}

/**
 * 计算续播起点
 *
 * 返回 null 表示无记录 / 已看完 / 无需续播。
 */
export function resumePosition(mediaId: string, episode?: number): number | null {
  const rec = getMemory(mediaId);
  if (!rec) return null;
  // 指定集数时，只有记忆里的集数匹配才续播
  if (episode != null && rec.episode !== episode) return null;
  if (rec.position < MIN_RECORD_SEC) return null;
  // 已看完
  if (rec.duration > 0 && rec.position / rec.duration > FINISHED_RATIO) return null;
  const pos = Math.max(0, rec.position - REWIND_OFFSET);
  if (rec.duration > 0 && pos > rec.duration * 0.92) return null;
  return pos;
}

/**
 * 列出最近观看（用于「继续观看」行）
 *
 * 过滤掉已看完的条目，按更新时间倒序。
 */
export function listMemories(limit = 20): MediaType[] {
  const out: MediaType[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(MEM_KEY_PREFIX)) continue;
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      try {
        const rec = JSON.parse(raw) as MediaType;
        if (!rec || !rec.title) continue;
        if (rec.position < MIN_RECORD_SEC) continue;
        if (rec.duration > 0 && rec.position / rec.duration > FINISHED_RATIO) continue;
        out.push(rec);
      } catch {
        /* 跳过损坏记录 */
      }
    }
  } catch {
    /* ignore */
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

/**
 * 观看历史时间线
 *
 * 与 listMemories 的区别：这里**不过滤已看完的条目** ——
 * 「继续观看」要的是没看完的，历史要的是全部足迹。
 */
export function listHistory(limit = 60): MediaType[] {
  const out: MediaType[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(MEM_KEY_PREFIX)) continue;
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      try {
        const rec = JSON.parse(raw) as MediaType;
        if (!rec || !rec.title) continue;
        if (!(rec.updatedAt > 0)) continue;
        out.push(rec);
      } catch {
        /* 跳过损坏记录 */
      }
    }
  } catch {
    /* ignore */
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

/** 清空全部观看历史 */
export function clearHistory(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(MEM_KEY_PREFIX)) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

/** 清理超出上限的旧记录 */
function prune(): void {
  try {
    const items: { key: string; updatedAt: number }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(MEM_KEY_PREFIX)) continue;
      try {
        const rec = JSON.parse(localStorage.getItem(k) || '{}') as MediaType;
        items.push({ key: k, updatedAt: rec.updatedAt || 0 });
      } catch {
        items.push({ key: k, updatedAt: 0 });
      }
    }
    if (items.length <= MAX_RECORDS) return;
    items.sort((a, b) => b.updatedAt - a.updatedAt);
    for (const it of items.slice(MAX_RECORDS)) {
      localStorage.removeItem(it.key);
    }
  } catch {
    /* ignore */
  }
}
