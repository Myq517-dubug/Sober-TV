import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PosterCard } from '../components/PosterCard';
import { Button } from '../components/Button';
import {
  clearFavorites,
  listFavorites,
  type FavoriteItem,
} from '../lib/favorites';
import { clearHistory, listHistory, clearMemory, type MediaType } from '../lib/memory';
import './Mine.css';

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / M月D日 */
function relTime(ts: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  if (hour < 48) return '昨天';
  const d = new Date(ts);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

type Tab = 'favorite' | 'history';

/**
 * 我的
 * - 收藏（追剧）
 * - 观看历史时间线
 *
 * 两者都只依赖本地存储，不发起网络请求，进页面即出结果。
 */
export function Mine() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('favorite');
  const [favorites, setFavorites] = useState<FavoriteItem[]>([]);
  const [history, setHistory] = useState<MediaType[]>([]);

  const refresh = useCallback(() => {
    setFavorites(listFavorites());
    setHistory(listHistory(80));
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);

  const favoriteIds = useMemo(() => new Set(favorites.map((f) => f.id)), [favorites]);

  function detailLink(id: string, mediaType: string): string {
    return `/detail/${encodeURIComponent(id)}?type=${mediaType || 'movie'}`;
  }

  return (
    <div className="mine">
      <header className="mine__head">
        <h1 className="mine__title">我的</h1>
        <p className="mine__count">
          {favorites.length} 部收藏 · {history.length} 条观看记录
        </p>
      </header>

      <div className="mine__tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'favorite'}
          className={`mine__tab ${tab === 'favorite' ? 'is-active' : ''}`}
          onClick={() => setTab('favorite')}
        >
          收藏
        </button>
        <button
          role="tab"
          aria-selected={tab === 'history'}
          className={`mine__tab ${tab === 'history' ? 'is-active' : ''}`}
          onClick={() => setTab('history')}
        >
          观看历史
        </button>
      </div>

      {tab === 'favorite' && (
        <>
          {favorites.length === 0 ? (
            <div className="mine__empty">
              <p className="mine__empty-title">还没有收藏</p>
              <p className="mine__empty-desc">在影片详情页点「收藏」，之后就能在这里快速找到</p>
              <Button variant="tonal" size="sm" onClick={() => navigate('/')}>
                去逛逛
              </Button>
            </div>
          ) : (
            <>
              <div className="mine__grid">
                {favorites.map((f, i) => (
                  <PosterCard
                    key={f.id}
                    id={f.id}
                    title={f.title}
                    poster={f.poster}
                    year={f.year}
                    rating={f.rating}
                    subtitle={f.typeLabel}
                    to={detailLink(f.id, f.mediaType)}
                    index={i}
                  />
                ))}
              </div>
              <div className="mine__foot">
                <Button
                  variant="text"
                  size="sm"
                  onClick={() => {
                    clearFavorites();
                    refresh();
                  }}
                >
                  清空收藏
                </Button>
              </div>
            </>
          )}
        </>
      )}

      {tab === 'history' && (
        <>
          {history.length === 0 ? (
            <div className="mine__empty">
              <p className="mine__empty-title">还没有观看记录</p>
              <p className="mine__empty-desc">看过的影片会按时间出现在这里，方便回看</p>
            </div>
          ) : (
            <>
              <div className="hist">
                {history.map((h) => {
                  const pct =
                    h.duration > 0 ? Math.min(100, (h.position / h.duration) * 100) : 0;
                  const finished = h.duration > 0 && h.position / h.duration > 0.95;
                  return (
                    <div className="hist__item" key={h.id}>
                      <Link
                        to={detailLink(h.id, h.mediaType)}
                        className="hist__main"
                        aria-label={`继续观看 ${h.title}`}
                      >
                        <div className="hist__art">
                          {h.poster ? (
                            <img
                              src={h.poster}
                              alt=""
                              loading="lazy"
                              decoding="async"
                              width={56}
                              height={84}
                              referrerPolicy="no-referrer"
                            />
                          ) : (
                            <span className="hist__initial" aria-hidden="true">
                              {h.title.slice(0, 1)}
                            </span>
                          )}
                        </div>
                        <div className="hist__text">
                          <p className="hist__name clamp-1">
                            {h.title}
                            {favoriteIds.has(h.id) && <span className="hist__star">收藏</span>}
                          </p>
                          <p className="hist__meta">
                            {h.mediaType !== 'movie' ? `第 ${h.episode} 集 · ` : ''}
                            {finished ? '已看完' : `已看 ${Math.round(pct)}%`}
                            <span className="hist__time">{relTime(h.updatedAt)}</span>
                          </p>
                          <div className="hist__bar" aria-hidden="true">
                            <span style={{ width: `${finished ? 100 : pct}%` }} />
                          </div>
                        </div>
                      </Link>
                      <button
                        className="hist__del"
                        aria-label={`删除 ${h.title} 的记录`}
                        onClick={() => {
                          clearMemory(h.id);
                          refresh();
                        }}
                      >
                        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                          <path
                            d="M6 6l12 12M18 6L6 18"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                          />
                        </svg>
                      </button>
                    </div>
                  );
                })}
              </div>
              <div className="mine__foot">
                <Button
                  variant="text"
                  size="sm"
                  onClick={() => {
                    clearHistory();
                    refresh();
                  }}
                >
                  清空观看历史
                </Button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
