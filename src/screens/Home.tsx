import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { PosterCard } from '../components/PosterCard';
import { Button } from '../components/Button';
import './Home.css';
import {
  clearCatalogueCache,
  loadCatalogue,
  resetTmdbCircuit,
  type Catalogue,
  type MediaItem,
} from '../lib/catalogue';
import { listMemories, type MediaType as MemoryRecord } from '../lib/memory';

/**
 * 首页
 * 结构：Hero 精选 → 分类行
 * 视觉：曜石黑底 + 薄荷绿点缀，海报墙为主，克制留白
 */
export function Home() {
  const [data, setData] = useState<Catalogue | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 继续观看（来自本地观看记忆） */
  const [memories, setMemories] = useState<MemoryRecord[]>([]);

  /** 加载片库。force=true 时绕过缓存并重置 TMDB 熔断 */
  const load = useCallback(async (force = false) => {
    setError(null);
    try {
      if (force) {
        clearCatalogueCache();
        resetTmdbCircuit();
        setLoading(true);
      }
      // onMoreRows：首批渲染后，其余分类在后台到达时追加
      const c = await loadCatalogue({
        forceRefresh: force,
        onMoreRows: (more) => {
          setData((prev) => {
            if (!prev) return prev;
            /*
             * 同名行**合并**而不是替换。
             *
             * 替换会导致：首批已渲染的条目（带海报）被后台补齐的
             * 同名行覆盖掉，用户看到卡片闪一下、图又没了。
             * 合并时按 id 去重，后到的补充新条目。
             */
            const byTitle = new Map(prev.rows.map((r) => [r.title, r]));
            for (const r of more) {
              const exist = byTitle.get(r.title);
              if (!exist) {
                byTitle.set(r.title, r);
                continue;
              }
              const ids = new Set(exist.items.map((i) => String(i.id)));
              const merged = [
                ...exist.items,
                ...r.items.filter((i) => !ids.has(String(i.id))),
              ];
              byTitle.set(r.title, { ...exist, items: merged });
            }
            return { ...prev, rows: [...byTitle.values()] };
          });
        },
      });
      setData(c);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  // 继续观看：每次回到首页都刷新（可能在详情页看了新内容）
  const refreshMemories = useCallback(() => {
    setMemories(listMemories(20));
  }, []);

  useEffect(() => {
    refreshMemories();
    // 从详情页返回时刷新（详情页会写记忆）
    window.addEventListener('focus', refreshMemories);
    return () => window.removeEventListener('focus', refreshMemories);
  }, [refreshMemories]);

  if (loading) return <HomeSkeleton />;

  if (error) {
    return (
      <div className="home-empty">
        <div className="home-empty__icon">
          <svg viewBox="0 0 24 24" width="40" height="40" aria-hidden="true">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" fill="none" />
            <path d="M12 8v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="12" cy="16.5" r="0.8" fill="currentColor" />
          </svg>
        </div>
        <h2 className="home-empty__title">暂时拿不到内容</h2>
        <p className="home-empty__desc clamp-2">{error}</p>
        <Button variant="tonal" onClick={() => void load(true)}>
          重试
        </Button>
      </div>
    );
  }

  const rows = data?.rows ?? [];

  return (
    <div className="home">
      {data?.hero && <Hero item={data.hero} />}

      {rows.length === 0 && (
        <div className="home-empty">
          <h2 className="home-empty__title">还没有内容</h2>
          <p className="home-empty__desc">
            在 config/sources.json 配置采集源，或连接 TMDB 后即可浏览片库
          </p>
          <Button variant="tonal" onClick={() => void load(true)}>
            刷新
          </Button>
        </div>
      )}

      {/* ── 继续观看 ── */}
      {memories.length > 0 && (
        <section className="row row--continue">
          <div className="row__head">
            <h2 className="row__title">继续观看</h2>
            <span className="row__sub">{memories.length} 部</span>
          </div>
          <div className="row__track no-scrollbar">
            {memories.map((m, i) => (
              <ContinueCard key={m.id} m={m} index={i} />
            ))}
          </div>
        </section>
      )}

      {rows.map((row) => (
        <section className="row" key={row.title}>
          <div className="row__head">
            <h2 className="row__title">{row.title}</h2>
            {row.subtitle && <span className="row__sub">{row.subtitle}</span>}
          </div>
          <div className="row__track no-scrollbar">
            {row.items.map((item, i) => (
              <PosterCard
                key={`${row.title}-${item.id}`}
                id={item.id}
                title={item.title}
                poster={item.poster}
                year={item.year}
                rating={item.rating}
                subtitle={item.typeLabel}
                to={`/detail/${item.id}?type=${item.mediaType}`}
                index={i}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * 继续观看卡片
 *
 * 与普通海报卡的区别：
 *   1. 底部叠加**进度条**（已播比例）
 *   2. 角标显示「第 N 集」与「还剩 xx」
 *   3. 悬停/点击直接续播（进详情页后自动跳到上次位置）
 */
function ContinueCard({ m, index }: { m: MemoryRecord; index: number }) {
  const pct =
    m.duration > 0 ? Math.min(100, (m.position / m.duration) * 100) : 0;
  const remain = m.duration > 0 ? Math.max(0, m.duration - m.position) : 0;

  return (
    <Link
      className="ccard"
      to={`/detail/${m.id}?type=${m.mediaType}`}
      style={{ animationDelay: `${index * 40}ms` }}
    >
      <div className="ccard__poster">
        {m.poster ? (
          <img
            src={m.poster}
            alt=""
            loading="lazy"
            decoding="async"
            width={320}
            height={180}
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="ccard__nophoto" aria-hidden="true" />
        )}

        {/* 集数角标 */}
        {m.episode > 1 && (
          <span className="ccard__ep">第 {m.episode} 集</span>
        )}

        {/* 进度条 */}
        <div className="ccard__bar" aria-hidden="true">
          <div className="ccard__barfill" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <p className="ccard__title clamp-1">{m.title}</p>
      <p className="ccard__meta">
        {remain > 0 ? `还剩 ${fmtRemain(remain)}` : '即将开始'}
        {m.keepLabel ? ` · ${m.keepLabel}` : ''}
      </p>
    </Link>
  );
}

/** 剩余时长 → 「xx 分 xx 秒」/「xx 小时」 */
function fmtRemain(sec: number): string {
  const m = Math.floor(sec / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h} 小时 ${m % 60} 分`;
  if (m > 0) return `${m} 分`;
  return `${Math.floor(sec)} 秒`;
}

/** Hero 精选 —— 大图 + 品牌色氛围光 */
function Hero({ item }: { item: MediaItem }) {
  return (
    <section className="hero">
      {item.backdrop && (
        <div className="hero__bg">
          <img
            src={item.backdrop}
            alt=""
            aria-hidden="true"
            decoding="async"
            fetchPriority="high"
            referrerPolicy="no-referrer"
          />
          <div className="hero__scrim" />
        </div>
      )}
      <div className="hero__glow" aria-hidden="true" />

      <div className="hero__body">
        <p className="hero__eyebrow">本周精选</p>
        <h1 className="hero__title clamp-2">{item.title}</h1>
        <div className="hero__meta">
          {item.year && <span>{item.year}</span>}
          {item.rating != null && item.rating > 0 && (
            <span className="hero__score">{item.rating.toFixed(1)}</span>
          )}
          {item.typeLabel && <span>{item.typeLabel}</span>}
        </div>
        {item.overview && <p className="hero__desc clamp-3">{item.overview}</p>}
        <div className="hero__actions">
          <Button
            variant="filled"
            size="lg"
            onClick={() => {
              window.location.href = `/detail/${item.id}?type=${item.mediaType}`;
            }}
          >
            立即观看
          </Button>
          <Link to={`/detail/${item.id}?type=${item.mediaType}`}>
            <Button variant="outlined" size="lg">
              详情
            </Button>
          </Link>
        </div>
      </div>
    </section>
  );
}

/** 骨架屏 */
function HomeSkeleton() {
  return (
    <div className="home">
      <div className="hero skeleton" style={{ height: 380 }} />
      {[0, 1, 2].map((i) => (
        <section className="row" key={i}>
          <div className="row__head">
            <div className="skeleton" style={{ width: 120, height: 20 }} />
          </div>
          <div className="row__track">
            {Array.from({ length: 6 }, (_, j) => (
              <div key={j} className="skeleton" style={{ aspectRatio: '2/3' }} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
