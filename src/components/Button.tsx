import React from 'react';
import './Button.css';

type Variant = 'filled' | 'tonal' | 'outlined' | 'text' | 'elevated';
type Size = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: React.ReactNode;
  /** 加载中 */
  loading?: boolean;
  /** 全宽 */
  block?: boolean;
}

/**
 * Expressive 按钮
 * - 形状 morphing：按下时圆角从 full 收到 sm（对应 tokens 里的 morphPress 动画）
 * - filled 用品牌薄荷绿，其余用中性色阶
 */
export function Button({
  variant = 'filled',
  size = 'md',
  icon,
  loading,
  block,
  className = '',
  children,
  disabled,
  ...rest
}: ButtonProps) {
  const cls = [
    'btn',
    `btn--${variant}`,
    `btn--${size}`,
    block ? 'btn--block' : '',
    loading ? 'is-loading' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button className={cls} disabled={disabled || loading} {...rest}>
      {loading ? <span className="btn__spinner" aria-hidden="true" /> : icon}
      {children != null && <span className="btn__label">{children}</span>}
    </button>
  );
}

/** 图标按钮 */
export function IconButton({
  label,
  children,
  className = '',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button className={`icon-btn ${className}`} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}
