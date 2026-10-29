/**
 * 源解析适配层
 *
 * 每个源实现 resolveSource(provider, ctx) → ResolvedSource[]
 * 新增一个源 = 在这里加一个条目 + 在 config/sources.json 加一条配置。
 *
 * 内置类型：
 *   direct     —— 直连固定地址（测试流、自己的 CDN）
 *   scraper    —— 调用外部刮削 API
 *   aggregator —— 苹果 CMS 采集站（?ac=videolist 协议）
 *
 * 注意：本文件是纯 JS（服务端用 Node 直接跑，不经 TS 编译），
 * 类型定义见 src/providers/types.ts，此处只做 JSDoc 标注。
 */

const UA =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

/**
 * 苹果 CMS 采集站解析
 * 标准接口：?ac=videolist&wd=关键词  或  ?ac=videolist&ids=影片ID
 */
async function resolveAppleCms(provider, ctx) {
  const endpoint = provider.endpoint;
  if (!endpoint) throw new Error('缺少 endpoint');

  const params = new URLSearchParams();
  params.set('ac', 'videolist');
  if (ctx.mediaId) params.set('ids', String(ctx.mediaId));

  const url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}${params.toString()}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: ctx.signal,
  });
  if (!res.ok) throw new Error(`采集站返回 ${res.status}`);

  const json = await res.json();
  const list = json.list || json.data || [];
  const out = [];

  for (const item of list) {
    const vodList = Array.isArray(item.vod_play_url) ? item.vod_play_url : [];
    for (const entry of vodList) {
      const [flag, playStr] = String(entry).split('$$');
      if (!playStr) continue;
      const eps = playStr.split('#').map((seg) => {
        const [name, playUrl] = seg.split('$');
        return { name, url: playUrl };
      });

      // 剧集过滤
      let picked = eps;
      if (ctx.mediaType === 'tv' && ctx.episode) {
        const idx = ctx.episode - 1;
        if (eps[idx]) picked = [eps[idx]];
      }

      for (const ep of picked) {
        if (!ep.url) continue;
        out.push({
          url: ep.url,
          quality: flag || '默认',
          label: `${provider.name} · ${flag || '默认'}`,
          official: !!provider.official,
          weight: provider.weight ?? 0,
          headers: { 'User-Agent': UA, Referer: provider.endpoint },
        });
      }
    }
  }
  return out;
}

/**
 * 刮削 API 解析
 * 约定：GET {endpoint}/?type={mediaType}&id={mediaId}&season=&episode=
 */
async function resolveScraper(provider, ctx) {
  const endpoint = provider.endpoint;
  if (!endpoint) throw new Error('缺少 endpoint');

  const params = new URLSearchParams({
    type: ctx.mediaType,
    id: String(ctx.mediaId),
  });
  if (ctx.season) params.set('season', String(ctx.season));
  if (ctx.episode) params.set('episode', String(ctx.episode));

  const url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}${params.toString()}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: ctx.signal,
  });
  if (!res.ok) throw new Error(`刮削 API 返回 ${res.status}`);

  const json = await res.json();
  const list = Array.isArray(json) ? json : json.sources || json.data || [];

  return list
    .filter((s) => s && s.url)
    .map((s) => ({
      url: s.url,
      quality: s.quality || s.label || '默认',
      label: s.label || `${provider.name} · ${s.quality || '默认'}`,
      official: !!provider.official,
      weight: provider.weight ?? 0,
      headers: s.headers || {},
      subtitles: s.subtitles || [],
    }));
}

/**
 * 直连源
 */
async function resolveDirect(provider) {
  if (!provider.url) throw new Error('缺少 url');
  return [
    {
      url: provider.url,
      quality: 'AUTO',
      label: provider.name,
      official: !!provider.official,
      weight: provider.weight ?? 0,
    },
  ];
}

/**
 * 分发器
 */
export async function resolveSource(provider, ctx) {
  switch (provider.type) {
    case 'direct':
      return resolveDirect(provider, ctx);
    case 'scraper':
      return resolveScraper(provider, ctx);
    case 'aggregator':
      return resolveAppleCms(provider, ctx);
    default:
      throw new Error(`未知源类型: ${provider.type}`);
  }
}

export { resolveAppleCms, resolveScraper, resolveDirect };
