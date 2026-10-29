import { useEffect, useState } from 'react';
import { PosterCard } from '../components/PosterCard';
import { Button } from '../components/Button';
import { loadCatalogue, type Catalogue, type MediaItem } from '../lib/catalogue';
import { fetchBlocks } from '../lib/api';
import './Library.css';

/**
 * 片库页
 * - 分区浏览
 * - 源健康度与黑名单管理（对应方案 P2-4）
 */
export function Library() {
  const [data, setData] = useState<Catalogue | null>(null);
  const [blocked, setBlocked] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [showBlocked, setShowBlocked] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        setData(await loadCatalogue());
      } finally {
        setLoading(false);
      }
      setBlocked(fetchBlocks());
    })();
  }, []);

  const allItems: MediaItem[] = data?.rows.flatMap((r) => r.items) ?? [];

  return (
    <div className="library">
      <header className="library__head">
        <h1 className="library__title">片库</h1>
        <p className="library__count">
          {loading ? '加载中…' : `共 ${allItems.length} 部 · ${data?.rows.length ?? 0} 个分区`}
        </p>
      </header>

      {showBlocked && (
        <section className="blocked">
          <div className="blocked__head">
            <h2 className="blocked__title">已拉黑的线路</h2>
            <Button variant="text" size="sm" onClick={() => setShowBlocked(false)}>
              收起
            </Button>
          </div>
          {blocked.length === 0 ? (
            <p className="blocked__empty">还没有拉黑任何线路。播放时可在换源面板拉黑异常线路。</p>
          ) : (
            <div className="blocked__list">
              {blocked.map((b) => (
                <span className="blocked__chip" key={b}>
                  {b}
                </span>
              ))}
            </div>
          )}
        </section>
      )}

      {data?.rows.map((row) => (
        <section className="lib-row" key={row.title}>
          <div className="lib-row__head">
            <h2 className="lib-row__title">{row.title}</h2>
            <span className="lib-row__count">{row.items.length}</span>
          </div>
          <div className="lib-row__grid stagger">
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

      <div className="library__foot">
        <Button variant="outlined" onClick={() => setShowBlocked((v) => !v)}>
          {showBlocked ? '隐藏线路管理' : '线路管理'}
        </Button>
      </div>
    </div>
  );
}
