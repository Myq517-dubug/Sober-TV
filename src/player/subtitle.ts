/**
 * 字幕解析（SRT / WebVTT）
 *
 * 公网采集源基本不提供字幕轨，所以字幕靠用户导入：
 * 本地文件或字幕链接。两条路径最终都归一成 Cue[]，
 * Web 引擎自己按播放进度取当前行，原生引擎则把原文转 data URI 交给 ExoPlayer。
 */

export interface Cue {
  start: number;
  end: number;
  text: string;
}

/** 字幕文本上限，防止把视频文件误当字幕导入 */
export const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;

function toSeconds(h: string, m: string, s: string, ms: string): number {
  const frac = ms ? Number(ms.padEnd(3, '0').slice(0, 3)) / 1000 : 0;
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + frac;
}

/** 去掉标记，只保留可读文本（渲染时用 textContent，不解析 HTML） */
function cleanText(lines: string[]): string {
  return lines
    .join('\n')
    .replace(/<[^>]*>/g, '')
    .replace(/\{[^}]*\}/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

/**
 * 解析字幕文本
 *
 * 不区分扩展名：SRT 用逗号分隔毫秒，VTT 用点，两者都被接受。
 */
export function parseSubtitles(raw: string): Cue[] {
  const text = String(raw || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
  if (!text.trim()) return [];

  const blocks = text.split(/\n{2,}/);
  const cues: Cue[] = [];
  const timeRe =
    /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

  for (const block of blocks) {
    const lines = block.split('\n');
    if (!lines.length) continue;
    // VTT 头 / NOTE 注释块
    if (/^\s*(WEBVTT|NOTE)\b/i.test(lines[0])) continue;

    const idx = lines.findIndex((l) => timeRe.test(l));
    if (idx < 0) continue;
    const m = lines[idx].match(timeRe);
    if (!m) continue;

    const start = toSeconds(m[1], m[2], m[3], m[4]);
    const end = toSeconds(m[5], m[6], m[7], m[8]);
    const body = cleanText(lines.slice(idx + 1));
    if (!body || end <= start) continue;
    cues.push({ start, end, text: body });
  }

  return cues.sort((a, b) => a.start - b.start);
}

/** 二分查找当前时间对应的字幕行（同一时刻多条时取第一条） */
export function cueAt(cues: Cue[], time: number): string {
  if (!cues.length) return '';
  let lo = 0;
  let hi = cues.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= time) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return '';
  const c = cues[found];
  return time <= c.end ? c.text : '';
}

/**
 * 转成原生 ExoPlayer 能直接读的 data URI
 *
 * Media3 的 DefaultDataSource 支持 data: 协议，省去「写临时文件 + 申请存储权限」
 * 那一整条链路 —— 字幕通常几百 KB，走 bridge 完全够用。
 */
export function toSubtitleDataUri(raw: string, isVtt: boolean): string {
  const utf8 = encodeURIComponent(String(raw || '').replace(/^\uFEFF/, ''));
  // 不用 btoa：中文直接转 base64 需要先做 UTF-8 编码，encodeURIComponent 产生的是
  // 百分号转义，Media3 以 UTF-8 解码后内容一致，且体积更可控。
  const mime = isVtt ? 'text/vtt' : 'application/x-subrip';
  return `data:${mime},${utf8}`;
}
