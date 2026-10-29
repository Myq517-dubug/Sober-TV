#!/usr/bin/env python3
"""
生成 Sober TV 的 X（Twitter 风格）App 图标
─────────────────────────────────────────────────────────
设计要点：
1. **X 形笔画**：Twitter 的 X 是两条对角粗线交叉，
   这里用「交叉笔」画法（每条笔画是一个平行四边形 + 切口），
   保证在任何尺寸下都是干净的几何形状，不是模糊的位图放大。
2. **配色**：延续 App 的曜石黑 (#0A0A0A) + 薄荷绿 (#4ADE80)。
   - 背景：深黑渐变（略带径向亮心，避免死板）
   - 主体：薄荷绿渐变（顶部更亮，模拟高光）
3. **尺寸**：输出 mipmap 各密度 + 自适应图标前景层（透明底）。
   自适应图标的 safe zone 是中心 66/108，需要额外的内缩。
"""

from PIL import Image, ImageDraw
import os
import math

# ── 品牌色 ─────────────────────────────────────────────
BLACK = (10, 10, 10)
MINT = (74, 222, 128)
MINT_LIGHT = (110, 231, 154)

# 各密度：mdpi=48, hdpi=72, xhdpi=96, xxhdpi=144, xxxhdpi=192
DENSITIES = {
    'mdpi': 48,
    'hdpi': 72,
    'xhdpi': 96,
    'xxhdpi': 144,
    'xxxhdpi': 192,
}

RES = os.path.join(os.path.dirname(__file__), '..', 'android', 'app', 'src', 'main', 'res')


def lerp(c1, c2, t):
    return tuple(int(round(a + (b - a) * t)) for a, b in zip(c1, c2))


def draw_background(size, rounded=True, radius_ratio=0.2237):
    """
    背景：曜石黑 + 径向微亮 + 可选圆角
    径向亮心让图标在深色壁纸上有立体感（纯黑会糊成一团）
    """
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    px = img.load()
    cx = cy = size / 2
    max_r = size * 0.78
    for y in range(size):
        for x in range(size):
            d = math.hypot(x - cx, y - cy) / max_r
            t = min(1.0, d)
            # 中心 #14181A → 边缘 #050505
            c = lerp((26, 32, 34), (6, 6, 7), t ** 1.25)
            px[x, y] = (c[0], c[1], c[2], 255)

    if not rounded:
        return img

    # 圆角遮罩（Android 启动图标圆角约 22.37%）
    mask = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(mask)
    r = int(size * radius_ratio)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=255)
    img.putalpha(mask)
    return img


def draw_x_mark(img, size, cx, cy, span, thickness, color_top, color_bottom):
    """
    画 X 形标志（Twitter 风格）
    ─────────────────────────────
    Twitter 的 X 几何特征：
      · 两条笔画互相垂直（±45°）
      · 端头切口**垂直于笔画方向**（不是竖直/水平）
        → 四角都是斜切的，这是 X 看起来「利落」的关键
      · 交叉处两笔等宽，形成一个小菱形

    实现：把一条粗线段画成矩形后旋转 ±45°。
      旋转矩形的端头天然垂直于笔画，比手工算多边形坐标更可靠。
    """
    # 笔画长度：X 的外接尺寸 ≈ (L + t) / √2 ，反推 L 使外接 ≈ span
    L = int(round(span * 1.16))
    t = int(round(thickness))

    for angle in (-45, 45):
        # 1) 画一条水平粗线段
        bar = Image.new('RGBA', (L, t), (0, 0, 0, 0))
        bd = ImageDraw.Draw(bar)

        # 垂直渐变（顶亮底暗）
        for y in range(t):
            tt = y / max(1, t - 1)
            col = lerp(color_top, color_bottom, tt)
            bd.line([(0, y), (L, y)], fill=col + (255,))

        # 2) 旋转（expand=True 保留完整笔画）
        bar = bar.rotate(angle, resample=Image.BICUBIC, expand=True)

        # 3) 居中贴到 (cx, cy)
        px = int(cx - bar.width / 2)
        py = int(cy - bar.height / 2)
        img.alpha_composite(bar, (px, py))


def build_icon(size, rounded=True, inset_ratio=0.0, bg_for_foreground=False,
               color_top=MINT_LIGHT, color_bottom=MINT):
    """
    构建图标
    inset_ratio: 自适应图标前景层需要内缩（安全区 66/108）
    """
    if bg_for_foreground:
        # 前景层：透明底，只有 X
        img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    else:
        img = draw_background(size, rounded=rounded)

    # X 在画布上的占比（Twitter X 偏饱满，约占 0.66）
    if inset_ratio > 0:
        # 自适应图标：X 放进中心安全区（66/108 ≈ 0.611）
        content = size * 0.50
        cx = cy = size / 2
    else:
        content = size * 0.66
        cx = cy = size / 2

    draw_x_mark(
        img,
        size,
        cx,
        cy,
        span=content,
        # 笔画粗细：Twitter X 的笔画很粗，约占整体宽度的 1/3
        thickness=content * 0.38,
        color_top=color_top,
        color_bottom=color_bottom,
    )
    return img


def main():
    for dens, size in DENSITIES.items():
        outdir = os.path.join(RES, f'mipmap-{dens}')
        os.makedirs(outdir, exist_ok=True)

        # 方形图标（带圆角）
        icon = build_icon(size, rounded=True)
        icon.save(os.path.join(outdir, 'ic_launcher.png'))

        # 圆形图标
        circ = build_icon(size, rounded=False)
        mask = Image.new('L', (size, size), 0)
        ImageDraw.Draw(mask).ellipse([0, 0, size - 1, size - 1], fill=255)
        circ.putalpha(mask)
        circ.save(os.path.join(outdir, 'ic_launcher_round.png'))

        # 自适应图标前景层（透明底 + 内缩）
        fg = build_icon(size, rounded=False, inset_ratio=0.22, bg_for_foreground=True)
        fg.save(os.path.join(outdir, 'ic_launcher_foreground.png'))

        # Android 13+ 主题图标单色层（纯白 X，系统会按主题着色）
        mono = build_icon(size, rounded=False, inset_ratio=0.22,
                          bg_for_foreground=True,
                          color_top=(255, 255, 255), color_bottom=(255, 255, 255))
        mono.save(os.path.join(outdir, 'ic_launcher_monochrome.png'))

        print(f'  mipmap-{dens}: {size}x{size} ✓')

    # 生成一张大图预览
    preview = build_icon(512, rounded=True)
    prev_dir = os.path.join(os.path.dirname(__file__), '..', '..', '..', 'game', 'outputs')
    os.makedirs(prev_dir, exist_ok=True)
    preview.save(os.path.join(prev_dir, 'sobertv_icon_512.png'))
    print('  预览: 512x512 ✓')


if __name__ == '__main__':
    main()
