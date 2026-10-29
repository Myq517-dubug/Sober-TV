/**
 * 源注册表 —— 借鉴 CineMax 的 sources_config.json 外置思路 + Nivio 的极简契约
 *
 * 设计要点：
 *  1. 源清单与解析逻辑分离：客户端只认 { url, quality }，解析细节全部在服务端
 *  2. 权重排序：weight 越高越优先，官方线路给 990+
 *  3. 黑名单：整条线路可被拉黑，改名时同步更新避免失配
 *  4. 热更新：配置文件变更后自动重载，无需重启
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const CONFIG_PATH = path.join(ROOT, 'config', 'sources.json');
const STATE_PATH = path.join(ROOT, 'data', 'state.json');

/** 默认源配置 —— 真实部署时由 config/sources.json 覆盖 */
const DEFAULT_SOURCES = {
  version: '1.0.0',
  updatedAt: '2026-10-26',
  sources: [
    {
      id: 'demo-direct',
      name: '演示源（直连测试）',
      type: 'direct',
      categories: ['movie', 'tv', 'anime', 'live'],
      enabled: true,
      order: 100,
      weight: 1000,
      official: true,
      url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
      note: '公共测试流，用于验证播放链路',
    },
  ],
};

function ensureDirs() {
  fs.mkdirSync(path.join(ROOT, 'config'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
}

function loadConfig() {
  ensureDirs();
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_SOURCES, null, 2), 'utf8');
    return { ...DEFAULT_SOURCES };
  }
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.sources)) throw new Error('sources 字段缺失');
    return parsed;
  } catch (err) {
    console.error('[config] 解析失败，使用默认配置:', err.message);
    return { ...DEFAULT_SOURCES };
  }
}

function loadState() {
  ensureDirs();
  if (!fs.existsSync(STATE_PATH)) {
    fs.writeFileSync(STATE_PATH, JSON.stringify({ blockedLines: [] }, null, 2), 'utf8');
    return { blockedLines: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return { blockedLines: [], ...parsed };
  } catch {
    return { blockedLines: [] };
  }
}

export const config = loadConfig();
export const state = loadState();

/** 保存运行时状态（黑名单等） */
export function saveState() {
  ensureDirs();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

/** 热更新配置文件 */
export function reloadConfig() {
  const next = loadConfig();
  const changed = next.version !== config.version;
  Object.assign(config, next);
  return { changed, version: config.version };
}

/** 启动时监听配置文件变化 */
export function watchConfig() {
  ensureDirs();
  try {
    fs.watchFile(CONFIG_PATH, { interval: 5000 }, () => {
      const r = reloadConfig();
      if (r.changed) {
        console.log(`[config] 已热更新到版本 ${r.version}`);
      }
    });
  } catch (err) {
    console.warn('[config] 监听失败:', err.message);
  }
}

/** 取所有启用的源，按 order / weight 排序 */
export function listSources({ category, includeDisabled = false } = {}) {
  let list = config.sources || [];
  if (!includeDisabled) list = list.filter((s) => s.enabled !== false);
  if (category) list = list.filter((s) => (s.categories || []).includes(category));
  return [...list].sort((a, b) => {
    const oa = a.order ?? 500;
    const ob = b.order ?? 500;
    if (oa !== ob) return oa - ob;
    const wa = a.weight ?? 0;
    const wb = b.weight ?? 0;
    if (wa !== wb) return wb - wa;
    return String(a.name).localeCompare(String(b.name));
  });
}

/** 按 id 取源 */
export function getSource(id) {
  return (config.sources || []).find((s) => s.id === id) || null;
}

/** 拉黑一条线路 */
export function blockLine(label) {
  if (!state.blockedLines.includes(label)) {
    state.blockedLines.push(label);
    saveState();
  }
  return state.blockedLines;
}

/** 解除拉黑 */
export function unblockLine(label) {
  state.blockedLines = state.blockedLines.filter((x) => x !== label);
  saveState();
  return state.blockedLines;
}

/** 线路改名时同步黑名单，避免按旧名失配 */
export function renameLine(oldLabel, newLabel) {
  state.blockedLines = state.blockedLines.map((x) => (x === oldLabel ? newLabel : x));
  saveState();
  return state.blockedLines;
}

/** 判断线路是否被拉黑 */
export function isBlocked(label, url) {
  const bl = state.blockedLines || [];
  if (!bl.length) return false;
  const lb = String(label || '');
  const uo = String(url || '');
  return bl.some((b) => (lb && lb.includes(b)) || (uo && uo.includes(b)));
}

/** 源排序 —— 借鉴 AIStream 的三级裁决：selected > weight > 官方优先 */
export function sortCandidates(candidates, { keepLabel } = {}) {
  const usable = candidates.filter((c) => !isBlocked(c.label, c.url));

  // keep：正在播的源置顶（失效才顺延，而不是直接跳到最优源）
  if (keepLabel) {
    const i = usable.findIndex((c) => c.label === keepLabel);
    if (i > 0) {
      const [item] = usable.splice(i, 1);
      usable.unshift(item);
    }
  }

  usable.sort((a, b) => {
    const sa = a.selected ? 1 : 0;
    const sb = b.selected ? 1 : 0;
    if (sa !== sb) return sb - sa;
    const wa = a.weight ?? 0;
    const wb = b.weight ?? 0;
    if (wa !== wb) return wb - wa;
    return (a.official ? 0 : 1) - (b.official ? 0 : 1);
  });

  return usable;
}
