import { useState, useEffect, useRef, useCallback } from 'react';
import { PosterCard } from '../components/PosterCard';
import { searchMedia, type MediaItem } from '../lib/catalogue';
import './Search.css';

const HISTORY_KEY = 'sober.searchHistory';
const HISTORY_MAX = 10;

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr)
      ? arr.filter((x): x is string => typeof x === 'string').slice(0, HISTORY_MAX)
      : [];
  } catch {
    return [];
  }
}

/**
 * 搜索页
 * - 输入即时过滤（300ms 防抖）
 * - 空态给出手写建议
 * - 搜索历史本地留存，输入时给出历史联想
 */
export function Search() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [history, setHistory] = useState<string[]>(loadHistory);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<number | null>(null);

  /** 记一次有效搜索（去重 + 置顶 + 截断） */
  const commitHistory = useCallback((q: string) => {
    const v = q.trim();
    if (!v) return;
    setHistory((prev) => {
      const next = [v, ...prev.filter((x) => x !== v)].slice(0, HISTORY_MAX);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const runSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([]);
      setSearched(false);
      return;
    }
    setLoading(true);
    try {
      const r = await searchMedia(q);
      setResults(r);
      setSearched(true);
    } finally {
      setLoading(false);
    }
  }, []);

  const onChange = (v: string) => {
    setQuery(v);
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => void runSearch(v), 300);
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, []);

  /** 空态（未搜索 / 无结果）：搜索框垂直居中 */
  const isEmpty = !searched && !loading;

  /**
   * 历史联想
   *
   * 只做包含匹配（不要前缀匹配）：用户往往记得片名里的关键词，
   * 而不记得从哪个字开头。联想项排除当前输入本身。
   */
  const q = query.trim();
  const suggestions = q
    ? history
        .filter((h) => h !== q && h.toLowerCase().includes(q.toLowerCase()))
        .slice(0, 5)
    : [];

  /** 点历史 / 联想：填词 + 立即搜 + 记一次历史 */
  const pickHistory = (t: string) => {
    setQuery(t);
    commitHistory(t);
    void runSearch(t);
  };

  return (
    <div className={`search ${isEmpty ? 'is-empty' : ''}`}>
      <div className="search__bar">
        <svg className="search__icon" viewBox="0 0 24 24" width="19" height="19" aria-hidden="true">
          <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.6" fill="none" />
          <path d="M16 16l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <input
          ref={inputRef}
          className="search__input"
          type="search"
          value={query}
          placeholder="搜索影片、剧集"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commitHistory(query);
              void runSearch(query);
            }
          }}
          autoComplete="off"
        />
        {loading && <span className="search__spin" aria-hidden="true" />}
      </div>

      {/* ── 历史联想：输入过程中给候选 ── */}
      {suggestions.length > 0 && (
        <div className="search__history search__history--inline">
          <div className="search__history-head">
            <span className="search__hint-title">历史联想</span>
          </div>
          <div className="search__history-list">
            {suggestions.map((t) => (
              <button
                key={t}
                className="search__history-item"
                onClick={() => pickHistory(t)}
              >
                <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                  <circle
                    cx="12"
                    cy="12"
                    r="8"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    fill="none"
                  />
                  <path
                    d="M12 8v4.5l3 1.8"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    fill="none"
                  />
                </svg>
                <span className="clamp-1">{t}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {isEmpty && history.length > 0 && (
        <div className="search__history">
          <div className="search__history-head">
            <span className="search__hint-title">搜索历史</span>
            <button
              className="search__history-clear"
              onClick={() => {
                setHistory([]);
                localStorage.removeItem(HISTORY_KEY);
              }}
            >
              清空
            </button>
          </div>
          <div className="search__chips">
            {history.map((t) => (
              <button
                key={t}
                className="search__chip"
                onClick={() => pickHistory(t)}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      )}

      {isEmpty && (
        <div className="search__hint">
          <p className="search__hint-title">试试这些</p>
          <div className="search__chips">
            {['科幻', '悬疑', '纪录片', '动画', '2025', '高分'].map((t) => (
              <button
                key={t}
                className="search__chip"
                onClick={() => {
                  commitHistory(t);
                  onChange(t);
                }}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      )}

      {searched && results.length === 0 && !loading && (
        <p className="search__empty">没有找到「{query}」相关内容</p>
      )}

      {results.length > 0 && (
        <div
          className="search__grid stagger"
          onClickCapture={() => commitHistory(query)}
        >
          {results.map((item, i) => (
            <PosterCard
              key={item.id}
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
      )}
    </div>
  );
}
