/**
 * 收藏（追剧）
 *
 * 与观看记忆分开存：
 *   记忆（sober.memory.*）会被「已看完」过滤掉，而收藏是用户主动行为，
 *   不该因为看完了就消失 —— 所以不复用同一套 key。
 *
 * 结构：sober.favorites → FavoriteItem[]（数组越新越靠前）
 */

const KEY = 'sober.favorites';
const MAX = 200;

export interface FavoriteItem {
  id: string;
  title: string;
  poster?: string;
  mediaType: 'movie' | 'tv' | 'anime' | 'live';
  typeLabel?: string;
  year?: string;
  rating?: number;
  updatedAt: number;
}

function read(): FavoriteItem[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as FavoriteItem[]).filter((x) => x && x.id) : [];
  } catch {
    return [];
  }
}

function write(list: FavoriteItem[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* 配额满时忽略 */
  }
}

export function listFavorites(): FavoriteItem[] {
  return read().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function isFavorite(id: string | number): boolean {
  const key = String(id);
  return read().some((x) => x.id === key);
}

/** 收藏 / 取消收藏，返回操作后的状态 */
export function toggleFavorite(item: Omit<FavoriteItem, 'updatedAt'>): boolean {
  const key = String(item.id);
  const list = read();
  const idx = list.findIndex((x) => x.id === key);
  if (idx >= 0) {
    list.splice(idx, 1);
    write(list);
    return false;
  }
  list.unshift({ ...item, id: key, mediaType: item.mediaType || 'movie', updatedAt: Date.now() });
  write(list);
  return true;
}

export function removeFavorite(id: string | number): void {
  const key = String(id);
  write(read().filter((x) => x.id !== key));
}

export function clearFavorites(): void {
  write([]);
}
