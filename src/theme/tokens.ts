/**
 * Sober TV 设计令牌
 * 风格：曜石黑 + 薄荷绿 · Material 3 Expressive
 *
 * Expressive 的三个核心特征在本文件中的体现：
 *  1. 形状系统 —— 从 4px 到 40px 的完整圆角阶梯 + 形状 morphing 变量
 *  2. 弹性动效 —— emphasized easing 曲线 + spring 曲线
 *  3. 动态色彩 —— 单一品牌种子色 + 语义色阶 + 容器层级
 */

// ── 品牌种子：薄荷绿 ──────────────────��──────────────────
export const BRAND = {
  /** 主色 50 — 极浅，用于浅色容器 */
  primary50: '#E8FFF4',
  /** 主色 100 */
  primary100: '#C4F5DD',
  /** 主色 200 */
  primary200: '#93E9C0',
  /** 主色 300 */
  primary300: '#5DD9A0',
  /** 主色 400 — 亮薄荷，主交互色 */
  primary400: '#4ADE80',
  /** 主色 500 */
  primary500: '#2FC46B',
  /** 主色 600 — 深一档，用于按下态 */
  primary600: '#22A655',
  /** 主色 700 */
  primary700: '#1A8244',
  /** 主色 800 */
  primary800: '#135F33',
  /** 主色 900 */
  primary900: '#0D4526',
} as const;

/** 中性色 —— 曜石黑系（带一点冷调，避免纯黑显得廉价） */
export const NEUTRAL = {
  n0: '#000000',
  n4: '#0A0A0A',
  n6: '#0E0F0F',
  n8: '#141616',
  n10: '#1A1D1C',
  n12: '#212524',
  n15: '#2A2F2D',
  n20: '#353B39',
  n25: '#454C49',
  n30: '#5A615E',
  n40: '#7B8380',
  n50: '#9BA3A0',
  n60: '#B9C0BD',
  n70: '#D6DCDA',
  n80: '#E8ECEA',
  n90: '#F1F5F3',
  n95: '#F7FAF8',
  n99: '#FBFDFC',
} as const;

/** 语义色 */
export const SEMANTIC = {
  error: '#FF6B6B',
  errorDark: '#C43D3D',
  warning: '#FFB84D',
  success: BRAND.primary400,
  info: '#5AB8FF',
} as const;

// ── 形状系统（Expressive 核心）───────────────────────────
export const SHAPE = {
  none: 0,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 28,
  xxxl: 36,
  full: 999,
  /** Expressive：强调容器用更大的圆角 */
  expressive: 20,
  /** 按钮按下时的 morphing 目标 */
  morph: 14,
} as const;

// ── 动效（Expressive 弹性曲线）──────────────────────────
export const MOTION = {
  /** 标准 emphasized 缓动 */
  standard: 'cubic-bezier(0.2, 0, 0, 1)',
  /** 减速进场 */
  emphasizedDecelerate: 'cubic-bezier(0.05, 0.7, 0.1, 1)',
  /** 加速退出 */
  emphasizedAccelerate: 'cubic-bezier(0.3, 0, 0.8, 0.15)',
  /** 弹簧感（Expressive 标志性） */
  spring: 'linear(0, 0.006, 0.025 2.8%, 0.101 6.1%, 0.539 18.9%, 0.721 25.3%, 0.849 31.5%, 0.937 38.1%, 0.968 41.8%, 0.991 45.7%, 1.006 50.1%, 1.015 55%, 1.017 63.9%, 1.001)',
  duration: {
    short: 150,
    medium: 250,
    long: 400,
    xlong: 600,
  },
} as const;

// ── 间距阶梯（4pt 基准）────────────────────────────────
export const SPACE = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
  huge: 64,
} as const;

// ── 排版（Expressive 强调大字标题）───────────────────────
export const TYPE = {
  displayLarge: { size: 52, weight: 400, line: 60, tracking: -0.5 },
  displayMedium: { size: 42, weight: 400, line: 50, tracking: -0.25 },
  displaySmall: { size: 34, weight: 400, line: 42, tracking: 0 },
  headlineLarge: { size: 28, weight: 400, line: 36, tracking: 0 },
  headlineMedium: { size: 24, weight: 400, line: 32, tracking: 0 },
  headlineSmall: { size: 20, weight: 500, line: 28, tracking: 0 },
  titleLarge: { size: 18, weight: 500, line: 24, tracking: 0.1 },
  titleMedium: { size: 15, weight: 500, line: 20, tracking: 0.15 },
  titleSmall: { size: 13, weight: 500, line: 18, tracking: 0.1 },
  bodyLarge: { size: 15, weight: 400, line: 22, tracking: 0.15 },
  bodyMedium: { size: 13, weight: 400, line: 19, tracking: 0.2 },
  bodySmall: { size: 11.5, weight: 400, line: 16, tracking: 0.3 },
  labelLarge: { size: 13, weight: 500, line: 18, tracking: 0.1 },
  labelMedium: { size: 11.5, weight: 500, line: 15, tracking: 0.4 },
  labelSmall: { size: 10.5, weight: 500, line: 14, tracking: 0.5 },
} as const;

// ── 层级（Elevation）───────────────────────────────────
export const ELEVATION = {
  level0: 'none',
  level1: '0 1px 2px rgba(0,0,0,0.32), 0 1px 3px 1px rgba(0,0,0,0.16)',
  level2: '0 1px 2px rgba(0,0,0,0.36), 0 2px 6px 2px rgba(0,0,0,0.18)',
  level3: '0 4px 8px 3px rgba(0,0,0,0.20), 0 1px 3px rgba(0,0,0,0.36)',
  level4: '0 6px 10px 4px rgba(0,0,0,0.22), 0 2px 3px rgba(0,0,0,0.38)',
  /** Expressive：焦点环用品牌色 */
  focusRing: `0 0 0 3px ${BRAND.primary400}55`,
} as const;

// ── 完整 CSS 变量输出 ─────────────────────────────────
export function cssVars(): Record<string, string> {
  return {
    '--primary-50': BRAND.primary50,
    '--primary-100': BRAND.primary100,
    '--primary-200': BRAND.primary200,
    '--primary-300': BRAND.primary300,
    '--primary-400': BRAND.primary400,
    '--primary-500': BRAND.primary500,
    '--primary-600': BRAND.primary600,
    '--primary-700': BRAND.primary700,
    '--primary-800': BRAND.primary800,
    '--primary-900': BRAND.primary900,

    '--n-0': NEUTRAL.n0,
    '--n-4': NEUTRAL.n4,
    '--n-6': NEUTRAL.n6,
    '--n-8': NEUTRAL.n8,
    '--n-10': NEUTRAL.n10,
    '--n-12': NEUTRAL.n12,
    '--n-15': NEUTRAL.n15,
    '--n-20': NEUTRAL.n20,
    '--n-25': NEUTRAL.n25,
    '--n-30': NEUTRAL.n30,
    '--n-40': NEUTRAL.n40,
    '--n-50': NEUTRAL.n50,
    '--n-60': NEUTRAL.n60,
    '--n-70': NEUTRAL.n70,
    '--n-80': NEUTRAL.n80,
    '--n-90': NEUTRAL.n90,

    '--error': SEMANTIC.error,
    '--warning': SEMANTIC.warning,
    '--info': SEMANTIC.info,

    /*
     * ⚠️ 圆角必须带 px 单位。
     *
     * 之前写成 String(SHAPE.full) → "999"（无单位数字），
     * 而 border-radius 只接受 <length>，无单位数字是**无效值**
     * → 整条声明作废，回退到 initial 值 0px。
     * 结果：全 App 的圆角全部失效（搜索框、按钮、卡片都是直角），
     * 视觉上还表现为「两个直角框重叠」（外层胶囊框 + input 的 focus 描边）。
     */
    '--shape-none': `${SHAPE.none}px`,
    '--shape-xs': `${SHAPE.xs}px`,
    '--shape-sm': `${SHAPE.sm}px`,
    '--shape-md': `${SHAPE.md}px`,
    '--shape-lg': `${SHAPE.lg}px`,
    '--shape-xl': `${SHAPE.xl}px`,
    '--shape-xxl': `${SHAPE.xxl}px`,
    '--shape-xxxl': `${SHAPE.xxxl}px`,
    '--shape-full': `${SHAPE.full}px`,
    '--shape-expressive': `${SHAPE.expressive}px`,

    '--motion-standard': MOTION.standard,
    '--motion-decel': MOTION.emphasizedDecelerate,
    '--motion-accel': MOTION.emphasizedAccelerate,
    '--motion-spring': MOTION.spring,
    '--dur-short': `${MOTION.duration.short}ms`,
    '--dur-medium': `${MOTION.duration.medium}ms`,
    '--dur-long': `${MOTION.duration.long}ms`,
    '--dur-xlong': `${MOTION.duration.xlong}ms`,

    '--elev-0': ELEVATION.level0,
    '--elev-1': ELEVATION.level1,
    '--elev-2': ELEVATION.level2,
    '--elev-3': ELEVATION.level3,
    '--elev-4': ELEVATION.level4,
    '--focus-ring': ELEVATION.focusRing,

    '--bg-base': NEUTRAL.n4,
    '--bg-surface': NEUTRAL.n8,
    '--bg-surface-2': NEUTRAL.n12,
    '--bg-elevated': NEUTRAL.n15,
    '--bg-scrim': 'rgba(0,0,0,0.62)',

    '--text-primary': NEUTRAL.n95,
    '--text-secondary': NEUTRAL.n60,
    '--text-tertiary': NEUTRAL.n40,
    '--text-on-primary': NEUTRAL.n4,
  };
}

/** 注入 CSS 变量到 :root */
export function injectCssVars(target: HTMLElement = document.documentElement): void {
  const vars = cssVars();
  for (const [k, v] of Object.entries(vars)) {
    target.style.setProperty(k, v);
  }
}
