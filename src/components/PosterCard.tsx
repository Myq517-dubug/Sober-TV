import { Link } from 'react-router-dom';
import { useState } from 'react';
import './PosterCard.css';

export interface PosterCardProps {
  id: string | number;
  title: string;
  poster?: string;
  backdrop?: string;
  year?: string;
  rating?: number;
  subtitle?: string;
  to?: string;
  onClick?: () => void;
  /** 焦点索引，遥控器导航用 */
  focusKey?: string;
  index?: number;
}

/**
 * 海报卡片
 * - 2:3 比例，hover 时海报轻微放大（Expressive 的「呼吸」感）
 * - 焦点态：品牌色光环 + 轻微上浮
 */
export function PosterCard({
  id,
  title,
  poster,
  year,
  rating,
  subtitle,
  to,
  onClick,
  focusKey,
  index,
}: PosterCardProps) {
  /** 图片加载失败（CDN 挂了 / 链接失效）→ 降级为首字占位 */
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = !!poster && !imgFailed;

  const content = (
    <>
      <div className="poster-card__art">
        {showImg ? (
          <img
            src={poster}
            alt={title}
            loading="lazy"
            decoding="async"
            width={300}
            height={450}
            fetchPriority={index != null && index < 6 ? 'high' : 'low'}
            referrerPolicy="no-referrer"
            draggable={false}
            onError={() => setImgFailed(true)}
          />
        ) : (
          <div className="poster-card__placeholder" aria-hidden="true">
            {/* 片名首字 —— 比通用图标更能让用户认出这是哪部片 */}
            <span className="poster-card__initial">{title.slice(0, 1)}</span>
          </div>
        )}

        {rating != null && rating > 0 && (
          <span className="poster-card__rating">{rating.toFixed(1)}</span>
        )}

        <div className="poster-card__sheen" aria-hidden="true" />
      </div>

      <div className="poster-card__meta">
        <p className="poster-card__title clamp-2">{title}</p>
        {subtitle || year ? (
          <p className="poster-card__sub clamp-1">{subtitle || year}</p>
        ) : null}
      </div>
    </>
  );

  const cls = 'poster-card';
  const style = { animationDelay: index != null ? `${Math.min(index, 12) * 45}ms` : undefined };

  if (to) {
    return (
      <Link to={to} className={cls} style={style} data-focus={focusKey} tabIndex={-1}>
        {content}
      </Link>
    );
  }
  return (
    <button
      type="button"
      className={cls}
      style={style}
      onClick={onClick}
      data-focus={focusKey}
      data-id={id}
    >
      {content}
    </button>
  );
}
