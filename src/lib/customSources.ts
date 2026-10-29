/**
 * 用户自定义聚合源管理
 *
 * 目标：让用户能自行添加 / 删除聚合资源链接，无需改代码重新打包。
 *
 * ── 设计要点 ──────────────────────────────────────────
 * 1. **自动识别协议**：粘贴任意 MacCMS 接口地址即可，
 *    内部统一规范化为 `.../api.php/provide/vod/` 形式。
 * 2. **自动探测**：添加时立即探测可用性、总条目数、延迟，
 *    探测结果直接展示，避免用户添加了才发现不能用。
 * 3. **持久化**：存 localStorage，重启 App 仍在。
 * 4. **与内置源并存**：内置源 + 自建源合并成统一源池参与解析，
 *    自建源权重更高（用户主动添加的，优先使用）。
 * 5. **可禁用**：源不稳定时可临时关掉，不必删除。
 *
 * ── 存储格式 ──────────────────────────────────────────
 * localStorage key: `sober.customSources`
 *   [{ id, name, base, weight, enabled, addedAt }]
 */

import { CMS_SOURCES, cmsDetail, cmsList, type CmsSource } from './cms';

const STORAGE_KEY = 'sober.customSources';

/** 自定义源在源池中的权重基准（高于所有内置源） */
const CUSTOM_WEIGHT_BASE = 500;

/** 用户自定义源记录 */
export interface CustomSource {
  id: string;
  name: string;
  /** 规范化后的接口根地址 */
  base: string;
  /** 是否启用 */
  enabled: boolean;
  /** 添加时间戳 */
  addedAt: number;
  /** 最近一次探测结果 */
  lastProbe?: {
    ok: boolean;
    total?: number;
    latencyMs: number;
    error?: string;
  };
}

/** 读取已保存的自定义源 */
export function loadCustomSources(): CustomSource[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x && typeof x.base === 'string' && x.base)
      .map((x) => ({
        id: String(x.id || `custom-${Date.now()}`),
        name: String(x.name || '自定义源'),
        base: String(x.base),
        enabled: x.enabled !== false,
        addedAt: Number(x.addedAt) || Date.now(),
        lastProbe: x.lastProbe,
      }));
  } catch {
    return [];
  }
}

/** 保存自定义源 */
export function saveCustomSources(list: CustomSource[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* 存储不可用时静默失败 */
  }
}

/**
 * 规范化用户输入的接口地址
 *
 * 接受多种写法：
 *   https://host/api.php/provide/vod/
 *   https://host/api.php/provide/vod
 *   https://host/api.php/provide/vod/?ac=list
 *   https://host/inc/api.php/provide/vod/
 *   host
 *
 * 统一输出 `.../api.php/provide/vod/`（保留 inc/ 这类路径前缀）。
 */
export function normalizeSourceUrl(input: string): string | null {
  let s = (input || '').trim();
  if (!s) return null;

  // 补协议
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;

  // 去掉查询串与片段
  s = s.split('?')[0].split('#')[0];

  // 去掉尾部斜杠
  s = s.replace(/\/+$/, '');

  // 已经指向 provide/vod 的情况
  const m = s.match(/^(.*?\/api\.php\/provide\/vod)/i);
  if (m) return `${m[1]}/`;

  // 含 api.php 但没有 provide/vod
  if (/\/api\.php/i.test(s)) {
    const m2 = s.match(/^(.*?\/api\.php)/i);
    if (m2) return `${m2[1]}/provide/vod/`;
  }

  // 裸域名 → 拼标准路径
  const m3 = s.match(/^(https?:\/\/[^/]+)/i);
  return m3 ? `${m3[1]}/api.php/provide/vod/` : null;
}

/** 从地址里猜一个展示名 */
function guessName(base: string): string {
  try {
    const u = new URL(base);
    const host = u.hostname.replace(/^www\./, '');
    const label = host.split('.')[0] || host;
    return label.slice(0, 16);
  } catch {
    return '自定义源';
  }
}

/** 生成唯一 id */
function makeId(base: string): string {
  const rand = Math.random().toString(36).slice(2, 7);
  return `custom-${base.replace(/[^a-z0-9]/gi, '').slice(-8)}-${rand}`;
}

/**
 * 添加自定义源
 * @param input 用户粘贴的地址或名称+地址
 * @param name  可选的自定义名称
 */
export async function addCustomSource(input: string, name?: string): Promise<
  | { ok: true; source: CustomSource }
  | { ok: false; error: string }
> {
  const base = normalizeSourceUrl(input);
  if (!base) return { ok: false, error: '地址为空' };

  const list = loadCustomSources();
  if (list.some((x) => x.base === base)) {
    return { ok: false, error: '该源已存在' };
  }

  // 立即探测，确认可用
  const probe = await probeOne(base, list.length);

  const src: CustomSource = {
    id: makeId(base),
    name: (name || '').trim() || guessName(base),
    base,
    enabled: true,
    addedAt: Date.now(),
    lastProbe: {
      ok: probe.ok,
      total: probe.total,
      latencyMs: probe.latencyMs,
      error: probe.error,
    },
  };

  saveCustomSources([...list, src]);
  return { ok: true, source: src };
}

/** 删除自定义源 */
export function removeCustomSource(id: string): void {
  saveCustomSources(loadCustomSources().filter((x) => x.id !== id));
}

/** 启用/禁用自定义源 */
export function toggleCustomSource(id: string, enabled: boolean): void {
  saveCustomSources(
    loadCustomSources().map((x) => (x.id === id ? { ...x, enabled } : x)),
  );
}

/** 重命名自定义源 */
export function renameCustomSource(id: string, name: string): void {
  saveCustomSources(
    loadCustomSources().map((x) => (x.id === id ? { ...x, name: name.trim() || x.name } : x)),
  );
}

/** 重新探测单个自定义源 */
export async function reprobeCustomSource(id: string): Promise<void> {
  const list = loadCustomSources();
  const item = list.find((x) => x.id === id);
  if (!item) return;
  const probe = await probeOne(item.base, list.length);
  saveCustomSources(
    list.map((x) =>
      x.id === id
        ? {
            ...x,
            lastProbe: {
              ok: probe.ok,
              total: probe.total,
              latencyMs: probe.latencyMs,
              error: probe.error,
            },
          }
        : x,
    ),
  );
}

/** 探测单个地址 */
async function probeOne(
  base: string,
  index: number,
): Promise<{ ok: boolean; total?: number; latencyMs: number; error?: string }> {
  const t0 = Date.now();
  const tmp: CmsSource = {
    id: `probe-${index}`,
    name: 'probe',
    base,
    weight: 1,
  };
  try {
    const r = await cmsList(tmp, { limit: 1 });
    return { ok: true, total: r.total, latencyMs: Date.now() - t0 };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 把自定义源转成 CmsSource（供解析链路使用）
 * 自定义源权重高于内置源 —— 用户主动添加的，优先尝试。
 */
export function toCmsSources(custom: CustomSource[]): CmsSource[] {
  return custom
    .filter((x) => x.enabled !== false)
    .map((x, i) => ({
      id: x.id,
      name: x.name,
      base: x.base,
      weight: CUSTOM_WEIGHT_BASE + (custom.length - i),
      custom: true,
      enabled: true,
    }));
}

/**
 * 完整源池 = 内置源 + 自定义源
 */
export function allSources(): CmsSource[] {
  return [...toCmsSources(loadCustomSources()), ...CMS_SOURCES];
}

/**
 * 验证一个地址能否作为源使用（供 UI 的「测试」按钮用）
 */
export async function testSourceUrl(input: string): Promise<{
  ok: boolean;
  base?: string;
  total?: number;
  latencyMs: number;
  sample?: { name: string; hasPlay: boolean };
  error?: string;
}> {
  const base = normalizeSourceUrl(input);
  if (!base) return { ok: false, latencyMs: 0, error: '地址无效' };

  const t0 = Date.now();
  const tmp: CmsSource = { id: 'test', name: 'test', base, weight: 1 };
  try {
    const list = await cmsList(tmp, { limit: 5 });
    const latencyMs = Date.now() - t0;
    const first = list.list[0];

    // 再验证一条能否拿到播放地址 —— 这是源真正可用的关键
    let hasPlay = false;
    if (first) {
      try {
        const det = await cmsDetail(tmp, first.vod_id);
        hasPlay = !!det && !!det.vod_play_url && det.vod_play_url.includes('.m3u8');
      } catch {
        hasPlay = false;
      }
    }

    return {
      ok: list.list.length > 0,
      base,
      total: list.total,
      latencyMs,
      sample: first ? { name: first.vod_name, hasPlay } : undefined,
      error: list.list.length ? undefined : '接口可达但无数据',
    };
  } catch (err) {
    return {
      ok: false,
      base,
      latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
