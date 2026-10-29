/**
 * 字幕本地留存
 *
 * 一部片一条记录（含字幕全文），最多留最近 5 部：
 * 字幕文件不大，但 localStorage 只有 5 MB，按片无限存迟早写爆。
 */

const PREFIX = 'sober.subtitle.';
const MAX_RECORDS = 5;
/** 单条文本上限 2 MB（与导入限制一致） */
const MAX_TEXT = 2 * 1024 * 1024;

export interface StoredSubtitle {
  mediaId: string;
  name: string;
  lang: string;
  text: string;
  updatedAt: number;
}

export function getSubtitle(mediaId: string): StoredSubtitle | null {
  if (!mediaId) return null;
  try {
    const raw = localStorage.getItem(PREFIX + mediaId);
    if (!raw) return null;
    const rec = JSON.parse(raw) as StoredSubtitle;
    return rec && rec.text ? rec : null;
  } catch {
    return null;
  }
}

export function saveSubtitle(
  mediaId: string,
  patch: { name: string; text: string; lang?: string },
): StoredSubtitle | null {
  if (!mediaId) return null;
  const text = String(patch.text || '');
  if (!text || text.length > MAX_TEXT) return null;
  const rec: StoredSubtitle = {
    mediaId,
    name: patch.name || '外挂字幕',
    lang: patch.lang || 'zh',
    text,
    updatedAt: Date.now(),
  };
  try {
    localStorage.setItem(PREFIX + mediaId, JSON.stringify(rec));
    prune();
    return rec;
  } catch {
    // 配额不足：清掉最旧一条再试一次
    try {
      prune(true);
      localStorage.setItem(PREFIX + mediaId, JSON.stringify(rec));
      return rec;
    } catch {
      return null;
    }
  }
}

export function removeSubtitle(mediaId: string): void {
  try {
    localStorage.removeItem(PREFIX + mediaId);
  } catch {
    /* ignore */
  }
}

function prune(aggressive = false): void {
  try {
    const items: { key: string; at: number }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(PREFIX)) continue;
      let at = 0;
      try {
        at = Number(JSON.parse(localStorage.getItem(k) || '{}').updatedAt) || 0;
      } catch {
        at = 0;
      }
      items.push({ key: k, at });
    }
    const limit = aggressive ? 2 : MAX_RECORDS;
    if (items.length <= limit) return;
    items.sort((a, b) => b.at - a.at);
    for (const it of items.slice(limit)) localStorage.removeItem(it.key);
  } catch {
    /* ignore */
  }
}
