/**
 * Sober TV 服务端 —— 统一采集、解析、体检、顺延、广告过滤
 *
 * 技术选型：Node 原生 http，零运行时依赖，docker 镜像仅百来 MB。
 * 与客户端的通信协议：REST + JSON。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  config,
  state,
  listSources,
  getSource,
  watchConfig,
  reloadConfig,
  blockLine,
  unblockLine,
  renameLine,
  isBlocked,
  sortCandidates,
} from './lib/registry.js';
import { probeLine, probeMany, clearHealthCache } from './lib/health.js';
import { analyzeMedia, stripAds } from './lib/adDetect.js';
import { resolveSource } from './sources/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

// ── 简易日志 ──────────────────────────────────────────
const logLines = [];
function log(level, scope, message) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] [${scope}] ${message}`;
  console.log(line);
  logLines.push(line);
  if (logLines.length > 800) logLines.shift();
}

// ── 缓存 ──────────────────────────────────────────────
const resolveCache = new Map(); // key -> { t, data }
const RESOLVE_TTL = 5 * 60 * 1000;
const AD_SCAN_CACHE = new Map(); // token -> { t, out }
const AD_SCAN_TTL = 5 * 60 * 1000;

function cacheGet(map, key, ttl) {
  const hit = map.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.data;
  return null;
}
function cacheSet(map, key, data) {
  if (map.size > 200) {
    const oldest = map.keys().next().value;
    if (oldest) map.delete(oldest);
  }
  map.set(key, { t: Date.now(), data });
}

// ── HTTP 辅助 ─────────────────────────────────────────
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
}

function sendText(res, code, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(code, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

// ── 路由 ──────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = u.pathname;
  const method = req.method || 'GET';

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    res.end();
    return;
  }

  try {
    // ── 源列表 ────────────────────────────────────
    if (p === '/api/sources' && method === 'GET') {
      const category = u.searchParams.get('category') || undefined;
      const list = listSources({ category }).map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        categories: s.categories,
        official: !!s.official,
        weight: s.weight ?? 0,
        order: s.order ?? 500,
        enabled: s.enabled !== false,
        note: s.note || '',
      }));
      sendJSON(res, 200, { version: config.version, sources: list });
      return;
    }

    // ── 解析播放源 ────────────────────────────────
    // GET /api/resolve?mediaId=xx&type=movie&season=1&episode=2&keep=线路名&skip=0
    if (p === '/api/resolve' && method === 'GET') {
      const mediaId = u.searchParams.get('mediaId') || '';
      const type = u.searchParams.get('type') || 'movie';
      const season = u.searchParams.get('season');
      const episode = u.searchParams.get('episode');
      const keep = (u.searchParams.get('keep') || '').trim();
      const skip = Math.max(0, parseInt(u.searchParams.get('skip') || '0', 10) || 0);
      const full = u.searchParams.get('full') === '1';

      if (!mediaId) {
        sendJSON(res, 400, { error: '缺少 mediaId' });
        return;
      }

      const cacheKey = `${mediaId}|${type}|${season || ''}|${episode || ''}|${full ? 'f' : ''}`;
      const cached = cacheGet(resolveCache, cacheKey, RESOLVE_TTL);

      let candidates;
      if (cached) {
        candidates = cached;
        log('info', 'resolve', `命中缓存 ${cacheKey}`);
      } else {
        const providers = listSources({ category: type });
        if (!providers.length) {
          sendJSON(res, 200, { url: '', error: '没有可用源' });
          return;
        }

        // 并发解析各源
        const results = await probeMany(
          providers.map((p) => p.id),
          { concurrency: 4 },
        );
        void results;

        const parsed = await Promise.all(
          providers.map(async (prov) => {
            const t0 = Date.now();
            try {
              const sources = await resolveSource(prov, {
                mediaId,
                mediaType: type,
                season: season ? Number(season) : undefined,
                episode: episode ? Number(episode) : undefined,
                full,
              });
              return {
                label: prov.name,
                providerId: prov.id,
                official: !!prov.official,
                weight: prov.weight ?? 0,
                selected: false,
                url: sources[0]?.url || '',
                sources,
              };
            } catch (err) {
              log('warn', 'resolve', `${prov.name} 解析失败: ${err.message}`);
              return {
                label: prov.name,
                providerId: prov.id,
                official: !!prov.official,
                weight: prov.weight ?? 0,
                selected: false,
                url: '',
                sources: [],
                error: err.message,
              };
            }
          }),
        );

        candidates = parsed.filter((c) => c.sources && c.sources.length > 0);
        cacheSet(resolveCache, cacheKey, candidates);
      }

      if (!candidates.length) {
        sendJSON(res, 200, { url: '', error: '所有源均无解析结果' });
        return;
      }

      // 排序 + keep 置顶
      const usable = sortCandidates(candidates, { keepLabel: keep });

      // 体检 + 顺延：最多试 8 条
      const MAX_TRY = 8;
      let tried = 0;
      for (const c of usable) {
        if (tried >= MAX_TRY) break;
        tried++;

        const target = c.sources[0];
        if (!target) continue;

        const health = await probeLine(target.url, target.headers);
        if (health.status === 'dead') {
          log('info', 'resolve', `线路体检未通过，顺延下一条: ${c.label}`);
          continue;
        }

        log('info', 'resolve', `选中线路 ${c.label} (${health.latencyMs}ms, ${health.status})`);
        sendJSON(res, 200, {
          url: target.url,
          label: c.label,
          quality: target.quality,
          headers: target.headers || {},
          subtitles: target.subtitles || [],
          official: !!c.official,
          health,
          total: usable.length,
          tried,
        });
        return;
      }

      log('warn', 'resolve', `尝试 ${tried} 条后仍无可用线路`);
      sendJSON(res, 200, { url: '', error: '暂无可播线路', total: usable.length, tried });
      return;
    }

    // ── 换源列表 ──────────────────────────────────
    if (p === '/api/sources/resolve' && method === 'GET') {
      const mediaId = u.searchParams.get('mediaId') || '';
      const type = u.searchParams.get('type') || 'movie';
      const season = u.searchParams.get('season');
      const episode = u.searchParams.get('episode');

      const providers = listSources({ category: type });
      const parsed = await Promise.all(
        providers.map(async (prov) => {
          try {
            const sources = await resolveSource(prov, {
              mediaId,
              mediaType: type,
              season: season ? Number(season) : undefined,
              episode: episode ? Number(episode) : undefined,
            });
            return { label: prov.name, providerId: prov.id, official: !!prov.official, sources };
          } catch {
            return { label: prov.name, providerId: prov.id, official: !!prov.official, sources: [] };
          }
        }),
      );
      sendJSON(res, 200, { lines: parsed });
      return;
    }

    // ── 线路体检 ──────────────────────────────────
    if (p === '/api/health' && method === 'GET') {
      const url = u.searchParams.get('url') || '';
      if (!url) {
        sendJSON(res, 400, { error: '缺少 url' });
        return;
      }
      const result = await probeLine(url);
      sendJSON(res, 200, result);
      return;
    }

    // ── 广告扫描 ──────────────────────────────────
    if (p === '/api/ad-scan' && method === 'GET') {
      const url = u.searchParams.get('url') || '';
      if (!url) {
        sendJSON(res, 400, { error: '缺少 url' });
        return;
      }
      const cached = cacheGet(AD_SCAN_CACHE, url, AD_SCAN_TTL);
      if (cached) {
        sendJSON(res, 200, cached);
        return;
      }
      try {
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const text = await r.text();
        const analysis = analyzeMedia(text, url, { blacklist: state.blockedLines });
        const out = { url, verdict: analysis.verdict, blocked: analysis.blocked, total: analysis.total, adBlocks: analysis.adBlocks, reasons: analysis.reasons };
        cacheSet(AD_SCAN_CACHE, url, out);
        sendJSON(res, 200, out);
      } catch (err) {
        sendJSON(res, 200, { url, verdict: 'unknown', error: err.message });
      }
      return;
    }

    // ── m3u8 清单代理（过滤广告）──────────────────
    if (p === '/api/m3u8' && method === 'GET') {
      const url = u.searchParams.get('url') || '';
      if (!url) {
        sendText(res, 400, '缺少 url');
        return;
      }
      const strip = u.searchParams.get('strip') === '1';
      try {
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        let text = await r.text();
        if (strip) {
          const out = stripAds(text, url, { blacklist: state.blockedLines });
          text = out.text;
        }
        sendText(res, 200, text, 'application/vnd.apple.mpegurl');
      } catch (err) {
        sendText(res, 502, String(err.message));
      }
      return;
    }

    // ── 黑名单管理 ────────────────────────────────
    if (p === '/api/blocks' && method === 'GET') {
      sendJSON(res, 200, { blocked: state.blockedLines });
      return;
    }
    if (p === '/api/blocks' && method === 'POST') {
      const body = await readBody(req);
      const label = String(body.label || '').trim();
      if (!label) {
        sendJSON(res, 400, { error: '缺少 label' });
        return;
      }
      const blocked = body.action === 'unblock' ? unblockLine(label) : blockLine(label);
      clearHealthCache();
      sendJSON(res, 200, { ok: true, blocked });
      return;
    }
    if (p === '/api/blocks/rename' && method === 'POST') {
      const body = await readBody(req);
      const blocked = renameLine(String(body.old || ''), String(body.new || ''));
      sendJSON(res, 200, { ok: true, blocked });
      return;
    }

    // ── 配置热更新 ────────────────────────────────
    if (p === '/api/config/reload' && method === 'POST') {
      const r = reloadConfig();
      clearHealthCache();
      sendJSON(res, 200, { ok: true, ...r });
      return;
    }

    // ── 日志 ──────────────────────────────────────
    if (p === '/api/logs' && method === 'GET') {
      sendJSON(res, 200, { logs: logLines.slice(-200) });
      return;
    }

    // ── 健康检查 ──────────────────────────────────
    if (p === '/api/healthz' && method === 'GET') {
      sendJSON(res, 200, { ok: true, version: config.version, uptime: process.uptime() });
      return;
    }

    // ── 静态文件（Web 前台，可选部署）─────────────
    const webDir = path.join(ROOT, 'public');
    if (fs.existsSync(webDir)) {
      let file = path.join(webDir, p === '/' ? 'index.html' : p);
      if (!file.startsWith(webDir)) {
        sendText(res, 403, 'forbidden');
        return;
      }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(webDir, 'index.html');
      }
      if (fs.existsSync(file)) {
        const ext = path.extname(file);
        sendText(res, 200, fs.readFileSync(file, 'utf8'), MIME[ext] || 'application/octet-stream');
        return;
      }
    }

    sendJSON(res, 404, { error: 'not found' });
  } catch (err) {
    log('error', 'http', String(err.stack || err));
    sendJSON(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[sober-tv] 服务端已启动 http://${HOST}:${PORT}`);
  console.log(`[sober-tv] 配置版本 ${config.version}，源数量 ${(config.sources || []).length}`);
  watchConfig();
});

process.on('SIGTERM', () => {
  console.log('[sober-tv] 收到 SIGTERM，退出');
  server.close(() => process.exit(0));
});
